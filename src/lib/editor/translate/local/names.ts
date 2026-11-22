/**
 * Language names for the local pair picker (the catalog speaks codes,
 * the UI speaks languages) — the code itself is the fallback, never a
 * crash.
 */

const display = typeof Intl !== 'undefined' && 'DisplayNames' in Intl
  ? new Intl.DisplayNames(['en'], { type: 'language' })
  : null;

export function languageName(code: string): string {
  if (!display) return code;
  try {
    return display.of(code) ?? code;
  } catch {
    return code;
  }
}

export function pairLabel(pair: { from: string; to: string }): string {
  return `${languageName(pair.from)} → ${languageName(pair.to)}`;
}
