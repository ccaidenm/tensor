/**
 * #COMMENTS (and future surfaces) — the screen-reader announcer: ONE
 * module-level `aria-live="polite"` region appended to <body> on first
 * use (the codebase had no live-region infrastructure; this seeds it).
 *
 * The clear-then-set timeout is the standard re-announcement trick: a
 * live region only fires when its CONTENT CHANGES, so announcing the
 * same message twice ("resolved" on two threads) needs a blink of
 * emptiness between the writes. polite (not assertive) — thread state
 * changes are context, never interruptions.
 */
let region: HTMLDivElement | null = null;

export function announce(message: string): void {
  if (typeof document === 'undefined') return;
  if (!region || !region.isConnected) {
    region = document.createElement('div');
    region.setAttribute('aria-live', 'polite');
    // sr-only: visually hidden, fully exposed to assistive tech (the
    // tailwind sr-only utility's own spellings, inlined — index.css
    // loads it, but a raw class dependency on the utility bundle is
    // brittle for an element created outside React's tree).
    region.style.position = 'absolute';
    region.style.width = '1px';
    region.style.height = '1px';
    region.style.padding = '0';
    region.style.margin = '-1px';
    region.style.overflow = 'hidden';
    region.style.clip = 'rect(0, 0, 0, 0)';
    region.style.whiteSpace = 'nowrap';
    region.style.borderWidth = '0';
    document.body.appendChild(region);
  }
  region.textContent = '';
  window.setTimeout(() => {
    if (region) region.textContent = message;
  }, 10);
}

/** Test seam: reset the module (the region element rides one jsdom
 *  document per test file — a fresh document needs a fresh region). */
export function __resetAnnouncerForTests(): void {
  region?.remove();
  region = null;
}
