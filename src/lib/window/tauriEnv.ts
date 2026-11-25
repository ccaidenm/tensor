/**
 * #100 — the Tauri environment seams: `inTauriWindow` gates every
 * window-API call (browser/jsdom no-op instead of throwing); `isMacOS`
 * picks the titlebar lane (traffic lights left on macOS, else centered).
 */

export function inTauriWindow(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function isMacOS(): boolean {
  return typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent);
}
