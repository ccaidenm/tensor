import type { Editor } from '@tiptap/core';
import { useMediaStore } from './store';

/**
 * The unresolved-ref report (dev-only): a media:// ref missing from
 * the MediaStore otherwise paints a placeholder with no trace.
 * Triggers: every relayout scan, plus the MediaStore subscription —
 * a store removal alone triggers no relayout.
 */
export function reportUnresolvedRefs(editor: Editor): void {
  const seen = new Set<string>();
  const entries = useMediaStore.getState().entries;
  editor.state.doc.descendants((node) => {
    const src = node.attrs?.src;
    if (typeof src === 'string' && src.startsWith('media://')) {
      const id = src.slice('media://'.length);
      if (!seen.has(id)) {
        seen.add(id);
        if (!entries.has(id)) {
          console.error(
            `[media] unresolved media ref — NOT in the MediaStore (the placeholder paints): media://${id}`,
          );
        }
      }
    }
    return true;
  });
}
