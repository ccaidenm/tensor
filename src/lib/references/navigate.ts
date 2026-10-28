import type { Editor } from '@tiptap/core';

/**
 * M-REFS — entry navigation, the ONE click path shared by both view
 * modes. The scan's targets are FINAL caret positions (block interiors
 * resolved pos+1 at scan time), so navigation is a single selection
 * write + PM's own scroll-into-view intent:
 *
 *  - PAGELESS: PM scrolls the real DOM natively.
 *  - PAGINATED: ScrollGuardExtension routes PM's scrollToSelection to
 *    the caretFollow machinery (minimal-edge scroll) — the same path
 *    every caret motion takes. Zero new scroll code, by construction.
 */
export function navigateToReferenceTarget(editor: Editor, pos: number): void {
  editor.chain().focus().setTextSelection(pos).scrollIntoView().run();
}
