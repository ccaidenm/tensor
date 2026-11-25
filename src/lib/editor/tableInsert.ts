import type { Editor } from '@tiptap/core';

/**
 * The ONE table-insert entry: TipTap's insertTable nests inside a cell,
 * but Tensor's v1 cells are paragraphs-only (a nested table would throw
 * the adapter's sentinel) — exit the table first, insert after it.
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

/** The dimensions cap for typed table specs — the palette is the
 *  SCALING surface (the grid picker's 8×8 is a hover surface);
 *  99 is the sane engine bound. */
export const TABLE_DIM_CAP = 99;

/**
 * The palette's typed table spec: "4x4" (also "4 x 4", "4×4",
 * "table 4x4", "4x4 table" — case-insensitive) → {rows: 4, cols: 4}.
 * null = not a table spec. Dimensions clamp to [1, TABLE_DIM_CAP].
 */
export function parseTableDims(query: string): { rows: number; cols: number } | null {
  const m = query.match(/^\s*(?:table\s+)?(\d{1,3})\s*[x×]\s*(\d{1,3})(?:\s+table)?\s*$/i);
  if (!m) return null;
  const clamp = (v: string) => Math.min(TABLE_DIM_CAP, Math.max(1, Number(v)));
  return { rows: clamp(m[1]!), cols: clamp(m[2]!) };
}
