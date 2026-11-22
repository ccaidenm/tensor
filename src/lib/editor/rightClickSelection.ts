import type { Editor } from '@tiptap/core';

/**
 * The right-click selection rule (Word): the menu reads the selection AT
 * THE CLICK — an image under the click wins (NodeSelection); a click
 * inside a selection keeps it; otherwise the caret collapses.
 */
export function applyRightClickSelection(editor: Editor, pos: number | null): void {
  if (pos == null) return;
  const { state } = editor;
  const clamped = Math.min(Math.max(pos, 0), state.doc.content.size);
  // Image first: posAtCoords/hitTest spell an image click as the NODE
  // position, and resolving walks the PARENT — so probe nodeAt, then
  // the ancestor walk for positions genuinely nested inside one.
  const nodeAt = state.doc.nodeAt(clamped);
  if (nodeAt && (nodeAt.type.name === 'image' || nodeAt.type.name === 'inlineImage')) {
    editor.commands.setNodeSelection(clamped);
    return;
  }
  const $pos = state.doc.resolve(clamped);
  for (let depth = $pos.depth; depth >= 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name === 'image' || node.type.name === 'inlineImage') {
      editor.commands.setNodeSelection($pos.before(depth));
      return;
    }
  }
  // Inside the current selection: keep it (any selection shape — a
  // CellSelection spans its cells; a text selection its range).
  const sel = state.selection;
  if (!sel.empty && sel.from <= clamped && clamped <= sel.to) return;
  // Outside: collapse to the click point.
  editor.commands.setTextSelection(clamped);
}
