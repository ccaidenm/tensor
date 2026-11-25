import { catalogsAllowed } from './http';
import { normalizeFamilyKey } from './normalize';
import { createGoogleSource, ensureGoogleMetadata } from './google';
import { createFontsourceSource, ensureFontsourceMetadata } from './fontsource';
import { createFontShareSource } from './fontshare';
import { ensureBrandMarks } from './brandMarks';
import type { CatalogFont, CatalogSource, CatalogId } from './types';

/**
 * The catalog index — the dialog's only import surface. PRIVACY GATE:
 * getCatalogSources() returns [] while the toggle is OFF and the http
 * wrapper refuses every fetch besides (defense in depth).
 */

const sourceOrder: CatalogId[] = ['google', 'fontshare', 'fontsource'];

export function getCatalogSources(): CatalogSource[] {
  if (!catalogsAllowed()) return [];
  return sourceOrder.map((id) =>
    id === 'google' ? createGoogleSource() : id === 'fontshare' ? createFontShareSource() : createFontsourceSource(),
  );
}

/** Boot prefetch when the toggle is ON: warm the session caches.
 *  Failures are silent — search marks sources unavailable on use. */
export async function prefetchCatalogs(): Promise<void> {
  if (!catalogsAllowed()) return;
  // Metadata lists + brand favicons — one round each per opted-in session.
  await Promise.allSettled([
    ensureGoogleMetadata(),
    ensureFontsourceMetadata(),
    ensureBrandMarks(),
  ]);
}

export interface CatalogSearchResult {
  /** Deduped across sources; sources[] chips in preference order. */
  fonts: MergedCatalogFont[];
  /** Per-source availability for the muted-chip UI. */
  unavailable: CatalogId[];
}

/** A deduped entry carrying each source's OWN catalog font — the
 *  download path dispatches on the user's source choice. */
export interface MergedCatalogFont extends CatalogFont {
  perSource: Partial<Record<CatalogId, CatalogFont>>;
}

/** Search every source; merge on the normalized family key. Each
 *  source's failure degrades to a muted chip — never blocks the others. */
export async function searchCatalogs(sources: CatalogSource[], q: string): Promise<CatalogSearchResult> {
  const results = await Promise.all(
    sources.map(async (source) => ({ source, fonts: await source.search(q) })),
  );
  const unavailable: CatalogId[] = results.filter((r) => !r.source.isAvailable()).map((r) => r.source.id);

  const merged = new Map<string, MergedCatalogFont>();
  for (const { source, fonts } of results) {
    for (const font of fonts) {
      const key = normalizeFamilyKey(font.family);
      const existing = merged.get(key);
      if (existing) {
        // Union the chips (preference order preserved); each source's
        // own entry rides perSource — the user's chip choice decides.
        for (const id of font.sources) {
          if (!existing.sources.includes(id)) existing.sources.push(id);
        }
        existing.perSource[source.id] ??= font;
      } else {
        merged.set(key, { ...font, key, sources: [...font.sources], perSource: { [source.id]: font } });
      }
    }
  }
  const list = [...merged.values()];
  // Entries carried by MORE sources rank first (the familiar ones).
  list.sort((a, b) => b.sources.length - a.sources.length || a.family.localeCompare(b.family));
  return { fonts: list.slice(0, 60), unavailable };
}
