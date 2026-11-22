import type { Editor } from '@tiptap/core';
import { useMediaStore } from '@/lib/media/store';
import { decodeImageSize } from '@/lib/media/insert';

/**
 * The legacy-image backfill: an image node opening without dims is
 * pending — load bytes, measure, write width/height. No epoch is
 * re-spun: attr writes go through PM, whose update path relayouts.
 */
export async function backfillImageDims(editor: Editor | null): Promise<number> {
  if (!editor) return 0;
  // Collect pending refs (sync scan over the current doc).
  const pending: string[] = [];
  editor.state.doc.descendants((node) => {
    if (
      node.type.name === 'image' &&
      typeof node.attrs.width !== 'number' &&
      typeof node.attrs.height !== 'number' &&
      typeof node.attrs.src === 'string' &&
      node.attrs.src.startsWith('media://')
    ) {
      pending.push(node.attrs.src);
    }
    return true;
  });

  let fixed = 0;
  for (const src of pending) {
    const entry = useMediaStore.getState().entries.get(src.slice('media://'.length));
    if (!entry) continue; // unresolved: nothing to measure yet
    try {
      const { width, height } = await decodeImageSize(entry.bytes, entry.ext);
      if (editor.isDestroyed) break;
      // Re-resolve by src — positions may have shifted since the
      // scan; a stale-pos write would mutate the wrong node.
      const tr = editor.state.tr;
      let found = false;
      editor.state.doc.descendants((node, pos) => {
        if (found) return false;
        if (
          node.type.name === 'image' &&
          node.attrs.src === src &&
          typeof node.attrs.width !== 'number'
        ) {
          tr.setNodeAttribute(pos, 'width', width);
          tr.setNodeAttribute(pos, 'height', height);
          found = true;
          return false;
        }
        return true;
      });
      if (found) {
        editor.view.dispatch(tr);
        fixed += 1;
      }
    } catch (err) {
      if (import.meta.env.DEV) {
        console.warn('[media] backfill could not decode image dims:', err);
      }
    }
  }
  return fixed;
}
