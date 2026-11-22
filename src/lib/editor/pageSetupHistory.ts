import type { Node as PMNode } from '@tiptap/pm/model';
import { useDocumentStore } from '@/lib/document/store';
import type { PageSetup } from '@/lib/document/pageSetup';
import type { PageStyles } from '@/lib/document/pageSetup';

/**
 * #58 — the page-setup co-undo: pageSetup lives outside prosemirror-
 * history. The co-restore fires only when the live doc equals the
 * entry's snapshot and our item is PM's next to move.
 */

/** The marker on OUR page-setup transactions (the history-joined ones;
 *  the ruler's preview frames stay out entirely). */
export const PAGE_SETUP_MARKER = 'pageSetupOurs';

/**
 * #48 — the synthetic pending transitions: a store-only write records
 * nothing in PM, so pmUndo dispatches nothing and pending would never
 * flip. The ours-branches dispatch these metas after the restore.
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
   * #48 — the pageStyles the action replaced. undefined = untouched
   * (leave the map standing); present = one Ctrl+Z reverts the setup
   * AND the map together.
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

/** The store write's undo push — call AFTER the PM tr dispatches
 *  (`docAfter` post-write, `docBefore` pre-write). null docs skip the
 *  push (file-open migrations); clears the redo stack. */
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
 * the map — leave it standing. */
export function restorePageSetup(setup: PageSetup, pageStyles?: PageStyles): void {
  const store = useDocumentStore.getState();
  store.setPageSetup(setup);
  if (pageStyles !== undefined) store.setPageStyles(pageStyles);
}
