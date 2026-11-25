import { create } from 'zustand';

/**
 * THE SYMBOL BUBBLE STORE — the bubble mounts in App.tsx, NOT inside
 * the Insert tab, so it PERSISTS across ribbon tab switches. The
 * ribbon button only OPENS it; closing is the bubble's business.
 */
interface SymbolBubbleStore {
  open: boolean;
  /** The trigger's viewport rect — the bubble's initial anchor. */
  anchor: { left: number; top: number; right: number; bottom: number } | null;
  openAt: (rect: { left: number; top: number; right: number; bottom: number }) => void;
  close: () => void;
}

export const useSymbolBubbleStore = create<SymbolBubbleStore>((set) => ({
  open: false,
  anchor: null,
  openAt: (anchor) => set({ open: true, anchor }),
  close: () => set({ open: false }),
}));
