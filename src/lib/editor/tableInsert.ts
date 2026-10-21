import type { Editor } from '@tiptap/core';

/**
 * M-TABLES — the ONE table-insert entry (grid picker, dialog, palette
 * converge here). TipTap's insertTable nests when the caret is inside
 * a cell (the official behavior); Tensor's v1 cell model is
 * paragraphs-only (a nested table would throw the adapter's sentinel
 * and fall back to pageless) — so an insert INSIDE a table exits the
 * table first and places the new one after it.
 */
export function insertTableAtSelection(
  editor: Editor,
  dims: { rows: number; cols: number; withHeaderRow: boolean },
): void {
  const $pos = editor.state.selection.$from;
  for (let d = $pos.depth; d >= 0; d--) {
    if ($pos.node(d).type.name === 'table') {
      // Just after the containing table node: a doc-level position
      // between blocks — the new table's home.
      editor
        .chain()
        .focus()
        .setTextSelection($pos.after(d))
        .insertTable(dims)
        .run();
      return;
    }
  }
  editor.chain().focus().insertTable(dims).run();
}

/** The dimensions cap for typed table specs — the grid picker's 8×8
 *  grid is a HOVER surface; the palette is the SCALING surface (the
 *  user's "4x4 creates a 4 by 4 table... greater scaling beyond the
 *  dropdown" spec). 99 is the sane engine bound. */
export const TABLE_DIM_CAP = 99;

/**
 * M-T3b — the command palette's typed table spec: "4x4" (also "4 x 4",
 * "4×4", "table 4x4", "4x4 table" — case-insensitive) parses to
 * {rows: 4, cols: 4}. null = not a table spec (the palette renders
 * its normal command list). Dimensions clamp to [1, TABLE_DIM_CAP].
 */
export function parseTableDims(query: string): { rows: number; cols: number } | null {
  const m = query.match(/^\s*(?:table\s+)?(\d{1,3})\s*[x×]\s*(\d{1,3})(?:\s+table)?\s*$/i);
  if (!m) return null;
  const clamp = (v: string) => Math.min(TABLE_DIM_CAP, Math.max(1, Number(v)));
  return { rows: clamp(m[1]!), cols: clamp(m[2]!) };
}
