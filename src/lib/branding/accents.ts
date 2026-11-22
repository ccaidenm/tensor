/**
 * #97 — Tensor's twelve brand accents: the ONE source for the config
 * enum, the store's token writer, the picker UI, and the logo assets
 * (a second list anywhere is the drift this prevents). One hex per
 * accent in both modes; foreground ink is luminance-picked and shipped
 * as data. Every accent has a matching logo in public/tensor-logos/.
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
