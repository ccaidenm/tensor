import { describe, it, expect, beforeEach, vi } from 'vitest';
import { gzipSync } from 'node:zlib';

/** gz bytes for the sniff tests (Buffer-pool-safe copy — see note). */
function gz(text: string): ArrayBuffer {
  const buf = gzipSync(Buffer.from(text, 'utf8'));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

import {
  parseChunk,
  parseChunkGrouped,
  commonChars,
  loadGroup,
  ensureCoreLoaded,
  getGroupChars,
  loadedChars,
  __setDecompressor,
  __resetCatalog,
} from '@/lib/editor/symbols/catalog';

/**
 * The symbols catalog — the runtime half of the generated dataset:
 * gz fetch → decompress → parse → cache. Common is bundled and
 * instant; core loads as one unit; CJK chunks load only when opened;
 * concurrent callers share one fetch. The decompressor runs through a
 * SEAM (tests inject a passthrough — the stream pipeline is
 * nondeterministic under jsdom+node); the native gzip path gets its
 * own direct test below.
 */

/** The core fixture in the GROUPED wire format (the real bundle's
 *  shape: '>groupId' headers, sections in this order so the flat
 *  assertions keep their order too). */
const CORE_TEXT = [
  '>punctuation',
  '003B;SEMICOLON',
  '>currency',
  '2044;FRACTION SLASH',
  '>greek',
  '03A9;GREEK CAPITAL LETTER OMEGA',
].join('\n');
const CJK_TEXT = '4E00;CJK UNIFIED IDEOGRAPH-4E00\n4E01;CJK UNIFIED IDEOGRAPH-4E01';

beforeEach(() => {
  __resetCatalog();
  __setDecompressor(async (bytes) => new TextDecoder().decode(bytes));
  vi.unstubAllGlobals();
});

describe('the wire format', () => {
  it('parses "hex;NAME" lines into codepoint chars', () => {
    const chars = parseChunk(CORE_TEXT);
    expect(chars.length).toBe(3);
    expect(chars[0]).toEqual({ cp: 0x3b, char: ';', name: 'SEMICOLON' });
    expect(chars[2]).toEqual({ cp: 0x3a9, char: 'Ω', name: 'GREEK CAPITAL LETTER OMEGA' });
  });

  it('parses astral codepoints via fromCodePoint (surrogate-safe)', () => {
    const [c] = parseChunk('1F600;GRINNING FACE');
    expect(c!.char).toBe('😀');
    expect(c!.char.length).toBe(2); // surrogate pair
  });

  it('skips blank and malformed lines', () => {
    expect(parseChunk('\n003B;SEMICOLON\nno-separator\n')).toEqual([
      { cp: 0x3b, char: ';', name: 'SEMICOLON' },
    ]);
  });

  it('DEFENSIVE: unparseable/out-of-range codepoints skip, never throw', () => {
    // A corrupted/partial response degrades to a smaller list — the
    // 'out of range of code points' crash class, dead.
    const garbage = 'zzzz;NOT HEX\nFFFFFF1;BEYOND THE RANGE\n110000;ONE TOO FAR\n003B;SEMICOLON';
    expect(parseChunk(garbage)).toEqual([{ cp: 0x3b, char: ';', name: 'SEMICOLON' }]);
  });

  it('parses the GROUPED core wire: >groupId headers slice the bundle', () => {
    const parsed = parseChunkGrouped('>math\n003B;SEMICOLON\n>greek\n03A9;OMEGA');
    expect(parsed.chars.map((c) => c.char)).toEqual([';', 'Ω']);
    expect(parsed.slices.get('math')!.map((c) => c.name)).toEqual(['SEMICOLON']);
    expect(parsed.slices.get('greek')!.map((c) => c.name)).toEqual(['OMEGA']);
  });
});

describe('Common', () => {
  it('is bundled — reshaped from the curated list, zero fetches', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const chars = commonChars();
    expect(chars.length).toBeGreaterThan(100); // the curated ~150
    expect(chars.some((c) => c.char === '©')).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('lazy chunk loading', () => {
  it('fetches the chunk, decompresses through the seam, caches forever', async () => {
    const fetchSpy = vi.fn(async () => new Response(CORE_TEXT));
    vi.stubGlobal('fetch', fetchSpy);

    await ensureCoreLoaded();
    await ensureCoreLoaded(); // second call = cache hit
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('/symbols/core.symbols');

    const chars = getGroupChars('core')!;
    expect(chars.map((c) => c.char)).toEqual([';', '⁄', 'Ω']);
    // Search surface = Common + core once loaded. Common populates its
    // cache on first call — call it BEFORE counting (the assertion
    // order was the bug: loadedChars() ran while Common was empty).
    const common = commonChars();
    expect(loadedChars().length).toBe(chars.length + common.length);
  });

  it('CORE GROUPS route through the ONE core load — no per-group chunks', async () => {
    // 'currency' is a core group (no currency.symbols exists on disk);
    // its chip must load the core bundle once and read the slice.
    const fetchSpy = vi.fn(async () => new Response(CORE_TEXT));
    vi.stubGlobal('fetch', fetchSpy);

    const currency = await loadGroup('currency');
    expect(currency.map((c) => c.char)).toEqual(['⁄']);
    expect(getGroupChars('punctuation')!.map((c) => c.char)).toEqual([';']);
    expect(getGroupChars('greek')!.map((c) => c.char)).toEqual(['Ω']);
    // ONE fetch — the core bundle; no currency.symbols was ever asked.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('/symbols/core.symbols');
  });

  it('concurrent callers share ONE fetch', async () => {
    const fetchSpy = vi.fn(async () => new Response(CJK_TEXT));
    vi.stubGlobal('fetch', fetchSpy);
    const [a, b] = await Promise.all([loadGroup('cjk-ideographs'), loadGroup('cjk-ideographs')]);
    expect(a).toBe(b);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a failed chunk surfaces the error and stays retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    await expect(loadGroup('cjk-ext-b')).rejects.toThrow('HTTP 404');
    expect(getGroupChars('cjk-ext-b')).toBeNull();
  });

  it('THE PRODUCTION GZIP PATH — fflate gunzip through the sniff', async () => {
    // Restore the DEFAULT decompressor (fflate gunzipSync — pure JS, no
    // runtime DecompressionStream dependency) and feed REAL gz bytes:
    // the sniff sees the gzip magic, fflate decodes, the wire parses.
    __setDecompressor();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(gz(CORE_TEXT))));
    await ensureCoreLoaded();
    expect(getGroupChars('core')!.map((c) => c.char)).toEqual([';', '⁄', 'Ω']);
  });

  it('THE TRANSPORT SNIFF — an already-decoded response parses directly', async () => {
    // Serving layers that transparently decode .gz hand the loader
    // PLAIN text; the gzip magic sniff must skip decompression, not
    // fail ('Failed to Decode Data.').
    const fetchSpy = vi.fn(async () => new Response(CORE_TEXT));
    vi.stubGlobal('fetch', fetchSpy);
    await ensureCoreLoaded();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(getGroupChars('core')!.map((c) => c.char)).toEqual([';', '⁄', 'Ω']);
  });
});
