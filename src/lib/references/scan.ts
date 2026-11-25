import type { Node as PMNode } from '@tiptap/pm/model';

/**
 * #31 — one pure walk over the PM doc producing every collection's
 * entries as one kind-agnostic shape (a new collection = one scanner
 * arm). Entries are derived facts — a rescan is the update.
 */

export type ReferenceKind = 'toc' | 'figures' | 'index';

/** One click target. `pos` is the final caret position (block interiors
 *  are pos+1; index marks sit at the span start). `blockId` is the
 *  generator's reconciliation key: a retitled heading updates in place. */
export interface ReferenceTarget {
  pos: number;
  blockId: string;
}

/** One collection entry, kind-agnostic: display text, indent level, and
 *  one or more navigation targets (toc/figures: exactly one; index:
 *  one per marked occurrence, in document order). */
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

/** The kind registry — the display metadata the insert dialog, NodeView,
 *  and placeholder read. Adding a collection kind = one entry here + one
 *  scanner arm in scanCollections. */
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
 * band content is not body content: a heading in a header is chrome,
 * never a ToC entry, and an index term in a footer is never indexed. */
const BAND_KINDS = new Set(['headerBlock', 'footerBlock']);

/** The scan — pure: reads the doc, allocates the entries. No editor,
 *  no store, no DOM. */

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

/** A figure is a block image whose next top-level sibling is a
 *  caption-styled paragraph (a hand-typed Caption after an image is
 *  still its caption; an inline image is not a figure). */
function isCaptionParagraph(node: PMNode | undefined): boolean {
  return (
    !!node && node.type.name === 'paragraph' && (node.attrs?.styleId ?? '') === 'caption'
  );
}

/** Merge adjacent marked text nodes into one span (a term marked
 * across a formatting boundary — "Tens" bold + "or" plain — is one
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

  // Group by exact trimmed text (case is identity: "Tensor" and
  // "tensor" are distinct entries — Word's rule); sort case-insensitive
  // with localeCompare; occurrences within a term keep doc order (JS
  // sort is stable, and spans were collected in doc order).
  const byTerm = new Map<string, RefCollectionEntry>();
  for (const span of spans) {
    const term = span.text.trim();
    if (!term) continue; // whitespace-only marks are never entries
    let entry = byTerm.get(term);
    if (!entry) {
      // Loop-proofing: every entry carries level ≥ 1 (a level-0 entry
      // would re-derive level 1 on read-back and loop the generator).
      entry = { text: term, level: 1, targets: [] };
      byTerm.set(term, entry);
    }
    entry.targets.push({ pos: span.from, blockId: blockIdOf(doc, span.from) });
  }
  return [...byTerm.values()].sort((a, b) =>
    a.text.localeCompare(b.text, undefined, { sensitivity: 'base' })
  );
}

/** Headings anywhere in body content (a heading in a blockquote is
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
      // Base level 1 — figure rows never indent (level 0 is banned).
      level: 1,
      targets: [{ pos: next.pos + 1, blockId: String(next.node.attrs?.blockId ?? '') }],
    });
  }
  return entries;
}

/** Scan every collection off the current doc — memoized on the doc
 *  object. Callers filter per node (a ToC's depth attr prunes deep
 *  headings); the scan itself is depth-blind. */
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

/** The entries for one node's kind+depth — the one projection every
 *  surface (NodeView, adapter, tests) consumes. */
export function entriesForKind(
  scan: CollectionScan,
  kind: ReferenceKind,
  depth: number
): RefCollectionEntry[] {
  const entries = scan[kind];
  return kind === 'toc' ? entries.filter((e) => e.level <= depth) : entries;
}

/** The generator's per-entry reconciliation key (`refId`): the target's
 *  blockId (toc/figures) or the term itself (index). An entry whose key
 *  survives an edit is updated in place, never rebuilt. */
export function refIdOf(entry: RefCollectionEntry, kind: ReferenceKind): string {
  return kind === 'index' ? entry.text : entry.targets[0]?.blockId ?? '';
}
