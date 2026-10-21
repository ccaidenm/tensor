import type { Editor } from '@tiptap/core';

/**
 * M-T4 — THE right-click selection rule (Word): the context menu reads
 * the selection AT THE CLICK, not wherever the caret happened to be.
 * One spelling shared by BOTH surfaces:
 *
 *  - an IMAGE (either shape) under the click wins — NodeSelection on it
 *    (the image variant's subject);
 *  - a click INSIDE a non-empty selection KEEPS it (the menu reads what
 *    you selected — cut/copy's subject);
 *  - otherwise the caret COLLAPSES to the click point — right-clicks
 *    never expand (the click-count word/paragraph logic is
 *    left-click-only, the M-T4 polish ruling).
 *
 * The PAGINATED surface feeds the click's hitTest position; PAGELESS
 * feeds view.posAtCoords — the rule itself never forks.
 */
export function applyRightClickSelection(editor: Editor, pos: number | null): void {
  if (pos == null) return;
  const { state } = editor;
  const clamped = Math.min(Math.max(pos, 0), state.doc.content.size);
  // Image first: a click on an image node (either shape) selects it.
  // posAtCoords/hitTest spell an image click as the NODE position, and
  // resolving it walks the PARENT (the image is a sibling boundary, not
  // an ancestor) — so probe nodeAt, then the ancestor walk for any
  // position genuinely nested inside one (a span-wrapped inline case).
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
