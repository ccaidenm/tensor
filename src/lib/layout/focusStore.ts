import { create } from 'zustand';
import { useSidebarStore } from '@/lib/layout/sidebarStore';
import { toast } from '@/components/ui/toast';
import { useConfigStore } from '@/lib/config/store';
import { formatShortcutParts, getEffectiveKeybinding } from '@/lib/shortcuts';

/** The sidebar store's active shape (local there — mirrored here as
 *  the displacement record; keep in sync if the sidebar grows). */
interface ActiveSidebar {
  id: string;
  anchor: 'left' | 'right' | 'bottom';
}

interface FocusStore {
  active: boolean;
  /**
   * The sidebar Focus Mode displaced, restored on exit. Session-only
   * chrome state, never persisted — every launch starts in normal mode.
   */
  displacedSidebar: ActiveSidebar | null;
  /** Enter Focus Mode: remember + close any open sidebar. */
  enter: () => void;
  /** Exit Focus Mode: restore the displaced sidebar, if there was one. */
  exit: () => void;
  toggle: () => void;
}

/**
 * Focus Mode's session state: a plain zustand store, not app-config —
 * a transient toggle, never persisted (every launch starts normal).
 * The store owns the transition side effects shared by every surface.
 */
export const useFocusStore = create<FocusStore>((set, get) => ({
  active: false,
  displacedSidebar: null,
  enter: () => {
    // The sidebar store keeps no memory of its own across close() —
    // Focus Mode carries the displaced panel itself.
    const open = useSidebarStore.getState().active;
    if (open) useSidebarStore.getState().close();
    set({ active: true, displacedSidebar: open });
    // Fullscreen: best-effort, never blocking — browsers reject
    // requestFullscreen outside a user gesture (every real trigger is
    // one); jsdom lacks the API (optional chaining skips the chain).
    void document.documentElement.requestFullscreen?.().catch(() => {
      // Rejected (permission/gesture policy): focus mode still works —
      // the mode never depends on the fullscreen succeeding.
    });
    // The orientation toast: the exit hint follows the user's rebind
    // (getEffectiveKeybinding — never a hardcoded F11).
    const hint = formatShortcutParts(
      getEffectiveKeybinding(useConfigStore.getState().config.keybindings, 'toggleFocusMode'),
    ).join(' + ');
    void toast.add({
      title: 'Focus mode enabled',
      description: `Press ${hint} or hover the top-right corner to exit.`,
      type: 'info',
    });
  },
  exit: () => {
    const { displacedSidebar } = get();
    if (displacedSidebar) useSidebarStore.getState().open(displacedSidebar.id, displacedSidebar.anchor);
    set({ active: false, displacedSidebar: null });
    // Leave fullscreen with the mode (the inverse of enter) — but only
    // if the document actually holds it (the user may have left it
    // themselves with Escape; exiting twice is a no-op browser-side).
    if (document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => {});
    }
  },
  toggle: () => (get().active ? get().exit() : get().enter()),
}));
