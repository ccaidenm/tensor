import type { Editor } from '@tiptap/core';
import { convertInlineToBlock } from './wrap';

/**
 * "Add Caption": insert a 'caption' paragraph after the image with
 * keepNext on the image (image + caption's first line share a page),
 * focused immediately. An inline image converts to a block first —
 * an in-flow object can't hold the bond.
 */
export function insertCaptionForImage(editor: Editor): void {
  const readSel = () =>
    editor.state.selection as unknown as {
      node?: { type?: { name?: string }; nodeSize?: number; attrs?: Record<string, unknown> };
      from?: number;
    };
  let selection = readSel();
  // Inline → extract first (the conversion selects the new block; the
  // rest rides the block path).
  if (selection.node?.type?.name === 'inlineImage') {
    convertInlineToBlock(editor);
    selection = readSel();
    if (selection.node?.type?.name !== 'image') return; // conversion refused — bail honestly
  }
  const node = selection.node;
  if (!node || node.type?.name !== 'image' || typeof selection.from !== 'number') return;
  const imagePos = selection.from;
  const after = imagePos + (node.nodeSize ?? 2);

  editor
    .chain()
    .focus()
    // The bond:
    .command(({ tr, dispatch }) => {
      if (dispatch) tr.setNodeAttribute(imagePos, 'keepNext', true);
      return true;
    })
    // The caption paragraph (blockId minted via appendTransaction):
    .insertContentAt(after, { type: 'paragraph', attrs: { styleId: 'caption' } })
    .run();

  // Focus the caption's interior — type right away. The paragraph
  // starts at `after`; its first inside position is after + 1.
  editor.commands.setTextSelection(after + 1);
  editor.view.focus();
}
