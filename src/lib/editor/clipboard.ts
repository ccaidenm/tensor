import { readText } from '@tauri-apps/plugin-clipboard-manager';
import type { Editor } from '@tiptap/core';
import { focusedTextControl } from './domUtils';

/** Menu-driven paste: execCommand('paste') is blocked by web engines, so
 * the Edit menu reads the system clipboard and replays it through PM's
 * own paste handler on the hidden view — a synthetic event, never a
 * reimplementation of PM's insertion logic. Plain text only (the plugin
 * has no readHtml); native Ctrl+V keeps the rich path. */
export async function pasteFromSystemClipboard(editor: Editor): Promise<void> {
  let text: string;
  try {
    text = await readText();
  } catch {
    return;
  }
  if (!text) return;
  // A focused text control (dialog fields, search inputs) owns the
  // paste: the native menu accelerator consumed the keystroke that
  // would have reached it, so the clipboard text replays THERE — never
  // into the hidden editor view. Same focused-surface law as the
  // cut/copy commands' execCommand-on-selection stance.
  const control = focusedTextControl();
  if (control) {
    const start = control.selectionStart ?? control.value.length;
    const end = control.selectionEnd ?? control.value.length;
    control.setRangeText(text, start, end, 'end');
    // setRangeText fires no events — React's controlled-input onChange
    // listens for the native input event, so dispatch it to commit.
    control.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  // Event + pinned property rather than the ClipboardEvent constructor:
  // identical to what PM's handler reads, and works everywhere.
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: dt });
  (editor.view.dom as HTMLElement).dispatchEvent(ev);
}
