import { PX_PER_PT } from '@/lib/document/pageSetup';

/**
 * M-DOCX — the ONE unit seam between Tensor and OOXML.
 *
 * The store law (pageSetup.ts): Tensor holds POINTS for page geometry
 * and PX for content geometry (runs, indents, spacing, tabs, images).
 * OOXML spells lengths in TWIPS (1/20 pt) and image geometry in EMU
 * (1/914400 inch); run sizes are HALF-POINTS.
 *
 * Every factor derives from PX_PER_PT (96/72 px per pt at the 96dpi
 * law) plus the two physical constants — no parallel copies of the
 * conversion tables may exist (the fontSize.ts/pageSetup.ts dupes are
 * the cautionary tale; this module imports, never forks).
 */

export const TWIPS_PER_PT = 20;

/** 1px = 0.75pt = 15 twips — derived, never restated. */
export const TWIPS_PER_PX = TWIPS_PER_PT / PX_PER_PT;

/** OOXML's physical constants: 1pt = 12700 EMU; 1px = 0.75pt. */
export const EMU_PER_PT = 12700;
export const EMU_PER_PX = EMU_PER_PT / PX_PER_PT; // 9525

export function ptToTwip(pt: number): number {
  return Math.round(pt * TWIPS_PER_PT);
}

export function pxToTwip(px: number): number {
  return Math.round(px * TWIPS_PER_PX);
}

export function pxToEmu(px: number): number {
  return Math.round(px * EMU_PER_PX);
}

export function emuToPx(emu: number): number {
  return emu / EMU_PER_PX;
}

/** w:sz is HALF-points (24 = 12pt). */
export function pxToHalfPoints(px: number): number {
  return Math.round((px / PX_PER_PT) * 2);
}

// ─── The inverse directions (#38a import reads twips/half-points) ──────

export function twipToPx(twip: number): number {
  return twip / TWIPS_PER_PX;
}

export function halfPointsToPx(halfPoints: number): number {
  return (halfPoints / 2) * PX_PER_PT;
}

/**
 * THE NUMERIC COERCION SEAM. TipTap stores several dimensional attrs
 * as STRINGS (the FontSize extension keeps the user's spelling —
 * '16px', '12pt' — and legacy documents may carry bare numbers as
 * strings). Every numeric conversion in the mapping goes through
 * here FIRST: a number passes; a string parses (pt → px at the unit
 * law, px and bare numbers stay px — the core law commits px);
 * anything else returns null and the CALLER skips the property.
 * Without this seam a '16px' fontSize becomes pxToHalfPoints(NaN) and
 * the docx lib's hpsMeasureValue throws "Invalid value 'NaN'
 * specified. Must be an integer." (the reported export failure).
 */
export function toPx(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return null;
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed)) return null;
    if (raw.trimEnd().endsWith('pt')) return parsed * PX_PER_PT;
    return parsed; // '16px' and bare '16' are px (the core law)
  }
  return null;
}
