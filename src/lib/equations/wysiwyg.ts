import type { MathfieldElement } from 'mathlive';

/**
 * M-EQ-2 — the MathLive layer: the WYSIWYG equation editing surface.
 * The document RENDERER stays KaTeX (lib/equations/render.ts — display,
 * measurement, the node views); MathLive is the EDITOR surface only
 * (Word's own split: display engine ≠ input UI).
 *
 * LAZY: the dynamic import resolves on first bubble open — the main
 * bundle never pays for it (Vite code-splits it into its own chunk).
 * The element registers itself at module load (dist check: customElements
 * .define("math-field") at toplevel, guarded by isBrowser()) and
 * `MathfieldElement` is a top-level export — the loader only sets the
 * two static asset directories.
 *
 * THE OFFLINE LAW (the fonts/CDN precedents): MathLive ships the SAME
 * KaTeX_* font families the document renderer already bundles via
 * katex.min.css, and its loader checks `document.fonts` FIRST — every
 * KaTeX_* face is already declared there (CSS Font Loading: declared
 * @font-face rules appear in the FontFaceSet before they load), so
 * MathLive marks fonts ready and never fetches its own. `fontsDirectory
 * = ''` additionally blocks any fallback fetch (there is none to make).
 * Sounds off — no assets, no fetches, no gimmick.
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
    // A REJECTED load clears the memo — the NEXT bubble open retries
    // (a transient chunk failure must not pin source-mode forever; the
    // bubble's per-open fallback still covers each individual failure).
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

// ─── Field configuration ───────────────────────────────────────────────

/**
 * THE `/` FRACTION SHORTCUT (the user-facing core of the WYSIWYG
 * surface): typing `2/3` grows a live stacked fraction. VERIFIED against
 * MathLive 0.111.1's dist: the main-row Slash key has NO default
 * fraction binding (only `[NumpadDivide]` inserts
 * `\frac{#@}{#?}` — the REVERSE_KEYBINDINGS' `"\\frac": "Slash"` entry
 * has no forward counterpart in DEFAULT_KEYBINDINGS), and no bare
 * `"/"` exists in INLINE_SHORTCUTS. So Tensor ADDS it — read-extend-
 * write against the field's DEFAULT shortcut set (`get
 * inlineShortcuts()` returns the defaults while unset; assigning
 * REPLACES wholesale, so the defaults are spread first — never a
 * partial set that would silently lose sqrt/pi/sum/...).
 *
 * `#@` = the token before the cursor (the just-typed `2` becomes the
 * numerator); `#?` = the placeholder slot the caret lands in (the
 * denominator). `after` enumerates the contexts where `/` converts —
 * deliberately WITHOUT `text`, so a literal slash inside \text{}
 * stays literal.
 */
const FRACTION_SLASH_AFTER =
  'nothing+digit+letter+binop+relop+punct+openfence+closefence+frac+surd+space';

export const FRACTION_SLASH_SHORTCUT = {
  value: '\\frac{#@}{#?}',
  after: FRACTION_SLASH_AFTER,
} as const;

/** Configure ONE freshly-mounted field. Called after the element is
 *  ATTACHED (the option accessors throw "Mathfield not mounted"
 *  before connection). */
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
    // DEFAULTS untouched rather than write a partial set — the palette
    // still covers fraction insertion.
  }
}

// ─── MathLive → document latex normalization ──────────────────────────

/**
 * THE ONE BOUNDARY between MathLive's latex and the DOCUMENT's latex.
 * MathLive's serialization carries EDITING-STATE tokens KaTeX cannot
 * parse; committed raw they put the node view in the invalid face —
 * raw source visible in the document (the exact "I see the unrendered
 * version" bug this ruling fixes). The edit-time display keeps its
 * slots (the field re-parses its own tokens on the next open — the
 * round-trip through the node attr is not the field's state).
 *
 * Stripped/mapped (verified against MathLive 0.111.1's serializer):
 *  - `\placeholder{…}` / `\placeholder[…]{…}` — empty-argument slots
 *    (serialized as `\placeholder{}`, dist: "return \"\\\\placeholder{}\"");
 *    an emptied argument renders as an empty slot, exactly what the
 *    document should show mid-edit.
 *  - `\imaginaryI`, `\imaginaryJ`, `\exponentialE`, `\differentialD` —
 *    MathLive-specific spellings for plain upright letters (the
 *    default `ii`/`jj`/`ee` shortcuts emit them; KaTeX knows none).
 *  - `\nicefrac{a}{b}` — MathLive's diagonal fraction (its own
 *    definition; KaTeX lacks it) → the stacked spelling.
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