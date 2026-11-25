import { CATALOG_LABELS, directionFromSubsets, pickSlots, type CatalogFont, type CatalogSource, type CatalogDownload } from './types';
import { catalogFetchBytes, catalogFetchText } from './http';
import { normalizeFamilyKey } from './normalize';

/**
 * Fontsource: metadata = api.fontsource.org/v1/fonts (boot prefetch,
 * session cache, client-side search); files = direct jsDelivr CDN URLs
 * (cdn.jsdelivr.net/npm/@fontsource[/-variable]/<id>/files/…woff2).
 */

const METADATA_URL = 'https://api.fontsource.org/v1/fonts';
const CDN_BASE = 'https://cdn.jsdelivr.net/npm';

interface FontsourceFont {
  id: string;
  family: string;
  subsets?: string[];
  weights: number[];
  styles: string[];
  defSubset: string;
  variable: boolean;
  license: string;
  type: string;
}

let metadataCache: FontsourceFont[] | null = null;
let metadataPromise: Promise<FontsourceFont[]> | null = null;

export async function ensureFontsourceMetadata(): Promise<FontsourceFont[]> {
  if (metadataCache) return metadataCache;
  if (metadataPromise) return metadataPromise;
  metadataPromise = (async () => {
    const text = await catalogFetchText(METADATA_URL);
    metadataCache = JSON.parse(text) as FontsourceFont[];
    return metadataCache;
  })();
  try {
    return await metadataPromise;
  } catch (err) {
    metadataPromise = null;
    throw err;
  }
}

/** The jsDelivr URL for one face. */
export function fontsourceFileUrl(font: FontsourceFont, weight: number, style: 'normal' | 'italic'): string {
  const scope = font.variable ? '@fontsource-variable' : '@fontsource';
  // Variable packages carry the wght axis in the filename, not a
  // weight (e.g. geist-latin-wght-normal.woff2).
  const weightOrAxis = font.variable ? 'wght' : String(weight);
  return `${CDN_BASE}/${scope}/${font.id}/files/${font.id}-${font.defSubset}-${weightOrAxis}-${style}.woff2`;
}

function toCatalogFont(f: FontsourceFont): CatalogFont {
  // Slots built from the declared weights/styles arrays, never a
  // fixed template.
  const declared = f.weights.flatMap((weight) =>
    f.styles.map((style) => ({ weight, style: style as 'normal' | 'italic' })),
  );
  const slots = pickSlots(declared);
  return {
    key: normalizeFamilyKey(f.family),
    family: f.family,
    displayName: f.family,
    sources: ['fontsource'],
    variable: f.variable,
    variants: [
      ...(slots.regular != null ? [{ weight: slots.regular, style: 'normal' as const }] : []),
      ...(slots.italic != null ? [{ weight: slots.italic, style: 'italic' as const }] : []),
      ...(slots.bold != null ? [{ weight: slots.bold, style: 'normal' as const }] : []),
      ...(slots.boldItalic != null ? [{ weight: slots.boldItalic, style: 'italic' as const }] : []),
    ],
    slots,
    license: f.license,
    direction: directionFromSubsets(f.subsets ?? []),
    ref: f,
  };
}

export function createFontsourceSource(): CatalogSource {
  let available = true;
  return {
    id: 'fontsource',
    label: CATALOG_LABELS.fontsource,

    async search(q) {
      try {
        const list = await ensureFontsourceMetadata();
        const needle = q.trim().toLowerCase();
        const out: CatalogFont[] = [];
        for (const f of list) {
          if (needle && !f.family.toLowerCase().includes(needle)) continue;
          out.push(toCatalogFont(f));
        }
        available = true;
        return out.slice(0, 50);
      } catch {
        available = false;
        return [];
      }
    },

    async previewBytes(entry) {
      const font = entry.ref as FontsourceFont;
      // The declared regular slot — a family without 400 previews its
      // real face.
      const weight = entry.slots?.regular ?? font.weights[0] ?? 400;
      return catalogFetchBytes(fontsourceFileUrl(font, weight, 'normal'));
    },

    async download(entry) {
      const font = entry.ref as FontsourceFont;
      const slots = entry.slots ?? pickSlots(font.weights.flatMap((weight) => font.styles.map((style) => ({ weight, style: style as 'normal' | 'italic' }))));
      // The declared regular slot — never a fixed 400.
      const files: CatalogDownload['files'] = {
        regular: await catalogFetchBytes(fontsourceFileUrl(font, slots.regular ?? font.weights[0] ?? 400, 'normal')),
      };
      // A variable family installs as ONE variable face (the wght
      // axis covers bold); static families get exactly the slot
      // faces they declare.
      if (font.variable) {
        if (slots.italic != null) {
          files.italic = await catalogFetchBytes(fontsourceFileUrl(font, slots.italic, 'italic'));
        }
      } else {
        if (slots.bold != null) {
          files.bold = await catalogFetchBytes(fontsourceFileUrl(font, slots.bold, 'normal'));
        }
        if (slots.italic != null) {
          files.italic = await catalogFetchBytes(fontsourceFileUrl(font, slots.italic, 'italic'));
        }
        if (slots.boldItalic != null) {
          files.boldItalic = await catalogFetchBytes(fontsourceFileUrl(font, slots.boldItalic, 'italic'));
        }
      }
      return { family: entry.family, variable: font.variable, files };
    },

    isAvailable: () => available,
  };
}

/** Test seam: drop the session metadata cache (never called by app code). */
export function resetForTests(): void {
  metadataCache = null;
  metadataPromise = null;
}
