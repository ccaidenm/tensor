/**
 * The screen-reader announcer: one module-level aria-live="polite"
 * region appended to <body> on first use. Clear-then-set re-announces
 * repeat messages (live regions fire only on content changes).
 */
let region: HTMLDivElement | null = null;

export function announce(message: string): void {
  if (typeof document === 'undefined') return;
  if (!region || !region.isConnected) {
    region = document.createElement('div');
    region.setAttribute('aria-live', 'polite');
    // sr-only inlined — a class dependency on the tailwind bundle is brittle outside React's tree.
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
