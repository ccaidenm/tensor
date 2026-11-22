/**
 * WCAG 2.x contrast math (criterion 1.4.3), no external library.
 * Parsing accepts what in-repo producers write — hex 3/6-digit any
 * case, rgb()/rgba() — anything else parses to null and the caller
 * skips the run rather than guessing.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
  /** 0–1; present only for rgb()/rgba() spellings. */
  alpha?: number;
}

/** Hex 3/6-digit (case-insensitive) or rgb()/rgba() → channels;
 *  null for unparseable. Channels are 0–255 (alpha 0–1). */
export function parseCssColor(color: string): Rgb | null {
  const hex = /^#([0-9a-f]{3})$/i.exec(color) ?? /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    let digits = hex[1]!;
    if (digits.length === 3) {
      digits = digits[0]! + digits[0] + digits[1]! + digits[1] + digits[2]! + digits[2];
    }
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
    };
  }
  const rgba = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.%]+))?\s*\)/.exec(color);
  if (rgba) {
    let alpha: number | undefined;
    if (rgba[4] != null) {
      alpha = rgba[4]!.endsWith('%') ? Number(rgba[4]!.slice(0, -1)) / 100 : Number(rgba[4]!);
      if (!Number.isFinite(alpha)) alpha = undefined;
    }
    return {
      r: Number(rgba[1]!),
      g: Number(rgba[2]!),
      b: Number(rgba[3]!),
      alpha,
    };
  }
  return null;
}

/** WCAG relative luminance: linearized sRGB channels, the standard
 *  coefficients. Input channels 0–255. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio — always ≥ 1 (lighter over darker, the +0.05
 *  offsets). Unparseable inputs return null (the caller skips). */
export function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseCssColor(foreground);
  const bg = parseCssColor(background);
  if (!fg || !bg) return null;
  // Semi-transparent layers composite with what's UNDER them — the
  // checker can't know that stack, so it declines to guess.
  if (fg.alpha != null && fg.alpha < 1) return null;
  if (bg.alpha != null && bg.alpha < 1) return null;
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG "large text": ≥ 24px regular or ≥ 18.66px bold. */
export function isLargeText(fontSizePx: number, bold: boolean): boolean {
  return fontSizePx >= 24 || (bold && fontSizePx >= 18.66);
}

/** AA thresholds (criterion 1.4.3): 4.5:1 normal, 3:1 large text. */
export function aaThreshold(large: boolean): number {
  return large ? 3 : 4.5;
}
