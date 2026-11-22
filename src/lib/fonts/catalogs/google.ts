import {
  CATALOG_LABELS,
  directionFromSubsets,
  pickSlots,
  type CatalogFont,
  type CatalogSource,
  type CatalogDownload,
  type VariantSlots,
} from './types';
import { BROWSER_UA, catalogFetchBytes, catalogFetchText } from './http';
import { normalizeFamilyKey } from './normalize';

/**
 * Google Fonts: search = the fonts.google.com/metadata/fonts list
 * (fetched once per session, cached in-module); download = the css2
 * API's latin woff2 — BROWSER_UA required (css2 serves ttf otherwise).
 */

const METADATA_URL = 'https://fonts.google.com/metadata/fonts';
const CSS2_URL = 'https://fonts.googleapis.com/css2';

interface GoogleMetadataFont {
  family: string;
  displayName: string | null;
  category: string;
  subsets?: string[];
  /** Weight keys: "400", "400i", "700", ... */
  fonts: Record<string, unknown>;
}

interface GoogleMetadata {
  familyMetadataList: GoogleMetadataFont[];
}

let metadataCache: GoogleMetadataFont[] | null = null;
let metadataPromise: Promise<GoogleMetadataFont[]> | null = null;

/** Boot prefetch (when the toggle is ON) + lazy ensure for the first
 *  search. Session-cached; a failure marks the source unavailable
 *  until the next search retries it. */
export async function ensureGoogleMetadata(): Promise<GoogleMetadataFont[]> {
  if (metadataCache) return metadataCache;
  if (metadataPromise) return metadataPromise;
  metadataPromise = (async () => {
    // The endpoint prepends an XSSI-guard )]}' to its JSON.
    const text = await catalogFetchText(METADATA_URL);
    const json = JSON.parse(text.replace(/^\)\]\}'?\s*/, '')) as GoogleMetadata;
    metadataCache = json.familyMetadataList;
    return metadataCache;
  })();
  try {
    return await metadataPromise;
  } catch (err) {
    metadataPromise = null;
    throw err;
  }
}

function weightStyleKeys(f: GoogleMetadataFont): { weight: number; style: 'normal' | 'italic' }[] {
  const out: { weight: number; style: 'normal' | 'italic' }[] = [];
  for (const key of Object.keys(f.fonts ?? {})) {
    const italic = key.endsWith('i');
    const weight = Number(italic ? key.slice(0, -1) : key);
    if (Number.isFinite(weight)) out.push({ weight, style: italic ? 'italic' : 'normal' });
  }
  return out;
}

/** Slot-derived display variants, sorted deterministically (weight,
 *  then style). */
function slotList(slots: VariantSlots): { weight: number; style: 'normal' | 'italic' }[] {
  const out: { weight: number; style: 'normal' | 'italic' }[] = [];
  if (slots.regular != null) out.push({ weight: slots.regular, style: 'normal' });
  if (slots.italic != null) out.push({ weight: slots.italic, style: 'italic' });
  if (slots.bold != null) out.push({ weight: slots.bold, style: 'normal' });
  if (slots.boldItalic != null) out.push({ weight: slots.boldItalic, style: 'italic' });
  return out.sort((a, b) => a.weight - b.weight || (a.style === 'italic' ? 1 : 0) - (b.style === 'italic' ? 1 : 0));
}

/** Parse the css2 response: url(...) of the LATIN subset block per
 *  weight/style. */
export function parseCss2LatinUrls(css: string): { weight: number; style: 'normal' | 'italic'; url: string }[] {
  const out: { weight: number; style: 'normal' | 'italic'; url: string }[] = [];
  // Blocks look like: /* latin */ @font-face { font-family: 'X';
  // font-style: normal; font-weight: 400; src: url(https://...) ... }
  const blockRe = /\/\*\s*latin\s*\*\/\s*@font-face\s*\{([^}]+)\}/g;
  const styleRe = /font-style:\s*(\w+)/;
  const weightRe = /font-weight:\s*(\d+)/;
  const urlRe = /url\((https:\/\/[^\s)]+)\)/;
  for (const match of css.matchAll(blockRe)) {
    const block = match[1]!;
    const style = (styleRe.exec(block)?.[1] ?? 'normal') as 'normal' | 'italic';
    const weight = Number(weightRe.exec(block)?.[1] ?? '400');
    const url = urlRe.exec(block)?.[1];
    if (url) out.push({ weight, style, url });
  }
  return out;
}

/**
 * css2 has two forms: with italics, tuples (ital,wght@0,400;0,700;…);
 * without italics, plain values (wght@400;700) — the tuple form is an
 * HTTP 400 there. Built strictly from the declared slots.
 */
export function css2FamilyQuery(slots: VariantSlots): string {
  const normals = [...new Set([slots.regular, slots.bold].filter((w): w is number => w != null))].sort((a, b) => a - b);
  const italics = [...new Set([slots.italic, slots.boldItalic].filter((w): w is number => w != null))].sort((a, b) => a - b);
  if (italics.length === 0) {
    return `wght@${normals.join(';')}`;
  }
  const tuples = [
    ...normals.map((w) => `0,${w}`),
    ...italics.map((w) => `1,${w}`),
  ];
  return `ital,wght@${tuples.join(';')}`;
}

export function createGoogleSource(): CatalogSource {
  let available = true;
  return {
    id: 'google',
    label: CATALOG_LABELS.google,

    async search(q) {
      try {
        const list = await ensureGoogleMetadata();
        const needle = q.trim().toLowerCase();
        const out: CatalogFont[] = [];
        for (const f of list) {
          const name = f.displayName ?? f.family;
          if (needle && !name.toLowerCase().includes(needle)) continue;
          const slots = pickSlots(weightStyleKeys(f));
          out.push({
            key: normalizeFamilyKey(f.family),
            family: f.family,
            displayName: name,
            sources: ['google'],
            variable: false, // css2 static-face downloads (see download())
            variants: slotList(slots),
            slots,
            direction: directionFromSubsets(f.subsets ?? []),
            ref: f,
          });
        }
        available = true;
        return out.slice(0, 50);
      } catch {
        available = false;
        return [];
      }
    },

    async previewBytes(entry) {
      const urls = await faceUrls(entry);
      const regular = urls.find((u) => u.style === 'normal') ?? urls[0];
      if (!regular) throw new Error(`no google faces for ${entry.family}`);
      return catalogFetchBytes(regular.url, BROWSER_UA);
    },

    async download(entry): Promise<CatalogDownload> {
      const slots = entry.slots ?? pickSlots(entry.variants ?? []);
      const urls = await faceUrls(entry);
      const files: CatalogDownload['files'] = { regular: new Uint8Array() };
      // The regular slot is the declared regular weight — a
      // 500-only family installs its real 500 as regular.
      const regularUrl =
        urls.find((u) => u.style === 'normal' && u.weight === slots.regular)?.url ??
        urls.find((u) => u.style === 'normal')?.url;
      if (!regularUrl) throw new Error(`no regular face from google for ${entry.family}`);
      files.regular = await catalogFetchBytes(regularUrl, BROWSER_UA);
      for (const face of urls) {
        if (face.style === 'normal' && face.weight === slots.regular) continue; // fetched above
        const bytes = await catalogFetchBytes(face.url, BROWSER_UA);
        if (face.style === 'italic') {
          if (face.weight === slots.boldItalic) files.boldItalic = bytes;
          else files.italic = bytes;
        } else if (face.weight === slots.bold) files.bold = bytes;
      }
      return { family: entry.family, variable: false, files };
    },

    isAvailable: () => available,
  };
}

async function faceUrls(entry: CatalogFont) {
  // The request is built only from the declared slots — a 400-only
  // family must never be asked for italics or 700.
  const slots = entry.slots ?? pickSlots(entry.variants ?? []);
  const query = css2FamilyQuery(slots);
  const css = await catalogFetchText(`${CSS2_URL}?family=${encodeURIComponent(entry.family)}:${query}`, BROWSER_UA);
  const urls = parseCss2LatinUrls(css);
  const wanted = new Set(
    [
      [slots.regular, 'normal'],
      [slots.bold, 'normal'],
      [slots.italic, 'italic'],
      [slots.boldItalic, 'italic'],
    ].filter(([w]) => w != null).map(([w, style]) => `${w}|${style}`),
  );
  // Keep only the faces we asked for (css2 emits per-subset blocks;
  // the parser already picked latin).
  return urls.filter((u) => wanted.has(`${u.weight}|${u.style}`));
}

/** Test seam: drop the session metadata cache (never called by app code). */
export function resetForTests(): void {
  metadataCache = null;
  metadataPromise = null;
}
