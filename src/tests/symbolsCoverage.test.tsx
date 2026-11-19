import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isGlyphCovered, activeFontStack, __resetCoverage } from '@/lib/editor/symbols/coverage';

/**
 * FONT COVERAGE — the canvas glyph heuristic, verified against MOCKED
 * canvas measurements that simulate real fonts: a Latin-only font, an
 * everything-is-tofu font, and a full font. The reference-glyph
 * comparison is what makes this "genuinely accurate, not assumed".
 */

let measureCalls = 0;

/** Simulated font stacks, keyed by the CSS font string the coverage
 *  layer sets (it measures ONE composite stack per check:
 *  "<font>, sans-serif", char + the missing reference):
 *   - LatinOnly: BMP Latin renders 40px; everything else + the missing
 *     reference renders 30px (tofu).
 *   - TofuFont: EVERY char — reference included — renders 30px (the
 *     lying font the reference signal exists to catch).
 *   - FullFont: chars render 40px, the reference 20px (a real font's
 *     notdef has its own width).
 *   - SystemFallback (the user-ruling semantics): EVERY renderable
 *     char gets 40px and the reference 20px — a fontconfig-style
 *     chain that finds SOME font on disc for almost everything. */
function mockCanvas(): void {
  measureCalls = 0;
  const realGet = HTMLCanvasElement.prototype.getContext;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, kind: string) {
    if (kind !== '2d') return realGet.call(this, kind);
    const state = { font: '' };
    return {
      set font(value: string) { state.font = value; },
      get font() { return state.font; },
      measureText: (char: string) => {
        measureCalls++;
        const stack = state.font;
        const cp = char.codePointAt(0)!;
        if (stack.includes('TofuFont')) return { width: 30 };
        if (stack.includes('FullFont')) return { width: char === '\u{10FFF7}' ? 20 : 40 };
        if (stack.includes('SystemFallback')) return { width: char === '\u{10FFF7}' ? 20 : 40 };
        if (stack.includes('LatinOnly')) {
          // BMP Latin-ish covered; astral + Greek + the missing reference tofu.
          if (char === '\u{10FFF7}') return { width: 30 };
          return cp < 0x250 ? { width: 40 } : { width: 30 };
        }
        return { width: 30 };
      },
    } as unknown as CanvasRenderingContext2D;
  });
}

beforeEach(() => {
  __resetCoverage();
  vi.restoreAllMocks();
  mockCanvas();
});

describe('the coverage heuristic', () => {
  it('a Latin-only font covers Latin, uncovers Greek/astral', () => {
    expect(isGlyphCovered('LatinOnly', 'é')).toBe(true);
    expect(isGlyphCovered('LatinOnly', 'Ω')).toBe(false);
    expect(isGlyphCovered('LatinOnly', '😀')).toBe(false);
  });

  it('an everything-is-tofu font uncovers EVERYTHING (the reference comparison)', () => {
    expect(isGlyphCovered('TofuFont', 'é')).toBe(false);
    expect(isGlyphCovered('TofuFont', 'Ω')).toBe(false);
    expect(isGlyphCovered('FullFont', 'é')).toBe(true);
    expect(isGlyphCovered('FullFont', '😀')).toBe(true);
  });

  it('THE SYSTEM-FALLBACK SEMANTICS — a fontconfig-style chain covers what ANY disc font renders', () => {
    // The user ruling: availability = any font on the system has the
    // glyph, not just the cursor's font. The composite stack's
    // fallback chain finds glyphs for Greek, math, emoji alike.
    expect(isGlyphCovered('SystemFallback', 'Ω')).toBe(true);
    expect(isGlyphCovered('SystemFallback', '∑')).toBe(true);
    expect(isGlyphCovered('SystemFallback', '😀')).toBe(true);
  });

  it('caches per font+char — one measurement per pair', () => {
    isGlyphCovered('LatinOnly', 'é');
    const afterFirst = measureCalls;
    isGlyphCovered('LatinOnly', 'é');
    isGlyphCovered('LatinOnly', 'é');
    expect(measureCalls).toBe(afterFirst); // cache hit: no new measurements
    isGlyphCovered('FullFont', 'é'); // same char, other font → measures
    expect(measureCalls).toBe(afterFirst + 2); // char + reference
  });

  it('without a canvas it assumes covered (never blocks the picker)', () => {
    vi.restoreAllMocks();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null as unknown as CanvasRenderingContext2D);
    __resetCoverage();
    expect(isGlyphCovered('Anything', 'Ω')).toBe(true);
  });
});

describe('the active font', () => {
  it('prefers the selection mark, falls back to the default', () => {
    expect(activeFontStack('"Crimson Pro", serif', 'system-ui')).toBe('Crimson Pro');
    expect(activeFontStack(undefined, 'system-ui')).toBe('system-ui');
    expect(activeFontStack('', '')).toBe('sans-serif');
  });
});
