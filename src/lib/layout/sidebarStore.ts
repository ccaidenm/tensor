import { create } from 'zustand';

export type SidebarAnchor = 'left' | 'right' | 'bottom';

interface ActiveSidebar {
  id: string;
  anchor: SidebarAnchor;
}

interface SidebarStore {
  active: ActiveSidebar | null;
  /**
   * #101 — DRAG-TO-REDOCK: the per-sidebar anchor memory. The hosts
   * derive their dock side from here (their `anchor` PROP is only the
   * seed), so a panel redocked by drag renders on the new edge — and
   * the memory survives close/reopen within the session.
   */
  anchors: Record<string, SidebarAnchor>;
  open: (id: string, anchor: SidebarAnchor) => void;
  /** #101 — the drag-release dock: open, plus the anchor memory write. */
  dock: (id: string, anchor: SidebarAnchor) => void;
  close: () => void;
}

/**
 * Generic docked-panel state. Deliberately minimal: only one sidebar can be
 * open at a time, across the whole app, for now. This is the seed of a
 * future multi-panel/draggable/snapping system — #101's drag-to-redock is
 * the first step (per-sidebar anchor memory + the grip drag).
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
