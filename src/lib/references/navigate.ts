import type { Editor } from '@tiptap/core';

/**
 * Entry navigation, shared by both view modes: the scan's targets are
 * final caret positions, so one selection write + PM's scroll-into-view
 * suffices (paginated routes that scroll to caretFollow).
 */
export function navigateToReferenceTarget(editor: Editor, pos: number): void {
  editor.chain().focus().setTextSelection(pos).scrollIntoView().run();
}
