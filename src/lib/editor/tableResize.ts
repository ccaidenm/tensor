import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TableMap } from '@tiptap/pm/tables';
import { CELL_MIN_TRACK } from '@tensor-editor/engine';

/**
 * M-TABLES — the paginated surface's column resize: ONE transaction
 * writing the dragged column's new width into EVERY cell covering it
 * (the engine's track derivation THROWS on per-column conflicts — the
 * column cells must move together; this is the same invariant
 * prosemirror-tables' own columnResizing plugin keeps in the DOM).
 *
 * The colwidth array is SPARSE by spanned-column position: entry j
 * names the j-th spanned column (null = flexible — the engine's
 * remaining-width share).
 */
export function setColumnWidth(editor: Editor, tablePos: number, col: number, width: number): boolean {
  const table: PMNode | null = editor.state.doc.nodeAt(tablePos);
  if (!table || table.type.name !== 'table') return false;
  const tr = editor.state.tr;
  const w = Math.max(CELL_MIN_TRACK, Math.round(width));
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
