import { Extension, type Editor } from '@tiptap/core';
import { create } from 'zustand';
import { scanCollections } from './scan';

/**
 * M-REFS — the reactive seam between doc changes and the pageless
 * NodeView (the search/spell store pattern, minimal form). The scan
 * itself is pure + memoized (scan.ts); this store only carries a
 * VERSION counter that bumps (debounced) after doc-changing
 * transactions so subscribed NodeViews re-render against the fresh
 * scan. The ADAPTER never touches this store — it calls the memoized
 * scan synchronously per conversion (paginated needs zero debounce:
 * the engine's incremental cache makes a synchronous rescan cheap).
 *
 * DEBOUNCE (the issue's performance note): every keystroke in a
 * RETITLED heading would otherwise rescan + re-render every reference
 * table node. One trailing-edge timer (~250ms) collapses bursts; the
 * last doc version wins. The NodeView reads the LIVE doc at render
 * time, so the debounce only delays the bump, never the data.
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

/** Mounted in tensorExtensions: the ONE doc-change listener. onCreate
 * covers the initial-content path (never dispatches a transaction the
 * debounce would see); onUpdate covers every doc change after. */
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
