import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { renderTensor, settleLayout } from './harness';
import { Ribbon } from '@/components/layout/Ribbon';
import { useDocumentStore } from '@/lib/document/store';
import { useConfigStore } from '@/lib/config/store';

/**
 * #100 — THE CUSTOM TOPBAR: the merged titlebar row (the Ribbon's h-10
 * strip IS the window chrome), the custom window controls, the drag
 * regions, the OS-title follow, and the absorbed-menu seams (the
 * web-side accelerators that replaced the native menu's).
 *
 * The window API is mocked locally (the palette.test pattern); jsdom's
 * userAgent reads as Linux, so the tests exercise the Linux/Windows
 * lane (the centered name + far-right controls) — the macOS lane is
 * the userAgent branch the same components read.
 */

const windowMocks = vi.hoisted(() => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  setTitle: vi.fn(),
  isMaximized: vi.fn(async () => false),
  onResized: vi.fn(async () => () => {}),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    minimize: windowMocks.minimize,
    toggleMaximize: windowMocks.toggleMaximize,
    close: windowMocks.close,
    setTitle: windowMocks.setTitle,
    isMaximized: windowMocks.isMaximized,
    onResized: windowMocks.onResized,
  }),
}));

// The env gate: the components call the window API only inside a Tauri
// webview (__TAURI_INTERNALS__). Stub it for the behavior tests.
let internalsStubbed = false;
function stubTauriEnv() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: {},
    configurable: true,
  });
  internalsStubbed = true;
}

beforeEach(() => {
  windowMocks.minimize.mockClear();
  windowMocks.toggleMaximize.mockClear();
  windowMocks.close.mockClear();
  windowMocks.setTitle.mockClear();
});

afterEach(() => {
  if (internalsStubbed) {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    internalsStubbed = false;
  }
});

describe('the merged titlebar row (#100)', () => {
  it('renders the window controls with accessible names (Linux lane: far right)', () => {
    renderTensor('<p>x</p>');
    render(<Ribbon />);
    expect(document.querySelector('[aria-label="Minimize"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Maximize"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Close"]')).not.toBeNull();
  });

  it('the controls work: minimize/toggle/close call the window API', () => {
    stubTauriEnv();
    renderTensor('<p>x</p>');
    render(<Ribbon />);
    fireEvent.click(document.querySelector('[data-testid="window-minimize"]')!);
    expect(windowMocks.minimize).toHaveBeenCalledTimes(1);
    fireEvent.click(document.querySelector('[data-testid="window-maximize"]')!);
    expect(windowMocks.toggleMaximize).toHaveBeenCalledTimes(1);
    fireEvent.click(document.querySelector('[data-testid="window-close"]')!);
    expect(windowMocks.close).toHaveBeenCalledTimes(1);
  });

  it('the drag lanes carry the tauri drag-region contract (drag + dblclick-maximize)', () => {
    // Tauri's injected core script OWNS the behavior on
    // data-tauri-drag-region (mousedown → start-dragging, dblclick →
    // toggle-maximize) — the app must NOT double-toggle with its own
    // onDoubleClick (the maximize-then-restore bug, user-caught). The
    // assertion is the attribute contract; jsdom has no tauri core.
    stubTauriEnv();
    renderTensor('<p>x</p>');
    render(<Ribbon />);
    const lanes = Array.from(
      document.querySelectorAll<HTMLElement>('[data-tauri-drag-region]'),
    );
    // The flex spacer + the document name's own band.
    expect(lanes.length).toBeGreaterThanOrEqual(2);
    expect(lanes.find((el) => el.className.includes('flex-1'))).toBeTruthy();
    expect(lanes.find((el) => el.textContent?.includes('Untitled'))).toBeTruthy();
  });

  it('the document name floats ABSOLUTELY CENTERED (the window-center law)', () => {
    renderTensor('<p>x</p>');
    render(<Ribbon />);
    const name = Array.from(
      document.querySelectorAll<HTMLElement>('[data-tauri-drag-region]'),
    ).find((el) => el.textContent.includes('Untitled'))!;
    // Linux lane: left-1/2 + -translate-x-1/2 (the absolute center).
    expect(name.className).toContain('left-1/2');
    expect(name.className).toContain('-translate-x-1/2');
  });

  it('the placement setting moves the controls lane (left lane mounts first)', () => {
    stubTauriEnv();
    act(() => {
      useConfigStore.getState().setWindowControlsSide('left');
    });
    renderTensor('<p>x</p>');
    render(<Ribbon />);
    const first = document.querySelector('[data-testid="window-minimize"]');
    expect(first).not.toBeNull();
    // Controls-left: the controls DIV precedes the Tensor button in the
    // row (the DOM order IS the visual lane order).
    const row = first!.closest('.h-10.items-center')!.parentElement!;
    const rowChildren = Array.from(row.children);
    expect(rowChildren.findIndex((c) => c.contains(first!))).toBe(0);
    act(() => {
      useConfigStore.getState().setWindowControlsSide('right');
    });
  });

  it('the close hover is white ink on the destructive red (the user’s call)', () => {
    renderTensor('<p>x</p>');
    render(<Ribbon />);
    const close = document.querySelector('[data-testid="window-close"]')!;
    expect(close.className).toContain('hover:text-white');
    expect(close.className).toContain('hover:bg-destructive');
  });

  it('the document name rides the titlebar and drags too', () => {
    renderTensor('<p>x</p>');
    render(<Ribbon />);
    const name = Array.from(
      document.querySelectorAll<HTMLElement>('[data-tauri-drag-region]'),
    ).find((el) => el.textContent.includes('Untitled'));
    expect(name).toBeTruthy();
    expect(name!.className).toContain('truncate');
  });

  it('the OS window title follows the document (dirty dot included)', async () => {
    stubTauriEnv();
    renderTensor('<p>content</p>');
    render(<Ribbon />);
    // The harness's setContent leaves the doc dirty — control the state
    // explicitly (the title follows it).
    act(() => {
      useDocumentStore.setState({ filePath: null, isDirty: false });
    });
    await settleLayout();
    expect(windowMocks.setTitle).toHaveBeenCalledWith('Untitled — Tensor');
    // A rename (file path) + dirty retitles:
    act(() => {
      useDocumentStore.setState({ filePath: '/home/caiden/Docs/newsletter.wpdoc', isDirty: true });
    });
    expect(windowMocks.setTitle).toHaveBeenCalledWith(
      'newsletter.wpdoc • — Tensor',
    );
  });

  it('outside Tauri the calls no-op (a plain-browser dev session renders, never throws)', () => {
    renderTensor('<p>x</p>');
    render(<Ribbon />);
    // __TAURI_INTERNALS__ is absent (not stubbed): clicking is inert.
    fireEvent.click(document.querySelector('[data-testid="window-minimize"]')!);
    expect(windowMocks.minimize).not.toHaveBeenCalled();
  });
});

describe('the absorbed menu (#100)', () => {
  it('the web-side accelerators own the menu\'s keys: open + quit exist, new waits for #103', async () => {
    const { SHORTCUTS } = await import('@/lib/shortcuts');
    const open = SHORTCUTS.find((s) => s.id === 'open')!;
    expect(open.keys).toBe('ctrl+o');
    const quit = SHORTCUTS.find((s) => s.id === 'quit')!;
    expect(quit.keys).toBe('ctrl+q');
    // #103 — the menu's last accelerator, alive on a real body now.
    expect(SHORTCUTS.find((s) => s.id === 'new')!.keys).toBe('ctrl+n');
  });

  it('live: ctrl+o dispatches the registry\'s open command (the menu\'s old body)', async () => {
    const { useAppShortcuts } = await import('@/lib/shortcuts/useAppShortcuts');
    const { getCommand } = await import('@/lib/commands/registry');
    const openCmd = getCommand('open')!;
    expect(openCmd).toBeDefined();
    const runSpy = vi.spyOn(openCmd, 'run').mockImplementation(() => {});
    const { renderHook } = await import('@testing-library/react');
    renderHook(() => useAppShortcuts());
    act(() => {
      fireEvent.keyDown(window, { key: 'o', ctrlKey: true });
    });
    expect(runSpy).toHaveBeenCalled();
    runSpy.mockRestore();
  });
});
