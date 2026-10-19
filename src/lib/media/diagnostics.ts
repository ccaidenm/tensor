import type { Editor } from '@tiptap/core';
import { useMediaStore } from './store';

/**
 * M-IMAGES-2.2 — the unresolved-ref report. A media:// ref whose id is
 * NOT in the MediaStore paints the placeholder in every surface with
 * zero trace of WHY — the missing-media half of the gray-placeholder
 * story (the decode-failure half lives in bitmapCache's onerror
 * diagnostic). Dev-only: an external doc opened without its container
 * is a legitimate placeholder state, not an error.
 *
 * Two triggers, both dev-only: the relayout (fresh scan on every
 * layout pass) and the MediaStore subscription (a store REMOVAL must
 * re-scan even with no PM transaction — the store change alone
 * triggers no relayout).
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
