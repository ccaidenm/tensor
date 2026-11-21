/**
 * #100 — the Tauri environment seams (one source, test-friendly):
 * `inTauriWindow` gates every window-API call the titlebar makes (the
 * real app always satisfies it; a plain-browser `vite dev` session and
 * the jsdom test env don't — the calls no-op instead of throwing, and
 * the components stay renderable/assertable everywhere), and
 * `isMacOS` picks the titlebar's platform lane (macOS: the native
 * traffic lights overlay the row's left + the document name sits far
 * right; Linux/Windows: the name centers + the custom controls sit
 * far right).
 */

export function inTauriWindow(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function isMacOS(): boolean {
  return typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent);
}
