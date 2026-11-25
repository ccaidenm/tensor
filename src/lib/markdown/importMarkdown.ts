import { readTextFile, readFile } from '@tauri-apps/plugin-fs';
import type { JSONContent } from '@tiptap/core';
import { useMediaStore } from '@/lib/media/store';
import { sha256Hex } from '@/lib/media/insert';
import { markdownToJSON } from './manager';
import { dirName, joinPath } from './paths';

/**
 * The import flow: read → parse → ingest images → JSON for setContent.
 * Markdown carries no dimensions — the standard backfill fills them in
 * after the content lands. Remote/missing/unreadable images are refused
 * or dropped (never silently — the open path surfaces the count).
 */

export interface MarkdownImport {
  json: JSONContent;
  /** Images dropped during ingestion (remote, missing, unreadable). */
  skippedImages: number;
}

const MEDIA_ID = /^media:\/\/([0-9a-f]{64})$/;
const DATA_URI = /^data:image\/([a-z0-9.+-]+);base64,(.*)$/i;

export async function importMarkdown(path: string): Promise<MarkdownImport> {
  const markdown = await readTextFile(path);
  const parsed = markdownToJSON(markdown);
  const { json, skippedImages } = await ingestImages(parsed, dirName(path));
  return { json, skippedImages };
}

async function ingestImages(
  doc: JSONContent,
  dir: string,
): Promise<{ json: JSONContent; skippedImages: number }> {
  let skipped = 0;

  async function walk(node: JSONContent): Promise<JSONContent | null> {
    if (node.type === 'image' || node.type === 'inlineImage') {
      const src = typeof node.attrs?.src === 'string' ? node.attrs.src : '';
      if (MEDIA_ID.test(src)) return node; // already internal — keep verbatim
      try {
        const { bytes, ext } = await loadImageBytes(src, dir);
        const id = await sha256Hex(bytes);
        useMediaStore.getState().add(id, ext, bytes);
        return { ...node, attrs: { ...node.attrs, src: `media://${id}` } };
      } catch {
        skipped += 1;
        return null; // dropped — the count is surfaced by the open path
      }
    }
    if (Array.isArray(node.content)) {
      const next: JSONContent[] = [];
      for (const child of node.content) {
        const replaced = await walk(child);
        if (replaced) next.push(replaced);
      }
      return { ...node, content: next };
    }
    return node;
  }

  // The TRANSFORMED tree feeds setContent — the walk is pure (returns a
  // new tree), so its result must actually flow out (the count alone
  // would leave the original srcs in place).
  const json = (await walk(doc)) ?? doc;
  return { json, skippedImages: skipped };
}

/** The three image source spellings a markdown file can carry. */
async function loadImageBytes(src: string, dir: string): Promise<{ bytes: Uint8Array; ext: string }> {
  if (!src) throw new Error('empty image source');

  if (/^https?:\/\//i.test(src)) {
    // The no-silent-fetch posture (insert.ts): remote images are never
    // fetched as a side effect of an import.
    throw new Error('remote image — refused');
  }

  if (src.startsWith('data:')) {
    const parsed = DATA_URI.exec(src);
    if (!parsed) throw new Error('unsupported data URI');
    const binary = atob(parsed[2]!);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes, ext: mediaExt(parsed[1]!) };
  }

  const clean = decodeURIComponent(src);
  const absolute = /^[\\/]/.test(clean) ? clean : joinPath(dir, clean);
  const bytes = await readFile(absolute);
  return { bytes, ext: extFromPath(clean) };
}

/** A mime subtype as a media ext — svg+xml collapses to svg (the
 *  MediaStore spells `image/<ext>` for rendering). */
function mediaExt(subtype: string): string {
  const cleaned = subtype.toLowerCase().replace(/[^a-z0-9]/g, '');
  return cleaned === 'svgxml' ? 'svg' : cleaned || 'png';
}

function extFromPath(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : 'png';
}
