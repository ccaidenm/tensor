/**
 * FONT COVERAGE — does the user's active font actually have a glyph for
 * this character, or would it render a tofu box?
 *
 * THE HEURISTIC (canvas-based, the issue's implementation note, hardened
 * against lying fonts): a char is "covered" only when the canvas renders
 * it DIFFERENTLY from a known-missing glyph IN THE SAME FONT STACK. Two
 * measurements per char:
 *
 *   1. width in "<font>, <generic fallback>"
 *   2. width of a known-never-glyph reference char (U+10FFF7, private
 *      use high plane — no font ships it) in the same stack
 *
 * If (1) equals (2), the font "rendered" our char the same way it
 * renders missing glyphs — i.e. tofu. If they differ, the font drew a
 * real glyph. This catches the classic failure where a font maps every
 * codepoint to an identical notdef box (then width 1 == width 2) AND
 * the classic false-negative where the fallback font happens to supply
 * the char (widths differ, but not via <font> — acceptable: the user
 * WOULD see a real glyph, which is what the check is for).
 *
 * SCALE LAW: checks are LAZY (only cells the picker shows), CACHED per
 * font+char forever, and batched through a rAF queue — a 150k pre-pass
 * never happens, a visible window of ~100 cells measures in ~1ms.
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
 *  Synchronous + cached — the picker calls this per visible cell.
 *
 *  THE SYSTEM-FALLBACK SEMANTICS (the user ruling): a character is
 *  available when ANY font that would actually render it — the active
 *  font OR anything in the system's fallback chain — has a real glyph.
 *  The canvas measures in the composite "<activeFont>, sans-serif"
 *  stack, which is precisely that chain: WebKit/fontconfig walks
 *  every font on disc behind it. ONE comparison decides:
 *
 *    covered  =  the char's width ≠ the KNOWN-MISSING reference glyph's
 *                width in the SAME stack (the reference is a plane-15
 *  private-use codepoint no font ships — its width IS the tofu box).
 *
 *  (The earlier fallback-agreement signal — comparing monospace vs
 *  serif fallback widths — was WRONG on real systems: when the active
 *  font lacks a glyph, fontconfig picks different real fonts for the
 *  two generic fallbacks, the widths diverge, and perfectly renderable
 *  characters got marked unavailable. The reference comparison alone
 *  asks the only question that matters: did the chain draw tofu?) */
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
