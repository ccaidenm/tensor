import katex from 'katex';

/**
 * The one KaTeX surface: every equation render goes through here (one
 * options set, one cache). Synchronous (node views re-render per
 * keystroke); bundled, no CDN, trust: false so formulas never reach out.
 */

export const KATEX_RENDER_OPTIONS = {
  displayMode: true,
  throwOnError: false,
  // strict: false — the unicode-text-in-math-mode warnings log to the
  // console per keystroke otherwise; a user-typed formula must never
  // spam the devtools.
  strict: false,
  trust: false,
  output: 'htmlAndMathml',
} as const;

const INLINE_KATEX_RENDER_OPTIONS = {
  ...KATEX_RENDER_OPTIONS,
  displayMode: false,
} as const;

/** renderToString result cache — equations re-render on every attr
 *  write (per keystroke while the editor is open); KaTeX parse+render
 *  is the hot path, so identical latex is served from the cache. */
const renderCache = new Map<string, string>();
const RENDER_CACHE_MAX = 600;

export function renderEquation(latex: string): string {
  const hit = renderCache.get(latex);
  if (hit !== undefined) return hit;
  const html = katex.renderToString(latex, KATEX_RENDER_OPTIONS);
  if (renderCache.size >= RENDER_CACHE_MAX) renderCache.clear();
  renderCache.set(latex, html);
  return html;
}

const inlineCache = new Map<string, string>();

/** Inline math (displayMode: false) — the palette glyph renderer only.
 *  Document equations are always display-mode blocks. */
export function renderInlineMath(latex: string): string {
  const hit = inlineCache.get(latex);
  if (hit !== undefined) return hit;
  const html = katex.renderToString(latex, INLINE_KATEX_RENDER_OPTIONS);
  if (inlineCache.size >= RENDER_CACHE_MAX) inlineCache.clear();
  inlineCache.set(latex, html);
  return html;
}

/** Validation for the editor UI: the ParseError message, or null when
 *  the source parses. Separate from the doc render (throwOnError: false
 *  there means the document never crashes on bad input). Memoized. */
const parseCache = new Map<string, string | null>();

export function parseEquation(latex: string): string | null {
  const hit = parseCache.get(latex);
  if (hit !== undefined) return hit;
  let message: string | null = null;
  try {
    katex.renderToString(latex, { ...KATEX_RENDER_OPTIONS, throwOnError: true });
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  if (parseCache.size >= RENDER_CACHE_MAX) parseCache.clear();
  parseCache.set(latex, message);
  return message;
}