import type { EquationMetrics, TextMetrics } from '@tensor-editor/engine';

/**
 * Deterministic metrics for the integration suite (injected via the
 * PaginatedView metrics seam). Numbers chosen to tile cleanly against the
 * default Letter pageSetup (816x1056, 96px margins):
 *   content width  624px -> 62 chars/line at 16px font (10px per char)
 *   content height 864px -> 54 lines/page (16px line: 0.8+0.2 ascent/descent)
 */
export const FakeMetrics: TextMetrics = {
  measure: (text, style) => text.length * 10 * (style.fontSize / 16),
  ascent: (style) => 0.8 * style.fontSize,
  descent: (style) => 0.2 * style.fontSize,
};

/** The equation dims port's deterministic double — same 10px/char
 *  shape as the text ruler (jsdom cannot measure DOM, so the real
 *  KaTeX measurer's rects read as zeros there; tests inject this). */
export const FakeEquationMetrics: EquationMetrics = {
  measure: (latex, fontSize) => ({
    width: latex.length * 10 * (fontSize / 16),
    height: fontSize * 1.6,
  }),
};