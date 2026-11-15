import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TableMap } from '@tiptap/pm/tables';
import { CELL_MIN_TRACK } from '@tensor-editor/engine';

/**
 * M-TABLES — the table attr writers (the paginated drag handles AND the
 * M-T3c side panel both dispatch through here — one writer family, no
 * forks). Column widths ride the stock `colwidth` cell attr; row
 * minimums ride the M-T3c `minHeight` row attr.
 *
 * The colwidth array is SPARSE by spanned-column position: entry j
 * names the j-th spanned column (null = flexible — the engine's
 * remaining-width share). ONE transaction writes the whole column —
 * the engine's track derivation THROWS on per-column conflicts, so
 * the column cells must move together (the same invariant
 * prosemirror-tables' own columnResizing plugin keeps in the DOM).
 */
export function setColumnWidth(editor: Editor, tablePos: number, col: number, width: number | null): boolean {
  const table: PMNode | null = editor.state.doc.nodeAt(tablePos);
  if (!table || table.type.name !== 'table') return false;
  const tr = editor.state.tr;
  const w = width == null ? null : Math.max(CELL_MIN_TRACK, Math.round(width));
  let changed = false;
  editor.state.doc.nodesBetween(tablePos + 1, tablePos + table.nodeSize, (node, pos) => {
    if (node.type.name !== 'tableCell' && node.type.name !== 'tableHeader') return true;
    // The cell's grid box: the offset relative to the table's CONTENT
    // start (TableMap's coordinate frame) = cellPos − (tablePos + 1).
    const box = TableMap.get(table).findCell(pos - tablePos - 1);
    if (!(box.left <= col && col < box.right)) return true;
    const cw = (node.attrs.colwidth as (number | null)[] | null) ?? [];
    const next: (number | null)[] = [...cw];
    while (next.length < (node.attrs.colspan as number)) next.push(null);
    if (next[col - box.left] === w) return false;
    next[col - box.left] = w;
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, colwidth: next });
    changed = true;
    return false; // cells have no nested cells
  });
  if (changed) editor.view.dispatch(tr);
  return changed;
}

/**
 * M-T3c — "Distribute evenly": clears EVERY cell's colwidth. All
 * columns become flexible → the engine's equal-share derivation lays
 * them out identically wide (the true "evenly" in the flexible model).
 */
export function clearAllColumnWidths(editor: Editor, tablePos: number): boolean {
  const table: PMNode | null = editor.state.doc.nodeAt(tablePos);
  if (!table || table.type.name !== 'table') return false;
  const tr = editor.state.tr;
  let changed = false;
  editor.state.doc.nodesBetween(tablePos + 1, tablePos + table.nodeSize, (node, pos) => {
    if (node.type.name !== 'tableCell' && node.type.name !== 'tableHeader') return true;
    if (node.attrs.colwidth == null) return true;
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, colwidth: null });
    changed = true;
    return true;
  });
  if (changed) editor.view.dispatch(tr);
  return changed;
}

/**
 * M-T4 — the FIXED-NEIGHBOR probe: the column's fixed width (the first
 * covering cell's colwidth entry), or null when the column is
 * FLEXIBLE. Mirrors the engine's per-column derivation (it takes the
 * first non-null; conflicts throw — so "any" === "all" in a consistent
 * doc).
 */
function columnFixedWidth(editor: Editor, table: PMNode, tablePos: number, col: number): number | null {
  let fixed: number | null = null;
  editor.state.doc.nodesBetween(tablePos + 1, tablePos + table.nodeSize, (node, pos) => {
    if (fixed != null) return false;
    if (node.type.name !== 'tableCell' && node.type.name !== 'tableHeader') return true;
    const box = TableMap.get(table).findCell(pos - tablePos - 1);
    if (box.left <= col && col < box.right) {
      const entry = (node.attrs.colwidth as (number | null)[] | null)?.[col - box.left] ?? null;
      if (typeof entry === 'number' && entry > 0) fixed = entry;
    }
    return true;
  });
  return fixed;
}

/**
 * M-T4 — the INTERIOR boundary drag, Word semantics: the dragged
 * column takes the new width and its RIGHT NEIGHBOR pays the delta —
 * the table's total width NEVER changes from an interior drag. A
 * flexible neighbor absorbs automatically (plain setColumnWidth); a
 * FIXED neighbor is written too, clamped at the track floor (the drag
 * then stops short — the neighbor can't pay more than it has).
 */
export function setColumnWidthWord(
  editor: Editor,
  tablePos: number,
  col: number,
  newWidth: number,
  oldWidth: number,
): boolean {
  const table: PMNode | null = editor.state.doc.nodeAt(tablePos);
  if (!table || table.type.name !== 'table') return false;
  const colCount = TableMap.get(table).width;
  // The rightmost column has no neighbor — degenerates to the plain
  // write (the rightmost EDGE routes through setTableTracks instead).
  if (col + 1 >= colCount) return setColumnWidth(editor, tablePos, col, newWidth);
  const neighborFixed = columnFixedWidth(editor, table, tablePos, col + 1);
  if (neighborFixed == null) return setColumnWidth(editor, tablePos, col, newWidth);
  // The neighbor pays; the floor clamp eats back into the drag.
  const delta = newWidth - oldWidth;
  const neighborNew = Math.max(CELL_MIN_TRACK, neighborFixed - delta);
  const draggedNew = oldWidth + (neighborFixed - neighborNew);
  const tr = editor.state.tr;
  let changed = false;
  editor.state.doc.nodesBetween(tablePos + 1, tablePos + table.nodeSize, (node, pos) => {
    if (node.type.name !== 'tableCell' && node.type.name !== 'tableHeader') return true;
    const box = TableMap.get(table).findCell(pos - tablePos - 1);
    const target =
      box.left <= col && col < box.right ? col : box.left <= col + 1 && col + 1 < box.right ? col + 1 : null;
    if (target == null) return true;
    const w = target === col ? draggedNew : neighborNew;
    const cw = (node.attrs.colwidth as (number | null)[] | null) ?? [];
    const next: (number | null)[] = [...cw];
    while (next.length < (node.attrs.colspan as number)) next.push(null);
    if (next[target - box.left] === w) return false;
    next[target - box.left] = w;
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, colwidth: next });
    changed = true;
    return false;
  });
  if (changed) editor.view.dispatch(tr);
  return changed;
}

/**
 * M-T4 — the RIGHT-BORDER drag: the table's outermost right edge is
 * the TABLE border, not a column boundary — dragging it scales EVERY
 * track proportionally (the previous behavior set only the last
 * column's width, and the still-flexible columns re-inflated to fill
 * the content box: the "backwards spacing" bug — the table could never
 * shrink). Every column becomes fixed; the caller clamps the new
 * total to [cols × CELL_MIN_TRACK, the table box].
 */
export function setTableTracks(editor: Editor, tablePos: number, widths: number[]): boolean {
  const table: PMNode | null = editor.state.doc.nodeAt(tablePos);
  if (!table || table.type.name !== 'table') return false;
  const tr = editor.state.tr;
  let changed = false;
  editor.state.doc.nodesBetween(tablePos + 1, tablePos + table.nodeSize, (node, pos) => {
    if (node.type.name !== 'tableCell' && node.type.name !== 'tableHeader') return true;
    const box = TableMap.get(table).findCell(pos - tablePos - 1);
    const cw = (node.attrs.colwidth as (number | null)[] | null) ?? [];
    const next: (number | null)[] = [...cw];
    while (next.length < (node.attrs.colspan as number)) next.push(null);
    let cellChanged = false;
    for (let c = box.left; c < box.right; c++) {
      const w = Math.max(CELL_MIN_TRACK, Math.round(widths[c] ?? 0));
      if (next[c - box.left] !== w) {
        next[c - box.left] = w;
        cellChanged = true;
      }
    }
    if (cellChanged) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, colwidth: next });
      changed = true;
    }
    return false; // cells have no nested cells
  });
  if (changed) editor.view.dispatch(tr);
  return changed;
}

/**
 * M-T3c — the row's minimum height (Word's Row Height "at least"):
 * null = auto (pure content height); a positive number floors the row.
 * ONE transaction per commit.
 */
export function setRowMinHeight(editor: Editor, tablePos: number, rowIndex: number, height: number | null): boolean {
  const table: PMNode | null = editor.state.doc.nodeAt(tablePos);
  if (!table || table.type.name !== 'table') return false;
  const row = table.maybeChild(rowIndex);
  if (!row) return false;
  // The row node's position: the table's open + the preceding rows'
  // sizes (a manual cursor — PM forEach offsets are content-relative).
  let rowPos = tablePos + 1;
  for (let i = 0; i < rowIndex; i++) rowPos += table.child(i)!.nodeSize;
  const min = height != null && Number.isFinite(height) && height > 0 ? Math.round(height) : null;
  if ((row.attrs.minHeight ?? null) === min) return false;
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(rowPos, undefined, { ...row.attrs, minHeight: min }),
  );
  return true;
}

/**
 * M-FLOW — the row's split control (Word's "Allow row to break across
 * pages" checkbox, stored under the OOXML w:cantSplit spelling):
 * null = unset = the row MAY split at the cell line grid (Word's AND
 * GDocs' default); true = atomic (moves wholly). The MODEL is binary
 * null|true — a write of `false` normalizes to null (they layout
 * identically; the parseHTML side still tolerates a literal false
 * from hand-written HTML). ONE transaction per commit.
 */
export function setRowCantSplit(
  editor: Editor,
  tablePos: number,
  rowIndex: number,
  cantSplit: boolean | null
): boolean {
  const table: PMNode | null = editor.state.doc.nodeAt(tablePos);
  if (!table || table.type.name !== 'table') return false;
  const row = table.maybeChild(rowIndex);
  if (!row) return false;
  let rowPos = tablePos + 1;
  for (let i = 0; i < rowIndex; i++) rowPos += table.child(i)!.nodeSize;
  const next = cantSplit === true ? true : null;
  if ((row.attrs.cantSplit ?? null) === next) return false;
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(rowPos, undefined, { ...row.attrs, cantSplit: next }),
  );
  return true;
}
