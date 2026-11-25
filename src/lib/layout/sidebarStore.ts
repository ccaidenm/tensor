import { create } from 'zustand';

export type SidebarAnchor = 'left' | 'right' | 'bottom';

interface ActiveSidebar {
  id: string;
  anchor: SidebarAnchor;
}

interface SidebarStore {
  active: ActiveSidebar | null;
  /**
   * #101 — the per-sidebar anchor memory. The hosts derive their dock
   * side from here (the `anchor` prop is only the seed), so a redocked
   * panel renders on the new edge; survives close/reopen in-session.
   */
  anchors: Record<string, SidebarAnchor>;
  open: (id: string, anchor: SidebarAnchor) => void;
  /** #101 — the drag-release dock: open, plus the anchor memory write. */
  dock: (id: string, anchor: SidebarAnchor) => void;
  close: () => void;
}

/**
 * Generic docked-panel state. Deliberately minimal: only one sidebar
 * open at a time, app-wide, for now. #101's drag-to-redock rides the
 * per-sidebar anchor memory.
 */
export const useSidebarStore = create<SidebarStore>((set) => ({
  active: null,
  anchors: {},
  open: (id, anchor) => set({ active: { id, anchor } }),
  dock: (id, anchor) =>
    set((state) => ({
      active: { id, anchor },
      anchors: { ...state.anchors, [id]: anchor },
    })),
  close: () => set({ active: null }),
}));
