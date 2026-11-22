import { readText } from '@tauri-apps/plugin-clipboard-manager';
import type { Editor } from '@tiptap/core';
import { focusedTextControl } from './domUtils';

/** Menu-driven paste: execCommand('paste') is blocked, so read the system
 * clipboard and replay it through PM's own paste handler as a synthetic
 * event. Plain text only; native Ctrl+V keeps the rich path. */
export async function pasteFromSystemClipboard(editor: Editor): Promise<void> {
  let text: string;
  try {
    text = await readText();
  } catch {
    return;
  }
  if (!text) return;
  // A focused text control (dialog fields, search inputs) owns the paste —
  // the menu accelerator consumed its keystroke, so replay there, never
  // into the hidden editor view.
  const control = focusedTextControl();
  if (control) {
    const start = control.selectionStart ?? control.value.length;
    const end = control.selectionEnd ?? control.value.length;
    control.setRangeText(text, start, end, 'end');
    // setRangeText fires no events — dispatch 'input' so React's onChange commits.
    control.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  // Pinned clipboardData property: what PM's handler reads, works everywhere.
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: dt });
  (editor.view.dom as HTMLElement).dispatchEvent(ev);
}
