// Package-root import only — deep '@tensor-editor/engine/src/*' imports are
// banned by the ESLint no-restricted-imports rule (they bypass the package
// contract and break the moment the engine ships compiled artifacts).
import type { LayoutOptions } from '@tensor-editor/engine';

export interface PageDimensions {
  width: number;
  height: number;
}

export interface Margins {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PageSetup {
  pageSize: string;
  margins: Margins;
  pageGap: number;
  /**
   * The document's preferred rendering mode ('pages' or 'pageless').
   * Absent = the app default (config.editor.defaultPageLayout) governs;
   * once set the doc owns its choice (the toggle writes here, marking
   * it dirty). resolveViewMode() is the one resolver.
   */
  viewMode?: 'pages' | 'pageless';
  /** 'landscape' swaps the page size's width/height for layout. */
  orientation?: 'portrait' | 'landscape';
  /** Per-document page background; '' = white. Persisted in .wpdoc metadata. */
  pageColor?: string;
  /** When pageSize === 'custom': the user-defined dimensions in POINTS. */
  customWidth?: number;
  customHeight?: number;
  /**
   * The document-level widow/orphan default (Word's Compatibility
   * option): true/absent = protection on; false = natural splits
   * where a paragraph doesn't override via its own flow.
   */
  widowControl?: boolean;
  /**
   * The decorative page overlay ("DRAFT", "CONFIDENTIAL", an image),
   * painted behind content on every page. Paint-only ink — never
   * enters toLayoutOptions. Per-section watermarks ride the
   * sectionBreak mechanism. null = none.
   */
  watermark?: WatermarkSettings | null;
  /**
   * #74 — the document-level column spec; rides toLayoutOptions
   * (layout, not paint). Per-section columns ride the sectionBreak
   * mechanism. null ≡ absent ≡ one column (mapped to undefined at the
   * boundary); the engine validates loudly.
   */
  columns?: ColumnSetup | null;
}

/**
 * #74 — the setup spelling of the column spec. Persisted measurements
 * are points (toLayoutOptions converts the gap to px). `widths` are
 * absolute per-column pt widths, consumed by the engine as relative
 * weights, so pt passes verbatim.
 */
export interface ColumnSetup {
  /** Column count, integer ≥ 1; 1 ≡ one column (clears). */
  count: number;
  /** POINTS between neighboring columns; absent = Word's 0.5" (36pt). */
  gap?: number;
  /** Absolute per-column widths in POINTS (unequal columns). */
  widths?: number[];
  /** Balance the section's last-page column heights. Default true. */
  balanced?: boolean;
}

/**
 * The watermark's two spellings. Every field is absent = default;
 * resolveWatermark is the one derivation all consumers use. Text
 * defaults to Word's own look; image defaults to horizontal at half
 * the page width.
 */
export interface WatermarkSettings {
  kind: 'text' | 'image';
  // ── the text spelling ──
  /** The words ("DRAFT"). kind === 'text'; blank = nothing paints. */
  text?: string;
  /** px. Absent = auto: spans ~70% of the page diagonal, measured
   *  through the one-ruler metrics at render time. */
  fontSize?: number;
  /** hex; default silver #c0c0c0 (Word's default watermark gray). */
  color?: string;
  /** Degrees, CSS sign (−45 = Word's diagonal). Text default −45;
   *  image default 0. */
  rotation?: number;
  /** 0..1; default 0.5 (Word's "semTransparent"). */
  opacity?: number;
  // ── the image spelling ──
  /** 'media://<sha>' — content-addressed like image nodes;
   *  registerImageBytes is the no-insert variant. */
  src?: string;
  /**
   * Natural px — required for kind === 'image' (dims are data, never
   * fetched at render time); without them the resolver paints nothing
   * rather than guessing.
   */
  width?: number;
  height?: number;
  /** Fraction of the page width the watermark spans; default 0.5. */
  scale?: number;
}

/**
 * #48 — a page's geometry can never be its own (a page IS its
 * section's), but its decor can: styles key page numbers, not content.
 * The paint chain resolves per-page → per-section → document → white;
 * a style for a page index that no longer exists is simply inert.
 */
export interface PageStyle {
  /** Full-page background color; unset = inherit the chain. */
  background?: string;
}

/** 0-based page index → its style. Sparse; {} = no per-page styles. */
export type PageStyles = Record<number, PageStyle>;

/**
 * The file-side spelling: JSON object keys are strings, so .wpdoc
 * carries `Record<string, PageStyle>`; this converts to numeric keys
 * (garbage keys drop — a corrupted index never crashes an open).
 */
export function normalizePageStyles(
  raw: Record<string, unknown> | null | undefined
): PageStyles {
  if (!raw || typeof raw !== 'object') return {};
  const out: PageStyles = {};
  for (const [key, value] of Object.entries(raw)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || value == null || typeof value !== 'object') continue;
    const background = (value as { background?: unknown }).background;
    if (typeof background === 'string' && background) {
      out[index] = { background };
    }
  }
  return out;
}

// ─── Unit system ─────────────────────────────────────────────────────────────
// All persisted measurements (PAGE_SIZES, DEFAULT_MARGINS, customWidth/
// customHeight) are stored in POINTS (1 pt = 1/72 inch). The engine
// consumes CSS px; toLayoutOptions converts pt → px at the boundary.

export const PX_PER_PT = 96 / 72;

export function ptToPx(pt: number): number {
  return Math.round(pt * PX_PER_PT);
}

export function pxToPt(px: number): number {
  return Math.round(px / PX_PER_PT);
}

export type MeasurementUnit = 'inches' | 'centimeters' | 'millimeters' | 'points' | 'picas';

export interface MeasurementUnitMeta {
  label: string;
  /** Input suffix, e.g. "in", "cm". */
  suffix: string;
  /** Points per 1 unit. */
  ptPer: number;
}

export const MEASUREMENT_UNITS: Record<MeasurementUnit, MeasurementUnitMeta> = {
  inches:       { label: 'Inches',       suffix: 'in', ptPer: 72 },
  centimeters: { label: 'Centimeters', suffix: 'cm', ptPer: 72 / 2.54 },
  millimeters: { label: 'Millimeters',  suffix: 'mm', ptPer: 72 / 25.4 },
  points:      { label: 'Points',       suffix: 'pt', ptPer: 1 },
  picas:       { label: 'Picas',        suffix: 'pc', ptPer: 12 },
};

export function formatPt(pt: number, unit: MeasurementUnit): string {
  const meta = MEASUREMENT_UNITS[unit];
  return String(Math.round((pt / meta.ptPer) * 100) / 100);
}

/** One pt value + unit → its human display ("1\"", "2.54 cm", "72 pt");
 *  inches use the double-prime mark, others spell their suffix. */
export function formatPtWithUnit(pt: number, unit: MeasurementUnit): string {
  const value = formatPt(pt, unit);
  return unit === 'inches' ? `${value}"` : `${value} ${MEASUREMENT_UNITS[unit].suffix}`;
}

/** #58 — preset margins → one human line: uniform margins read as one
 *  number; top/bottom vs left/right pairs read by axis ("gutter" is
 *  Word's binding-edge margin, a different thing). */
export function summarizeMarginPreset(margins: Margins, unit: MeasurementUnit): string {
  if (margins.top === margins.bottom && margins.left === margins.right) {
    const top = formatPtWithUnit(margins.top, unit);
    const side = formatPtWithUnit(margins.left, unit);
    return margins.top === margins.left
      ? `${top} margins`
      : `${top} bands, ${side} sides`;
  }
  return (
    `${formatPtWithUnit(margins.top, unit)} top, ` +
    `${formatPtWithUnit(margins.bottom, unit)} bottom, ` +
    `${formatPtWithUnit(margins.left, unit)} left, ` +
    `${formatPtWithUnit(margins.right, unit)} right`
  );
}

/**
 * The four margins → one human summary: all equal → `1" all sides`;
 * T==B and L==R → `1" top/bottom · 1.25" left/right`; otherwise
 * `T 1" · B 1" · L 1.25" · R 1.25"`.
 */
export function formatMarginsSummary(margins: Margins, unit: MeasurementUnit): string {
  const f = (pt: number) => formatPtWithUnit(pt, unit);
  const { top, bottom, left, right } = margins;
  if (top === bottom && bottom === left && left === right) {
    return `${f(top)} all sides`;
  }
  if (top === bottom && left === right) {
    return `${f(top)} top/bottom · ${f(left)} left/right`;
  }
  return `T ${f(top)} · B ${f(bottom)} · L ${f(left)} · R ${f(right)}`;
}

/**
 * User input in the display unit → points, or null for
 * unparseable/non-positive input. Margins pass allowZero (a 0pt
 * margin is legal); page dimensions must stay positive.
 */
export function parseUnitToPt(
  raw: string,
  unit: MeasurementUnit,
  opts?: { allowZero?: boolean }
): number | null {
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return null;
  if (v < 0 || (v === 0 && !(opts?.allowZero ?? false))) return null;
  return Math.round(v * MEASUREMENT_UNITS[unit].ptPer);
}

/** If the pt dims match a preset (portrait), return its key; else null. */
export function findMatchingPreset(widthPt: number, heightPt: number): string | null {
  for (const [key, preset] of Object.entries(PAGE_SIZES)) {
    if (preset.width === widthPt && preset.height === heightPt) return key;
  }
  return null;
}

// ─── Presets (width/height in POINTS; engine converts to px) ─────────────

export interface PageSizePreset extends PageDimensions {
  /** Display label for the dropdown, e.g. '8.5" × 11"' */
  inches: string;
}

export const PAGE_SIZES: Record<string, PageSizePreset> = {
  Letter:    { width: 612, height: 792,  inches: '8.5" × 11"' },
  Tabloid:   { width: 792, height: 1224, inches: '11" × 17"' },
  Legal:     { width: 612, height: 1008, inches: '8.5" × 14"' },
  Statement: { width: 396, height: 612,  inches: '5.5" × 8.5"' },
  Executive: { width: 522, height: 756,  inches: '7.25" × 10.5"' },
  Folio:     { width: 612, height: 936,  inches: '8.5" × 13"' },
  A3:        { width: 842, height: 1191, inches: '11.7" × 16.5"' },
  A4:        { width: 595, height: 842,  inches: '8.3" × 11.7"' },
  A5:        { width: 420, height: 595,  inches: '5.8" × 8.3"' },
  B4:        { width: 709, height: 1002, inches: '9.8" × 13.9"' },
  B5:        { width: 498, height: 709,  inches: '6.9" × 9.8"' },
};

export const PAGE_GAP = 32;
export const FALLBACK_PAGE_SIZE = 'Letter';

export const DEFAULT_MARGINS: Margins = {
  top: 72,
  bottom: 72,
  left: 72,
  right: 72,
};

// Word's physical margin presets, stored in POINTS (the engine receives
// px via toLayoutOptions at 96/72 px/pt). "Normal" is kept reference-equal
// to DEFAULT_MARGINS by construction (pinned by test) so they never drift.
export interface MarginPreset {
  label: string;
  margins: Margins;
}

export const MARGIN_PRESETS: Record<string, MarginPreset> = {
  Narrow: {
    label: 'Narrow',
    margins: { top: 36, bottom: 36, left: 36, right: 36 },
  },
  Normal: {
    label: 'Normal',
    margins: DEFAULT_MARGINS,
  },
  Moderate: {
    label: 'Moderate',
    margins: { top: 72, bottom: 72, left: 54, right: 54 },
  },
  Wide: {
    label: 'Wide',
    margins: { top: 72, bottom: 72, left: 144, right: 144 },
  },
};

/**
 * Pageless margin presets: Narrow/Normal/Wide reuse the paginated
 * presets (one margin concept per document); Full zeroes every side
 * (the content spans the strip). Moderate is absent — its tapered
 * sides mean little edge-to-edge.
 */
export const PAGELESS_MARGIN_PRESETS: Record<string, MarginPreset> = {
  Narrow: MARGIN_PRESETS.Narrow,
  Normal: MARGIN_PRESETS.Normal,
  Wide: MARGIN_PRESETS.Wide,
  Full: {
    label: 'Full',
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
  },
};

/**
 * The one view-mode resolver: the document's choice when set, else
 * the app default (config.editor.defaultPageLayout). Pure, so
 * non-React consumers (ScrollGuardExtension) resolve the same way.
 */
export function resolveViewMode(
  docViewMode: string | undefined,
  configDefault: string,
): 'Pages' | 'Pageless' {
  if (docViewMode === 'pageless') return 'Pageless';
  if (docViewMode === 'pages') return 'Pages';
  return configDefault === 'Pageless' ? 'Pageless' : 'Pages';
}

export function toLayoutOptions(pageSetup: PageSetup): LayoutOptions {
  let widthPt: number;
  let heightPt: number;
  if (
    pageSetup.pageSize === 'custom' &&
    pageSetup.customWidth != null &&
    pageSetup.customHeight != null
  ) {
    widthPt = pageSetup.customWidth;
    heightPt = pageSetup.customHeight;
  } else {
    const base = PAGE_SIZES[pageSetup.pageSize] ?? PAGE_SIZES[FALLBACK_PAGE_SIZE];
    widthPt = base.width;
    heightPt = base.height;
  }
  if (pageSetup.orientation === 'landscape') {
    [widthPt, heightPt] = [heightPt, widthPt];
  }
  return {
    page: { width: ptToPx(widthPt), height: ptToPx(heightPt) },
    margins: {
      top: ptToPx(pageSetup.margins.top),
      right: ptToPx(pageSetup.margins.right),
      bottom: ptToPx(pageSetup.margins.bottom),
      left: ptToPx(pageSetup.margins.left),
    },
    // The document-level widow/orphan default; the engine's own
    // default (true) covers absent (old documents).
    preventWidowsAndOrphans: pageSetup.widowControl ?? true,
    // #74 — gap pt → px at the boundary; widths pass verbatim (the
    // engine consumes them as relative weights, so the pt scale
    // cancels). null ≡ absent ≡ one column (the engine never sees null).
    ...(pageSetup.columns
      ? {
          columns: {
            count: pageSetup.columns.count,
            ...(pageSetup.columns.gap != null ? { gap: ptToPx(pageSetup.columns.gap) } : {}),
            ...(pageSetup.columns.widths ? { widths: pageSetup.columns.widths } : {}),
            ...(pageSetup.columns.balanced != null
              ? { balanced: pageSetup.columns.balanced }
              : {}),
          },
        }
      : {}),
  };
}
