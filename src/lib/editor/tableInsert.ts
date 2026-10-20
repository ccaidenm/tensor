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
