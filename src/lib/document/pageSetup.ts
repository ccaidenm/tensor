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
  /** 'landscape' swaps the page size's width/height for layout. */
  orientation?: 'portrait' | 'landscape';
  /** Per-document page background; '' = white. Persisted in .wpdoc metadata. */
  pageColor?: string;
  /** When pageSize === 'custom': the user-defined dimensions in POINTS. */
  customWidth?: number;
  customHeight?: number;
  /**
   * M-FLOW — the DOCUMENT-LEVEL widow/orphan default (Word's
   * Compatibility/layout option): true/absent = protection ON (the
   * engine's LayoutOptions default); false = natural splits
   * everywhere a paragraph doesn't override via its own flow.
   */
  widowControl?: boolean;
}

/**
 * #48 — PAGE STYLES: the per-page presentation layer. A page's
 * geometry can never be its own (the engine's one-geometry-per-page
 * law — a page IS its section's), but its DECOR can be: background
 * colors ride the POSITIONAL map below.
 *
 * THE POSITIONAL RULING (spec of record, the session's locked
 * decision): styles key PAGE NUMBERS, not content — "make page 1 a
 * dark cover" is literal, the paint chain resolves
 * per-page → per-section → document → white, and a style for a page
 * index that no longer exists (content deleted) is simply INERT (the
 * chain falls through to the section/doc layers; the map entry rides
 * until the user clears it). Page numbers are 0-based in the model;
 * the dialog speaks 1-based to the user.
 */
export interface PageStyle {
  /** Full-page background color; unset = inherit the chain. */
  background?: string;
}

/** 0-based page index → its style. Sparse; {} = no per-page styles. */
export type PageStyles = Record<number, PageStyle>;

/**
 * The file-side spelling: JSON object keys are strings, so the .wpdoc
 * metadata carries `Record<string, PageStyle>` and this converts to the
 * model's numeric keys (garbage keys drop loudly-quietly — a corrupted
 * index never crashes a file open).
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

/**
 * One pt value + unit → its human display ("1\"", "2.54 cm", "72 pt").
 * Inches use the double-prime mark (Word's own display); every other
 * unit spells its suffix.
 */
export function formatPtWithUnit(pt: number, unit: MeasurementUnit): string {
  const value = formatPt(pt, unit);
  return unit === 'inches' ? `${value}"` : `${value} ${MEASUREMENT_UNITS[unit].suffix}`;
}

/** #58 — the PRESET margins → ONE human line: uniform margins read as
 *  one number ("1\" margins"); the top/bottom vs left/right pairs read
 *  by AXIS ("1\" vertical, 0.75\" horizontal" — the CSS box model's
 *  pairing; "gutter" is Word's binding-edge margin, a different
 *  thing). */
export function summarizeMarginPreset(margins: Margins, unit: MeasurementUnit): string {
  if (margins.top === margins.bottom && margins.left === margins.right) {
    const top = formatPtWithUnit(margins.top, unit);
    const side = formatPtWithUnit(margins.left, unit);
    return margins.top === margins.left
      ? `${top} margins`
      : `${top} bands, ${side} sides`;
  }
  // An all-different shape: spell the four edges.
  return (
    `${formatPtWithUnit(margins.top, unit)} top, ` +
    `${formatPtWithUnit(margins.bottom, unit)} bottom, ` +
    `${formatPtWithUnit(margins.left, unit)} left, ` +
    `${formatPtWithUnit(margins.right, unit)} right`
  );
}

/**
 * The four margins → ONE human summary (the print dialog's Paper card):
 *  - all equal        → `1" all sides`
 *  - T==B and L==R    → `1" top/bottom · 1.25" left/right`
 *  - otherwise        → `T 1" · B 1" · L 1.25" · R 1.25"`
 * Never "72/72/72/72 pt" — the display unit is the user's
 * config.editor.measurementUnit (one source).
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
 * User input in the display unit → points. Returns null for
 * unparseable/non-positive input — margins are the one caller that
 * passes allowZero (a 0pt margin is legal: the content box then meets
 * the sheet edge); page DIMENSIONS must stay positive.
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

// Word's physical margin presets, stored in POINTS (the store's
// canonical unit — the engine receives px via toLayoutOptions at
// 96/72 px/pt). pt ↔ px table (engine units):
//   Narrow   36pt all        → 48px all       (0.5")
//   Normal   72pt all        → 96px all       (1.0" — ≡ DEFAULT_MARGINS)
//   Moderate T/B 72, L/R 54  → T/B 96, L/R 72 (1.0" / 0.75")
//   Wide     T/B 72, L/R 144 → T/B 96, L/R 192 (1.0" / 2.0")
// "Normal" is kept reference-equal to DEFAULT_MARGINS by construction
// (pinned by test) so the preset and the store default can never drift.
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
    // M-FLOW — the document-level widow/orphan default; the engine's
    // own default (true) covers absent (old documents).
    preventWidowsAndOrphans: pageSetup.widowControl ?? true,
  };
}
