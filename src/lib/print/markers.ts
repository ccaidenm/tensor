/**
 * M-PRINT/M6.1 — the list-marker TEXT spellings, shared by the canvas
 * paint and the print renderer (ONE derivation — painted and printed
 * markers can never diverge). Pure string functions, no state.
 */

/** Ordered-number spelling per CSS list-style-type. */
export function orderedMarkerText(index: number, styleType: string): string {
  switch (styleType) {
    case 'lower-alpha':
      return `${toAlpha(index).toLowerCase()}.`;
    case 'upper-alpha':
      return `${toAlpha(index)}.`;
    case 'lower-roman':
      return `${toRoman(index).toLowerCase()}.`;
    case 'upper-roman':
      return `${toRoman(index)}.`;
    default:
      return `${index}.`;
  }
}

/** Bullet-glyph spelling per CSS list-style-type. */
export function bulletMarkerText(styleType: string): string {
  switch (styleType) {
    case 'circle':
      return '○';
    case 'square':
      return '▪';
    default:
      return '•';
  }
}

function toAlpha(n: number): string {
  // 1-based spreadsheet spelling: 27 → AA.
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s || 'A';
}

function toRoman(n: number): string {
  const table: Array<[number, string]> = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
    [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let s = '';
  for (const [value, glyph] of table) {
    while (n >= value) {
      s += glyph;
      n -= value;
    }
  }
  return s || 'I';
}