import { create } from 'zustand';

/**
 * THE SYMBOL BUBBLE STORE — the bubble's mount lives in App.tsx (NOT
 * inside the Insert tab's TabsContent), so it PERSISTS across ribbon
 * tab switches: park it in a corner, switch to Home, keep dropping
 * symbols. The ribbon button only OPENS it (with its rect as the
 * anchor); closing is the bubble's business (Done / the toggle).
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
