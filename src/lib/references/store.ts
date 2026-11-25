import { Extension, type Editor } from '@tiptap/core';
import { create } from 'zustand';
import { scanCollections } from './scan';

/**
 * The reactive seam between doc changes and the NodeView: a version
 * counter bumped (debounced ~250ms) after doc-changing transactions so
 * NodeViews re-render; the adapter rescans synchronously instead.
 */

interface ReferenceStoreState {
  /** Bumped after the debounced post-transaction rescan. */
  version: number;
  bump: () => void;
}

export const useReferenceStore = create<ReferenceStoreState>((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}));

export const REFERENCE_SCAN_DEBOUNCE_MS = 250;

let timer: ReturnType<typeof setTimeout> | null = null;

function scheduleScan(editor: Editor): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    // Warm the memo for the settled doc (a no-op rescan if unchanged),
    // then bump — NodeViews re-render against fresh entries.
    scanCollections(editor.state.doc);
    useReferenceStore.getState().bump();
  }, REFERENCE_SCAN_DEBOUNCE_MS);
}

/** Mounted in tensorExtensions: the one doc-change listener. onCreate
 *  covers the initial-content path (never dispatches a transaction the
 *  debounce would see); onUpdate covers every doc change after. */
export const ReferenceScanExtension = Extension.create({
  name: 'referenceScanSync',

  onCreate({ editor }) {
    scheduleScan(editor);
  },

  onUpdate({ editor }) {
    scheduleScan(editor);
  },

  onDestroy() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  },
});
