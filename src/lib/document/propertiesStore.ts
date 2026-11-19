import { create } from 'zustand';

interface DocumentPropertiesStore {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  customSizeIsOpen: boolean;
  /**
   * #58 — WHO the custom size is for: 'document' (the ribbon's path —
   * Done applies document-wide) or 'draft' (the Page Setup dialog's
   * path — Done hands the pick back through customSizeOnPick; the
   * page-setup scope then decides where it lands).
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
  /** #58 — the ONE Page Setup dialog (paper/orientation/margins with
   *  an Apply-to scope: whole document / this section / this point
   *  forward). The old per-feature margins dialog is merged into it. */
  pageSetupIsOpen: boolean;
  openPageSetup: () => void;
  closePageSetup: () => void;
  /** #74 COLUMNS — the ONE Columns dialog (the spec with an Apply-to
   *  scope — the Page Setup machinery, no page scope: columns are
   *  geometry, never page decor). */
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