/**
 * THE SYMBOLS CATALOG — the runtime half of the generated dataset
 * (scripts/generate-symbols.mjs). The picker's design, in one place:
 *
 *  - "Common" (the curated ~150 in symbols.ts) is ALWAYS available —
 *    bundled, instant, zero dataset.
 *  - The CORE dataset (~44k chars: every graphic symbol/script family
 *    except CJK/Hangul) ships gzipped (~271KB) and loads ONCE, lazily,
 *    when the user browses beyond Common or searches deep.
 *  - CJK/Hangul groups (~114k chars) are INDIVIDUAL lazy chunks
 *    (~660KB total across 7 files) that load only when their group is
 *    opened — the user-ruled scope: viewable on demand, never part of
 *    the core load or search set until opened.
 *
 * DECOMPRESSION: the chunks are gzip at build time; the runtime
 * decompresses with the native DecompressionStream (WebKitGTK 2.40+ /
 * all modern WebViews). If the runtime lacks it, the catalog degrades
 * honestly: Common still works, expanded groups report the requirement
 * (never a broken picker).
 */

import symbolsIndex from '@/generated/symbols-index.json';
import { gunzipSync } from 'fflate';
import { SYMBOL_CATEGORIES } from '../symbols';

export interface CatalogGroup {
  id: string;
  label: string;
  count: number;
  lazy: boolean;
}

/** The generated group index (force-added to git like licenses.json —
 *  tiny, stable, lets the chips render before anything loads). */
export const GROUP_INDEX = symbolsIndex.groups as CatalogGroup[];

/** The lazy chunks' base path (public/, served from the app origin —
 *  the bergamot artifacts' pattern). The .symbols extension (not .gz —
 *  see the generator's extension law) keeps transport encodings off. */
const CHUNK_BASE = '/symbols';

export interface CatalogChar {
  cp: number;
  char: string;
  name: string;
}

interface LoadedChunk {
  chars: CatalogChar[];
}

/** Loaded-group cache: groupId → chars (Common cached eagerly). */
const loaded = new Map<string, LoadedChunk>();
/** The core bundle's per-group slices (the group-boundary law): core
 *  groups have no chunks of their own — their lists are sections of
 *  the one core.symbols load. */
const coreSlices = new Map<string, CatalogChar[]>();
/** In-flight loads — concurrent chips/search share one fetch. */
const pending = new Map<string, Promise<LoadedChunk>>();

/** Parse the wire format: one "hex;NAME" per line, with optional
 *  `>groupId` section headers (the core bundle's group-boundary law).
 *  DEFENSIVE: lines with unparseable hex or out-of-range codepoints
 *  are SKIPPED, never thrown on — a corrupted/partial response
 *  degrades to a smaller list, never a crashed picker. */
export interface ParsedChunk {
  /** Every entry in the chunk, headers or not (the search surface). */
  chars: CatalogChar[];
  /** groupId → its slice (the core bundle's sections). */
  slices: Map<string, CatalogChar[]>;
}

export function parseChunkGrouped(text: string): ParsedChunk {
  const chars: CatalogChar[] = [];
  const slices = new Map<string, CatalogChar[]>();
  let current: CatalogChar[] | null = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.startsWith('>')) {
      current = [];
      slices.set(line.slice(1).trim(), current);
      continue;
    }
    const sep = line.indexOf(';');
    if (sep < 0) continue;
    const cp = parseInt(line.slice(0, sep), 16);
    // The codepoint range law: String.fromCodePoint throws beyond
    // 0x10FFFF (and NaN) — validate instead of trusting the wire.
    if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) continue;
    const entry: CatalogChar = { cp, char: String.fromCodePoint(cp), name: line.slice(sep + 1) };
    chars.push(entry);
    current?.push(entry);
  }
  return { chars, slices };
}

/** The flat view of a chunk (lazy chunks have no headers). */
export function parseChunk(text: string): CatalogChar[] {
  return parseChunkGrouped(text).chars;
}

/** "Common" — the curated set, reshaped into the catalog's shape.
 *  Always loaded (bundled); never touches the network. */
export function commonChars(): CatalogChar[] {
  const cached = loaded.get('common');
  if (cached) return cached.chars;
  const chars: CatalogChar[] = [];
  for (const [category, symbols] of Object.entries(SYMBOL_CATEGORIES)) {
    for (const s of symbols) {
      chars.push({ cp: s.char.codePointAt(0)!, char: s.char, name: `${s.name} (${category})` });
    }
  }
  loaded.set('common', { chars });
  return chars;
}

/** THE DECOMPRESSION SEAM — production uses fflate's pure-JS
 *  gunzipSync (the wpdoc zip's own dependency — no runtime
 *  DecompressionStream dependency, whose availability/behavior varies
 *  by WebKit build); tests inject a passthrough. */
const defaultDecompress = async (bytes: ArrayBuffer): Promise<string> => {
  const out = gunzipSync(new Uint8Array(bytes));
  return new TextDecoder().decode(out);
};
let decompress = defaultDecompress;

/** Test seam: replace the decompressor; call with no argument to
 *  restore the production default (fflate). */
export function __setDecompressor(fn?: (bytes: ArrayBuffer) => Promise<string>): void {
  decompress = fn ?? defaultDecompress;
}

/** Load one group's chars, routed by kind (the group-boundary law):
 *  LAZY groups (CJK/Hangul) fetch their own chunk; CORE groups are
 *  sections of the one core bundle — loading them loads core, then
 *  reads the slice. Shared promise so a chip click + a search racing
 *  each other fetch once. */
export async function loadGroup(groupId: string): Promise<CatalogChar[]> {
  // Lazy groups (and 'core' itself): their own chunk, cached forever.
  const isLazy = groupId === 'core' || GROUP_INDEX.some((g) => g.id === groupId && g.lazy);
  if (isLazy) return loadChunk(groupId);
  // Core groups: ride the ONE core load, then read the slice.
  await ensureCoreLoaded();
  const slice = coreSlices.get(groupId);
  if (!slice) throw new Error(`Group ${groupId} is not in the core dataset`);
  return slice;
}

async function loadChunk(chunkId: string): Promise<CatalogChar[]> {
  const cached = loaded.get(chunkId);
  if (cached) return cached.chars;
  const inFlight = pending.get(chunkId);
  if (inFlight) return (await inFlight).chars;

  const promise = (async () => {
    const res = await fetch(`${CHUNK_BASE}/${chunkId}.symbols`);
    if (!res.ok) throw new Error(`Dataset chunk ${chunkId} failed to load (HTTP ${res.status})`);
    const bytes = await res.arrayBuffer();
    // THE TRANSPORT SNIFF: some serving layers (vite dev, the Tauri
    // asset protocol) transparently decode .gz files — the runtime
    // then hands us ALREADY-DECODED bytes and a blind decompression
    // pass fails. The gzip magic (1f 8b) decides: decode only when
    // the bytes are still gzipped.
    const head = new Uint8Array(bytes, 0, 2);
    const gzipped = head[0] === 0x1f && head[1] === 0x8b;
    const text = gzipped ? await decompress(bytes) : new TextDecoder().decode(bytes);
    const parsed = parseChunkGrouped(text);
    const chunk = { chars: parsed.chars };
    loaded.set(chunkId, chunk);
    // The core bundle's sections become the core groups' lists.
    if (chunkId === 'core') {
      coreSlices.clear();
      for (const [id, slice] of parsed.slices) coreSlices.set(id, slice);
    }
    return chunk;
  })();
  pending.set(chunkId, promise);
  try {
    return (await promise).chars;
  } finally {
    pending.delete(chunkId);
  }
}

/** The core bundle loads as ONE unit (all non-lazy groups together —
 *  ~271KB gz). Search beyond Common needs it. */
export async function ensureCoreLoaded(): Promise<void> {
  if (loaded.has('core')) return;
  await loadChunk('core');
}

/** Chars for one group id ('common' included): a lazy chunk's own
 *  list, or a core group's slice — null when not loaded yet (the UI
 *  shows the loading state). */
export function getGroupChars(groupId: string): CatalogChar[] | null {
  return loaded.get(groupId)?.chars ?? coreSlices.get(groupId) ?? null;
}

/** Every loaded group's chars (for search) — Common always included. */
export function loadedChars(): CatalogChar[] {
  const all: CatalogChar[] = [];
  for (const chunk of loaded.values()) all.push(...chunk.chars);
  return all;
}

/** Test seam: reset the caches. */
export function __resetCatalog(): void {
  loaded.clear();
  coreSlices.clear();
  pending.clear();
}

// ─── THE COMMAND PALETTE'S CODEPOINT PATH ──────────────────────────────
// Typing a codepoint straight into the palette ("U+03A9", "u+2192")
// inserts that character — the power user's keyboard-first sibling of
// the bubble picker. THE FORM: 'u+' (case-insensitive) followed by
// 1–6 hex digits — unambiguous (bare hex would fight the command
// search), the same shorthand the bubble's search accepts.

/** Parse a palette query into a codepoint, or null (not a codepoint
 *  spec / out of range / surrogate — fromCodePoint's crash class). */
export function parseCodepointQuery(query: string): number | null {
  const m = query.trim().match(/^u\+\s*([0-9a-f]{1,6})$/i);
  if (!m) return null;
  const cp = parseInt(m[1]!, 16);
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return null;
  if (cp >= 0xd800 && cp <= 0xdfff) return null; // lone surrogates render tofu
  return cp;
}
