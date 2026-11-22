import { create } from 'zustand';

interface LinkEditorStore {
  /** Bumped to open the link editor — onto an existing link at the
   *  cursor, or a blank insert form. A counter, not a boolean, so
   *  pressing Ctrl+K while already open re-triggers. */
  insertRequestId: number;
  /** Bumped to force-close, regardless of current state — used by the
   *  popover's own Cancel/Save/X/Escape handlers. */
  closeRequestId: number;
  requestInsert: () => void;
  requestClose: () => void;
}

export const useLinkEditorStore = create<LinkEditorStore>((set) => ({
  insertRequestId: 0,
  closeRequestId: 0,
  requestInsert: () => set((s) => ({ insertRequestId: s.insertRequestId + 1 })),
  requestClose: () => set((s) => ({ closeRequestId: s.closeRequestId + 1 })),
}));
