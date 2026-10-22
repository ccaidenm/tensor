/**
 * M-EQ-2 — the MathLive loader: the WYSIWYG equation editing surface's
 * ONE gateway. The document RENDERER stays KaTeX (lib/equations/render.ts
 * — display, measurement, the node views); MathLive is the EDITOR
 * surface only (Word's own split: display engine ≠ input UI).
 *
 * LAZY: the dynamic import resolves on first bubble open — the main
 * bundle never pays for it (Vite code-splits it into its own chunk).
 *
 * THE OFFLINE LAW (the fonts/CDN precedents): MathLive ships the SAME
 * KaTeX_* font families the document renderer already bundles via
 * katex.min.css, and its loader checks `document.fonts` FIRST — every
 * KaTeX_* face is already declared there, so MathLive skips its own
 * font pipeline entirely. `fontsDirectory = ''` additionally blocks
 * any CDN fallback fetch (there is none to make: the families are
 * in-document). Sounds off — no assets, no fetches, no gimmick.
 *
 * SHORTCUTS: MathLive's DEFAULT inline shortcut set is kept as-is (it
 * replaces wholesale if overridden — never pass a partial set): typing
 * `sqrt`, `pi`, `alpha`, `oo`, `sum`, `int`, function names all expand
 * live, and smart-mode typing turns `/` into a fraction with the
 * preceding atoms as numerator. The virtual-keyboard-style structural
 * inserts (`\frac{#@}{#?}` — selection into slot 1, caret into the
 * `#?` placeholder) ride `mf.executeCommand(['insert', ...])` from the
 * palette (catalogs.ts `mf` forms).
 */

type MathLiveModule = typeof import('mathlive');

let loadPromise: Promise<MathLiveModule> | null = null;

export function loadMathLive(): Promise<MathLiveModule> {
  if (!loadPromise) {
    loadPromise = import('mathlive').then((ml) => {
      // The static config: set once, before any <math-field> mounts.
      ml.MathfieldElement.fontsDirectory = '';
      ml.MathfieldElement.soundsDirectory = '';
      return ml;
    });
  }
  return loadPromise;
}

/** Test seam: forget the memoized load (module reset between suites). */
export function resetMathLiveLoader(): void {
  loadPromise = null;
}

export type { MathLiveModule };
