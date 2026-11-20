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
   * chrome state, like `active` itself — never persisted (this is
   * transient display state, not a user preference: every launch starts
   * in normal mode).
   */
  displacedSidebar: ActiveSidebar | null;
  /** Enter Focus Mode: remember + close any open sidebar. */
  enter: () => void;
  /** Exit Focus Mode: restore the displaced sidebar, if there was one. */
  exit: () => void;
  toggle: () => void;
}

/**
 * #FOCUS — Focus Mode's session state. Deliberately a plain zustand
 * store beside sidebarStore, NOT app-config: Focus Mode is a transient
 * display toggle (like the palette), not a preference to persist — the
 * issue's ruling is that every launch starts in normal mode.
 *
 * The store owns the MODE-TRANSITION SIDE EFFECTS (sidebar displacement,
 * fullscreen, the instructional toast) so every surface — ribbon button,
 * F11, palette, exit button — gets the identical transition through the
 * one command body. Direct setState bypasses them (tests use that).
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
    // FULLSCREEN — entering focus mode takes the whole screen (the
    // distraction-free promise). BEST-EFFORT, never blocking: browsers
    // reject requestFullscreen outside a user gesture (every real
    // trigger — button, F11, palette — IS one) and environments without
    // the API (jsdom) skip the whole chain via optional chaining.
    void document.documentElement.requestFullscreen?.().catch(() => {
      // Rejected (permission/gesture policy): focus mode still works —
      // the mode never depends on the fullscreen succeeding.
    });
    // THE ORIENTATION TOAST: a first-timer in a chromeless window needs
    // to know the way out. The hint is LIVE (the user's rebind via
    // getEffectiveKeybinding — never a hardcoded F11).
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
