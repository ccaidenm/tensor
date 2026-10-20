export function getScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
    node = node.parentElement;
  }
  return document.scrollingElement as HTMLElement | null;
}

/**
 * The focused text-entry control (dialog fields, search inputs), if
 * any. Native menu accelerators (menu-paste, menu-undo, …) consume
 * their keystrokes app-wide and re-dispatch them through the command
 * registry — without this check those commands act on the editor even
 * when the user is typing in a form control. The PM editor is a
 * contenteditable div, never an input/textarea, so it is excluded by
 * shape; selection-editable input types only (checkbox/color/etc.
 * have no caret to act on).
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
