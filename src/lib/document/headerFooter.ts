/**
 * M-HEADER-FOOTER-2 — the header/footer SETTINGS model.
 *
 * SPLIT (the unified-pipeline ruling): CONTENT (the paragraphs) rides
 * the ONE PM document as doc-level `headerBlock`/`footerBlock` nodes
 * (lib/editor/HeaderFooterNodes.ts) — .wpdoc docJSON, the hidden input
 * view, the engine pipeline — while these DOCUMENT-WIDE SETTINGS ride
 * .wpdoc metadata (the optional-field precedent). The old per-region
 * JSON docs are GONE; the region editors are GONE.
 *
 * UNITS NOTE (the pageSetup.ts law): settings carry no geometry. The
 * band anchor (36pt from the page edge) is the ENGINE's fact
 * (BAND_ANCHOR_PX) — the shell never re-derives it.
 */

export interface HeaderFooterSettings {
  /** Scope tag — the seam the sections milestone grows into. */
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
 * The legacy v1 model (M-HEADER-FOOTER-1): per-region TipTap JSON docs.
 * Recognized ONLY by the open path's one-time migration (below) — the
 * live model never holds region content.
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