import type { Editor } from '@tiptap/core';
import { convertInlineToBlock } from './wrap';

/**
 * M-IMAGES-1 — the caption bond: "Add Caption" inserts a paragraph
 * with styleId 'caption' (the built-in, editable like all built-ins —
 * the ToF #31 hook reads captions regardless of the display toggle)
 * directly after the selected image, and sets keepNext ON THE IMAGE —
 * the E-IMG-1 bond spelling (FlowPolicy.keepNext: the image's
 * placement and the caption's first line share a page, engine-pinned;
 * the shell never re-implements the bond, only writes the flag).
 * The new paragraph is focused immediately — type right away (Word
 * behavior).
 *
 * M-IMAGES-2.1 — the INLINE policy (extract-then-caption): a caption
 * bonds a BLOCK image to the paragraph BELOW it; an in-flow object
 * cannot hold the bond (the adapter refuses float+keepNext's shape —
 * the loud-validation seam). So an inline selection first runs the
 * EXACT conversion the Wrap menu uses (convertInlineToBlock — which
 * selects the new block node), then the block path proceeds
 * unchanged. One policy, one conversion primitive, no forks.
 */
export function insertCaptionForImage(editor: Editor): void {
  const readSel = () =>
    editor.state.selection as unknown as {
      node?: { type?: { name?: string }; nodeSize?: number; attrs?: Record<string, unknown> };
      from?: number;
    };
  let selection = readSel();
  // INLINE → EXTRACT first (the new block image is selected by the
  // conversion; everything below then rides the block path).
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
    // The bond (the model fact):
    .command(({ tr, dispatch }) => {
      if (dispatch) tr.setNodeAttribute(imagePos, 'keepNext', true);
      return true;
    })
    // The caption paragraph (BlockIdExtension mints its blockId via
    // appendTransaction — styleId 'caption' is the style identity):
    .insertContentAt(after, { type: 'paragraph', attrs: { styleId: 'caption' } })
    .run();

  // Focus the caption's interior — type right away. The paragraph
  // starts at `after`; its first inside position is after + 1.
  editor.commands.setTextSelection(after + 1);
  editor.view.focus();
}
