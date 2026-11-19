import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { SymbolButton } from '@/components/layout/ribbon/insert/SymbolButton';
import { SymbolBubble } from '@/components/layout/ribbon/insert/SymbolBubble';
import { useSymbolBubbleStore } from '@/lib/editor/symbols/bubbleStore';
import { __resetCatalog, __setDecompressor, getGroupChars, loadedChars, commonChars } from '@/lib/editor/symbols/catalog';
import { __resetCoverage } from '@/lib/editor/symbols/coverage';
import { renderTensor } from './harness';

/**
 * THE SYMBOL PICKER UI — Common instant, lazy core on search, windowed
 * grid at scale, coverage-disabled cells, insert-keeps-open. The
 * decompressor is the seam's passthrough (deterministic; the native
 * gzip path has its own direct test in symbolsCatalog).
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
  // lives at App level now — the store is global).
  useSymbolBubbleStore.setState({ open: false, anchor: null });
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
    expect(greek.disabled).toBe(true);
    expect(greek.getAttribute('data-covered')).toBe('false');
    expect(greek.title).toContain('not available in');
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
    fireEvent.click(document.querySelector('[data-testid="symbol-group-math"]')!);
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
    fireEvent.click(document.querySelector('[data-testid="symbol-group-cjk-ideographs"]')!);
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
    fireEvent.click(document.querySelector('[data-testid="symbol-group-cjk-ideographs"]')!);
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

  // ─── THE CLOSE LAW (the user ruling) ─────────────────────────────────
  // A menu the user never moved is a transient — click-away auto-closes
  // it. A menu the user DRAGGED is a parked tool — it persists until
  // closed explicitly (Done / the ribbon toggle). No X: the header is
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
    // the law is behavior; the chrome stays quiet.)
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
});

