import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { renderTensor } from './harness';
import { Ribbon } from '@/components/layout/Ribbon';
import { StatusBar } from '@/components/layout/StatusBar';
import { DisplayModeGroup } from '@/components/layout/ribbon/view/groups/DisplayModeGroup';
import { ExitFocusButton } from '@/components/layout/ExitFocusButton';
import { SidebarHost } from '@/lib/layout/sidebar/SidebarHost';
import { SearchResultsSidebar } from '@/components/editor/SearchResultsSidebar';
import { useAppShortcuts } from '@/lib/shortcuts/useAppShortcuts';
import { getCommand } from '@/lib/commands/registry';
import { useFocusStore } from '@/lib/layout/focusStore';
import { useSidebarStore } from '@/lib/layout/sidebarStore';
import { useConfigStore } from '@/lib/config/store';
import { DEFAULT_CONFIG } from '@/lib/config/schema';
import { toast } from '@/components/ui/toast';
import { settleLayout } from './harness';

/**
 * Focus Mode: the session chrome toggle — one command body (ribbon
 * button, palette, F11, exit button); the store drives every hide
 * (ribbon, status bar, rulers, sidebars) and owns the transition side
 * effects (fullscreen + the orientation toast). Session-only state —
 * never persisted.
 */

/** Mounts the app-shortcut listener (App.tsx's own mount — the F11
 *  keydown path needs it live). */
function ShortcutHarness() {
  useAppShortcuts();
  return null;
}

/** The chrome under test: the full ribbon, the status bar, the
 *  View-tab group holding the Focus Mode button, the exit button, and
 *  one docked sidebar host (the displacement surface). */
function mountChrome() {
  render(
    <>
      <Ribbon />
      <div className="relative">
        <SidebarHost id="search" anchor="right">
          <SearchResultsSidebar />
        </SidebarHost>
      </div>
      <StatusBar />
      <DisplayModeGroup />
      <ExitFocusButton />
      <ShortcutHarness />
    </>,
  );
}

const button = (label: string) =>
  document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;

/** The Tensor menu trigger carries no aria-label — its text IS the
 *  label (logo + the word); query by text. */
const tensorButton = () =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Tensor')) ?? null;

/**
 * Fullscreen + toast stubs — jsdom has no Fullscreen API (the store's
 * optional-chained calls would silently skip; stubbing PINS the calls),
 * and the orientation toast is asserted through the manager.
 */
/** Standalone optional types for the stubs — lib.dom declares these
 *  methods NON-optional, so an intersecting cast would defeat the `?`
 *  and the deletes would not typecheck; cast through unknown instead. */
type FsElement = { requestFullscreen?: () => Promise<void> };
type FsDocument = { exitFullscreen?: () => Promise<void> };

let requestFullscreen: MockInstance;
let exitFullscreen: MockInstance;
let toastAddSpy: MockInstance;

beforeEach(() => {
  useFocusStore.setState({ active: false, displacedSidebar: null });
  useSidebarStore.getState().close();
  useConfigStore.setState({ config: DEFAULT_CONFIG });
  requestFullscreen = vi.fn(() => Promise.resolve());
  (document.documentElement as unknown as FsElement).requestFullscreen =
    requestFullscreen as unknown as () => Promise<void>;
  exitFullscreen = vi.fn(() => Promise.resolve());
  (document as unknown as FsDocument).exitFullscreen =
    exitFullscreen as unknown as () => Promise<void>;
  toastAddSpy = vi.spyOn(toast, 'add');
});

afterEach(() => {
  delete (document.documentElement as unknown as FsElement).requestFullscreen;
  delete (document as unknown as FsDocument).exitFullscreen;
  delete (document as { fullscreenElement?: unknown }).fullscreenElement;
  toastAddSpy.mockRestore();
  vi.useRealTimers();
});

async function settle() {
  await settleLayout();
}

describe('#FOCUS: the toggle hides the chrome, keeps the document', () => {
  it('starts in normal mode: chrome present, exit button absent', async () => {
    renderTensor();
    mountChrome();
    await settle();
    expect(useFocusStore.getState().active).toBe(false);
    // The ribbon (the Tensor menu trigger) and the status bar ("Page N
    // of" — the document's own words must not be the marker) are up;
    // the exit button is not.
    expect(tensorButton()).not.toBeNull();
    expect(document.body.textContent).toContain('Page 1 of');
    expect(document.querySelector('[data-testid="focus-exit-button"]')).toBeNull();
  });

  it('the command hides ribbon, status bar, ruler, and sidebar; the document stays', async () => {
    renderTensor();
    const { useDocumentStore } = await import('@/lib/document/store');
    const ed = useDocumentStore.getState().editor!;
    act(() => {
      ed.commands.setContent('<p>the words survive</p>');
    });
    mountChrome();
    await settle();
    useSidebarStore.getState().open('search', 'right');
    await settle();

    // THE COMMAND the button, F11, the palette, and the pill share.
    act(() => {
      getCommand('toggleFocusMode')!.run();
    });
    await settle();

    expect(useFocusStore.getState().active).toBe(true);
    // The chrome is gone — the Tensor menu trigger, the status bar's
    // page line, the ruler bar, and the open sidebar.
    expect(tensorButton()).toBeNull();
    expect(document.body.textContent).not.toContain('Page 1 of');
    expect(document.querySelector('[data-testid="ruler"]')).toBeNull();
    expect(useSidebarStore.getState().active).toBeNull();
    // The document itself is untouched and visible.
    expect(document.querySelector('.ProseMirror')!.textContent).toContain('the words survive');

    // Toggle back: the chrome returns (the ruler and the status bar;
    // the displaced sidebar is the restore test below).
    act(() => {
      getCommand('toggleFocusMode')!.run();
    });
    await settle();
    expect(tensorButton()).not.toBeNull();
    expect(document.body.textContent).toContain('Page 1 of');
    expect(document.querySelector('[data-testid="ruler"]')).not.toBeNull();
  });

  it('THE ACCEPTANCE PIN: the selection survives the round-trip', async () => {
    renderTensor();
    const { useDocumentStore } = await import('@/lib/document/store');
    const ed = useDocumentStore.getState().editor!;
    act(() => {
      ed.commands.setContent('<p>hello focus world</p>');
      ed.commands.setTextSelection({ from: 1, to: 6 }); // 'hello'
    });
    const before = { from: ed.state.selection.from, to: ed.state.selection.to };
    expect(before).toEqual({ from: 1, to: 6 });

    act(() => {
      getCommand('toggleFocusMode')!.run();
    });
    await settle();
    act(() => {
      getCommand('toggleFocusMode')!.run();
    });
    await settle();

    // Same editor instance, same selection, same content (one PM
    // instance renders both modes — the toggle routes the VIEW only).
    expect(useDocumentStore.getState().editor).toBe(ed);
    expect(ed.state.selection.from).toBe(before.from);
    expect(ed.state.selection.to).toBe(before.to);
    expect(ed.state.doc.textContent).toContain('hello focus world');
  });

  it('a displaced sidebar is REMEMBERED and RESTORED', async () => {
    renderTensor();
    mountChrome();
    await settle();
    useSidebarStore.getState().open('search', 'right');
    await settle();

    act(() => {
      getCommand('toggleFocusMode')!.run();
    });
    await settle();
    // Displaced: the store closed it and Focus Mode carries the memory.
    expect(useSidebarStore.getState().active).toBeNull();
    expect(useFocusStore.getState().displacedSidebar).toEqual({ id: 'search', anchor: 'right' });

    act(() => {
      getCommand('toggleFocusMode')!.run();
    });
    await settle();
    // Restored: the same panel is open again.
    expect(useSidebarStore.getState().active).toEqual({ id: 'search', anchor: 'right' });
  });

  it('the exit button: reveals on entry, fades after a few seconds, hover-reveals, and exits', async () => {
    // Fake timers from the START (scoped to setTimeout/clearTimeout,
    // auto-advancing with real time so the harness's settles still run):
    // the auto-hide timeout must be scheduled on the FAKE clock or
    // advanceTimersByTime can never fire it.
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    renderTensor();
    mountChrome();
    await settle();

    expect(document.querySelector('[data-testid="focus-exit-button"]')).toBeNull();
    act(() => {
      getCommand('toggleFocusMode')!.run();
    });
    await settle();

    const exitBtn = () =>
      document.querySelector('[data-testid="focus-exit-button"]') as HTMLButtonElement | null;
    const btn = exitBtn()!;
    expect(btn).not.toBeNull();
    // Shadcn-native: the ribbon's IconButton (aria-label + Minimize svg;
    // the tooltip + live kbd hint ride on shortcutId). It starts REVEALED.
    expect(btn.getAttribute('aria-label')).toBe('Exit focus mode');
    expect(btn.querySelector('svg')).not.toBeNull();
    expect(btn.getAttribute('aria-hidden')).toBe('false');

    // It fades after a few seconds — HIDDEN, not unmounted: opacity-0 +
    // pointer-events-none + aria-hidden + tabindex -1 (invisible to
    // pointer and AT; the shortcut stays the keyboard path). The timer
    // is already on the fake clock installed at the top of the test —
    // re-installing here would orphan it.
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(btn.className).toContain('opacity-0');
    expect(btn.getAttribute('aria-hidden')).toBe('true');
    expect(btn.getAttribute('tabindex')).toBe('-1');

    // Hovering the top-right corner brings it back...
    act(() => {
      fireEvent.mouseMove(window, { clientX: window.innerWidth - 60, clientY: 30 });
    });
    expect(btn.className).toContain('opacity-100');
    // ...and leaving the corner fades it again.
    act(() => {
      fireEvent.mouseMove(window, { clientX: 100, clientY: 300 });
    });
    expect(btn.className).toContain('opacity-0');
    vi.useRealTimers();

    // A revealed button exits through the ONE command body.
    act(() => {
      fireEvent.mouseMove(window, { clientX: window.innerWidth - 60, clientY: 30 });
    });
    act(() => {
      fireEvent.click(btn);
    });
    await settle();
    expect(useFocusStore.getState().active).toBe(false);
    expect(exitBtn()).toBeNull();
  });

  it('entering dispatches the orientation toast with the LIVE shortcut hint', async () => {
    renderTensor();
    mountChrome();
    await settle();

    toastAddSpy.mockClear();
    act(() => {
      getCommand('toggleFocusMode')!.run();
    });
    expect(toastAddSpy).toHaveBeenCalledTimes(1);
    const call = toastAddSpy.mock.calls[0][0] as { title: string; description: string };
    expect(call.title).toBe('Focus mode enabled');
    // Both ways out, named: the shortcut and the corner hover.
    expect(call.description).toContain('F11');
    expect(call.description).toContain('top-right corner');

    // THE LIVE HINT: a user rebind shows THEIR shortcut in the copy —
    // never a hardcoded F11.
    act(() => {
      getCommand('toggleFocusMode')!.run(); // exit
    });
    useConfigStore.setState({
      config: {
        ...DEFAULT_CONFIG,
        keybindings: { ...DEFAULT_CONFIG.keybindings, toggleFocusMode: 'ctrl+shift+f' },
      },
    });
    toastAddSpy.mockClear();
    act(() => {
      getCommand('toggleFocusMode')!.run();
    });
    const rebound = toastAddSpy.mock.calls[0][0] as { description: string };
    expect(rebound.description).toContain('Ctrl + Shift + F');
  });

  it('entering takes the screen fullscreen; leaving releases it (best-effort)', async () => {
    renderTensor();
    mountChrome();
    await settle();

    act(() => {
      getCommand('toggleFocusMode')!.run();
    });
    // The enter transition requested fullscreen on the document root.
    expect(requestFullscreen).toHaveBeenCalledTimes(1);

    // The user left fullscreen THEMSELVES (Escape): exiting focus mode
    // must not call exitFullscreen on a document holding nothing.
    act(() => {
      getCommand('toggleFocusMode')!.run();
    });
    expect(exitFullscreen).not.toHaveBeenCalled();

    // Normal path: the document holds fullscreen → exit releases it.
    Object.defineProperty(document, 'fullscreenElement', {
      value: document.documentElement,
      configurable: true,
    });
    act(() => {
      getCommand('toggleFocusMode')!.run(); // enter
    });
    act(() => {
      getCommand('toggleFocusMode')!.run(); // exit
    });
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it('F11 (the app-context shortcut) toggles both ways', async () => {
    renderTensor();
    mountChrome();
    await settle();

    act(() => {
      fireEvent.keyDown(window, { key: 'F11' });
    });
    expect(useFocusStore.getState().active).toBe(true);

    // The same key exits — even with the editor holding focus (the
    // 'app' context fires regardless).
    act(() => {
      fireEvent.keyDown(window, { key: 'F11' });
    });
    expect(useFocusStore.getState().active).toBe(false);
  });

  it('the View-tab Focus Mode button: enabled, toggles, shows pressed', async () => {
    renderTensor();
    mountChrome();
    await settle();

    const btn = button('Focus Mode')!;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-pressed')).toBe('false');

    act(() => {
      fireEvent.click(btn);
    });
    expect(useFocusStore.getState().active).toBe(true);
    // The button shows PRESSED (the harness mounts the group beside
    // the ribbon; inside the real ribbon it unmounts with the chrome —
    // the exit button and F11 carry exiting there).
    expect(button('Focus Mode')!.getAttribute('aria-pressed')).toBe('true');
  });
});
