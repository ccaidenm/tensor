import { create } from 'zustand';

interface DocumentPropertiesStore {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  customSizeIsOpen: boolean;
  /**
   * #58 — who the custom size is for: 'document' (Done applies it
   * document-wide) or 'draft' (Done hands the pick back via customSizeOnPick).
   */
  customSizeTarget: 'document' | 'draft';
  customSizeSeed: { pageSize: string; customWidth?: number; customHeight?: number } | null;
  customSizeOnPick: ((pick: {
    pageSize: string;
    customWidth?: number;
    customHeight?: number;
  }) => void) | null;
  openCustomSize: (opts?: {
    seed?: { pageSize: string; customWidth?: number; customHeight?: number };
    onPick?: (pick: { pageSize: string; customWidth?: number; customHeight?: number }) => void;
  }) => void;
  closeCustomSize: () => void;
  /** #58 — the Page Setup dialog (paper/orientation/margins with an Apply-to scope). */
  pageSetupIsOpen: boolean;
  openPageSetup: () => void;
  closePageSetup: () => void;
  /** #74 — the Columns dialog (Apply-to scope like Page Setup, but no page scope: columns are geometry). */
  columnsIsOpen: boolean;
  openColumns: () => void;
  closeColumns: () => void;
}

export const useDocumentPropertiesStore = create<DocumentPropertiesStore>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  customSizeIsOpen: false,
  customSizeTarget: 'document',
  customSizeSeed: null,
  customSizeOnPick: null,
  openCustomSize: (opts) =>
    set({
      customSizeIsOpen: true,
      customSizeTarget: opts?.onPick ? 'draft' : 'document',
      customSizeSeed: opts?.seed ?? null,
      customSizeOnPick: opts?.onPick ?? null,
    }),
  closeCustomSize: () =>
    set({ customSizeIsOpen: false, customSizeSeed: null, customSizeOnPick: null }),
  pageSetupIsOpen: false,
  openPageSetup: () => set({ pageSetupIsOpen: true }),
  closePageSetup: () => set({ pageSetupIsOpen: false }),
  columnsIsOpen: false,
  openColumns: () => set({ columnsIsOpen: true }),
  closeColumns: () => set({ columnsIsOpen: false }),
}));