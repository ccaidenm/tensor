import type { Node as PMNode } from '@tiptap/pm/model';
import { useDocumentStore } from '@/lib/document/store';
import type { PageSetup } from '@/lib/document/pageSetup';

/**
 * #58 — the PAGE-SETUP co-undo. The store's pageSetup (the FINAL
 * section's props + the doc defaults) lives OUTSIDE ProseMirror, so
 * prosemirror-history can't track it: a page-setup action that writes
 * both the break nodes (PM) and the store would half-undo — the breaks
 * revert while the final section keeps the new values.
 *
 * THE CORRELATION (doc-snapshot law): each entry carries the setup it
 * replaced plus the document BEFORE and AFTER the write. The undo
 * command override fires the co-restore ONLY when the live document
 * equals the entry's post-write snapshot (doc.eq — content equality):
 * the page-setup action is then the NEWEST recorded action, so one
 * Ctrl+Z reverts the PM part and the store part together. The redo
 * fires on the PRE-write snapshot (the state Ctrl+Y starts from). Any
 * later typing buries both (the doc no longer matches) until the
 * interloper is undone/redone — the standard PM ordering, never a
 * corruption.
 *
 * NOT undoable (by design): file-open migrations and test fixtures
 * write the store directly — opening a document must not be undoable.
 */

export interface PageSetupUndoEntry {
  prev: PageSetup;
  docAfter: PMNode;
  docBefore: PMNode;
}

export interface PageSetupRedoEntry {
  next: PageSetup;
  /** The original action's post/pre documents (the redo re-creates the
   *  same states — captured at write time, immune to dispatch timing). */
  docAfter: PMNode;
  docBefore: PMNode;
}

const undoStack: PageSetupUndoEntry[] = [];
const redoStack: PageSetupRedoEntry[] = [];

/** The store write's undo push (call AFTER the PM tr dispatches —
 *  `docAfter` must be the post-write document; `docBefore` the pre-write
 *  one. `null` docs skip the push, which makes the write non-undoable:
 *  file-open migrations, test fixtures). Clears the redo stack — a new
 *  write invalidates it (the standard rule). */
export function pushPageSetupUndo(
  prev: PageSetup,
  docAfter: PMNode | null,
  docBefore: PMNode | null,
): void {
  if (!docAfter || !docBefore) return;
  undoStack.push({ prev, docAfter, docBefore });
  redoStack.length = 0;
}

export function peekPageSetupUndo(): PageSetupUndoEntry | undefined {
  return undoStack[undoStack.length - 1];
}

export function popPageSetupUndo(): PageSetupUndoEntry | undefined {
  return undoStack.pop();
}

export function pushPageSetupRedo(entry: PageSetupRedoEntry): void {
  redoStack.push(entry);
}

export function peekPageSetupRedo(): PageSetupRedoEntry | undefined {
  return redoStack[redoStack.length - 1];
}

export function popPageSetupRedo(): PageSetupRedoEntry | undefined {
  return redoStack.pop();
}

export function currentPageSetup(): PageSetup {
  return useDocumentStore.getState().pageSetup;
}

export function restorePageSetup(setup: PageSetup): void {
  useDocumentStore.getState().setPageSetup(setup);
}
