import { create } from 'zustand';
import type { RibbonContextId } from './contextualTabs';

/**
 * M-CONTEXTUAL-RIBBON — the contextual tab activation model.
 *
 * The ribbon doesn't know about contexts; contexts announce themselves.
 * A context (table selection, image selection, header/footer editing, …)
 * ENTERS when its selection kind becomes active and EXITS when it stops.
 * While active, the ribbon appends the context's tab (defined in
 * contextualTabs.ts) to the tab strip, auto-focuses it, and restores the
 * tab the user was on when the context exits (that interplay lives in
 * Ribbon.tsx, next to the tab state it acts on).
 *
 * RULES (Word semantics):
 *  - ONE context at a time — contexts are mutually exclusive by
 *    construction (the caret is in a table cell or a header, never both).
 *    First-come wins: `enter` while another context is active is a no-op.
 *  - `exit` is id-scoped — a stale producer exiting never kills a newer
 *    context (the no-op-unless-active guard).
 *  - Clicking a NORMAL tab does NOT exit the context: the contextual tab
 *    lingers in the strip while the selection kind persists; a fresh
 *    `enter` (re-selecting into the context) re-focuses it.
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
    // Idempotent for the SAME context (producers re-announce on every
    // selection refresh), and first-come wins across DIFFERENT ones.
    if (active === id || active !== null) return;
    set({ active: id });
  },

  exit: (id) => {
    // Id-scoped: only the ACTIVE context's producer can tear it down.
    if (get().active !== id) return;
    set({ active: null });
  },
}));