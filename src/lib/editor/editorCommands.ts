import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { nanoid } from 'nanoid';
import { useSidebarStore } from '@/lib/layout/sidebarStore';
import { useSearchStore } from '@/lib/editor/search/store';
import { useLinkEditorStore } from '@/lib/editor/linkEditorStore';
import { stepFontSize } from '@/lib/editor/fontSize';
import { useDocumentStore } from '@/lib/document/store';
import { selectionInBand } from '@/lib/editor/headerFooterCommands';
import { wordAround } from '@/lib/editor/CommentExtension';
import { useCommentStore } from '@/lib/comments/store';
import { toast } from '@/components/ui/toast';

/**
 * The single editor-command path, shared by the keybinding plugin and
 * the command palette (run by id) so neither re-implements a command.
 */
export const EDITOR_COMMAND_MAP: Record<string, (editor: Editor) => boolean> = {
  bold: (editor) => editor.commands.toggleBold(),
  italic: (editor) => editor.commands.toggleItalic(),
  underline: (editor) => editor.commands.toggleUnderline(),
  strike: (editor) => editor.commands.toggleStrike(),
  insertPageBreak: (editor) => editor.commands.insertPageBreak(),
  // #58 — the break seeds the store's pageSetup; nothing changes until the dialog edits props.
  insertSectionBreak: (editor) => editor.commands.insertSectionBreak(),
  // #74 — the manual column break; the adapter stamps the following block.
  insertColumnBreak: (editor) => editor.commands.insertColumnBreak(),
  // NodeSelection on the inserted equation opens the editor bubble.
  insertEquation: (editor) => editor.commands.insertEquation(),
  alignLeft: (editor) => editor.commands.setTextAlign('left'),
  alignCenter: (editor) => editor.commands.setTextAlign('center'),
  alignRight: (editor) => editor.commands.setTextAlign('right'),
  alignJustify: (editor) => editor.commands.setTextAlign('justify'),
  unorderedList: (editor) => editor.commands.toggleBulletList(),
  orderedList: (editor) => editor.commands.toggleOrderedList(),
  increaseIndent: (editor) => editor.commands.increaseIndent(),
  decreaseIndent: (editor) => editor.commands.decreaseIndent(),
  clearFormatting: (editor) => editor.commands.clearFormatting(),
  // ±2pt in chrome space, committed as px (see fontSize.ts).
  fontSizeUp: (editor) => stepFontSize(editor, 1),
  fontSizeDown: (editor) => stepFontSize(editor, -1),
  find: () => {
    const sidebarActive = useSidebarStore.getState().active?.id === 'search';
    if (sidebarActive) {
      useSearchStore.getState().bumpFocus();
    } else {
      useSearchStore.getState().open();
    }
    return true;
  },
  insertLink: () => {
    useLinkEditorStore.getState().requestInsert();
    return true;
  },
  // All comment surfaces dispatch here. Node selections are refused;
  // bands are refused with a toast (separate editor instances). A bare
  // caret anchors the word it sits in — selected and anchored in ONE
  // chained transaction; a caret in no word toasts the guidance.
  addComment: (editor) => {
    const { selection } = editor.state;
    if (selection instanceof NodeSelection) return false;
    if (selectionInBand(editor)) {
      toast.add({
        title: 'Comments are not available here',
        description: 'Headers and footers cannot carry comments yet.',
        type: 'warning',
      });
      return true;
    }
    // Resolve the word BEFORE creating anything — a caret in no word
    // toasts the guidance and writes nothing at all.
    if (selection.empty) {
      const word = wordAround(editor.state.doc, selection.from);
      if (!word) {
        toast.add({
          title: 'Nothing to comment on',
          description: 'Place the cursor in a word, or select some text, then add a comment.',
          type: 'info',
        });
        return true;
      }
      const threadId = nanoid();
      // startDraft BEFORE setMark: the store record must exist before
      // any mark lands (the janitor strips unknown threadIds).
      useCommentStore.getState().startDraft(threadId);
      // setComment reads tr.selection, so the chained range is anchored.
      return editor.chain().setTextSelection(word).setComment(threadId).run();
    }
    const threadId = nanoid();
    useCommentStore.getState().startDraft(threadId);
    return editor.commands.setComment(threadId);
  },

  // Style application — palette-invoked (no keybinding), same dispatch
  // path. Applying sets styleId, or converts the node for heading
  // entries and back for the rest.
  applyStyleNormal: (editor) => editor.chain().focus().applyParagraphStyle('normal').run(),
  applyStyleHeading1: (editor) => editor.chain().focus().applyParagraphStyle('heading-1').run(),
  applyStyleHeading2: (editor) => editor.chain().focus().applyParagraphStyle('heading-2').run(),
  applyStyleHeading3: (editor) => editor.chain().focus().applyParagraphStyle('heading-3').run(),
  applyStyleQuote: (editor) => editor.chain().focus().applyParagraphStyle('quote').run(),
};

/** Run an editor command by id against the live editor instance
 *  (from the document store). Returns the command's own handled flag,
 *  or false when there is no editor / no such command. */
export function runEditorCommand(id: string): boolean {
  const editor = useDocumentStore.getState().editor;
  if (!editor) return false;
  const handler = EDITOR_COMMAND_MAP[id];
  if (!handler) return false;
  return handler(editor);
}
