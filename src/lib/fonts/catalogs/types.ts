/**
 * The online catalog seam: search, preview, download — then register
 * via registerFont(). privacy.allowFontCatalogs gates all of it:
 * OFF → no adapters are constructed and zero fetches happen.
 */

export type CatalogId = 'google' | 'fontshare' | 'fontsource';

export const CATALOG_LABELS: Record<CatalogId, string> = {
  google: 'Google Fonts',
  fontshare: 'Font Share',
  fontsource: 'Fontsource',
};

/** The byte-level download a catalog can provide for one family,
 *  shaped to land directly on FontEntry.files. */
export interface CatalogDownload {
  /** CSS family name (the editable confirm dialog may change it). */
  family: string;
  variable: boolean;
  files: { regular: Uint8Array; bold?: Uint8Array; italic?: Uint8Array; boldItalic?: Uint8Array };
}

export interface CatalogSource {
  id: CatalogId;
  label: string;
  /** Search must never throw — failures degrade to an empty result
   *  and mark the source unavailable. */
  search(q: string): Promise<CatalogFont[]>;
  /** One regular-face file's bytes — for the lazy single-slot preview. */
  previewBytes(entry: CatalogFont): Promise<Uint8Array>;
  /** All faces the family offers, as bytes. */
  download(entry: CatalogFont): Promise<CatalogDownload>;
  /** False after a failed request this session — the UI mutes the
   *  chip. Resets on next attempt. */
  isAvailable(): boolean;
}

export interface CatalogFont {
  /** normalizeFamilyKey(family) — the cross-source dedupe key. */
  key: string;
  family: string;
  displayName: string;
  sources: CatalogId[];
  variable: boolean;
  variants?: { weight: number; style: 'normal' | 'italic' }[];
  /** The declared faces — request/download builders consume these,
   *  never a fixed template. */
  slots?: VariantSlots;
  license?: string;
  /** Script direction for the LTR/RTL badge — derived from the
   *  source's subsets (arabic/hebrew → rtl); default ltr. */
  direction?: 'ltr' | 'rtl';
  /** Implementation detail for the adapter's own download path. */
  ref?: unknown;
}

/** arabic/hebrew subsets → rtl; everything else ltr. */
export function directionFromSubsets(subsets: readonly string[]): 'ltr' | 'rtl' {
  return subsets.some((s) => s === 'arabic' || s === 'hebrew') ? 'rtl' : 'ltr';
}

/**
 * The faces a family declares: variant requests build only from
 * these, never a fixed template — bold only when the family declares
 * 700 (no synthesis); a 400-only family downloads one regular face.
 */
export interface VariantSlots {
  regular?: number;
  bold?: number;
  italic?: number;
  boldItalic?: number;
}

export function pickSlots(declared: { weight: number; style: 'normal' | 'italic' }[]): VariantSlots {
  const normals = declared.filter((v) => v.style === 'normal').map((v) => v.weight).sort((a, b) => a - b);
  const italics = declared.filter((v) => v.style === 'italic').map((v) => v.weight).sort((a, b) => a - b);
  return {
    regular: normals.includes(400) ? 400 : normals[0],
    bold: normals.includes(700) ? 700 : undefined,
    italic: italics.length ? (italics.includes(400) ? 400 : italics[0]) : undefined,
    boldItalic: italics.includes(700) ? 700 : undefined,
  };
}
