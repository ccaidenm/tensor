/**
 * The cross-source dedupe key: one family arriving from several
 * sources = one CatalogFont with a chip per source. Variable-suffixed
 * names ("Lora Variable") normalize to the static family.
 */

export function normalizeFamilyKey(family: string): string {
  return family
    .toLowerCase()
    .replace(/\s+variable(\s+italic)?$/i, '') // "Lora Variable" → "lora"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
