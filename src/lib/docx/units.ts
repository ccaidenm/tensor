import { PX_PER_PT } from '@/lib/document/pageSetup';

/**
 * The unit seam between Tensor and OOXML: Tensor holds points for page
 * geometry, px for content geometry; OOXML uses twips, EMU, and
 * half-points. Every factor derives from PX_PER_PT — no parallel tables.
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

// ─── The inverse directions (#38 import reads twips/half-points) ──────

export function twipToPx(twip: number): number {
  return twip / TWIPS_PER_PX;
}

export function halfPointsToPx(halfPoints: number): number {
  return (halfPoints / 2) * PX_PER_PT;
}

/**
 * The numeric coercion seam: TipTap keeps some dimensional attrs as strings
 * ('16px', '12pt'); anything unparseable returns null and the caller skips
 * the property — else '16px' becomes pxToHalfPoints(NaN) and the docx lib throws.
 */
export function toPx(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return null;
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed)) return null;
    if (raw.trimEnd().endsWith('pt')) return parsed * PX_PER_PT;
    return parsed; // '16px' and bare '16' are px
  }
  return null;
}
