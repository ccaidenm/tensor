import { create } from 'zustand';

interface DocumentPropertiesStore {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  statsIsOpen: boolean;
  openStats: () => void;
  closeStats: () => void;
  customSizeIsOpen: boolean;
  openCustomSize: () => void;
  closeCustomSize: () => void;
  /** #58 — the ONE Page Setup dialog (paper/orientation/margins with
   *  an Apply-to scope: whole document / this section / this point
   *  forward). The old per-feature margins dialog is merged into it. */
  pageSetupIsOpen: boolean;
  openPageSetup: () => void;
  closePageSetup: () => void;
}

export const useDocumentPropertiesStore = create<DocumentPropertiesStore>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  statsIsOpen: false,
  openStats: () => set({ statsIsOpen: true }),
  closeStats: () => set({ statsIsOpen: false }),
  customSizeIsOpen: false,
  openCustomSize: () => set({ customSizeIsOpen: true }),
  closeCustomSize: () => set({ customSizeIsOpen: false }),
  pageSetupIsOpen: false,
  openPageSetup: () => set({ pageSetupIsOpen: true }),
  closePageSetup: () => set({ pageSetupIsOpen: false }),
}));