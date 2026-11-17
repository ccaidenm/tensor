import type { Node as PMNode } from '@tiptap/pm/model';
import { useDocumentStore } from '@/lib/document/store';
import type { PageSetup } from '@/lib/document/pageSetup';
import type { PageStyles } from '@/lib/document/pageSetup';

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
 * equals the entry's post-write snapshot (doc.eq — content equality)
 * AND the plugin's pending law says our item is the one PM's next
 * undo/redo would move; the redo mirrors on the pre-write snapshot.
 * Any later typing buries both (a foreign recorded transaction also
 * EMPTIES PM's redo stack — the coincidence guard: a net-zero edit
 * cycle like bold+unbold can return the doc to a snapshot without our
 * item being next, and the emptied redo stack is what refuses it).
 *
 * NOT undoable (by design): file-open migrations and test fixtures
 * write the store directly — opening a document must not be undoable.
 */

/** The marker on OUR page-setup transactions (the history-joined ones;
 *  the ruler's preview frames stay out entirely). */
export const PAGE_SETUP_MARKER = 'pageSetupOurs';

/**
 * #48 — the SYNTHETIC pending transitions. A STORE-ONLY write (a page
 * style; a doc-scope change on an unsectioned doc) dispatches a
 * marker-only EMPTY tr: PM history records nothing (no steps), so
 * pmUndo/pmRedo dispatch NOTHING for it and the pending state would
 * never flip — undo worked once, redo was dead (a pre-existing gap
 * the store-only per-page writes make load-bearing). The ours-branches
 * dispatch these marker metas after the restore; the plugin treats
 * them as the history movement they stand in for. Idempotent for
 * doc-touching actions (their real history tr already flipped the
 * state; the case arms return the same value on re-application).
 */
export const PAGE_SETUP_SYNTH_UNDO = 'pageSetupSyntheticUndo';
export const PAGE_SETUP_SYNTH_REDO = 'pageSetupSyntheticRedo';

export type PageSetupPending = 'undo' | 'redo' | null;

/** The plugin's state: which stack side holds our newest item, and
 *  whether PM's redo stack is non-empty (the coincidence guard). */
export interface PageSetupPendingState {
  pending: PageSetupPending;
  redoNonEmpty: boolean;
}

/** The pending-state transitions (pure — the plugin's apply). */
export function nextPending(pending: PageSetupPending, event: 'ours' | 'foreign-recorded' | 'history-undo' | 'history-redo'): PageSetupPending {
  switch (event) {
    case 'ours':
      return 'undo';
    case 'foreign-recorded':
      return null;
    case 'history-undo':
      // Our item moves done->redo; a foreign undo pops the done-top
      // (not ours when pending is 'redo').
      return pending === 'undo' ? 'redo' : pending;
    case 'history-redo':
      // Our item moves redo->done; a foreign redo pops the redo-top
      // (not ours when pending is 'undo').
      return pending === 'redo' ? 'undo' : pending;
  }
}

export interface PageSetupUndoEntry {
  prev: PageSetup;
  docAfter: PMNode;
  docBefore: PMNode;
  /**
   * #48 — the pageStyles the action replaced. undefined = the action
   * never touched the map (a plain setup write): the co-restore leaves
   * pageStyles alone. Present = one Ctrl+Z reverts the setup AND the
   * map together (the never-half law, extended).
   */
  prevPageStyles?: PageStyles;
}

export interface PageSetupRedoEntry {
  next: PageSetup;
  /** #48 — the map the redo restores (captured at undo time). */
  nextPageStyles?: PageStyles;
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
  prevPageStyles?: PageStyles,
): void {
  if (!docAfter || !docBefore) return;
  undoStack.push({ prev, docAfter, docBefore, prevPageStyles });
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

/** #48 — the live map, for the redo entries' nextPageStyles capture. */
export function currentPageStyles(): PageStyles {
  return useDocumentStore.getState().pageStyles;
}

/** The co-restore. `pageStyles` undefined = the action never touched
 * the map — leave it standing (the never-half law). */
export function restorePageSetup(setup: PageSetup, pageStyles?: PageStyles): void {
  const store = useDocumentStore.getState();
  store.setPageSetup(setup);
  if (pageStyles !== undefined) store.setPageStyles(pageStyles);
}
