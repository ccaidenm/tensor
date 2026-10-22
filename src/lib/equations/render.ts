import katex from 'katex';

/**
 * M-EQ-0 — the ONE KaTeX surface. Every render of equation math in the
 * app goes through here (node views, the EquationLayer, the editor
 * popover's preview, the palette glyphs) — one options set, one cache,
 * never a second spelling.
 *
 * LIBRARY RECEIPT (the issue's evaluation): KaTeX over MathJax v3 —
 * ~78KB gz JS + per-family woff2 fonts vs ~280KB gz and an async
 * typesetting pipeline; a SYNCHRONOUS string-in/string-out API (a node
 * view re-renders on every keystroke — async typesetting cannot);
 * print-grade TeX output; and the default 'htmlAndMathml' output ships
 * a visually-hidden MathML copy beside the HTML — the a11y receipt the
 * hidden-input mirror relies on (the M5 Orca law's equation arm),
 * free. MathJax's advantages (speech rules, MathML-first) don't buy
 * back that weight in an editor node view.
 *
 * OFFLINE LAW (the media/privacy precedents): KaTeX and its fonts are
 * bundled from npm — katex.min.css is imported once in index.css and
 * Vite hashes its font urls into the build. NO CDN, ever; trust: false
 * disables \href/\includegraphics so a formula can never reach out.
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
 *  the source parses. A separate throw-catch call (the doc render uses
 *  throwOnError: false so the DOCUMENT never crashes on bad input —
 *  the invalid state is the editor's to surface, the node view paints
 *  its own styled invalid face). Memoized: validation runs on every
 *  keystroke in the source input. */
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