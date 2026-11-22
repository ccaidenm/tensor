import type { Editor } from '@tiptap/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import { useMediaStore } from './store';

/**
 * The insertion pipeline — picker, drag-and-drop, and paste all
 * land here: bytes → sha256 (the content-address contract) →
 * MediaStore → natural dims → insert. The node holds refs, never bytes.
 */

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Natural-dims decode: createImageBitmap primary (the platform
 * decoder), with a pure PNG-IHDR fallback (bytes 16..24, big-endian)
 * for environments without ImageBitmap (jsdom); neither fabricates
 * numbers.
 */
export async function decodeImageSize(
  bytes: Uint8Array,
  ext: string,
): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    const blob = new Blob([bytes as unknown as BlobPart], { type: `image/${ext}` });
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return size;
  }
  const png = pngIhdrSize(bytes);
  if (png) return png;
  throw new Error(`cannot decode image dims for .${ext} in this environment`);
}

/** Pure PNG IHDR read: signature(8) + len(4) + 'IHDR'(4) → width,height
 *  big-endian at offsets 16..24. Testable with fixture bytes. */
export function pngIhdrSize(bytes: Uint8Array): { width: number; height: number } | null {
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) return null;
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIG[i]) return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
  };
}

export async function insertImageBytes(
  editor: Editor | null,
  bytes: Uint8Array,
  ext: string,
): Promise<boolean> {
  if (!editor) return false;
  const id = await sha256Hex(bytes);
  useMediaStore.getState().add(id, ext, bytes);
  const { width, height } = await decodeImageSize(bytes, ext);
  return editor
    .chain()
    .focus()
    .insertContent({ type: 'image', attrs: { src: `media://${id}`, width, height, alt: '' } })
    .run();
}

/** The register-only variant (watermark settings): bytes → sha →
 *  MediaStore → dims, no node insert. Null on decode failure — no
 *  fabricated dims. */
export async function registerImageBytes(
  bytes: Uint8Array,
  ext: string,
): Promise<{ src: string; width: number; height: number } | null> {
  const id = await sha256Hex(bytes);
  useMediaStore.getState().add(id, ext, bytes);
  try {
    const { width, height } = await decodeImageSize(bytes, ext);
    return { src: `media://${id}`, width, height };
  } catch {
    return null;
  }
}

/** The watermark panel's path: OS picker → binary read →
 *  registerImageBytes (no node insert). */
export async function registerImageFromPicker(): Promise<
  { src: string; width: number; height: number } | null
> {
  const path = await openDialog({
    filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
    multiple: false,
  });
  if (!path || Array.isArray(path)) return null;
  const ext = (path.split('.').pop() ?? 'png').toLowerCase();
  const bytes = await readFile(path);
  return registerImageBytes(bytes, ext === 'jpeg' ? 'jpeg' : ext);
}

/** The Insert > Image path: OS picker → binary read → the pipeline. */
export async function insertImageFromPicker(editor: Editor | null): Promise<boolean> {
  const path = await openDialog({
    filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
    multiple: false,
  });
  if (!path || Array.isArray(path)) return false;
  const ext = (path.split('.').pop() ?? 'png').toLowerCase();
  const bytes = await readFile(path);
  return insertImageBytes(editor, bytes, ext === 'jpeg' ? 'jpeg' : ext);
}

/** Drop + paste: the browser already has the bytes — a Blob, no fs
 *  round-trip. */
export async function insertImageBlob(editor: Editor | null, blob: Blob): Promise<boolean> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const ext = (blob.type.split('/')[1] ?? 'png').toLowerCase();
  return insertImageBytes(editor, bytes, ext === 'jpeg' ? 'jpeg' : ext);
}

// ─── The external-URL refusal ────────────────────────────────────────
//
// An http(s) image pasted in is refused — no download, no dialog:
// the document holds internal media:// refs only, and no network
// call ever fires from a paste. The refusal is a toast (paste handler).
export function isExternalImageUrl(src: string): boolean {
  return /^https?:\/\//i.test(src);
}
