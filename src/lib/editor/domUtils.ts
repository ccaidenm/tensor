export function getScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
    node = node.parentElement;
  }
  return document.scrollingElement as HTMLElement | null;
}

/**
 * The focused text-entry control (dialog fields, search inputs), if any.
 * Menu accelerators re-dispatch commands app-wide — without this check
 * those commands act on the editor while the user types in a form.
 */
export function focusedTextControl(): HTMLInputElement | HTMLTextAreaElement | null {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement) {
    const t = el.type;
    return t === 'text' || t === 'search' || t === 'url' || t === 'tel' ||
      t === 'password' || t === 'email' || t === 'number'
      ? el
      : null;
  }
  return null;
}
