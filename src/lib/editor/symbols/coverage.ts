/**
 * FONT COVERAGE — a char is "covered" only when the canvas renders it
 * DIFFERENTLY from a known-missing glyph (U+10FFF7) in the SAME stack:
 * same width = tofu. LAZY, cached, batched — no 150k pre-pass.
 */

const REFERENCE_MISSING_CHAR = '\u{10FFF7}'; // high private use — no real font ships a glyph
const MEASURE_FONT = '72px '; // large enough that sub-pixel rounding can't alias widths

const coverageCache = new Map<string, boolean>();
let ctx: CanvasRenderingContext2D | null | undefined;

function measureContext(): CanvasRenderingContext2D | null {
  if (ctx !== undefined) return ctx;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 10;
    canvas.height = 10;
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null;
  }
  return ctx;
}

function measureWidth(fontStack: string, char: string): number {
  const c = measureContext();
  if (!c) return -1;
  c.font = `${MEASURE_FONT} ${fontStack}`;
  return c.measureText(char).width;
}

/** Is `char` renderable by `fontStack` (a CSS font-family list)?
 *  Synchronous + cached; measures in "<font>, sans-serif" (the full
 *  fallback chain) — covered = width ≠ the KNOWN-MISSING reference
 *  glyph's width in the same stack (equal = tofu). */
export function isGlyphCovered(fontStack: string, char: string): boolean {
  const key = `${fontStack}\u0000${char}`;
  const cached = coverageCache.get(key);
  if (cached !== undefined) return cached;
  const c = measureContext();
  if (!c) return true; // no canvas (tests/degraded) — assume covered, never block
  const stack = `${fontStack}, sans-serif`;
  const width = measureWidth(stack, char);
  const refWidth = measureWidth(stack, REFERENCE_MISSING_CHAR);
  const covered = width > 0 && width !== refWidth;
  coverageCache.set(key, covered);
  return covered;
}

/** The active font for insertion: the cursor's font-family mark, else
 *  the app default (the panel passes both; this resolves). */
export function activeFontStack(selectionFontFamily: string | undefined, defaultFamily: string): string {
  const fromMark = selectionFontFamily?.split(',')[0]?.replace(/["']/g, '').trim();
  return fromMark || defaultFamily || 'sans-serif';
}

/** Test seam: clear the cache (mocked-canvas tests re-seed widths). */
export function __resetCoverage(): void {
  coverageCache.clear();
  ctx = undefined;
}
