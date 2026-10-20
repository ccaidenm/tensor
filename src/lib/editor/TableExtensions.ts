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

const BORDER_ATTR = 'data-table-border';

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
  }

  update(node: PMNode): boolean {
    const ok = super.update(node);
    if (ok) this.table.setAttribute(BORDER_ATTR, borderMarker(node));
    return ok;
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
    };
  },
}).configure({
  // Built-in columnResizing drag-resize (the pageless surface's
  // colwidth writer) + our border-marker-syncing NodeView.
  resizable: true,
  View: TensorTableView,
});

export const TensorTableRow = TableRowBase;

export const TensorTableCell = TableCellBase.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      backgroundColor: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute('data-cell-background') ??
          (element.style?.backgroundColor || null),
        renderHTML: (attributes) =>
          attributes.backgroundColor
            ? {
                'data-cell-background': attributes.backgroundColor,
                style: `background-color: ${attributes.backgroundColor}`,
              }
            : {},
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
        renderHTML: (attributes) =>
          attributes.backgroundColor
            ? {
                'data-cell-background': attributes.backgroundColor,
                style: `background-color: ${attributes.backgroundColor}`,
              }
            : {},
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
    };
  }
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
