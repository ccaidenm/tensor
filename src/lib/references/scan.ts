import type { Node as PMNode } from '@tiptap/pm/model';

/**
 * M-REFS — the generic reference-collection scanner (issue #31): ONE
 * pure walk over the PM document producing EVERY collection's entries
 * (ToC headings, bonded figure captions, index-marked terms) as ONE
 * kind-agnostic entry shape. The three shipped features are thin
 * projections of this scan; M3's Table of Tables / Table of
 * Authorities / custom collections add a scanner arm here — the
 * rendering, insertion, and persistence layers stay untouched (the
 * issue's "cheap to add later" demand).
 *
 * ENTRIES ARE DERIVED FACTS (the equation law: the model stores the
 * SOURCE, rendering is a projection): nothing here is persisted, so
 * auto-update is inherent — a rescan IS the update — and .wpdoc
 * round-trips need zero new fields. The referenceTable NODE stores
 * only { kind, depth }; every entry you see is recomputed per doc
 * version.
 *
 * STABILITY LAW (the adapter's identity-cache pattern): the scan is
 * memoized on the PM DOC OBJECT (immutable — one object per doc
 * version via structural sharing), so unchanged documents never
 * rescan, and the scan is shared by every referenceTable node in the
 * document (one walk, N consumers — the adapter calls it synchronously
 * at conversion time; the NodeView calls it at render time).
 */

export type ReferenceKind = 'toc' | 'figures' | 'index';

/** One click target. `pos` is the FINAL caret position for navigation
 * (block interiors are pos+1; index marks sit AT the span start).
 * `blockId` is the target block's stable id — the GENERATOR's
 * reconciliation key (an entry paragraph carries it as `refId`, so
 * a retitled heading UPDATES its entry in place, keeping the user's
 * formatting, instead of rebuilding the whole table). */
export interface ReferenceTarget {
  pos: number;
  blockId: string;
}

/** One collection entry, kind-agnostic — the generic system's unit:
 * display text, indent level, and one or more navigation targets
 * (toc/figures: exactly one; index: one per marked occurrence, in
 * document order — a term appearing multiple times lists multiple
 * locations, the issue's explicit demand). */
export interface RefCollectionEntry {
  text: string;
  /** Indent level (toc: the heading level 1–6; figures/index: 0). */
  level: number;
  targets: ReferenceTarget[];
}

export interface CollectionScan {
  toc: RefCollectionEntry[];
  figures: RefCollectionEntry[];
  index: RefCollectionEntry[];
}

/**
 * The kind registry — the display metadata the insert dialog, the
 * NodeView, and the placeholder all read. Adding an M3 collection
 * kind = one entry here + one scanner arm in scanCollections.
 */
export const REFERENCE_KINDS: Record<
  ReferenceKind,
  { title: string; emptyHint: string; description: string }
> = {
  toc: {
    title: 'Table of Contents',
    emptyHint: 'No headings yet — entries appear as you add them.',
    description: 'Headings, in document order. Updates automatically.',
  },
  figures: {
    title: 'Table of Figures',
    emptyHint: 'No captioned figures yet — add a caption to an image and it appears here.',
    description: 'Captioned images, in document order. Updates automatically.',
  },
  index: {
    title: 'Index',
    emptyHint: 'No index entries yet — mark a word or phrase and it appears here.',
    description: 'Marked terms, alphabetically. Updates automatically.',
  },
};

/** Top-level band container names (HeaderFooterNodes' containers) —
 * band content is NOT body content: a heading in a header is chrome,
 * never a ToC entry, and an index term in a footer is never indexed. */
const BAND_KINDS = new Set(['headerBlock', 'footerBlock']);

/** ─── The scan ───────────────────────────────────────────────────
 * Pure: reads the doc, allocates the entries. No editor, no store, no
 * DOM (the adapter contract — L1's shape at the scan layer). */

/** The containing block's stable id for a position (an index span
 * lives inside its paragraph — the paragraph's blockId is the
 * generator's reconciliation key for the entry it feeds). */
function blockIdOf(doc: PMNode, pos: number): string {
  const $pos = doc.resolve(pos);
  for (let d = $pos.depth; d >= 1; d--) {
    const attrs = $pos.node(d).attrs as { blockId?: unknown };
    if (typeof attrs.blockId === 'string' && attrs.blockId) return attrs.blockId;
  }
  return '';
}

const scanCache = new WeakMap<PMNode, CollectionScan>();

/** The caption-bond ruling: a figure is a BLOCK image whose NEXT
 * TOP-LEVEL SIBLING is a caption-styled paragraph. The keepNext bond
 * (media/caption.ts) is the LAYOUT spelling of the link; the ToF hook
 * keys on ADJACENCY + the 'caption' STYLE identity (Word's reading —
 * a hand-typed Caption paragraph after an image is still its caption).
 * An inline image is not a figure (it seats in text, no caption can
 * bond to it — the extract-then-caption policy). */
function isCaptionParagraph(node: PMNode | undefined): boolean {
  return (
    !!node && node.type.name === 'paragraph' && (node.attrs?.styleId ?? '') === 'caption'
  );
}

/** Merge ADJACENT marked text nodes into one span (a term marked
 * across a formatting boundary — "Tens" bold + "or" plain — is ONE
 * index term, not two halves), then group by exact trimmed text. */
function scanIndexSpans(doc: PMNode): RefCollectionEntry[] {
  const spans: Array<{ from: number; to: number; text: string }> = [];
  doc.descendants((node, pos) => {
    if (BAND_KINDS.has(node.type.name)) return false; // band subtrees are skipped
    if (!node.isText) return;
    if (!node.marks.some((m) => m.type.name === 'indexEntry')) return;
    const text = node.text ?? '';
    const last = spans[spans.length - 1];
    if (last && last.to === pos) {
      // Adjacent marked text — same span (PM only splits a marked
      // range at formatting boundaries).
      last.to = pos + node.nodeSize;
      last.text += text;
    } else {
      spans.push({ from: pos, to: pos + node.nodeSize, text });
    }
    return;
  });

  // Group by EXACT trimmed text (case is identity: "Tensor" and
  // "tensor" are distinct entries — Word's rule); sort case-INSENSITIVE
  // with localeCompare; occurrences within a term keep doc order (JS
  // sort is stable, and spans were collected in doc order).
  const byTerm = new Map<string, RefCollectionEntry>();
  for (const span of spans) {
    const term = span.text.trim();
    if (!term) continue; // whitespace-only marks are never entries
    let entry = byTerm.get(term);
    if (!entry) {
      // LEVEL CONVENTION (loop-proofing, pinned by the app-flow tests):
      // EVERY entry carries a level ≥ 1 — figures/index rows are base
      // level 1 (the generator's (level−1)·32 indent math and its
      // read-back agree by construction; a level-0 entry would
      // re-derive level 1 on read-back and loop the generator).
      entry = { text: term, level: 1, targets: [] };
      byTerm.set(term, entry);
    }
    entry.targets.push({ pos: span.from, blockId: blockIdOf(doc, span.from) });
  }
  return [...byTerm.values()].sort((a, b) =>
    a.text.localeCompare(b.text, undefined, { sensitivity: 'base' })
  );
}

/** Headings ANYWHERE in body content (a heading in a blockquote is
 * still a heading), each carrying its level + the caret-inside target. */
function scanTocEntries(doc: PMNode): RefCollectionEntry[] {
  const entries: RefCollectionEntry[] = [];
  doc.descendants((node, pos) => {
    if (BAND_KINDS.has(node.type.name)) return false;
    if (node.type.name !== 'heading') return;
    const level = typeof node.attrs.level === 'number' ? node.attrs.level : 1;
    entries.push({
      text: node.textContent,
      level,
      targets: [{ pos: pos + 1, blockId: String(node.attrs?.blockId ?? '') }],
    });
    return;
  });
  return entries;
}

/** Figures: block image + caption sibling, top level only. */
function scanFigureEntries(doc: PMNode): RefCollectionEntry[] {
  const entries: RefCollectionEntry[] = [];
  const top: Array<{ node: PMNode; pos: number }> = [];
  doc.forEach((node, offset) => {
    if (!BAND_KINDS.has(node.type.name)) top.push({ node, pos: offset });
  });
  for (let i = 0; i < top.length; i++) {
    if (top[i]!.node.type.name !== 'image') continue;
    const next = top[i + 1];
    if (!isCaptionParagraph(next?.node)) continue;
    const text = next.node.textContent.trim();
    if (!text) continue; // an empty caption is not yet a figure entry
    entries.push({
      text,
      // Base level 1 — the figures rows never indent (the convention
      // comment above; level 0 is banned).
      level: 1,
      targets: [{ pos: next.pos + 1, blockId: String(next.node.attrs?.blockId ?? '') }],
    });
  }
  return entries;
}

/** Scan EVERY collection off the CURRENT doc — memoized on the doc
 * object (the stability law). Callers filter per node (e.g. a ToC's
 * depth attr prunes deep headings) — the scan itself is depth-blind. */
export function scanCollections(doc: PMNode): CollectionScan {
  const cached = scanCache.get(doc);
  if (cached) return cached;
  const scan: CollectionScan = {
    toc: scanTocEntries(doc),
    figures: scanFigureEntries(doc),
    index: scanIndexSpans(doc),
  };
  scanCache.set(doc, scan);
  return scan;
}

/** The entries for one node's kind+depth — the ONE projection every
 * surface (NodeView, adapter, tests) consumes. */
export function entriesForKind(
  scan: CollectionScan,
  kind: ReferenceKind,
  depth: number
): RefCollectionEntry[] {
  const entries = scan[kind];
  return kind === 'toc' ? entries.filter((e) => e.level <= depth) : entries;
}

/** The GENERATOR's per-entry reconciliation key (an entry paragraph's
 * `refId`): the target's stable blockId (toc/figures) or the term
 * itself (index — terms are unique by the grouping law). An entry
 * whose key survives a doc edit is UPDATED IN PLACE, never rebuilt —
 * the user's formatting lives on (the GDocs ruling). */
export function refIdOf(entry: RefCollectionEntry, kind: ReferenceKind): string {
  return kind === 'index' ? entry.text : entry.targets[0]?.blockId ?? '';
}
