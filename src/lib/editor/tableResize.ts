import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TableMap } from '@tiptap/pm/tables';
import { CELL_MIN_TRACK } from '@tensor-editor/engine';

/**
 * The table attr writers (drag handles AND the side panel). The colwidth
 * array is SPARSE by spanned position (null = flexible); ONE transaction
 * writes the whole column — the engine THROWS on per-column conflicts.
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
 * "Distribute evenly": clears EVERY cell's colwidth — all columns
 * flexible, the engine's equal-share derivation lays them out
 * identically wide.
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
 * The column's fixed width (the first covering cell's colwidth entry),
 * or null when FLEXIBLE — mirrors the engine's per-column derivation
 * (it takes the first non-null; conflicts throw).
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
 * The interior boundary drag, Word semantics: the right NEIGHBOR pays
 * the delta (total width never changes); a fixed neighbor is clamped
 * at the track floor.
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
 * The RIGHT-BORDER drag: the outer right edge is the TABLE border —
 * dragging it scales EVERY track proportionally (all become fixed).
 * The caller clamps the total to [cols × CELL_MIN_TRACK, the table box].
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
 * The row's minimum height ("at least"): null = auto; a positive
 * number floors the row. ONE transaction per commit.
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
 * The row's split control ("Allow row to break across pages"): null =
 * the row MAY split (default); true = atomic. The MODEL is binary —
 * `false` normalizes to null (parseHTML still tolerates a literal false).
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
