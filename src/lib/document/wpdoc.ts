import { invoke } from '@tauri-apps/api/core';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { DocumentFileSchema, type DocumentFile } from './schema';
import { useMediaStore } from '@/lib/media/store';

/**
 * The .wpdoc v2 container layer (#28): v1 = bare JSON, v2 = a zip
 * (document.json + manifest + media files). The v1 converter is permanent;
 * the Rust packager writes exactly the media passed, so GC happens here.
 */

/** The not-zip marker unpackage_document returns for v1 files (the
 *  Rust constant, quoted). */
const NOT_ZIP_MARKER = 'NOT_ZIP';

export interface WireMediaFile {
  id: string;
  ext: string;
  bytesB64: string;
}

export interface UnpackResult {
  document: string;
  media: WireMediaFile[];
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The v1 legacy converter (permanent): v1's content is document.json's
 * schema verbatim, so conversion is validation + the in-memory model. A
 * failing schema throws the standard invalid-document error.
 */
export function parseLegacyV1(raw: string): DocumentFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt v1 JSON — the same loud posture as a failed schema:
    // never a crash, never silent loss.
    throw new Error('This file is not a valid document, or was saved by an incompatible version.');
  }
  const result = DocumentFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error('This file is not a valid document, or was saved by an incompatible version.');
  }
  return result.data;
}

/** The v2 open path: unpackage → validate → feed the MediaStore. */
async function openV2(path: string): Promise<DocumentFile> {
  const result = await invoke<UnpackResult>('unpackage_document', { path });
  const parsed = DocumentFileSchema.safeParse(JSON.parse(result.document));
  if (!parsed.success) {
    throw new Error('This file is not a valid document, or was saved by an incompatible version.');
  }
  useMediaStore
    .getState()
    .setFromUnpackage(result.media.map((m) => ({ id: m.id, ext: m.ext, bytes: b64ToBytes(m.bytesB64) })));
  return parsed.data;
}

/** Open a .wpdoc — v2 container, or v1 plain JSON via the permanent
 *  converter (detected by the unpackager's NOT_ZIP marker). Corrupted
 *  files throw (the store surfaces the error dialog). */
export async function openWpdoc(path: string): Promise<DocumentFile> {
  try {
    return await openV2(path);
  } catch (err) {
    if (String(err).includes(NOT_ZIP_MARKER)) {
      // v1: read the plain JSON and convert — forever.
      return parseLegacyV1(await readTextFile(path));
    }
    throw err;
  }
}

/**
 * Save-time GC: collect the media ids the document references
 * (media://<sha256> in any string value). Dropped ids stay in the
 * in-session MediaStore until the next open — file GC is caller policy.
 */
export function collectReferencedMediaIds(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    if (value.startsWith('media://')) into.add(value.slice('media://'.length));
    return into;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectReferencedMediaIds(v, into);
    return into;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectReferencedMediaIds(v, into);
  }
  return into;
}

/** The v2 save path: document JSON + referenced media only. */
export async function saveWpdoc(path: string, file: DocumentFile): Promise<void> {
  // Walk the whole file, not just docJSON — a doc-level watermark's
  // image ref lives in metadata.pageSetup.
  const referenced = collectReferencedMediaIds(file);
  const entries = useMediaStore.getState().entries;
  const media: WireMediaFile[] = [...entries]
    .filter(([id]) => referenced.has(id))
    .map(([id, entry]) => ({ id, ext: entry.ext, bytesB64: bytesToB64(entry.bytes) }));
  await invoke('package_document', { path, documentJson: JSON.stringify(file), media });
}
