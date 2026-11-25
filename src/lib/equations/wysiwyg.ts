import type { MathfieldElement } from 'mathlive';

/**
 * The MathLive layer: the WYSIWYG editing surface only — the document
 * renderer stays KaTeX. The dynamic import resolves on first bubble open;
 * fontsDirectory = '' and soundsDirectory = '' block every asset fetch.
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
    // A rejected load clears the memo — the next bubble open retries
    // (a transient chunk failure must not pin source-mode forever).
    loadPromise.catch(() => {
      loadPromise = null;
    });
  }
  return loadPromise;
}

/** Test seam: forget the memoized load (module reset between suites). */
export function resetMathLiveLoader(): void {
  loadPromise = null;
}

export type { MathLiveModule };

// ── Field configuration ─────────────────────────────────────────────

/**
 * Assigning inlineShortcuts replaces wholesale — spread the defaults
 * first; `after` deliberately omits `text` so a literal slash inside
 * \text{} stays literal.
 */
const FRACTION_SLASH_AFTER =
  'nothing+digit+letter+binop+relop+punct+openfence+closefence+frac+surd+space';

export const FRACTION_SLASH_SHORTCUT = {
  value: '\\frac{#@}{#?}',
  after: FRACTION_SLASH_AFTER,
} as const;

/** Configure one freshly-mounted field. The option accessors throw
 *  "Mathfield not mounted" before the element is attached. */
export function configureMathField(mf: MathfieldElement): void {
  mf.menuItems = [];
  mf.smartMode = true;
  mf.smartFence = true;
  mf.smartSuperscript = true;
  try {
    mf.inlineShortcuts = {
      ...mf.inlineShortcuts,
      '/': FRACTION_SLASH_SHORTCUT,
    };
  } catch {
    // The getter unexpectedly unavailable (exotic build): keep the
    // defaults untouched rather than write a partial set.
  }
}

// ── MathLive → document latex normalization ─────────────────────────

/**
 * The one boundary between MathLive's latex and the document's: the
 * serializer emits editing-state tokens KaTeX cannot parse — stripped
 * or mapped below so committed latex always renders.
 */
const PLACEHOLDER_RE = /\\placeholder(?:\[[^[\]]*\])?\{[^{}]*\}/g;
const COMMAND_MAP: [RegExp, string][] = [
  [/\\imaginaryI/g, 'i'],
  [/\\imaginaryJ/g, 'j'],
  [/\\exponentialE/g, 'e'],
  [/\\differentialD/g, 'd'],
  [/\\nicefrac\{([^{}]*)\}\{([^{}]*)\}/g, '\\frac{$1}{$2}'],
];

export function sanitizeMathliveLatex(latex: string): string {
  let out = latex.replace(PLACEHOLDER_RE, '');
  for (const [re, replacement] of COMMAND_MAP) {
    out = out.replace(re, replacement);
  }
  return out;
}