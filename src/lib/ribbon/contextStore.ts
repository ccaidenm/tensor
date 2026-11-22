import { create } from 'zustand';
import type { RibbonContextId } from './contextualTabs';

/**
 * The contextual tab activation model: a context enters when its
 * selection kind becomes active, exits when it stops. One at a time
 * (first-come wins); `exit` is id-scoped; a normal tab click does not exit.
 */
interface RibbonContextState {
  /** The active context id, or null when no context is active. */
  active: RibbonContextId | null;
  enter: (id: RibbonContextId) => void;
  exit: (id: RibbonContextId) => void;
}

export const useRibbonContextStore = create<RibbonContextState>((set, get) => ({
  active: null,

  enter: (id) => {
    const { active } = get();
    // Idempotent (producers re-announce on every selection refresh);
    // first-come wins across different ones.
    if (active === id || active !== null) return;
    set({ active: id });
  },

  exit: (id) => {
    // Id-scoped: only the active context's producer can tear it down.
    if (get().active !== id) return;
    set({ active: null });
  },
}));