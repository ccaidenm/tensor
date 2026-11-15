import { Extension } from '@tiptap/core';
import {
  Table as TableBase,
  TableRow as TableRowBase,
  TableCell as TableCellBase,
  TableHeader as TableHeaderBase,
} from '@tiptap/extension-table';
import type { EditorState } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { CellSelection, TableView as ResizableTableView } from '@tiptap/pm/tables';
import { tableFlowAttributes } from '@/lib/editor/ParagraphExtensions';

/**
 * M-TABLES — the table model.
 *
 * The stock @tiptap/extension-table family is the DOCUMENT MODEL layer
 * (schema, commands, clipboard, fixTables normalization) — used as-is
 * via thin `.extend()`s for the Tensor-specific attributes:
 *
 *  - `borderStyle` on the TABLE ('all' | 'none' | 'outer'): the
 *    table-level border preset (Word's Borders control, v1). The
 *    pageless CSS reads the rendered data-table-border marker; the
 *    paginated engine will read the attr straight off the PM node.
 *  - `backgroundColor` on CELL/HEADER: cell shading — not in the box
 *    (the issue's own prediction). Rendered as BOTH an inline style
 *    (pageless display) and a data marker (clipboard round-trip +
 *    stable test hook). External pasted tables carry their inline
 *    background in (plain style parse — a table has no ImageNode-style
 *    media-ref security story that would justify a scoped marker).
 *
 * The `colwidth` attr (per-cell px-width array, written by the built-in
 * columnResizing plugin and by the M-T2 shell drag handles) is stock —
 * no changes needed for resizable tables.
 *
 * Row and cell ids: NO blockId on rows/cells — the paginated adapter
 * turns ONE table into ONE engine TableBlock (one blockId at the table
 * node, minted by BlockIdExtension); rows/cells are positional inside it.
 */

export type TableBorderPreset = 'all' | 'none' | 'outer';

/** M-T4 — one side of a per-side edges attr (null = unset → inherit). */
export type EdgeSide = 'top' | 'right' | 'bottom' | 'left';
export interface BoxEdgesAttrs {
  top: number | null;
  right: number | null;
  bottom: number | null;
  left: number | null;
}

const BORDER_ATTR = 'data-table-border';

/** BoxEdges parse: JSON data marker → the nullable-sides record. */
function edgesFromElement(element: HTMLElement, marker: string): BoxEdgesAttrs | null {
  const raw = element.getAttribute(marker);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<BoxEdgesAttrs>;
    const num = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
    return {
      top: num(parsed.top),
      right: num(parsed.right),
      bottom: num(parsed.bottom),
      left: num(parsed.left),
    };
  } catch {
    return null;
  }
}

/** BoxEdges attr spelling: JSON data marker (the float precedent). */
function edgesAttr(marker: string, attrName: string) {
  return {
    default: null as BoxEdgesAttrs | null,
    parseHTML: (element: HTMLElement) => edgesFromElement(element, marker),
    renderHTML: (attributes: Record<string, unknown>) => {
      const edges = attributes[attrName] as BoxEdgesAttrs | null;
      return edges ? { [marker]: JSON.stringify(edges) } : {};
    },
  };
}

function borderMarker(node: PMNode): string {
  const v = node.attrs.borderStyle;
  return v === 'none' || v === 'outer' ? v : 'all';
}

/**
 * M-TABLES — table NodeView that keeps data-table-border in sync. The
 * resizable table renders through prosemirror-tables' TableView, which
 * re-syncs the colgroup on update but NEVER re-applies node attrs to
 * the <table> element — a borderStyle setNodeMarkup would never reach
 * the pageless DOM. Thin subclass: construction AND every update
 * re-stamp the marker. (The stock non-resizable path applies its
 * HTMLAttributes in a constructor we shadow — re-applied here so either
 * construction path renders the node's attrs.)
 */
class TensorTableView extends ResizableTableView {
  constructor(
    node: PMNode,
    cellMinWidth: number,
    _view?: unknown,
    htmlAttributes?: Record<string, unknown>,
  ) {
    super(node, cellMinWidth);
    if (htmlAttributes) {
      for (const [key, value] of Object.entries(htmlAttributes)) {
        if (value != null) this.table.setAttribute(key, String(value));
      }
    }
    this.table.setAttribute(BORDER_ATTR, borderMarker(node));
    this.applySpacingVars(node);
  }

  update(node: PMNode): boolean {
    const ok = super.update(node);
    if (ok) {
      this.table.setAttribute(BORDER_ATTR, borderMarker(node));
      this.applySpacingVars(node);
    }
    return ok;
  }

  /**
   * M-T4 — the pageless spacing surface: outer margins + the default
   * cell padding as CSS VARS (index.css consumes them with the engine
   * constants as fallbacks — the same per-side resolution the engine
   * performs). The stock TableView never re-applies node attrs on
   * update; the vars ride the same re-stamp as the border marker.
   */
  private applySpacingVars(node: PMNode): void {
    const margin = node.attrs.margin as BoxEdgesAttrs | null;
    for (const side of ['mt', 'mr', 'mb', 'ml'] as const) {
      const attrSide = { mt: 'top', mr: 'right', mb: 'bottom', ml: 'left' }[side] as EdgeSide;
      const v = margin?.[attrSide];
      if (typeof v === 'number' && v > 0) {
        this.table.style.setProperty(`--tensor-table-${side}`, `${v}px`);
      } else {
        this.table.style.removeProperty(`--tensor-table-${side}`);
      }
    }
    const pad = node.attrs.cellPadding as BoxEdgesAttrs | null;
    const fallback = { top: 4, right: 8, bottom: 4, left: 8 };
    const pick = (side: EdgeSide): number =>
      typeof pad?.[side] === 'number' && pad[side]! >= 0 ? pad[side]! : fallback[side];
    this.table.style.setProperty(
      '--tensor-cell-pad',
      `${pick('top')}px ${pick('right')}px ${pick('bottom')}px ${pick('left')}px`,
    );
  }
}

export const TensorTable = TableBase.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      borderStyle: {
        default: 'all',
        parseHTML: (element) => {
          const v = element.getAttribute('data-table-border');
          return v === 'none' || v === 'outer' ? v : 'all';
        },
        renderHTML: (attributes) => ({ [BORDER_ATTR]: attributes.borderStyle }),
      },
      // M-T3c — TABLE FLOW: horizontal placement of the table within
      // the content box (Word's table alignment). The engine's
      // TableBlock.align consumes it (alignOffset over the tracks'
      // total); pageless CSS mirrors it (a fully-fixed-width table
      // is the case where it visibly moves).
      align: {
        default: 'left',
        parseHTML: (element) => {
          const v = element.getAttribute('data-table-align');
          return v === 'center' || v === 'right' ? v : 'left';
        },
        renderHTML: (attributes) => ({
          'data-table-align': attributes.align === 'center' || attributes.align === 'right' ? attributes.align : 'left',
        }),
      },
      // M-T4 — outer margins (t/b/l/r): top/bottom ride the engine's
      // block spacing via the adapter; left/right narrow the engine's
      // table box. Pageless renders them through CSS vars (the view).
      margin: edgesAttr('data-table-margin', 'margin'),
      // M-T4 — default cell padding (per-side; cells override).
      cellPadding: edgesAttr('data-table-cell-padding', 'cellPadding'),
      // M-FLOW — table-level pagination flags (keepLines = keep the
      // whole table on one page when it fits; keepNext/keepPrevious
      // bond the table to a caption/neighbor; forced breaks around
      // it). The engine's TableBlock accepts FlowPolicy directly.
      ...tableFlowAttributes,
    };
  },
}).configure({
  // Built-in columnResizing drag-resize (the pageless surface's
  // colwidth writer) + our border-marker-syncing NodeView.
  resizable: true,
  View: TensorTableView,
});

/**
 * M-T3c — the ROW's minimum height (Word's Row Height "At least"):
 * null = pure content height; a number floors the row at that px.
 * The engine's TableRowData.minHeight consumes it verbatim ("never a
 * MAXIMUM: rows grow" — the engine's documented contract; exact
 * heights are a tracked follow-up). Rendered as a data marker for the
 * clipboard round-trip.
 */
export const TensorTableRow = TableRowBase.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      minHeight: {
        default: null,
        parseHTML: (element) => {
          const v = element.getAttribute('data-row-min-height');
          const n = v == null ? NaN : Number(v);
          return Number.isFinite(n) && n > 0 ? n : null;
        },
        renderHTML: (attributes) =>
          typeof attributes.minHeight === 'number' && attributes.minHeight > 0
            ? { 'data-row-min-height': String(attributes.minHeight) }
            : {},
      },
      // M-FLOW — Word's per-row "Allow row to break across pages",
      // stored under the OOXML w:cantSplit spelling (the DOCX
      // round-trip's name; the PANEL's checkbox label is Word's
      // user-facing inverted phrasing): null = unset = the row MAY
      // split at the cell line grid (Word's AND GDocs' DEFAULT — the
      // engine's per-line-grid banding); true = the row is atomic,
      // it moves wholly when it doesn't fit the page remainder. A
      // monster row (taller than a page) fragments regardless — the
      // engine's "can't keep together what can't fit together".
      cantSplit: {
        default: null,
        parseHTML: (element) => {
          const v = element.getAttribute('data-cant-split');
          if (v === 'true') return true;
          if (v === 'false') return false;
          return null;
        },
        renderHTML: (attributes) =>
          attributes.cantSplit === true || attributes.cantSplit === false
            ? { 'data-cant-split': String(attributes.cantSplit) }
            : {},
      },
    };
  },
});

export const TensorTableCell = TableCellBase.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      backgroundColor: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute('data-cell-background') ??
          (element.style?.backgroundColor || null),
        renderHTML: cellRenderHTML,
      },
      // M-T4 — per-cell padding override; null sides inherit the table
      // default, then the engine constants.
      padding: {
        default: null as BoxEdgesAttrs | null,
        parseHTML: (element) => edgesFromElement(element, 'data-cell-padding'),
        renderHTML: cellRenderHTML,
      },
    };
  },
});

export const TensorTableHeader = TableHeaderBase.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      backgroundColor: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute('data-cell-background') ??
          (element.style?.backgroundColor || null),
        renderHTML: cellRenderHTML,
      },
      // M-T4 — per-cell padding override (the header's own; null sides
      // inherit the table default).
      padding: {
        default: null as BoxEdgesAttrs | null,
        parseHTML: (element) => edgesFromElement(element, 'data-cell-padding'),
        renderHTML: cellRenderHTML,
      },
    };
  },
});

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    tensorTable: {
      /**
       * Set the cell shading for every cell under the selection —
       * cursor-in-cell sets that one cell; a CellSelection sets all
       * selected cells (prosemirror-tables setCellAttr does the
       * dispatch for both shapes). null clears back to transparent.
       */
      setCellBackground: (color: string | null) => ReturnType;
      /** Apply a table-level border preset to the table the selection is in. */
      setTableBorderPreset: (preset: TableBorderPreset) => ReturnType;
      /** Set the table's horizontal placement (left/center/right) within the content box. */
      setTableAlign: (align: 'left' | 'center' | 'right') => ReturnType;
      /** M-T4 — set one side of the table's OUTER margin (null = 0). */
      setTableMargin: (side: EdgeSide, value: number | null) => ReturnType;
      /** M-T4 — set one side of the table's DEFAULT cell padding (null = engine default). */
      setTableCellPadding: (side: EdgeSide, value: number | null) => ReturnType;
      /**
       * M-T4 — set one side of the CURRENT cell(s)' padding override
       * (null = inherit the table default). A CellSelection merges EACH
       * cell's own attr (per-cell state, not one shared value).
       */
      setCellPadding: (side: EdgeSide, value: number | null) => ReturnType;
    };
  }
}

/** The all-unset edges record (the merge base for attr writes). */
function nullEdges(): BoxEdgesAttrs {
  return { top: null, right: null, bottom: null, left: null };
}

/** One side's merged write: clamp positives, null = unset (inherit). */
function mergeEdge(edges: BoxEdgesAttrs, side: EdgeSide, value: number | null): BoxEdgesAttrs {
  const v =
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  return { ...edges, [side]: v };
}

/** True when ANY side carries a value (all-null reads as "never set"). */
function edgesAreSet(edges: BoxEdgesAttrs): boolean {
  return edges.top != null || edges.right != null || edges.bottom != null || edges.left != null;
}

/**
 * M-T4 — the CELL's combined render: the shading marker + the per-cell
 * padding override. The padding renders as SET-SIDE LONGHANDS
 * (`padding-left: 40px`) — an inline longhand beats the stylesheet's
 * table-level `padding: var(--tensor-cell-pad, ...)` for JUST that
 * side, while unset sides keep the table default (the per-side
 * inheritance the engine resolves, mirrored by the CSS cascade).
 */
function cellRenderHTML(attributes: Record<string, unknown>) {
  const bg = attributes.backgroundColor as string | null;
  const pad = attributes.padding as BoxEdgesAttrs | null;
  const styleParts: string[] = [];
  if (bg) styleParts.push(`background-color: ${bg}`);
  if (pad) {
    const sides: [EdgeSide, string][] = [
      ['top', 'padding-top'],
      ['right', 'padding-right'],
      ['bottom', 'padding-bottom'],
      ['left', 'padding-left'],
    ];
    for (const [side, cssProp] of sides) {
      if (typeof pad[side] === 'number' && pad[side]! >= 0) {
        styleParts.push(`${cssProp}: ${pad[side]}px`);
      }
    }
  }
  return {
    ...(bg ? { 'data-cell-background': bg } : {}),
    ...(pad ? { 'data-cell-padding': JSON.stringify(pad) } : {}),
    ...(styleParts.length ? { style: styleParts.join('; ') } : {}),
  };
}

/** The cell node containing the (non-Cell) selection, or null. */
function cellAroundSelection(selection: EditorState['selection']): { node: PMNode; pos: number } | null {
  const { $from } = selection;
  for (let depth = $from.depth; depth >= 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
      return { node, pos: $from.before(depth) };
    }
  }
  return null;
}

/** The nearest table ancestor of the selection, by position. */
export function findTableUnderSelection(state: EditorState): { node: PMNode; pos: number } | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth >= 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === 'table') return { node, pos: $from.before(depth) };
  }
  return null;
}

function cellIsMerged(node: PMNode): boolean {
  return (node.attrs.colspan ?? 1) > 1 || (node.attrs.rowspan ?? 1) > 1;
}

/**
 * True when any cell under the selection is merged (colspan/rowspan > 1)
 * — the floating toolbar's Merge⇄Split toggle reads this to pick which
 * action (and icon) the single button offers.
 */
export function selectionHasMergedCells(state: EditorState): boolean {
  const { selection } = state;
  if (selection instanceof CellSelection) {
    let merged = false;
    selection.forEachCell((node) => {
      if (cellIsMerged(node)) merged = true;
    });
    return merged;
  }
  const { $from } = selection;
  for (let depth = $from.depth; depth >= 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
      return cellIsMerged(node);
    }
  }
  return false;
}

export const TensorTableCommands = Extension.create({
  name: 'tensorTableCommands',

  addCommands() {
    return {
      setCellBackground:
        (color) =>
        ({ chain }) =>
          chain().setCellAttribute('backgroundColor', color).run(),

      setTableBorderPreset:
        (preset) =>
        ({ state, dispatch }) => {
          const table = findTableUnderSelection(state);
          if (!table) return false;
          if (dispatch) {
            dispatch(
              state.tr.setNodeMarkup(table.pos, undefined, { ...table.node.attrs, borderStyle: preset }),
            );
          }
          return true;
        },

      setTableAlign:
        (align) =>
        ({ state, dispatch }) => {
          const table = findTableUnderSelection(state);
          if (!table) return false;
          if (dispatch) {
            dispatch(
              state.tr.setNodeMarkup(table.pos, undefined, { ...table.node.attrs, align }),
            );
          }
          return true;
        },

      setTableMargin:
        (side, value) =>
        ({ state, dispatch }) => {
          const table = findTableUnderSelection(state);
          if (!table) return false;
          if (dispatch) {
            const edges = mergeEdge(
              (table.node.attrs.margin as BoxEdgesAttrs | null) ?? nullEdges(),
              side,
              value
            );
            dispatch(
              state.tr.setNodeMarkup(table.pos, undefined, {
                ...table.node.attrs,
                // All-null edges read as "never set" (absent ≡ unset).
                margin: edgesAreSet(edges) ? edges : null,
              }),
            );
          }
          return true;
        },

      setTableCellPadding:
        (side, value) =>
        ({ state, dispatch }) => {
          const table = findTableUnderSelection(state);
          if (!table) return false;
          if (dispatch) {
            const edges = mergeEdge(
              (table.node.attrs.cellPadding as BoxEdgesAttrs | null) ?? nullEdges(),
              side,
              value
            );
            dispatch(
              state.tr.setNodeMarkup(table.pos, undefined, {
                ...table.node.attrs,
                cellPadding: edgesAreSet(edges) ? edges : null,
              }),
            );
          }
          return true;
        },

      setCellPadding:
        (side, value) =>
        ({ state, dispatch }) => {
          const { selection } = state;
          if (dispatch) {
            const tr = state.tr;
            let touched = false;
            const write = (node: PMNode, pos: number): void => {
              const edges = mergeEdge(
                (node.attrs.padding as BoxEdgesAttrs | null) ?? nullEdges(),
                side,
                value
              );
              tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                padding: edgesAreSet(edges) ? edges : null,
              });
              touched = true;
            };
            if (selection instanceof CellSelection) {
              // Per-CELL merge: every selected cell's own attr (Word's
              // selection semantics — not one shared value).
              selection.forEachCell((node, pos) => write(node, pos));
            } else {
              const cell = cellAroundSelection(selection);
              if (cell) write(cell.node, cell.pos);
            }
            if (!touched) return false;
            dispatch(tr);
          }
          return true;
        },
    };
  },
});

/** The one registration unit — Tensor's table model. */
export const TensorTableKit = [
  TensorTable,
  TensorTableRow,
  TensorTableCell,
  TensorTableHeader,
  TensorTableCommands,
];
