import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { nanoid } from 'nanoid';
import { useSidebarStore } from '@/lib/layout/sidebarStore';
import { useSearchStore } from '@/lib/editor/search/store';
import { useLinkEditorStore } from '@/lib/editor/linkEditorStore';
import { stepFontSize } from '@/lib/editor/fontSize';
import { useDocumentStore } from '@/lib/document/store';
import { selectionInBand } from '@/lib/editor/headerFooterCommands';
import { useCommentStore } from '@/lib/comments/store';
import { toast } from '@/components/ui/toast';

/**
 * The single editor-command path. Consumed by BOTH keydown surfaces —
 * ShortcutsExtension's ProseMirror plugin (typing the binding) and the
 * command palette (run by id) — so neither re-implements an editor
 * command. A command missing from this map simply doesn't fire.
 */
export const EDITOR_COMMAND_MAP: Record<string, (editor: Editor) => boolean> = {
  bold: (editor) => editor.commands.toggleBold(),
  italic: (editor) => editor.commands.toggleItalic(),
  underline: (editor) => editor.commands.toggleUnderline(),
  strike: (editor) => editor.commands.toggleStrike(),
  insertPageBreak: (editor) => editor.commands.insertPageBreak(),
  // #58 SECTIONS: the split-dance insert (the break seeds the store's
  // pageSetup — nothing changes visually until the dialog edits props).
  insertSectionBreak: (editor) => editor.commands.insertSectionBreak(),
  // #74 COLUMNS: the manual column break (the page break's twin — the
  // split-dance insert; the adapter stamps the following block).
  insertColumnBreak: (editor) => editor.commands.insertColumnBreak(),
  // M-EQ: inserts an empty display equation and NodeSelections it —
  // the selection opens the editor bubble (useEquationEditor).
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
  // ±2pt in chrome space, committed as px (fontSize.ts law).
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
  // #COMMENTS — THE ONE COMMENT BODY: the floating toolbar, Ctrl+Alt+M,
  // and the palette all land here (the ShortcutsExtension + registry
  // dispatch through this map; nothing re-implements a piece of it).
  // Guards: a non-empty TEXT selection (a caret is a no-op — the
  // toolbar disables itself in sync); an image NodeSelection is refused
  // (non-text anchors are out of scope — the image strip keeps its own
  // stub disabled); headers/footers are refused with a TOAST (the
  // referenceTable band precedent — bands are separate editor
  // instances, and a loud no beats a silent half-anchored comment).
  // THE WRITE-ORDER LAW: startDraft (store record) BEFORE setMark —
  // the tracking plugin's janitor must never observe a mark whose
  // thread is not yet in the store. The mark is inclusive, so the
  // anchor rides PM from here (edges extend it; deleting the range
  // orphans the thread — the defined states).
  addComment: (editor) => {
    const { selection } = editor.state;
    if (selection.empty) return false;
    if (selection instanceof NodeSelection) return false;
    if (selectionInBand(editor)) {
      toast.add({
        title: 'Comments are not available here',
        description: 'Headers and footers cannot carry comments yet.',
        type: 'warning',
      });
      return true;
    }
    const threadId = nanoid();
    useCommentStore.getState().startDraft(threadId);
    return editor.commands.setComment(threadId);
  },

  // Style application (built-in paragraph styles) — no keybinding, but
  // palette-invoked, so they live on the SAME dispatch path rather than
  // a second mechanism. Ids are the styles registry's builtin ids
  // (builtins.ts); applying is the styleCommands law: sets styleId or
  // converts the node for heading entries / back for the rest.
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
