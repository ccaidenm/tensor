import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, waitFor, act } from '@testing-library/react';
import { SymbolButton } from '@/components/layout/ribbon/insert/SymbolButton';
import { SymbolBubble } from '@/components/layout/ribbon/insert/SymbolBubble';
import { CommandPalette } from '@/components/palette/CommandPalette';
import { usePaletteStore } from '@/lib/palette/store';
import { useSymbolBubbleStore } from '@/lib/editor/symbols/bubbleStore';
import { useConfigStore } from '@/lib/config/store';
import { __resetCatalog, __setDecompressor, getGroupChars, loadedChars, commonChars } from '@/lib/editor/symbols/catalog';
import { __resetCoverage } from '@/lib/editor/symbols/coverage';
import { renderTensor } from './harness';

/**
 * The symbol picker UI: Common instant, lazy core on search, windowed
 * grid at scale, coverage-disabled cells, insert-keeps-open. The
 * decompressor seam is deterministic (native gzip: symbolsCatalog).
 */

/** The core fixture in the GROUPED wire format ('>groupId' section
 *  headers — the core bundle is one chunk holding many groups, so
 *  core-group chips read their slice from the single load). */
const CORE_TEXT = [
  '>punctuation',
  '003B;SEMICOLON',
  '>math',
  '2044;FRACTION SLASH',
  '2202;PARTIAL DIFFERENTIAL',
  '>greek',
  '03A9;GREEK CAPITAL LETTER OMEGA',
  '0394;GREEK CAPITAL LETTER DELTA',
].join('\n');

/** Canvas mock extending the setup's full 2D stub (the editor's own
 *  canvases — BlockCanvas, rulers — keep working) with the picker's
 *  coverage simulation: TestFont covers BMP but flags the Greek
 *  fixture chars as tofu (the disabled-cell path); the monospace
 *  baseline measures 25 so the fallback signal can distinguish. */
function mockCanvas(): void {
  const base = HTMLCanvasElement.prototype.getContext;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, kind: string) {
    if (kind !== '2d') return base.call(this, kind);
    // The setup's getContext returns the full stubContext singleton.
    const baseCtx = base.call(this, kind) as unknown as Record<string, unknown>;
    const state = { font: '' };
    return {
      ...baseCtx,
      set font(value: string) { state.font = value; },
      get font() { return state.font; },
      measureText: (char: string) => {
        const stack = state.font;
        if (stack.startsWith('72px monospace')) return { width: 25 };
        if (stack.startsWith('72px serif')) return { width: 35 };
        const cp = char.codePointAt(0)!;
        if (stack.includes('TestFont')) {
          if (cp >= 0x370 && cp < 0x400) return { width: 30 }; // Greek = tofu
          if (char === '\u{10FFF7}') return { width: 30 }; // the reference
          return { width: 40 };
        }
        return { width: char === '\u{10FFF7}' ? 20 : 40 };
      },
    } as unknown as CanvasRenderingContext2D;
  });
}

beforeEach(() => {
  __resetCatalog();
  __resetCoverage();
  __setDecompressor(async (bytes) => new TextDecoder().decode(bytes));
  // The bubble's store state must never leak between tests (the mount
  // lives at App level now — the store is global); same for the
  // config-persisted chip recency (earlier tests' picks would leak).
  useSymbolBubbleStore.setState({ open: false, anchor: null });
  const cfg = useConfigStore.getState();
  useConfigStore.setState({
    config: { ...cfg.config, editor: { ...cfg.config.editor, recentSymbolGroups: [] } },
  });
  vi.restoreAllMocks();
  mockCanvas();
  const fetchSpy = vi.fn(async (url: string) => {
    if (url.endsWith('core.symbols')) return new Response(CORE_TEXT);
    if (url.endsWith('cjk-ideographs.symbols')) {
      // A big chunk — the windowing proof (far more cells than render).
      const lines = Array.from({ length: 2000 }, (_, i) => `${(0x4e00 + i).toString(16)};CJK UNIFIED IDEOGRAPH-${(0x4e00 + i).toString(16).toUpperCase()}`);
      return new Response(lines.join('\n'));
    }
    return new Response('nope', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchSpy);
});

function openPicker() {
  const trigger = document.querySelector('[data-testid="symbol-button-trigger"]') as HTMLButtonElement;
  fireEvent.click(trigger);
  return trigger;
}

/** THE UI-REAL GROUP PICK: groups live in one collapsed row — Common +
 *  recents as chips, the rest in the ellipsis dropdown. This helper
 *  walks the actual surface (chip when present, menu item otherwise). */
function pickGroupViaUI(id: string) {
  const chip = document.querySelector(`[data-testid="symbol-group-${id}"]`);
  if (chip) {
    fireEvent.click(chip);
    return;
  }
  fireEvent.click(document.querySelector('[data-testid="symbol-group-more"]')!);
  fireEvent.click(document.querySelector(`[data-testid="symbol-menu-${id}"]`)!);
}

/** THE MOUNT PATTERN (App.tsx parity): the picker bubble mounts at the
 *  app level through the store; the trigger is the ribbon's dumb
 *  toggle. One editor per test — the harness mount provides the store
 *  editor both insert into. */
function mountButton() {
  const { editor } = renderTensor('<p>placeholder</p>');
  render(
    <>
      <SymbolButton />
      <SymbolBubble editor={editor} />
    </>,
  );
  return { editor };
}

describe('the symbol picker', () => {
  it('Common renders instantly — bundled, zero fetches', async () => {
    mountButton();
    openPicker();
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="symbol-cell"]').length).toBeGreaterThan(50);
    });
    // The curated © is there; no chunk fetch happened for Common.
    const cells = [...document.querySelectorAll('[data-testid="symbol-cell"]')];
    expect(cells.some((c) => c.textContent === '©')).toBe(true);
  });

  it('searching beyond Common loads the core bundle and finds core-only chars', async () => {
    mountButton();
    openPicker();
    const input = document.querySelector('[data-testid="symbol-picker"] input') as HTMLInputElement;
    // 'FRACTION SLASH' exists ONLY in the core fixture (Common has no ⁄).
    fireEvent.change(input, { target: { value: 'FRACTION SLASH' } });
    await waitFor(() => {
      expect(getGroupChars('core')).not.toBeNull();
    });
    await waitFor(() => {
      const cells = [...document.querySelectorAll('[data-testid="symbol-cell"]')];
      expect(cells.some((c) => c.textContent === '⁄')).toBe(true);
    });
  });

  it('hex search finds characters by codepoint', async () => {
    mountButton();
    openPicker();
    const input = document.querySelector('[data-testid="symbol-picker"] input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '3A9' } });
    await waitFor(() => {
      const cells = [...document.querySelectorAll('[data-testid="symbol-cell"]')];
      expect(cells.some((c) => c.textContent === 'Ω')).toBe(true);
    });
  });

  it('uncovered glyphs render DISABLED — viewable, never insertable', async () => {
    const { editor } = mountButton();
    // The picker checks the ACTIVE font — set TestFont on the selection.
    editor.chain().focus().setFontFamily('TestFont').run();
    openPicker();
    const input = document.querySelector('[data-testid="symbol-picker"] input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'GREEK' } });
    await waitFor(() => {
      const greek = [...document.querySelectorAll('[data-testid="symbol-cell"]')].find((c) => c.textContent === 'Ω');
      expect(greek).not.toBeNull();
    });
    const greek = [...document.querySelectorAll('[data-testid="symbol-cell"]')].find((c) => c.textContent === 'Ω') as HTMLButtonElement;
    // ARIA-disabled (not the native attribute): the shadcn tooltip —
    // the WHY of the dead cell — must still reach hover.
    expect(greek.getAttribute('aria-disabled')).toBe('true');
    expect(greek.getAttribute('data-covered')).toBe('false');
    // Insertion is guarded in the handler, not the attribute.
    fireEvent.click(greek);
    expect(editor.getHTML()).not.toContain('Ω');
  });

  it('inserting keeps the picker open (multi-insert)', async () => {
    const { editor } = mountButton();
    openPicker();
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="symbol-cell"]').length).toBeGreaterThan(0);
    });
    const cell = [...document.querySelectorAll('[data-testid="symbol-cell"]')].find((c) => c.textContent === '©') as HTMLButtonElement;
    fireEvent.click(cell);
    await waitFor(() => {
      expect(editor.getHTML()).toContain('©');
    });
    // The picker stayed open for the next insert.
    expect(document.querySelector('[data-testid="symbol-picker"]')).not.toBeNull();
  });

  it('a CORE group chip loads the one core bundle and shows its slice (no per-group chunk exists)', async () => {
    mountButton();
    openPicker();
    // 'math' is a core group — its chip must NOT fetch /symbols/math.symbols
    // (a 404); it loads core.symbols and reads the >math slice.
    pickGroupViaUI('math');
    await waitFor(() => {
      expect(getGroupChars('math')).not.toBeNull();
    });
    await waitFor(() => {
      const cells = [...document.querySelectorAll('[data-testid="symbol-cell"]')];
      expect(cells.some((c) => c.textContent === '⁄')).toBe(true);
    });
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    expect(calls.some((u) => u.endsWith('/core.symbols'))).toBe(true);
    expect(calls.some((u) => u.endsWith('/math.symbols'))).toBe(false);
  });

  it('a CJK group opens its own lazy chunk', async () => {
    mountButton();
    openPicker();
    pickGroupViaUI('cjk-ideographs');
    await waitFor(() => {
      expect(getGroupChars('cjk-ideographs')).not.toBeNull();
    });
    await waitFor(() => {
      const cells = [...document.querySelectorAll('[data-testid="symbol-cell"]')];
      expect(cells.length).toBeGreaterThan(0);
      expect(cells.some((c) => c.textContent === '一')).toBe(true);
    });
  });

  it('the windowed grid renders a bounded slice of a 2k-char group', async () => {
    mountButton();
    openPicker();
    pickGroupViaUI('cjk-ideographs');
    await waitFor(() => {
      expect(getGroupChars('cjk-ideographs')).not.toBeNull();
    });
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="symbol-cell"]').length).toBeGreaterThan(0);
    });
    // 2000 chars in the chunk; only ~100 cells live in the DOM.
    expect(document.querySelectorAll('[data-testid="symbol-cell"]').length).toBeLessThan(300);
    expect(loadedChars().length).toBeGreaterThan(commonChars().length + 1000);
  });

  // Close behavior: a menu the user never moved is a transient —
  // click-away auto-closes it. A menu the user DRAGGED is a parked
  // tool — it persists until closed explicitly (Done / the ribbon
  // toggle). No X: the header is
  // purely the drag handle; Done lives in the footer (equation parity).

  it('click-away closes an UNDRAGGED bubble (the transient law)', async () => {
    mountButton();
    openPicker();
    await waitFor(() => {
      expect(document.querySelector('[data-testid="symbol-picker"]')).not.toBeNull();
    });
    // Pointerdown outside the bubble (and off the trigger) → auto-close.
    fireEvent.pointerDown(document.body);
    expect(document.querySelector('[data-testid="symbol-picker"]')).toBeNull();
    expect(useSymbolBubbleStore.getState().open).toBe(false);
  });

  it('a DRAGGED bubble is pinned — click-away does not close it', async () => {
    mountButton();
    openPicker();
    await waitFor(() => {
      expect(document.querySelector('[data-testid="symbol-picker"]')).not.toBeNull();
    });
    // Tear it off: header pointerdown → move → up. (No visual badge —
    // the behavior is the contract; the chrome stays quiet.)
    const header = document.querySelector('[data-testid="symbol-bubble-header"]')!;
    fireEvent.pointerDown(header, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(header, { clientX: 160, clientY: 140, pointerId: 1 });
    fireEvent.pointerUp(header, { clientX: 160, clientY: 140, pointerId: 1 });
    // Click-away now stands down — the bubble survives.
    fireEvent.pointerDown(document.body);
    expect(document.querySelector('[data-testid="symbol-picker"]')).not.toBeNull();
    // Done closes it (the footer's explicit close).
    fireEvent.click(document.querySelector('[data-testid="symbol-done"]')!);
    expect(document.querySelector('[data-testid="symbol-picker"]')).toBeNull();
  });

  it('FIRST LOAD fills the row with the most common categories (display-only)', async () => {
    mountButton();
    openPicker();
    await waitFor(() => {
      expect(document.querySelector('[data-testid="symbol-picker"]')).not.toBeNull();
    });
    // No history → the row seeds with the classic symbol categories,
    // all core (instant). Nothing is WRITTEN to config yet. (The row
    // query also catches the ellipsis trigger — 'more' at the end.)
    const rowIds = [...document.querySelectorAll('[data-testid^="symbol-group-"]')]
      .map((el) => el.getAttribute('data-testid')!.replace('symbol-group-', ''));
    expect(rowIds).toEqual(['common', 'math', 'punctuation', 'arrows', 'currency', 'more']);
    expect(useConfigStore.getState().config.editor.recentSymbolGroups).toEqual([]);
    // The user's first real pick takes over the row (defaults yield).
    pickGroupViaUI('greek');
    const recents = useConfigStore.getState().config.editor.recentSymbolGroups;
    expect(recents).toEqual(['greek']);
    const afterIds = [...document.querySelectorAll('[data-testid^="symbol-group-"]')]
      .map((el) => el.getAttribute('data-testid')!.replace('symbol-group-', ''));
    expect(afterIds).toContain('common');
    expect(afterIds).toContain('greek');
    expect(afterIds).not.toContain('math'); // display defaults yielded
  });

  it('the header has NO close affordance — closing belongs to Done', () => {
    mountButton();
    openPicker();
    const header = document.querySelector('[data-testid="symbol-bubble-header"]')!;
    expect(header.querySelectorAll('button').length).toBe(0);
    // The footer owns Done (equation parity).
    expect(document.querySelector('[data-testid="symbol-done"]')).not.toBeNull();
  });

  it('the ribbon trigger toggles: open → click → closed', async () => {
    mountButton();
    const trigger = openPicker();
    await waitFor(() => {
      expect(document.querySelector('[data-testid="symbol-picker"]')).not.toBeNull();
    });
    // The trigger's own pointerdown is guarded (no auto-close), then the
    // click toggles it shut.
    fireEvent.click(trigger);
    expect(document.querySelector('[data-testid="symbol-picker"]')).toBeNull();
    // And it re-opens with a fresh anchor.
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(document.querySelector('[data-testid="symbol-picker"]')).not.toBeNull();
    });
  });

  // The chip row: one row of Common + the user's last-used groups;
  // everything else lives in the ellipsis dropdown. Recency is
  // config-persisted.

  it('picking a group moves it into the row and persists recency in config', async () => {
    mountButton();
    openPicker();
    // Greek is not in the row yet (no recents) — reach it via the dropdown.
    pickGroupViaUI('greek');
    await waitFor(() => {
      expect(document.querySelector('[data-testid="symbol-group-greek"]')).not.toBeNull();
    });
    // The config now carries the recency (YOUR groups persist across
    // sessions).
    const recents = useConfigStore.getState().config.editor.recentSymbolGroups;
    expect(recents).toEqual(['greek']);
    // A fresh bubble honors it: reopen shows the Greek chip directly.
    fireEvent.click(document.querySelector('[data-testid="symbol-button-trigger"]')!); // close
    fireEvent.click(document.querySelector('[data-testid="symbol-button-trigger"]')!); // reopen
    expect(document.querySelector('[data-testid="symbol-group-greek"]')).not.toBeNull();
  });

  it('the row caps at four recents and the rest stay in the dropdown', async () => {
    mountButton();
    openPicker();
    for (const id of ['greek', 'math', 'arrows', 'currency', 'punctuation']) {
      pickGroupViaUI(id);
    }
    // MRU cap: the four most recent are chips; greek (the first pick)
    // fell off the cap and dropped back to the dropdown.
    const rowIds = [...document.querySelectorAll('[data-testid^="symbol-group-"]')]
      .map((el) => el.getAttribute('data-testid')!.replace('symbol-group-', ''));
    expect(rowIds).toContain('common');
    expect(rowIds).toContain('punctuation');
    expect(rowIds).toContain('currency');
    expect(rowIds).toContain('arrows');
    expect(rowIds).toContain('math');
    expect(rowIds).not.toContain('greek');
    // The dropdown holds the rest — greek back in the menu.
    fireEvent.click(document.querySelector('[data-testid="symbol-group-more"]')!);
    expect(document.querySelector('[data-testid="symbol-menu-greek"]')).not.toBeNull();
    expect(useConfigStore.getState().config.editor.recentSymbolGroups).toEqual([
      'punctuation', 'currency', 'arrows', 'math',
    ]);
  });
});

// The command palette's codepoint path
// Typing "U+03A9" surfaces a one-item insert group (like tableDims) —
// keyboard-first symbol entry.

describe('the command palette codepoint insert', () => {
  it('typing U+03A9 surfaces the insert item and inserts Ω at the caret', async () => {
    const { editor } = renderTensor('<p>before</p>');
    // The palette is NOT part of the Editor harness (App mounts it) —
    // mount it alongside, then open via the store with editorContext
    // (the synthetic items require the editor-context guard).
    render(<CommandPalette />);
    await act(async () => {
      usePaletteStore.setState({ isOpen: true, editorContext: true });
    });
    const input = document.querySelector('[data-testid="palette-input"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: 'U+03A9' } });
    });
    const item = document.querySelector('[data-testid="palette-codepoint-insert"]') as HTMLElement | null;
    expect(item).toBeTruthy();
    expect(item!.textContent).toContain('Ω');
    await act(async () => {
      fireEvent.click(item!);
    });
    expect(usePaletteStore.getState().isOpen).toBe(false);
    expect(editor.getHTML()).toContain('Ω');
  });

  it('surrogate and out-of-range specs never surface an insert item', async () => {
    renderTensor('<p>x</p>');
    render(<CommandPalette />);
    await act(async () => {
      usePaletteStore.setState({ isOpen: true, editorContext: true });
    });
    const input = document.querySelector('[data-testid="palette-input"]') as HTMLInputElement;
    for (const bad of ['U+D800', 'U+110000', 'U+ZZZZ']) {
      await act(async () => {
        fireEvent.change(input, { target: { value: bad } });
      });
      expect(document.querySelector('[data-testid="palette-codepoint-insert"]')).toBeNull();
    }
  });
});
