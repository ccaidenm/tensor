/**
 * Document-wide header/footer settings; the content rides the PM
 * document as `headerBlock`/`footerBlock` nodes (HeaderFooterNodes.ts).
 * Settings carry no geometry — the band anchor is the engine's fact.
 */

export interface HeaderFooterSettings {
  /** Scope tag — reserved as the seam for future section-level scoping. */
  scope: { kind: 'document' };
  /** Page 1 paints the first* variant nodes; other pages the defaults. */
  differentFirstPage: boolean;
}

export function defaultHeaderFooterSettings(): HeaderFooterSettings {
  return {
    scope: { kind: 'document' },
    differentFirstPage: false,
  };
}

/** Deep copy (load/save isolation — settings are plain data). */
export function cloneHeaderFooterSettings(s: HeaderFooterSettings): HeaderFooterSettings {
  return {
    scope: { ...s.scope },
    differentFirstPage: s.differentFirstPage,
  };
}

/**
 * The legacy v1 model: per-region TipTap JSON docs, recognized only
 * by the open path's one-time migration — the live model never holds
 * region content.
 */
export interface LegacyHeaderFooterSettings {
  headerEnabled?: boolean;
  footerEnabled?: boolean;
  differentFirstPage?: boolean;
  /** The v1 per-region content docs (TipTap JSON). */
  header?: { doc?: unknown } | null;
  footer?: { doc?: unknown } | null;
  firstHeader?: { doc?: unknown } | null;
  firstFooter?: { doc?: unknown } | null;
}

/** The discriminator: the v1 shape carried per-region content docs. */
export function isLegacyHeaderFooter(value: unknown): value is LegacyHeaderFooterSettings {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return 'header' in v || 'footer' in v || 'firstHeader' in v || 'firstFooter' in v;
}