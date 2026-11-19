// ─── SYMBOLS DATASET GENERATOR (build-time) ────────────────────────────
//
// Expands the Symbol picker from the curated ~150 to the full Unicode
// character database. @unicode/unicode-17.0.0 is the raw source, but it
// CANNOT run in a browser (its modules decompress via node:zlib) — so
// this script consumes it at BUILD time and emits our own compact,
// gzipped dataset into public/symbols/ (gitignored; the picker fetches
// and decompresses it lazily with the runtime's DecompressionStream).
//
// THE SCOPE (user-ruled): the CORE set is every graphic character
// EXCEPT CJK ideographs and Hangul syllables (~59k — the symbol-browsing
// set; 63% of full Unicode is CJK/Hangul, which would drown every
// browse). CJK ships as SEPARATE lazy chunks that only load when their
// group is opened. The curated ~150 in src/lib/editor/symbols.ts stay
// as the always-bundled "Common" group, untouched.
//
// THE FILTER (never leaks into the dataset): Unassigned, Private Use,
// Surrogates, Control, Format, Line/Paragraph separators — nothing the
// picker should ever offer.
//
// FRIENDLY GROUPING (the issue's UX bar — raw block names are not
// enough): a curated ordered mapping assigns every character to a
// human group at generation time; first match wins. Fallback group
// catches the rest.

import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ─── The friendly groups ───────────────────────────────────────────────
// Ordered: first match wins. Ranges are [start, end] code-point pairs
// (inclusive), or a GC predicate. Core groups load as ONE lazy chunk;
// CJK groups are individually lazy.

export const GROUPS = [
  // ORDER LAW: block-based groups match BEFORE GC-based families (an
  // Arrows char is GC Math_Symbol — a GC catch-all earlier in the list
  // would starve every later block group). Currency is first because
  // GC Currency_Symbol is unambiguous. NOTE: the GC map speaks LONG
  // names ('Currency_Symbol'), never abbreviations.
  { id: 'currency', label: 'Currency', lazy: false, match: { gc: ['Currency_Symbol'] } },
  { id: 'arrows', label: 'Arrows', lazy: false, match: { blocks: ['Arrows', 'Supplemental Arrows-A', 'Supplemental Arrows-B', 'Supplemental Arrows-C', 'Miscellaneous Symbols and Arrows'] } },
  { id: 'emoji', label: 'Emoji & Pictographs', lazy: false, match: { blocks: ['Emoticons', 'Miscellaneous Symbols and Pictographs', 'Supplemental Symbols and Pictographs', 'Transport and Map Symbols', 'Alchemical Symbols', 'Ancient Symbols'] } },
  { id: 'letterlike', label: 'Letterlike & Shapes', lazy: false, match: { blocks: ['Letterlike Symbols', 'Enclosed Alphanumerics', 'Enclosed Alphanumeric Supplement', 'Dingbats', 'Miscellaneous Symbols', 'Geometric Shapes', 'Geometric Shapes Extended', 'Ornamental Dingbats', 'Control Pictures', 'Optical Character Recognition', 'Yijing Hexagram Symbols', 'Braille Patterns', 'Runic', 'Gothic', 'Deseret', 'Shavian', 'Ogham', 'Tai Xuan Jing Symbols', 'Counting Rod Numerals', 'Domino Tiles', 'Playing Cards', 'Mahjong Tiles'] } },
  { id: 'greek', label: 'Greek & Coptic', lazy: false, match: { blocks: ['Greek and Coptic', 'Greek Extended'] } },
  { id: 'cyrillic', label: 'Cyrillic', lazy: false, match: { blocks: ['Cyrillic', 'Cyrillic Supplement', 'Cyrillic Extended-A', 'Cyrillic Extended-B', 'Cyrillic Extended-C'] } },
  { id: 'hebrew', label: 'Hebrew', lazy: false, match: { blocks: ['Hebrew'] } },
  { id: 'arabic', label: 'Arabic', lazy: false, match: { blocks: ['Arabic', 'Arabic Supplement', 'Arabic Extended-A', 'Arabic Presentation Forms-A', 'Arabic Presentation Forms-B'] } },
  { id: 'armenian', label: 'Armenian & Georgian', lazy: false, match: { blocks: ['Armenian', 'Georgian', 'Georgian Extended'] } },
  { id: 'latin', label: 'Latin Extended', lazy: false, match: { blocks: ['Latin Extended-A', 'Latin Extended-B', 'Latin Extended Additional', 'Latin Extended-C', 'Latin Extended-D', 'Latin Extended-E', 'Latin-1 Supplement', 'IPA Extensions', 'Phonetic Extensions', 'Phonetic Extensions Supplement', 'Modifier Tone Letters'] } },
  // CJK groups BEFORE the scripts catch-all (CJK ideographs are GC
  // Other_Letter — the catch-all would swallow them otherwise). Block
  // names are the package's full official names (underscores → spaces).
  { id: 'cjk-symbols', label: 'CJK Symbols', lazy: true, match: { blocks: ['CJK Symbols And Punctuation', 'CJK Radicals Supplement', 'CJK Strokes', 'Enclosed CJK Letters And Months'] } },
  { id: 'cjk-ideographs', label: 'CJK Ideographs', lazy: true, match: { blocks: ['CJK Unified Ideographs'] } },
  { id: 'cjk-ext-a', label: 'CJK Ext. A', lazy: true, match: { blocks: ['CJK Unified Ideographs Extension A'] } },
  { id: 'cjk-ext-b', label: 'CJK Ext. B', lazy: true, match: { blocks: ['CJK Unified Ideographs Extension B'] } },
  { id: 'cjk-ext-c-j', label: 'CJK Ext. C–J', lazy: true, match: { blocks: ['CJK Unified Ideographs Extension C', 'CJK Unified Ideographs Extension D', 'CJK Unified Ideographs Extension E', 'CJK Unified Ideographs Extension F', 'CJK Unified Ideographs Extension G', 'CJK Unified Ideographs Extension H', 'CJK Unified Ideographs Extension I', 'CJK Unified Ideographs Extension J'] } },
  { id: 'cjk-compat', label: 'CJK Compatibility', lazy: true, match: { blocks: ['CJK Compatibility Ideographs', 'CJK Compatibility Forms'] } },
  { id: 'hangul', label: 'Hangul', lazy: true, match: { blocks: ['Hangul Syllables', 'Hangul Jamo', 'Hangul Compatibility Jamo', 'Hangul Jamo Extended-A', 'Hangul Jamo Extended-B'] } },
  // Core catch-alls AFTER the script-specific groups.
  { id: 'scripts', label: 'Other Scripts', lazy: false, match: { gc: ['Other_Letter', 'Modifier_Letter', 'Titlecase_Letter', 'Lowercase_Letter', 'Uppercase_Letter', 'Nonspacing_Mark', 'Spacing_Mark', 'Enclosing_Mark', 'Other_Number', 'Letter_Number'] } },
  { id: 'math', label: 'Math & Technical', lazy: false, match: { gc: ['Math_Symbol', 'Other_Symbol', 'Modifier_Symbol'], blocks: ['Mathematical Operators', 'Miscellaneous Technical', 'Mathematical Alphanumeric Symbols', 'Miscellaneous Mathematical Symbols-A', 'Miscellaneous Mathematical Symbols-B', 'Supplemental Mathematical Operators'] } },
  { id: 'punctuation', label: 'Punctuation', lazy: false, match: { gc: ['Other_Punctuation', 'Dash_Punctuation', 'Open_Punctuation', 'Close_Punctuation', 'Initial_Punctuation', 'Final_Punctuation', 'Connector_Punctuation'] } },
  { id: 'other', label: 'Other Symbols', lazy: false, match: {} },
]

export const DROPPED_CATEGORIES = new Set([
  'Unassigned', 'Private_Use', 'Surrogate', 'Control', 'Format',
  'Line_Separator', 'Paragraph_Separator',
]);

// ─── Block ranges (from the package's per-block ranges.mjs, resolved
// once — directory names use underscores; the group table uses spaces) ──

export async function buildBlockRanges(packageDir) {
  const blocksDir = join(packageDir, 'Block');
  const ranges = new Map(); // NORMALIZED block name -> [[start, end], ...]
  for (const name of readdirSync(blocksDir)) {
    const mod = await import(pathToFileURL(join(blocksDir, name, 'ranges.mjs')).href);
    const list = (mod.default ?? mod).map((r) => [r.begin, r.end]);
    // The package writes hyphens as underscores ('Supplemental_Arrows_A'
    // vs the official 'Supplemental Arrows-A') — group tables match on
    // the NORMALIZED form (lowercase, [_-] collapsed to space) so the
    // table can speak official names.
    ranges.set(normalizeBlockName(name.replaceAll('_', ' ')), list);
  }
  return ranges;
}

/** Block-name normalization for matching: lowercase, hyphens and
 *  underscores collapse to single spaces ('supplemental arrows a'). */
export function normalizeBlockName(name) {
  return name.toLowerCase().replace(/[_\s-]+/g, ' ').trim();
}

/** Assign one character to its group (first match wins over GROUPS). */
export function assignGroup(cp, cat, blockRanges) {
  for (const group of GROUPS) {
    const { gc, blocks } = group.match;
    if (gc && gc.includes(cat)) return group.id;
    if (blocks) {
      for (const block of blocks) {
        const list = blockRanges.get(normalizeBlockName(block));
        if (!list) continue;
        for (const [start, end] of list) {
          if (cp >= start && cp <= end) return group.id;
        }
      }
    }
  }
  return null; // dropped
}

/** The pure core of the generator: dataset in → grouped lines + index
 *  out. Exported for tests (the script's CLI is a thin shell).
 *  TYPEABLE ASCII DROPPED: Basic-Latin letters/digits are keyboard
 *  work, not symbols — no symbol picker offers A-Z/0-9. */
export function buildDataset(gc, names, blockRanges) {
  const byGroup = new Map(); // groupId -> lines[]
  for (const group of GROUPS) byGroup.set(group.id, []);
  let dropped = 0;
  for (const [cp, cat] of gc) {
    if (DROPPED_CATEGORIES.has(cat)) { dropped++; continue; }
    // Typeable ASCII: letters/digits the user can already type.
    if (cp >= 0x41 && cp <= 0x5A) { dropped++; continue; } // A-Z
    if (cp >= 0x61 && cp <= 0x7A) { dropped++; continue; } // a-z
    if (cp >= 0x30 && cp <= 0x39) { dropped++; continue; } // 0-9
    const groupId = assignGroup(cp, cat, blockRanges);
    if (groupId === null || !names.has(cp)) { dropped++; continue; }
    byGroup.get(groupId).push(`${cp.toString(16).padStart(4, '0')};${names.get(cp)}`);
  }
  const groups = [];
  for (const group of GROUPS) {
    const lines = byGroup.get(group.id);
    if (lines.length === 0) continue;
    groups.push({ id: group.id, label: group.label, lazy: group.lazy, count: lines.length });
  }
  return { groups, byGroup };
}

/** The compact wire format: one group per line in the index; each
 *  chunk file is a single string of "hex;NAME" lines (newline-joined)
 *  — ~5 bytes/char overhead-free, parse = split('\n'). */
export function chunkText(lines) {
  return lines.join('\n');
}

// ─── CLI ───────────────────────────────────────────────────────────────

async function main() {
  const gc = (await import('@unicode/unicode-17.0.0/General_Category/index.mjs')).default;
  const names = (await import('@unicode/unicode-17.0.0/Names/index.mjs')).default;
  const blockRanges = await buildBlockRanges(join(process.cwd(), 'node_modules', '@unicode', 'unicode-17.0.0'));

  const { groups, byGroup } = buildDataset(gc, names, blockRanges);

  const out = join(process.cwd(), 'public', 'symbols');
  mkdirSync(out, { recursive: true });
  // Stale .json.gz chunks from earlier builds would linger and confuse
  // nobody (the loader asks for .symbols) — clean them anyway.
  const stale = readdirSync(out).filter((f) => f.endsWith('.json.gz'));
  for (const f of stale) rmSync(join(out, f));

  // One gz chunk per LAZY group + one bundle for all core groups
  // (core loads as a unit — ~271KB gz; CJK chunks load individually).
  // THE .symbols EXTENSION LAW: a .gz filename makes serving layers
  // claim `Content-Encoding: gzip`, and the webview's transparent
  // decode of a Content-Length-mismatched body leaves the loader
  // hanging ('Loading …' forever). A non-.gz name means the bytes
  // arrive RAW — the loader's magic sniff + fflate decode them.
  //
  // THE GROUP-BOUNDARY LAW: the core bundle is ONE chunk holding MANY
  // groups — a `>groupId` header line starts each group's section so
  // the runtime can slice per-group lists out of the single load
  // (without it, every core-group chip would fetch a chunk that does
  // not exist — the 'Loading Currency… forever' bug).
  const core = [];
  for (const g of groups) {
    if (g.lazy) continue;
    core.push(`>${g.id}`);
    core.push(...byGroup.get(g.id));
  }
  writeFileSync(join(out, 'core.symbols'), gzipSync(Buffer.from(chunkText(core), 'utf8')));

  for (const g of groups) {
    if (!g.lazy) continue;
    writeFileSync(
      join(out, `${g.id}.symbols`),
      gzipSync(Buffer.from(chunkText(byGroup.get(g.id)), 'utf8')),
    );
  }

  // The index — tiny, committed (force-added like licenses.json) so
  // the picker's chips render without loading anything.
  const genDir = join(process.cwd(), 'src', 'generated');
  mkdirSync(genDir, { recursive: true });
  writeFileSync(
    join(genDir, 'symbols-index.json'),
    JSON.stringify({ groups, total: groups.reduce((sum, g) => sum + g.count, 0) }, null, 2),
  );

  const coreCount = core.length;
  const lazyCount = groups.filter((g) => g.lazy).reduce((sum, g) => sum + g.count, 0);
  console.log(`[generate-symbols] ${groups.length} groups, core ${coreCount} chars, lazy ${lazyCount} chars — public/symbols/ + src/generated/symbols-index.json`);
}

// Run only as a CLI (tests import the functions).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  await main();
}
