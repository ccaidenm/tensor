/**
 * #97 BRANDING — THE ACCENT CATALOG: Tensor's twelve brand accents.
 * ONE SOURCE for the whole app: the config schema's enum, the token
 * writer in the config store, the (#102) picker UI, and the logo
 * assets all read from here — a second list anywhere is the drift bug
 * this module exists to prevent.
 *
 * THE MODEL (the brand's ruling): one hex per accent, applied in BOTH
 * light and dark modes (no per-mode variant); the foreground ink is
 * LUMINANCE-PICKED per accent and shipped as data (explicit and
 * reviewable, not runtime math) — the pale accents (azure, emerald,
 * gold, graphite, pink, teal) get the app's dark ink on top so
 * button/selected text stays readable; the deep accents keep white.
 *
 * ASSET PARITY: every accent has its matching 1024px logo at
 * public/tensor-logos/tensor-icon-<id>.png (pinned by test) — the
 * app icon set generates from ember, and the in-app logo marks ride
 * the CSS tokens instead (crisper at UI sizes), so the files are the
 * asset source of truth the catalog stays aligned with.
 */

export interface AccentDefinition {
  id: string;
  label: string;
  /** The brand hex, applied as --primary in both modes. */
  hex: string;
  /** The accent's readable foreground: 'white' (deep accents) or 'ink'
   *  (the app's dark foreground token — the pale accents). */
  foreground: 'white' | 'ink';
}

export const ACCENTS = [
  { id: 'ember', label: 'Ember', hex: '#ed5f27', foreground: 'white' },
  { id: 'azure', label: 'Azure', hex: '#38bdf8', foreground: 'ink' },
  { id: 'cobalt', label: 'Cobalt', hex: '#5c8af5', foreground: 'white' },
  { id: 'emerald', label: 'Emerald', hex: '#10b981', foreground: 'ink' },
  { id: 'gold', label: 'Gold', hex: '#fbbf24', foreground: 'ink' },
  { id: 'graphite', label: 'Graphite', hex: '#a1a8b0', foreground: 'ink' },
  { id: 'indigo', label: 'Indigo', hex: '#7c83f6', foreground: 'white' },
  { id: 'orchid', label: 'Orchid', hex: '#cf5ce8', foreground: 'white' },
  { id: 'pink', label: 'Pink', hex: '#f472b6', foreground: 'ink' },
  { id: 'rose', label: 'Rose', hex: '#fb5266', foreground: 'white' },
  { id: 'teal', label: 'Teal', hex: '#14b8a6', foreground: 'ink' },
  { id: 'violet', label: 'Violet', hex: '#9a63f8', foreground: 'white' },
] as const satisfies readonly AccentDefinition[];

export type AccentId = (typeof ACCENTS)[number]['id'];

/** The ids as a zod-enum-ready tuple (literal-typed). */
export const ACCENT_IDS = ACCENTS.map((a) => a.id) as [AccentId, ...AccentId[]];

export const ACCENTS_BY_ID: Record<AccentId, AccentDefinition> = Object.fromEntries(
  ACCENTS.map((a) => [a.id, a]),
) as Record<AccentId, AccentDefinition>;

/** Ember is Tensor — the default accent (the catalog's first entry). */
export const DEFAULT_ACCENT_ID: AccentId = 'ember';

/** The matching logo asset for an accent (public/ is served at root). */
export const accentLogoPath = (id: AccentId): string => `/tensor-logos/tensor-icon-${id}.png`;
