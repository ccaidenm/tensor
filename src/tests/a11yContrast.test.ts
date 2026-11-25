import { describe, expect, it } from 'vitest';
import {
  aaThreshold,
  contrastRatio,
  isLargeText,
  parseCssColor,
  relativeLuminance,
} from '@/lib/a11yCheck/contrast';

/**
 * The WCAG math, pinned with the canonical boundary vectors (the pairs
 * the WCAG docs themselves use to demonstrate the AA thresholds). Pure
 * unit tests: no doc, no editor.
 */

describe('parseCssColor', () => {
  it('hex 6-digit, case-insensitive (the DOCX import writes uppercase, the palette lowercase)', () => {
    expect(parseCssColor('#ff0000')).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseCssColor('#FF0000')).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('hex 3-digit expands', () => {
    expect(parseCssColor('#f00')).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseCssColor('#ABC')).toEqual({ r: 170, g: 187, b: 204 });
  });

  it('rgb/rgba — the rich-text paste path', () => {
    expect(parseCssColor('rgb(255, 0, 0)')).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseCssColor('rgba(0, 0, 255, 0.5)')).toEqual({ r: 0, g: 0, b: 255, alpha: 0.5 });
    expect(parseCssColor('rgb(1 2 3 / 0.8)')).toEqual({ r: 1, g: 2, b: 3, alpha: 0.8 });
    expect(parseCssColor('rgba(0, 0, 255, 1)')).toEqual({ r: 0, g: 0, b: 255, alpha: 1 });
  });

  it('unparseable shapes → null (named colors, hsl, CSS variables — never guessed)', () => {
    expect(parseCssColor('red')).toBeNull();
    expect(parseCssColor('hsl(120, 50%, 50%)')).toBeNull();
    expect(parseCssColor('var(--brand)')).toBeNull();
    expect(parseCssColor('')).toBeNull();
  });
});

describe('relativeLuminance (WCAG)', () => {
  it('black is 0, white is 1', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 10);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 10);
  });
});

describe('contrastRatio', () => {
  it('black on white is 21:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 2);
  });

  it('the canonical AA boundary pair: #767676 passes 4.5:1 by a hair, #777777 fails', () => {
    const passing = contrastRatio('#767676', '#ffffff')!;
    const failing = contrastRatio('#777777', '#ffffff')!;
    expect(passing).toBeCloseTo(4.54, 2);
    expect(failing).toBeCloseTo(4.48, 2);
    expect(passing).toBeGreaterThanOrEqual(4.5);
    expect(failing).toBeLessThan(4.5);
  });

  it('symmetric — argument order never matters', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 2);
  });

  it('semi-transparent layers → null (the composite underneath is unknowable)', () => {
    expect(contrastRatio('rgba(0, 0, 0, 0.5)', '#ffffff')).toBeNull();
    expect(contrastRatio('#000000', 'rgba(255, 255, 255, 0.5)')).toBeNull();
    // Opaque alpha is fine.
    expect(contrastRatio('rgba(0, 0, 0, 1)', '#ffffff')).toBeCloseTo(21, 2);
  });

  it('unparseable either side → null', () => {
    expect(contrastRatio('var(--fg)', '#ffffff')).toBeNull();
    expect(contrastRatio('#000000', 'rebeccapurple')).toBeNull();
  });
});

describe('the AA thresholds', () => {
  it('isLargeText: ≥24px regular, ≥14pt (18.66px) bold — WCAG 1.4.3', () => {
    expect(isLargeText(24, false)).toBe(true);
    expect(isLargeText(23.99, false)).toBe(false);
    expect(isLargeText(18.66, true)).toBe(true);
    expect(isLargeText(18.65, true)).toBe(false);
    expect(isLargeText(18.66, false)).toBe(false);
  });

  it('4.5:1 normal, 3:1 large', () => {
    expect(aaThreshold(false)).toBe(4.5);
    expect(aaThreshold(true)).toBe(3);
  });
});
