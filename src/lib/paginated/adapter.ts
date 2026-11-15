import type { Node as PMNode } from '@tiptap/pm/model';
import type {
  Block,
  CodeBlockBlock,
  EquationBlock,
  HeadingBlock,
  ImageBlock,
  ParagraphBlock,
  ReferenceTableBlock,
  Run,
  SectionBoundary,
  SemanticDoc,
  TableBlock,
  TextStyle,
} from '@tensor-editor/engine';
import { toLayoutOptions, type PageSetup } from '@/lib/document/pageSetup';
import type { TextAlign } from './positionMap';
import type { StyleDefinition, StyleRegistrySnapshot } from '@/lib/styles/types';
import { headingStyleId } from '@/lib/styles/types';
import { builtinDefinitionsById } from '@/lib/styles/builtins';
import { lookupStyle } from '@/lib/styles/registry';
import { normalizeTabStops } from '@/lib/editor/ParagraphExtensions';
import { FINAL_SECTION_ID, regionOf, type HeaderFooterVariant } from '@/lib/editor/HeaderFooterNodes';
// M-REFS: the collection scan — the referenceTable node's entries are
// real paragraphs the GENERATOR maintains (the container model); the
// adapter joins them to their navigation targets through the same
// memoized one-walk scan every consumer shares.
import {
  entriesForKind,
  scanCollections,
  type CollectionScan,
  type ReferenceKind,
} from '@/lib/references/scan';
// M-REFS: the two-pass resolver's map type (referencePages.ts).
import type { ReferencePagesMap } from './referencePages';
import {
  baselineRunStyle,
  resolveBlockTier,
  resolveRun,
  transformText,
  type BlockTierAttrs,
  type RunStyle,
} from '@/lib/styles/resolve';
export type { TextAlign } from './positionMap';

/**
 * PM doc -> engine SemanticDoc. Pure conversion, no
 * measurement, no DOM reads (L1: the engine computes, never paints; the
 * shell paints, never computes — this is the shell->engine handoff).
 *
 * FULL EXISTING-BLOCK PARITY (M6.1): every block kind the schema can
 * hold projects into engine Blocks:
 *   - bulletList/orderedList recurse: each listItem's inner paragraph
 *     becomes a paragraph block with indentLeft = depth × 32 (px) and
 *     a paint-only listMarker hint (ordered index computed per-list —
 *     sibling deletion reindexes the remainder).
 *   - blockquote bodies project as paragraph blocks with indentLeft 32
 *     and a paint-only blockquote hint.
 *   - codeBlock projects onto the engine's codeBlock kind (source-line
 *     semantics in the engine's breaker), runs mapped per source line,
 *     monospace @ the document-default size (the pageless <pre> look).
 *   - horizontalRule projects as a single-line paragraph block with a
 *     rule paint hint — one LineBox, never fragments.
 *   - equation (M-EQ) projects onto the engine's equation kind: latex
 *     is the node's ONLY document data; dims are NOT sent — they are
 *     derived facts the engine asks the EquationMetrics PORT for at
 *     layout time (the adapter is pure and cannot measure — L1).
 *     fontSize is the resolved document-default run size (`base` — the
 *     same derivation every paragraph run carries).
 * Remaining kinds throw UnsupportedDocError — ONLY the true future
 * features (table, image, drawing). The PaginatedView's fallback
 * catches ONLY that sentinel; everything else crashes loudly in dev
 * (CONVENTIONS.md, the fallback audit).
 *
 * The pageBreak node is NOT part of the IR: it becomes
 * `flow.breakBefore: 'page'` on the FOLLOWING block (the forced-break
 * spelling the engine's structural tier consumes — engine/src/types.ts
 * FlowPolicy).
 */

/**
 * The unsupported-kind sentinel. The pageless fallback catches ONLY
 * this class (CONVENTIONS.md): a document using a node the projection
 * does not support yet degrades gracefully — a real adapter/engine bug
 * is a different exception and must crash loudly in dev.
 */
/** #58 — the defensive page-setup fallback (a caller that skips the
 *  pageSetup arg; the real callers pass the store's per-call read). */
const FALLBACK_PAGE_SETUP: PageSetup = {
  pageSize: 'Letter',
  orientation: 'portrait',
  margins: { top: 72, bottom: 72, left: 72, right: 72 },
  pageGap: 32,
};

export class UnsupportedDocError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedDocError';
  }
}

export interface ListMarkerHint {
  kind: 'bullet' | 'ordered';
  /** 1-based nesting depth (top-level items = 1; indentLeft = depth × 32). */
  depth: number;
  /** 1-based index within the item's own list (ordered reindex source). */
  index: number;
  /** The list node's listStyleType attr ('disc'/'decimal'/'lower-roman'/...). */
  styleType: string;
}

/**
 * SHELL-SIDE PAINT HINTS, attached to semantic blocks AND mirrored on
 * AdapterBlock.paint. The ENGINE IGNORES THEM: hashBlock stringifies
 * only {kind, runs, flow, spaceBefore, spaceAfter} and the walk never
 * reads them — they are paint facts. Consequence (deliberate): an
 * ordered reindex produces a NEW Block object with an UNCHANGED hash,
 * so the engine's splice keeps the cached placement — markers are ink,
 * never re-flow.
 */
export interface BlockPaint {
  marker?: ListMarkerHint;
  blockquote?: boolean;
  rule?: boolean;
  /** codeBlock backgrounds (the kind's paint face — carried here so the
   * painter stays hint-driven, one extras field for all block decor). */
  code?: boolean;
  /** M-IMAGES-1: a styleId 'caption' paragraph — the DISPLAY toggle's
   *  paint-side hook (document-derived fact; config stays out of the
   *  projection). */
  caption?: boolean;
  /** M-REFS: a reference table block — the GDocs-style FIELD BORDER
   * (a light gray rounded box around the block's per-page fragment,
   * drawn by paintLines as pure ink; layout never reads it). (The
   * leader toggle lives in the MODEL — the generator's refLeader
   * span — not a paint hint: the dots are real runs now.) */
  reference?: boolean;
}

export interface AdapterBlock {
  id: string;
  runs: Run[];
  /** Concatenated run text (runs joined in array order) — the engine's
   * LineBox/rangeStart/rangeEnd offsets index into exactly this string. */
  text: string;
  /** PM positions: the block node spans [from, to); its text content
   * starts at from + 1. PM caret pos -> block text offset =
   * pos - (from + 1). */
  from: number;
  to: number;
  /** Block-level text alignment, from PM's textAlign attr. 'justify' is
   * engine work (explicitly out of the shell scope) and stays in
   * the dropped-attr warning list. */
  align: TextAlign;
  /** Block-tier left indent (px) — mirrors the semantic block's
   * indentLeft for the painter (markers live in the [indent−32,
   * indent) gutter). */
  indentLeft?: number;
  /** Block-tier right indent (px) — informational mirror. */
  indentRight?: number;
  /** Paint hints — see BlockPaint. */
  paint?: BlockPaint;
  /** Visual mark props per run (parallel to `runs`, indexed by the
   * LineBox segments' runIndex) — shell-side paint concerns the engine's
   * layout math never sees. */
  runDecor: RunDecor[];
  /**
   * M-TABLES — present IFF this block is a table: the CELL-PARAGRAPH
   * map, the PM↔table-text offset bridge. The table's runs/text are
   * the CANONICAL concatenation (rows top-down, cells left-to-right,
   * paragraphs in order); each entry names one cell paragraph's text:
   * `relStart` = the paragraph's first text position relative to the
   * TABLE node (pmStart = block.from + relStart), `textStart`/`textLen`
   * = the paragraph's slice of the block text. The slices tile the
   * block text exactly (no gaps) — PM's table cells are isolating, so
   * every text selection lives inside one slice.
   */
  table?: { paragraphs: { relStart: number; textStart: number; textLen: number }[] };
  /**
   * M-REFS — present IFF this block is a referenceTable: the
   * ENTRY map, the hit-offset → navigation-target bridge (the
   * table.paragraphs precedent). The block's runs/text are the
   * entries' CANONICAL concatenation (entry text, then the tab +
   * page-number runs when pages are resolved); each sidecar entry
   * names one collection entry's text slice + its PM navigation
   * targets (toc/figures: exactly one; index: one per occurrence).
   * The placeholder (empty collection) carries ONE entry with ZERO
   * targets — visible, never navigable.
   */
  reference?: ReferenceSidecar;
}

/** One reference-table sidecar entry — see AdapterBlock.reference. */
export interface ReferenceSidecarEntry {
  /** The entry paragraph's PM position RELATIVE to the container node
   *  (its text starts at relStart; pmStart = block.from + relStart) —
   *  the caret/selection bridge into REAL entry text (the table
   *  cell-map's shape, minus the grid). */
  relStart: number;
  /**
   * M-REFS-8 — the LEADER SPAN's text length at this row's tail (the
   * refLeader-marked dots; 0 = no leader). The PAINTER's tag: the
   * gap-filling dots (extra ink at the leader run's own measured
   * style) are drawn after the span's text, up to the page number —
   * never layout, never the block-text contract. */
  leaderLen: number;
  /** The child's REAL text slice of the canonical block text (the
   *  synthetic tab/number suffix follows it, non-mappable). */
  textStart: number;
  textLen: number;
  /** PM positions (final caret targets), doc order. Zero for the
   *  placeholder (visible, never navigable). */
  targets: number[];
}

export interface ReferenceSidecar {
  entries: ReferenceSidecarEntry[];
}

/** The sidecar entry whose text slice contains `offset` (the slices
 * tile the block text; binary search on textStart). Null when the
 * offset falls between slices — never happens today (no separators),
 * kept honest for the number-run layout. */
export function referenceEntryAt(
  ref: ReferenceSidecar,
  offset: number
): ReferenceSidecarEntry | null {
  let lo = 0;
  let hi = ref.entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = ref.entries[mid]!;
    if (offset < e.textStart) hi = mid - 1;
    else if (offset >= e.textStart + e.textLen) lo = mid + 1;
    else return e;
  }
  return null;
}

export interface RunDecor {
  /** Text color (PM color mark, hex). */
  color?: string;
  /** Highlight background (PM highlight mark; resolved color). */
  highlight?: string;
  underline?: boolean;
  strike?: boolean;
}

export interface AdapterResult {
  doc: SemanticDoc;
  blocks: AdapterBlock[];
  /**
   * M-HEADER-FOOTER-2 — the BAND blocks (header/footer children), in
   * document order. The SAME adapter objects ride `blocks` (they hold
   * real PM positions — the paint/caret/hit-test sidecar's binary
   * search needs them, and the walk emits them in `from` order); this
   * sidecar carries the band MEMBERSHIP (muted ink, band hit-test
   * routing, band-boundary selection clamps).
   */
  bandBlocks: AdapterBlock[];
  /** M-HEADER-FOOTER-2 — block ids that belong to bands (the set form). */
  bandBlockIds: Set<string>;
  /**
   * #58 SECTIONS — the resolved section-boundary table for the engine
   * (LayoutOptions.sections). ABSENT when the doc carries no
   * sectionBreak nodes (the additive law: the engine then runs ONE
   * section of the layout opts — today's shape exactly). Each
   * boundary is a SECTION START: afterBlock −1 carries section 0's
   * geometry (the FIRST break's attrs — Word's preceding-section
   * spelling resolved forward), each following boundary the NEXT
   * break's attrs, and the implicit final section rides the layout
   * opts (the doc defaults — the engine appends it).
   */
  sections?: SectionBoundary[];
  /**
   * #58 — the NPC sidecar (formatting marks): every break atom with
   * the block following it. VIEW-ONLY ink (the PaginatedView paints
   * the badges when formatting marks are shown); the print/PDF walks
   * never read it — markers never print.
   */
  breakFacts: {
    kind: 'pageBreak' | 'sectionBreak';
    type: 'nextPage' | 'continuous';
    pos: number;
    afterBlockId: string | null;
  }[];
}

/**
 * The default registry for call sites that predate M-STYLES: the code
 * builtins alone. Heading levels resolve through their built-in
 * definitions (the old HEADING_DEFAULTS values, verbatim) and
 * paragraphs carry styleId 'normal' (no properties) — behavior
 * identical to the pre-registry adapter.
 */
const BUILTIN_REGISTRY: StyleRegistrySnapshot = {
  definitions: builtinDefinitionsById(),
  epoch: 0,
};

// Dropped-attr policy: these PM attributes/marks have no representation
// in the semantic doc. NEVER silent — one dev warning per distinct
// dropped-set (enumerating them), not per block and not per occurrence.
// Painted (runDecor/align, NOT dropped): color, highlight,
// underline, strike, textAlign left/center/right.
// M-REFS: the indexEntry mark is RECOGNIZED-QUIET — invisible by
// design (a reading-mode mark the scanner consumes document-side),
// never a dropped-in-error warn. Its entries ride the referenceTable
// blocks, not the paragraph runs it decorates.
const warnedDroppedSignatures = new Set<string>();

const DEFAULT_HIGHLIGHT = '#fef08a';

/** One indent gutter per list nesting level (px) — the marker column
 * is [indentLeft − 32, indentLeft). */
export const LIST_INDENT_PX = 32;

/** Per-list marker style defaults (the extensions' attr defaults). */
function defaultListStyle(kind: 'bullet' | 'ordered'): string {
  return kind === 'bullet' ? 'disc' : 'decimal';
}

/**
 * The identity cache that makes the pipeline O(edit):
 * conversions are memoized on the PM NODE object. ProseMirror's
 * structural sharing guarantees a typing transaction rebuilds only the
 * edited node's path — sibling nodes are the same object references
 * across doc versions — so unchanged blocks reuse their semantic Block
 * and AdapterBlock BY REFERENCE. That is exactly the adapter contract
 * the engine's hash identity cache is keyed on: reference-stable
 * blocks → zero re-hashing, zero re-conversion. PM nodes are
 * immutable: a CHANGED paragraph is a new object, which misses here
 * and reconverts. A baseStyle change (font default) invalidates
 * everything via the generation tag, since cached runs embed
 * baseStyle-derived fields.
 *
 * SIBLING FACTS (indentLeft, the listMarker index, ...) are NOT part
 * of the node: an ordered reindex after a sibling deletion changes an
 * UNCHANGED node's marker. The cache therefore stores the projection
 * facts it was built under and reuses the cached objects ONLY when
 * they are equal — a reindexed item reconverts (O(changed) clones,
 * correct), while an edit inside item 7 leaves item 9's cached objects
 * reference-identical (pinned by tests, both directions).
 */
interface CachedConversion {
  gen: number;
  semantic:
    | ParagraphBlock
    | HeadingBlock
    | CodeBlockBlock
    | ImageBlock
    | EquationBlock
    | TableBlock
    | ReferenceTableBlock;
  adapter: AdapterBlock;
  /** Projection facts this conversion was built under (sibling-dependent). */
  indentLeft: number;
  paint?: BlockPaint;
  /** M-PAGEFIELD: the warm total the field placeholders were measured
   *  at (the fixpoint's input — a widened total re-converts). Undefined
   *  on field-free blocks (undefined === undefined keeps their reuse). */
  fieldTotal?: number;
  /** M-REFS: the scan object the referenceTable entries were built
   * under (the doc-version fact — see Projection.scan). Undefined on
   * every other kind (undefined === undefined keeps their reuse test
   * byte-identical). */
  scan?: CollectionScan;
  /** M-REFS: the RESOLVED PAGE STRINGS for the entries (the two-pass
   * resolver's output): one string per entry, aligned with the
   * container's children. The conversion cache reuses only when the
   * ARRAY is the same object (identity-stable resolver output — the
   * scan precedent). Undefined on every other kind. */
  refPages?: readonly string[];
  /** M-REFS-9: the number display the conversion was built under
   * (the preset fact — see Projection.numberDisplay). */
  numberDisplay?: 'plain' | 'none';
}

const nodeCache = new WeakMap<PMNode, CachedConversion>();

/** Float+flow refusal warning — once per session (the styles warned-
 * set precedent): the adapter STRIPS the flow from floated images so
 * the engine's validateFloatFlow never sees a violation from the
 * shell; the doc model still carries keepNext (the caption bond
 * returns if the float is removed). */
const warnedFloatFlow = new Set<string>();
function warnFloatFlowOnce(): void {
  if (warnedFloatFlow.has('float-flow')) return;
  warnedFloatFlow.add('float-flow');
  if (import.meta.env.DEV) {
    console.warn(
      '[adapter] a floated image cannot carry the caption bond (keepNext) — the flow is omitted for layout; the bond returns when the float is removed'
    );
  }
}
let cacheGeneration = 0;
let lastContextKey: string | null = null;

/** Sibling-fact equality for the identity cache's reuse test. */
function paintEqual(a: BlockPaint | undefined, b: BlockPaint | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const am = a.marker;
  const bm = b.marker;
  const markersEqual =
    am == null && bm == null
      ? true
      : am != null &&
        bm != null &&
        am.kind === bm.kind &&
        am.depth === bm.depth &&
        am.index === bm.index &&
        am.styleType === bm.styleType;
  return (
    markersEqual &&
    (a.blockquote ?? false) === (b.blockquote ?? false) &&
    (a.rule ?? false) === (b.rule ?? false) &&
    (a.code ?? false) === (b.code ?? false) &&
    (a.reference ?? false) === (b.reference ?? false)
  );
}

function warnDroppedAttrs(dropped: Set<string>): void {
  if (dropped.size === 0) return;
  if (!import.meta.env.DEV) return;
  const signature = [...dropped].sort().join(',');
  if (warnedDroppedSignatures.has(signature)) return;
  warnedDroppedSignatures.add(signature);
  console.warn(
    `[adapter] attributes present but dropped by the semantic doc: ${signature}. ` +
      'Layout ignores them; they are preserved in the PM document and re-appear in .wpdoc saves.'
  );
}

/** PM fontSize attr (a CSS string; the UI writes 'NNpx') → core px.
 * Pasted HTML may carry pt — the DATA BOUNDARY converts it to the
 * core's px (M6-PRE: pt at the chrome, px in the core; parseLineHeight
 * applies the same conversion for its absolute unit paths). */
function parseFontSize(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return value.trim().endsWith('pt') ? Math.round(parsed * (96 / 72)) : parsed;
    }
  }
  return fallback;
}

/**
 * PM lineHeight attr (a string — the schema stores CSS values) → the
 * engine's multiplier. CSS semantics, in declining order of how the
 * UI emits them (LineSpacingButton writes only unitless multipliers
 * '1'/'1.15'/'1.5'/'2' and arbitrary custom numeric strings):
 *   unitless 'NNN' | number → NNN            (multiplier, Word set)
 *   'NNN%'                  → NNN / 100      (pasted HTML)
 *   'NNNpx' | 'NNNpt'        → absolute → ÷fontSize (CSS: relative
 *                             to the element's own font size)
 *   'NNNem'                 → NNN            (already × fontSize)
 *   'normal' / junk / non-positive → undefined (single spacing)
 * Outside [0.25, 4] → undefined: a garbage multiplier ('25px' pasted
 * raw used to become 25×) must degrade to single, never to a wreck.
 */
function parseLineHeight(value: unknown, fontSize: number): number | undefined {
  const MIN_LH = 0.25;
  const MAX_LH = 4;
  let multiplier: number | undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    multiplier = value;
  } else if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw || raw === 'normal') return undefined;
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    if (raw.endsWith('%')) multiplier = parsed / 100;
    else if (raw.endsWith('px')) multiplier = parsed / fontSize;
    else if (raw.endsWith('pt')) multiplier = (parsed * (96 / 72)) / fontSize;
    else if (raw.endsWith('em')) multiplier = parsed;
    else multiplier = parsed;
  }
  if (multiplier == null || !Number.isFinite(multiplier) || multiplier <= 0) return undefined;
  if (multiplier < MIN_LH || multiplier > MAX_LH) return undefined;
  return multiplier;
}

function isNonZero(value: unknown): boolean {
  return typeof value === 'number' && value !== 0;
}

// ─── Indent family mapping (M6.2) ─────────────────────────────────────────
//
// RECEIPTS (the units, reconciled at the ADAPTER — the conversion
// site, per the STEP 1 ruling):
//  - PM indentLeft/indentRight attrs are PX already (the ribbon input
//    writes px, parseHTML reads px) → pass through 1:1.
//  - The legacy `indent` attr is STEPS of 32px → folded in here
//    (steps × 32, additive); the commands migrate it away on first
//    press, so in practice at most one of the two is ever set.
//  - firstLineIndent is px (may be negative — hanging), mapped 1:1.
//
// VALIDATION BEFORE THE ENGINE CAN THROW (engine layout.ts throws on
// indentLeft + firstLineIndent < 0 — "the adapter must validate before
// sending; this throw is the backstop"): rejected values fall back to
// the NEAREST LEGAL one and warn once per distinct clamp in dev —
// never silent, never a layout crash.

const warnedIndentClamps = new Set<string>();

function warnIndentClamp(fact: string): void {
  if (!import.meta.env.DEV) return;
  if (warnedIndentClamps.has(fact)) return;
  warnedIndentClamps.add(fact);
  console.warn(`[adapter] indent value rejected, clamped to the nearest legal one: ${fact}`);
}

/** Any numeric-ish attr → px number (strings tolerated defensively). */
function parseIndentPx(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** The block's OWN left indent (px): indentLeft + legacy `indent`
 * steps folded. Clamped ≥ 0 (negative left indent is not a thing). */
function ownIndentLeft(node: PMNode): number {
  const raw =
    parseIndentPx(node.attrs?.indentLeft) +
    (isNonZero(node.attrs?.indent) ? parseIndentPx(node.attrs?.indent) * LIST_INDENT_PX : 0);
  if (raw < 0) {
    warnIndentClamp(`indentLeft ${node.attrs?.indentLeft} < 0 → 0`);
    return 0;
  }
  return raw;
}

function ownIndentRight(node: PMNode): number {
  const raw = parseIndentPx(node.attrs?.indentRight);
  if (raw < 0) {
    warnIndentClamp(`indentRight ${node.attrs?.indentRight} < 0 → 0`);
    return 0;
  }
  return raw;
}

/** How a PM node projects into the engine's Block union. */
interface Projection {
  kind: 'paragraph' | 'heading' | 'codeBlock' | 'image' | 'equation' | 'table' | 'referenceTable';
  /** Block-tier left indent (px) — 0 for unindented blocks. Images
   * don't wrap — the indent family is ignored for them (engine
   * ImageBlock law). */
  indentLeft: number;
  /** Paint hints (sibling facts — see CachedConversion). */
  paint?: BlockPaint;
  // ─── M-IMAGES-1: the image projection fields (kind 'image') ────
  /** OPAQUE ref — 'media://<sha256>'; echoes to placed[]. */
  src?: string;
  width?: number;
  height?: number;
  alt?: string;
  align?: 'left' | 'center' | 'right';
  keepNext?: boolean;
  /** M-IMAGES-2: the anchored float echo (dx/dy/z). */
  float?: { dx: number; dy: number; z: 'front' | 'behind' } | null;
  // ─── M-EQ: the equation projection fields (kind 'equation') ────
  /** OPAQUE LaTeX source — the node's only document data. */
  latex?: string;
  /** M-EQ-2: the font scale against the document default (folds into
   *  the metrics fontSize key; default 1). */
  scale?: number;
  // ─── M-REFS: the referenceTable projection fields ─────────────────
  /** The collection kind ('toc' | 'figures' | 'index'). */
  refKind?: ReferenceKind;
  /** The ToC's heading-depth option (node attr; other kinds ignore). */
  refDepth?: number;
  /** The DOC-VERSION FACT the entries were built under — the memoized
   * scan object (identity-stable while the doc is unchanged). A
   * referenceTable node's PM object does NOT change when a heading is
   * retitled, so the conversion cache reuses ONLY when the scan
   * object is the same one (the sibling-fact pattern: list markers
   * reconvert the same way). */
  scan?: CollectionScan;
  /** M-REFS: the RESOLVED PAGE STRINGS for this container's entries
   * (the two-pass resolver's output): one string per entry, aligned
   * with the children. The conversion cache reuses only when the
   * ARRAY is the same object (identity-stable resolver output). */
  refPages?: readonly string[];
  /** M-REFS-9: the number display ('plain' default | 'hyperlink' —
   * the numbers carry their target for link styling | 'none' — no
   * numbers). */
  numberDisplay?: 'plain' | 'none';
}

/**
 * Pageless-look receipt (engine E2, tests/code-block.test.ts): the
 * pageless editor renders codeBlock as <pre><code> with NO font of its
 * own — the UA stylesheet's `pre { font-family: monospace }` applies
 * and the size INHERITS the container's document-default. Runs carry
 * exactly that. One run per source line ('\n' kept at the end of the
 * line it terminates): the engine's breakCodeLines honors the
 * separators (the '\n' belongs to no LineBox range) and measures blank
 * lines under the first run's style, so blank lines are exactly as
 * tall as their siblings.
 */
function codeRuns(node: PMNode, base: RunStyle): { runs: Run[]; text: string } {
  const style: TextStyle = { fontFamily: 'monospace', fontSize: base.fontSize };
  const runs: Run[] = [];
  let text = '';
  node.forEach((child) => {
    if (!child.isText || !child.text) {
      throw new UnsupportedDocError(
        `[adapter] unsupported inline node '${child.type.name}' inside codeBlock`
      );
    }
    const pieces = child.text.split('\n');
    for (let i = 0; i < pieces.length; i++) {
      const piece = i < pieces.length - 1 ? pieces[i] + '\n' : pieces[i];
      if (piece) {
        runs.push({ text: piece, style });
        text += piece;
      }
    }
  });
  return { runs, text };
}

/** The resolved RunStyle → the engine's TextStyle. bold/italic are
 * always-present booleans (the non-empty-run contract the tests
 * pin); lineHeight passes through verbatim — a direct attr's '1'
 * stays 1, an absent attr AND absent tier stays absent (the engine's
 * absent ≡ 1.0 bit-for-bit invariant), a style-provided value wins
 * when the attr is unset. fontVariant 'normal' is stripped (explicit
 * 'normal' hashes ≠ absent — engine tests/font-variant.test.ts pins
 * the seam ruling: the shell normalizes). */
function textStyleOf(resolved: RunStyle, lineHeight: number | undefined, withBoldItalic = true): TextStyle {
  return {
    fontFamily: resolved.fontFamily,
    fontSize: resolved.fontSize,
    ...(withBoldItalic ? { bold: resolved.bold, italic: resolved.italic } : {}),
    ...(lineHeight !== undefined ? { lineHeight } : {}),
    ...(resolved.fontVariant === 'small-caps' ? { fontVariant: 'small-caps' as const } : {}),
  };
}

/** The per-node conversion (the expensive part): runs, marks, decor,
 * text, align, spacing, indent, hints. Cached on the node object (see
 * CachedConversion for the sibling-fact reuse test). PM positions
 * (from/to) are deliberately NOT cached — they depend on preceding
 * siblings and are recomputed per call (cheap).
 *
 * M-STYLES: all style resolution flows through resolve.ts resolveRun /
 * resolveBlockTier (THE one function) with the registry snapshot —
 * baseStyle < paragraph style < charStyle < direct marks, per
 * property. */
interface RunConversion {
  runs: Run[];
  runDecor: RunDecor[];
  text: string;
}

/**
 * THE PROSE RUN WALK (M-TABLES extraction): one paragraph-like node's
 * children → runs/decor/text. inlineImage children map to
 * InlineImageRuns; any other non-text inline child throws the
 * sentinel. Shared by the flow tier AND table cell paragraphs — one
 * run mapping, no fork.
 */
function walkProseRuns(
  node: PMNode,
  kind: string,
  paraDef: StyleDefinition | null,
  base: RunStyle,
  definitions: Record<string, StyleDefinition>,
  dropped: Set<string>,
  fieldTotal?: number
): RunConversion {
  const runs: Run[] = [];
  const runDecor: RunDecor[] = [];
  let text = '';
  node.forEach((child) => {
      if (!child.isText || !child.text) {
        // M-IMAGES-2 — INLINE OBJECTS (E-IMG-2): an inlineImage child
        // maps to an InlineImageRun in the containing paragraph's
        // runs — ONE position per object (the U+FFFC token appended to
        // the block's concatenated text keeps the PM-offset identity:
        // shell text/offsets stay source-coordinate-exact).
        // M-PAGEFIELD — the page-number FIELD: an inline atom whose
        // run text is the MEASURED PLACEHOLDER (the warm total's
        // max-width digits — every page's number fits the slot); the
        // shell's painter substitutes the per-page resolution at draw
        // time (fieldKind rides the run — the engine treats the run
        // as plain text). The style resolves from the paragraph tier
        // (no marks on an atom) — the field renders in the running
        // text's look.
        if (child.type.name === 'pageField') {
          const kind = (child.attrs as { kind?: string }).kind === 'pages' ? 'pages' : 'page';
          const placeholder = fieldTotal != null ? String(fieldTotal) : '8';
          const resolved = resolveRun({ base, para: paraDef, char: null, direct: {} });
          runs.push({
            text: transformText(placeholder, resolved.textTransform),
            style: textStyleOf(resolved, undefined),
            fieldKind: kind,
          } as Run);
          runDecor.push({});
          text += placeholder;
          return;
        }
        if (child.type.name === 'inlineImage') {
          const ia = child.attrs as {
            src?: string | null;
            width?: number | null;
            height?: number | null;
            alt?: string;
          };
          if (typeof ia.width !== 'number' || typeof ia.height !== 'number') {
            throw new UnsupportedDocError(
              '[adapter] inline image lacks dims — inline objects carry REQUIRED document data'
            );
          }
          runs.push({
            kind: 'inlineImage',
            src: String(ia.src ?? ''),
            width: ia.width,
            height: ia.height,
            alt: ia.alt ?? '',
          });
          runDecor.push({});
          text += '\uFFFC';
          return;
        }
        throw new UnsupportedDocError(
          `[adapter] unsupported inline node '${child.type.name}' inside ${kind}: ` +
            'the engine has no inline-break model (hardBreak included) — the pageless ' +
            'fallback renders it until the engine grows one'
        );
      }

      const textStyleMark = child.marks.find((m) => m.type.name === 'textStyle');

      // tiptap v3's FontFamily is a GLOBAL ATTRIBUTE on the textStyle
      // mark (verified against extension-text-style's dist), not a
      // separate mark — read it from there. (A standalone 'fontFamily'
      // mark stays supported defensively for any custom schema.)
      const standaloneFamilyMark = child.marks.find((m) => m.type.name === 'fontFamily');
      const familyAttr =
        typeof standaloneFamilyMark?.attrs?.fontFamily === 'string' && standaloneFamilyMark.attrs.fontFamily
          ? standaloneFamilyMark.attrs.fontFamily
          : typeof textStyleMark?.attrs?.fontFamily === 'string' && textStyleMark.attrs.fontFamily
            ? textStyleMark.attrs.fontFamily
            : null;

      const fontSizeAttr =
        textStyleMark?.attrs?.fontSize != null
          ? parseFontSize(textStyleMark.attrs.fontSize, base.fontSize)
          : undefined;

      // The charStyle mark: a registry reference, resolved alongside
      // the formatting marks (stacks with them, never stamps).
      const charStyleMark = child.marks.find((m) => m.type.name === 'charStyle');
      const charDef =
        typeof charStyleMark?.attrs?.styleId === 'string' && charStyleMark.attrs.styleId
          ? lookupStyle(charStyleMark.attrs.styleId, definitions)
          : null;

      const highlightMark = child.marks.find((m) => m.type.name === 'highlight');

      // DIRECT MARKS (strongest tier).
      const direct = {
        ...(familyAttr ? { fontFamily: familyAttr } : {}),
        ...(fontSizeAttr != null ? { fontSize: fontSizeAttr } : {}),
        ...(child.marks.some((m) => m.type.name === 'bold') ? { bold: true } : {}),
        ...(child.marks.some((m) => m.type.name === 'italic') ? { italic: true } : {}),
        ...(child.marks.some((m) => m.type.name === 'underline') ? { underline: true } : {}),
        ...(child.marks.some((m) => m.type.name === 'strike') ? { strike: true } : {}),
        ...(typeof textStyleMark?.attrs?.color === 'string' && textStyleMark.attrs.color
          ? { color: textStyleMark.attrs.color }
          : {}),
        ...(highlightMark
          ? { highlight: ((highlightMark.attrs?.color as string | undefined) ?? DEFAULT_HIGHLIGHT) }
          : {}),
      };

      // ONE resolution function (resolve.ts): baseStyle < paragraph
      // style < charStyle < direct marks, per property, complete
      // values — the registry never leaves a property undefined.
      const resolved = resolveRun({ base, para: paraDef, char: charDef, direct });

      // Direct BLOCK formatting (the lineHeight attr) parses against
      // the RESOLVED font size (CSS: absolute units are relative to
      // the element's own size) and beats the char/para tiers. The
      // attr value passes through VERBATIM (1 stays 1 — the pinned
      // attr-table contract); tiers apply only when the attr is unset.
      const attrLineHeight = parseLineHeight(node.attrs?.lineHeight, resolved.fontSize);
      const tierLineHeight = charDef?.properties.lineHeight ?? paraDef?.properties.lineHeight;
      const lineHeight = attrLineHeight !== undefined ? attrLineHeight : tierLineHeight;

      // Dropped-attr detection — collected, warned once, never silent.
      // color/highlight/underline/strike and left/center/right textAlign
      // are painted (runDecor / block align); spaceBefore/spaceAfter are
      // MAPPED to the engine's block-tier spacing (M6); the INDENT
      // FAMILY is mapped to engine geometry (M6.2 — indent/indentLeft/
      // indentRight consumed, no longer dropped); justify remains
      // engine work and stays loud.
      // M-REFS-11: the reference-table rows' SEMANTIC links (the
      // `tensor-ref:` scheme — the invisible always-on hyperlink) are
      // RECOGNIZED-QUIET: no styling in paginated (the user's
      // "invisible" ruling), no dropped-attr warning (they are
      // deliberate model data for the future PDF/DOCX exporters).
      if (child.marks.some((m) => m.type.name === 'link')) {
        const href = child.marks.find((m) => m.type.name === 'link')?.attrs?.href;
        if (typeof href !== 'string' || !href.startsWith('tensor-ref:')) dropped.add('link');
      }

      // TRANSFORMED MEASUREMENT (amendment 3): run TEXT is transformed
      // HERE, so the engine measures (and wraps) the transformed text
      // — uppercase is wider than source in real fonts. PM keeps the
      // source text; the length-preserving invariant (transformText
      // throws otherwise) keeps engine offsets identity-mapped to PM
      // offsets, so caret/hitTest/search all stay in source coords.
      const runText = transformText(child.text, resolved.textTransform);
      runs.push({ text: runText, style: textStyleOf(resolved, lineHeight) });
      runDecor.push({
        color: resolved.color !== '#000000' ? resolved.color : undefined,
        // The HIGHLIGHT tier cascades like color (direct mark > char
        // style > paragraph style; '' baseline = no highlight).
        highlight: resolved.highlight !== '' ? resolved.highlight : undefined,
        underline: resolved.underline,
        strike: resolved.strike,
      });
      text += runText;
  });
  return { runs, runDecor, text };
}

/**
 * EMPTY-TEXTBLOCK INHERITANCE (P1): an empty paragraph/heading emits
 * ONE zero-length run with the block's effective style — same
 * resolution as normal runs minus the marks (none exist on an empty
 * textblock). The engine measures present-run styles over baseStyle
 * (P1 ruling), so an empty paragraph in a 2.0-spaced style measures
 * 2.0 and its NPC ¶ paints at the right size. (The horizontalRule
 * atom — kind 'paragraph' by projection — never reaches here: its
 * baseStyle-measured placeholder line comes from the projection's own
 * runs push.)
 */
function emptyTextBlockRun(
  node: PMNode,
  paraDef: StyleDefinition | null,
  base: RunStyle
): Run {
  const resolved = resolveRun({ base, para: paraDef });
  const attrLineHeight = parseLineHeight(node.attrs?.lineHeight, resolved.fontSize);
  const tierLineHeight = paraDef?.properties.lineHeight;
  const lineHeight = attrLineHeight !== undefined ? attrLineHeight : tierLineHeight;
  // No bold/italic keys on the empty-textblock style (the pinned
  // P1 projection shape) — the glyph is the ¶ placeholder.
  return { text: '', style: textStyleOf(resolved, lineHeight, false) };
}

function convertNode(
  node: PMNode,
  projection: Projection,
  blockId: string,
  base: RunStyle,
  definitions: Record<string, StyleDefinition>,
  dropped: Set<string>,
  fieldTotal?: number
): CachedConversion {
  const kind = projection.kind;

  // M-IMAGES-1 — images convert structurally: no runs, no text, no
  // BlockTier (indent/firstLine are wrap geometry the engine IGNORES
  // for images by law; align is their horizontal control, relative to
  // the FULL content box). src OPAQUE, dims REQUIRED (validated at
  // the projection site), keepNext = the caption bond (FlowPolicy).
  // M-IMAGES-2 — FLOATS (E-IMG-3): the float echo rides through; and
  // the LOUD REFUSAL: a floated block NEVER carries flow — the
  // engine's validateFloatFlow THROWS on float+keepNext (a float is
  // not in flow and must not derive pages), so the adapter must never
  // EMIT one. float present → flow omitted entirely, warned once.
  if (kind === 'image') {
    const float =
      projection.float && Number.isFinite(projection.float.dx) && Number.isFinite(projection.float.dy)
        ? { dx: projection.float.dx, dy: projection.float.dy, z: projection.float.z }
        : null;
    if (float && projection.keepNext) {
      warnFloatFlowOnce();
    }
    const semantic: ImageBlock = {
      id: blockId,
      kind: 'image',
      src: projection.src ?? '',
      width: projection.width ?? 0,
      height: projection.height ?? 0,
      align: projection.align ?? 'left',
      alt: projection.alt ?? '',
      ...(float
        ? { float }
        : projection.keepNext
          ? { flow: { keepNext: true } }
          : {}),
    };
    return {
      gen: cacheGeneration,
      semantic,
      // The AdapterBlock mirrors paint-side facts: images carry no
      // text; placed[] (not lines[]) is the render surface.
      adapter: { id: blockId, runs: [], text: '', from: 0, to: 0, align: 'left', runDecor: [] },
      indentLeft: 0,
    };
  }

  // M-EQ — equations convert structurally, the image arm's shape:
  // no runs, no text, no BlockTier (the indent family is wrap
  // geometry, ignored for atomics by law; align is the horizontal
  // control). THE DIMS RULING: width/height are NOT projected — they
  // are derived facts (a function of latex + fontSize under the KaTeX
  // fonts) the engine asks the EquationMetrics port for at layout
  // time; the adapter is pure (L1) and cannot measure. fontSize is
  // the resolved document-default run size scaled by the node's
  // `scale` attr (M-EQ-2 style control — a LAYOUT-relevant attr that
  // rides the fontSize hash, so a scale edit re-measures + re-walks
  // through the existing engine path; color is paint-only and stays
  // OUT of the engine entirely, the image-radius precedent). No
  // float/flow v1: a display equation is strictly in flow (Word's
  // display-equation model).
  if (kind === 'equation') {
    const scale =
      typeof projection.scale === 'number' && Number.isFinite(projection.scale) && projection.scale > 0
        ? projection.scale
        : 1;
    const semantic: EquationBlock = {
      id: blockId,
      kind: 'equation',
      latex: projection.latex ?? '',
      fontSize: base.fontSize * scale,
      align: projection.align ?? 'center',
    };
    return {
      gen: cacheGeneration,
      semantic,
      adapter: { id: blockId, runs: [], text: '', from: 0, to: 0, align: 'left', runDecor: [] },
      indentLeft: 0,
    };
  }

  // M-TABLES — the table projects WHOLE (one engine TableBlock, one
  // blockId): rows → TableRowData, each cell's paragraphs through the
  // SHARED walkProseRuns (one run mapping, no fork) into the table's
  // CANONICAL arrays — rows top-down, cells left-to-right, paragraphs
  // in order; the engine re-derives the same concatenation from the
  // TableBlock structure (agreement by construction). Non-paragraph
  // cell content throws the sentinel (v1 cell content = paragraphs
  // only; the pageless fallback renders it until the engine grows
  // cell code/quote/image support). The AdapterBlock carries the
  // CELL-PARAGRAPH map (relStart positions relative to the table
  // node — push() patches from/to the same way, and positionMap
  // derives pmStart = from + relStart).
  if (kind === 'table') {
    const rows: TableBlock['rows'] = [];
    const tableRuns: Run[] = [];
    const tableDecor: RunDecor[] = [];
    const paragraphs: { relStart: number; textStart: number; textLen: number }[] = [];
    let tableText = '';
    // Position walk with a MANUAL cursor (PM forEach offsets are
    // CONTENT-relative and its third callback arg is an INDEX — never
    // a position): cursor tracks each child node's position relative
    // to the TABLE node. The table node's open is +1, so the first row
    // sits at relative 1; each node's span = its nodeSize.
    let cursor = 1;
    node.forEach((row) => {
      if (row.type.name !== 'tableRow') {
        throw new UnsupportedDocError(`[adapter] unexpected node '${row.type.name}' inside a table`);
      }
      const rowPos = cursor;
      cursor = rowPos + 1; // into the row's content
      const cells: TableBlock['rows'][0]['cells'] = [];
      let allHeader = row.childCount > 0;
      row.forEach((cell) => {
        if (cell.type.name !== 'tableCell' && cell.type.name !== 'tableHeader') {
          throw new UnsupportedDocError(`[adapter] unexpected node '${cell.type.name}' inside a table row`);
        }
        if (cell.type.name !== 'tableHeader') allHeader = false;
        const cellPos = cursor;
        cursor = cellPos + 1; // into the cell's content
        const content: ParagraphBlock[] = [];
        cell.forEach((para) => {
          if (para.type.name !== 'paragraph' && para.type.name !== 'heading') {
            throw new UnsupportedDocError(
              `[adapter] unsupported cell content '${para.type.name}' in a table — ` +
                'cell content is paragraphs only in v1 (the pageless fallback renders it)',
            );
          }
          const cellParaDef =
            para.type.name === 'heading'
              ? lookupStyle(headingStyleId(para.attrs.level ?? 1), definitions)
              : lookupStyle(
                  typeof para.attrs?.styleId === 'string' && para.attrs.styleId
                    ? para.attrs.styleId
                    : 'normal',
                  definitions
                );
          const conv = walkProseRuns(para, para.type.name, cellParaDef, base, definitions, dropped, fieldTotal);
          if (conv.runs.length === 0) {
            conv.runs.push(emptyTextBlockRun(para, cellParaDef, base));
          }
          const textStart = tableText.length;
          content.push({
            id: typeof para.attrs?.blockId === 'string' ? para.attrs.blockId : '',
            kind: 'paragraph',
            runs: conv.runs,
          });
          tableRuns.push(...conv.runs);
          tableDecor.push(...conv.runDecor);
          // THE SEPARATOR LAW (M-TABLES 2 — the engine's computeTableLayout
          // advances textOffset by the same +1): every cell paragraph's
          // slice gets a trailing '\n' in the canonical text, so empty
          // cells own a DISTINCT textStart and the PM↔offset bridge
          // round-trips. The separator never enters a line range.
          tableText += conv.text + '\n';
          // The paragraph's first text position, TABLE-relative:
          // the paragraph node at `cursor` (relative to the table),
          // its text at +1.
          paragraphs.push({ relStart: cursor + 1, textStart, textLen: conv.text.length });
          cursor += para.nodeSize;
        });
        cursor = cellPos + cell.nodeSize;
        // M-T4 — per-cell padding override (per-side; null inherits).
        const cellPad = cell.attrs.padding as
          | { top?: number | null; right?: number | null; bottom?: number | null; left?: number | null }
          | null
          | undefined;
        const cellPadSide = (side: 'top' | 'right' | 'bottom' | 'left'): number | null => {
          const v = cellPad?.[side];
          return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
        };
        cells.push({
          colspan: typeof cell.attrs.colspan === 'number' ? cell.attrs.colspan : 1,
          rowspan: typeof cell.attrs.rowspan === 'number' ? cell.attrs.rowspan : 1,
          colwidth:
            Array.isArray(cell.attrs.colwidth) && cell.attrs.colwidth.some((w) => typeof w === 'number')
              ? (cell.attrs.colwidth.map((w) => (typeof w === 'number' ? w : null)) as (number | null)[])
              : null,
          backgroundColor:
            typeof cell.attrs.backgroundColor === 'string' && cell.attrs.backgroundColor
              ? cell.attrs.backgroundColor
              : null,
          ...(cellPad != null
            ? {
                padding: {
                  top: cellPadSide('top'),
                  right: cellPadSide('right'),
                  bottom: cellPadSide('bottom'),
                  left: cellPadSide('left'),
                },
              }
            : {}),
          content,
        });
      });
      cursor = rowPos + row.nodeSize;
      // M-T3c: the row's minimum height (Word's "at least") — null =
      // pure content height; the engine's TableRowData.minHeight
      // consumes it verbatim.
      const rowMin = row.attrs?.minHeight;
      rows.push({
        isHeader: allHeader,
        minHeight: typeof rowMin === 'number' && rowMin > 0 ? rowMin : null,
        cells,
      });
    });

    const borderStyle = node.attrs?.borderStyle;
    const alignAttr = node.attrs?.align;
    // M-T4 — outer margins: top/bottom ride the block tier's spacing
    // (the engine's once-at-entry rule — a table margin above/below IS
    // block spacing); left/right narrow the engine's table box. Sides
    // clamp ≥ 0 (the panel clamps too; this is the backstop).
    const marginAttr = node.attrs?.margin as
      | { top?: number | null; right?: number | null; bottom?: number | null; left?: number | null }
      | null
      | undefined;
    const marginSide = (side: 'top' | 'right' | 'bottom' | 'left'): number | null => {
      const v = marginAttr?.[side];
      return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
    };
    const spaceBefore = marginSide('top') ?? undefined;
    const spaceAfter = marginSide('bottom') ?? undefined;
    const marginLR =
      marginSide('left') != null || marginSide('right') != null
        ? { left: marginSide('left') ?? 0, right: marginSide('right') ?? 0 }
        : null;
    // M-T4 — the table's default cell padding (per-side; null sides
    // inherit the engine constants).
    const cellPaddingAttr = node.attrs?.cellPadding as
      | { top?: number | null; right?: number | null; bottom?: number | null; left?: number | null }
      | null
      | undefined;
    const padSide = (side: 'top' | 'right' | 'bottom' | 'left'): number | null => {
      const v = cellPaddingAttr?.[side];
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
    };
    const cellPadding =
      cellPaddingAttr != null
        ? { top: padSide('top'), right: padSide('right'), bottom: padSide('bottom'), left: padSide('left') }
        : null;
    const semantic: TableBlock = {
      id: blockId,
      kind: 'table',
      rows,
      borderStyle: borderStyle === 'none' || borderStyle === 'outer' ? borderStyle : 'all',
      // M-T3c — table flow: horizontal placement within the content box.
      align: alignAttr === 'center' || alignAttr === 'right' ? alignAttr : 'left',
      ...(spaceBefore != null ? { spaceBefore } : {}),
      ...(spaceAfter != null ? { spaceAfter } : {}),
      ...(marginLR ? { margin: marginLR } : {}),
      ...(cellPadding ? { cellPadding } : {}),
    };
    return {
      gen: cacheGeneration,
      semantic,
      adapter: {
        id: blockId,
        runs: tableRuns,
        text: tableText,
        from: 0,
        to: 0,
        align: 'left',
        runDecor: tableDecor,
        table: { paragraphs },
      },
      indentLeft: 0,
    };
  }

  // M-REFS — the reference table converts from its REAL CHILDREN (the
  // container model: entries are real paragraphs the generator
  // maintains): each child's runs flow through the SHARED
  // walkProseRuns (one run mapping, no fork — user marks render in
  // paginated like body text), plus the SYNTHETIC tab + page-number
  // runs (document-default style; page strings arrive with the
  // two-pass — LAYOUT facts, never persisted PM text). One engine
  // ReferenceTableBlock + the ENTRY sidecar (the table.paragraphs
  // precedent): per-entry `relStart` = the child paragraph's position
  // RELATIVE to the container (pmStart = block.from + relStart — the
  // caret/selection bridge into entry text), `textStart`/`textLen`
  // = the child's REAL text slice of the canonical block text (the
  // synthetic tab/number suffix follows it, non-mappable). TARGETS
  // come from the SCAN (keyed by the child's refId — the generator's
  // key): the sidecar's targets are navigation facts, not layout.
  // The PLACEHOLDER (a null-refId child, the generator's own write)
  // converts like any entry — real italic text, zero targets.
  if (kind === 'referenceTable') {
    const refKind = projection.refKind ?? 'toc';
    const refDepth = typeof projection.refDepth === 'number' ? projection.refDepth : 3;
    const scan = projection.scan ?? scanCollections(node);
    const scanEntries = entriesForKind(scan, refKind, refDepth);
    const syntheticStyle: TextStyle = textStyleOf(base, undefined);
    const engineEntries: ReferenceTableBlock['entries'] = [];
    const refRuns: Run[] = [];
    const refDecor: RunDecor[] = [];
    const sidecarEntries: ReferenceSidecarEntry[] = [];
    let refText = '';
    // Relative cursor into the container (its open token is +1; the
    // table arm's manual walk, same shape).
    let cursor = 1;
    let sawChild = false;
    // The resolver's per-entry page strings (aligned with the children
    // below) — undefined when the caller passed none (cold start).
    const refPagesInput = projection.refPages;
    // THE NUMBER DISPLAY (M-REFS-9) — hoisted (the sidecar's click
    // fact reads it outside the row loop).
    const numberDisplay = projection.numberDisplay ?? 'plain';
    let entryIndex = 0;

    node.forEach((child) => {
      const childPos = cursor;
      cursor += child.nodeSize;
      if (child.type.name !== 'paragraph') return; // the generator owns paragraphs; anything else waits
      sawChild = true;
      const thisEntryIndex = entryIndex;
      entryIndex += 1;

      // The child's runs: the SHARED prose walk (marks resolve like
      // body text — bold/color on an entry render everywhere).
      const paraDef = lookupStyle(
        typeof child.attrs?.styleId === 'string' && child.attrs.styleId
          ? child.attrs.styleId
          : 'normal',
        definitions
      );
      const prose = walkProseRuns(child, 'paragraph', paraDef, base, definitions, dropped, fieldTotal);
      const textStart = refText.length;

      // The entry's targets: the scan join by refId (null = the
      // placeholder — real text, zero navigation).
      const refId = typeof child.attrs.refId === 'string' && child.attrs.refId ? child.attrs.refId : null;
      let targets: number[] = [];
      if (refId) {
        const match = scanEntries.find((e) =>
          refKind === 'index' ? e.text === refId : e.targets[0]?.blockId === refId
        );
        targets = match ? match.targets.map((t) => t.pos) : [];
      }

      const indentLeft = Math.max(0, ownIndentLeft(child));
      // THE LEADER SPAN (M-REFS-8): the generator writes a refLeader-
      // marked dots span as the row's LAST text node — REAL text with
      // the USER's marks (resolved through the shared prose walk, so
      // size/bold/color flow into the runs). Its LENGTH is detected
      // from the child's own inline nodes (never guessed from text: a
      // heading may legitimately end in dots) and rides the SIDECAR as
      // the painter's tag — the engine lays out the seed verbatim (the
      // block-text contract holds bit-for-bit; the engine NEVER
      // rewrites run text), and the PAINTER extends the dots with
      // extra ink at the leader run's own measured style to fill the
      // gap to the page number.
      let leaderLen = 0;
      const lastInline = child.childCount > 0 ? child.child(child.childCount - 1) : null;
      if (
        lastInline?.isText &&
        lastInline.marks.some((m) => m.type.name === 'refLeader')
      ) {
        leaderLen = lastInline.text?.length ?? 0;
      }

      // The engine entry: the row's real runs (text + seed dots) + the
      // synthetic tab + THE PAGE NUMBER (the two-pass resolver's
      // string, '' while unresolved — a LAYOUT fact riding the entry
      // runs by construction, so a re-resolved number re-breaks
      // exactly this block through the engine's contentHash).
      // THE NUMBER DISPLAY (M-REFS-9, the presets' number arm): the
      // container's numberDisplay attr decides the number run's TEXT.
      // 'plain' (default): the resolved page string. 'none': NO
      // number at all (the entries stand alone — the entries' own
      // semantic link marks (M-REFS-11) are the navigation data; the
      // future exporters map them).
      const pageStr = numberDisplay === 'none' ? '' : refPagesInput?.[thisEntryIndex] ?? '';
      engineEntries.push({
        runs: [
          ...prose.runs,
          { text: '\t', style: syntheticStyle },
          { text: pageStr, style: syntheticStyle },
        ],
        ...(indentLeft ? { indentLeft } : {}),
      });
      refRuns.push(...prose.runs);
      refDecor.push(...prose.runDecor);
      // The synthetic pair rides the canonical text too (the engine's
      // block text = the entries' concatenation, by construction).
      refRuns.push({ text: '\t', style: syntheticStyle }, { text: pageStr, style: syntheticStyle });
      refDecor.push({}, {});
      refText += prose.text + '\t' + pageStr;

      sidecarEntries.push({
        relStart: childPos + 1, // the child's text starts at relStart (+1 for its open)
        leaderLen,
        textStart,
        textLen: prose.text.length,
        targets,
      });
    });

    // No children at all (a just-inserted container, pre-generator):
    // one placeholder line so the block is never a zero-height ghost.
    if (!sawChild) {
      engineEntries.push({ runs: [{ text: ' ', style: syntheticStyle }] });
      refRuns.push({ text: ' ', style: syntheticStyle });
      refDecor.push({});
      refText = ' ';
      sidecarEntries.push({ relStart: 1, leaderLen: 0, textStart: 0, textLen: 1, targets: [] });
    }

    const semantic: ReferenceTableBlock = {
      id: blockId,
      kind: 'referenceTable',
      entries: engineEntries,
    };
    const sidecar: ReferenceSidecar = {
      entries: sidecarEntries,
    };
    return {
      gen: cacheGeneration,
      semantic,
      adapter: {
        id: blockId,
        runs: refRuns,
        text: refText,
        from: 0,
        to: 0,
        align: 'left',
        paint: { reference: true },
        runDecor: refDecor,
        reference: sidecar,
      },
      indentLeft: 0,
      // The doc-version fact (see Projection.scan) — targets ride the
      // scan; the children's own edits miss the node cache naturally.
      scan: projection.scan,
      // The page-strings fact (identity-stable resolver output) —
      // the reuse test below compares it by reference.
      refPages: projection.refPages,
      // The number-display fact (the preset — the reuse test).
      numberDisplay: projection.numberDisplay,
    };
  }

  // The paragraph tier's style identity. Headings resolve through
  // `heading-{level}` — the styleId attr's guaranteed twin (the
  // HeadingSync plugin maintains the alignment); paragraphs through
  // their styleId attr ('normal' default, schema-guaranteed).
  const paraDef =
    kind === 'heading'
      ? lookupStyle(headingStyleId(node.attrs.level ?? 1), definitions)
      : lookupStyle(
          typeof node.attrs?.styleId === 'string' && node.attrs.styleId
            ? node.attrs.styleId
            : 'normal',
          definitions
        );

  const runs: Run[] = [];
  const runDecor: RunDecor[] = [];
  let text = '';

  const alignAttr = node.attrs?.textAlign;

  if (kind === 'codeBlock') {
    const code = codeRuns(node, base);
    runs.push(...code.runs);
    text = code.text;
    // EMPTY-TEXTBLOCK INHERITANCE (P1): an empty codeBlock emits one
    // zero-length run carrying the pageless-look style — the engine
    // measures present-run styles over baseStyle (P1 ruling), so the
    // blank line matches its mono siblings, not the prose default.
    if (runs.length === 0) {
      runs.push({ text: '', style: { fontFamily: 'monospace', fontSize: base.fontSize } });
    }
  } else {
    // M-TABLES: the walk is SHARED — table cell paragraphs convert
    // through the same walkProseRuns (one run mapping, no fork).
    const prose = walkProseRuns(node, kind, paraDef, base, definitions, dropped, fieldTotal);
    runs.push(...prose.runs);
    runDecor.push(...prose.runDecor);
    text = prose.text;
  }

  // EMPTY-TEXTBLOCK INHERITANCE (P1) — the shared helper (M-TABLES:
  // cell paragraphs inherit through the same function).
  if (
    runs.length === 0 &&
    (node.type.name === 'paragraph' || node.type.name === 'heading')
  ) {
    runs.push(emptyTextBlockRun(node, paraDef, base));
  }

  // BLOCK TIER (M6 + M-STYLES): direct attrs beat the paragraph style's
  // geometry properties, which beat the baseline. Unset = default attr
  // value (0 / null), so the STYLE provides the value in that case; the
  // legacy `indent` steps fold into the attr side as today.
  const attrsTier: BlockTierAttrs =
    kind === 'paragraph'
      ? {
          spaceBefore: node.attrs?.spaceBefore || undefined,
          spaceAfter: node.attrs?.spaceAfter || undefined,
          indentLeft: ownIndentLeft(node) || undefined,
          indentRight: ownIndentRight(node) || undefined,
          firstLineIndent: node.attrs?.firstLineIndent,
          textAlign: alignAttr,
        }
      : { textAlign: alignAttr };
  const tier = resolveBlockTier(paraDef, attrsTier, projection.indentLeft);

  // Validation before the engine can throw (negative left edge), plus
  // the style tier's own values — same clamps, same one-time warnings.
  const totalLeft = tier.indentLeft < 0 ? (warnIndentClamp(`style indentLeft < 0 → 0`), 0) : tier.indentLeft;
  const indentRight = tier.indentRight < 0 ? (warnIndentClamp(`style indentRight < 0 → 0`), 0) : tier.indentRight;
  let firstLineIndent = tier.firstLineIndent;
  if (firstLineIndent != null && totalLeft + firstLineIndent < 0) {
    warnIndentClamp(
      `firstLineIndent ${firstLineIndent} under indentLeft ${totalLeft} → ${-totalLeft} (first line left edge floored at 0)`
    );
    firstLineIndent = totalLeft > 0 ? -totalLeft : undefined;
  }

  // 'justify' (attr OR style tier) is engine work and stays LOUD: the
  // pageless CSS renders it natively, the paginated mode drops it to
  // left through the same one-time warning the textAlign attr always
  // had — identical ruling for the style tier.
  const align: TextAlign = tier.align === 'justify' ? 'left' : tier.align;
  if (tier.align === 'justify') dropped.add('textAlign (justify — engine work)');
  const spaceBefore = tier.spaceBefore != null && tier.spaceBefore > 0 ? tier.spaceBefore : undefined;
  const spaceAfter = tier.spaceAfter != null && tier.spaceAfter > 0 ? tier.spaceAfter : undefined;

  const hints = projection.paint ?? {};
  // SEMANTIC-side hint spelling (M6.1): listMarker per the projection
  // spec; blockquote/rule/code as booleans. The engine ignores all of
  // them (hashBlock covers kind/runs/flow/space only).
  const hintFields = {
    ...(hints.marker ? { listMarker: hints.marker } : {}),
    ...(hints.blockquote ? { blockquote: true } : {}),
    ...(hints.rule ? { rule: true } : {}),
    ...(hints.code ? { code: true } : {}),
  };
  // TAB STOPS (M-RULER Phase 3): projected onto the block px
  // content-box-relative, normalized (sorted, deduped, absent when
  // empty). Inert in the breaker until Phase 4; hashBlock deliberately
  // doesn't cover the field yet (see engine/src/types.ts).
  const tabStops = kind === 'paragraph' ? normalizeTabStops(node.attrs?.tabStops) : null;
  const shared = {
    id: blockId,
    runs,
    spaceBefore,
    spaceAfter,
    ...(totalLeft ? { indentLeft: totalLeft } : {}),
    ...(indentRight ? { indentRight } : {}),
    ...(firstLineIndent != null ? { firstLineIndent } : {}),
    ...(tabStops ? { tabStops } : {}),
    ...hintFields,
  };

  const semantic: Block =
    kind === 'heading'
      ? { ...shared, kind: 'heading', level: node.attrs.level ?? 1 }
      : kind === 'codeBlock'
        ? { ...shared, kind: 'codeBlock' }
        : { ...shared, kind: 'paragraph' };

  return {
    gen: cacheGeneration,
    semantic: semantic as CachedConversion['semantic'],
    adapter: {
      id: blockId,
      runs,
      text,
      from: 0,
      to: 0,
      align,
      ...(totalLeft ? { indentLeft: totalLeft } : {}),
      ...(indentRight ? { indentRight } : {}),
      ...(projection.paint ? { paint: projection.paint } : {}),
      runDecor,
    },
    // The cache's sibling-fact key is the BASE indent (structural:
    // list depth / blockquote gutter) — own-attr changes produce a NEW
    // node object (PM immutability) and miss the WeakMap by
    // construction, so only the base needs the equality test.
    indentLeft: projection.indentLeft,
    paint: projection.paint,
    // M-PAGEFIELD: the warm total rides ONLY on field-bearing blocks —
    // field-free blocks convert identically at ANY total (storing the
    // total here would break reuse whenever the shell's warm total
    // differs from the caller's, e.g. the unit tests' undefined). The
    // fixpoint's widened total must MISS field-bearing caches (a stale
    // placeholder would never widen).
    fieldTotal: runs.some((r) => (r as { fieldKind?: string }).fieldKind != null) ? fieldTotal : undefined,
  };
}

export function pmDocToSemantic(
  pm: PMNode,
  baseStyle: TextStyle,
  registry: StyleRegistrySnapshot = BUILTIN_REGISTRY,
  /**
   * M-HEADER-FOOTER-2 — band options read PER CALL (L4): the
   * different-first-page flag travels in .wpdoc metadata; the caller
   * (PaginatedView's relayout) reads it fresh from the document store.
   */
  bandOptions?: { differentFirstPage?: boolean },
  /**
   * M-REFS — the RESOLVED PAGE STRINGS (the two-pass fixpoint's input):
   * per referenceTable blockId, one string per entry (multi-location
   * index entries join pages "3, 7"). Absent on cold start ('' runs);
   * the caller (PaginatedView's relayout) passes the resolver's
   * identity-stable output so the conversion cache stays warm in
   * steady state.
   */
  referencePages?: ReferencePagesMap,
  /**
   * M-PAGEFIELD — the WARM PAGE TOTAL (the two-pass fixpoint's other
   * input): the field runs' measured placeholder is the total's
   * max-width digit string (layout-stable across pages — every page's
   * number fits); pass 1 guesses 1 digit, the fixpoint re-lays-out
   * when the real total widens. Absent on cold start.
   */
  fieldTotal?: number,
  /**
   * #58 SECTIONS — the document's page setup (read PER CALL, L4): the
   * FINAL section's props (the store law — the sectionBreak nodes
   * carry sections 0..n−1; the content after the last break rides the
   * store). The adapter resolves the COMPLETE boundary table with it;
   * absent → the Letter/Normal fallback (defensive — real callers
   * pass the store's pageSetup).
   */
  pageSetup?: PageSetup,
): AdapterResult {
  // THE REGISTRY EPOCH (M-STYLES STEP 3): the shell-side mirror of the
  // engine's baseStyleHash. A baseStyle change OR any definition edit
  // (epoch bump) invalidates the identity cache wholesale — every
  // block re-converts with fresh resolved runs/decor. The engine then
  // decides per block what re-breaks via contentHash (layout-relevant
  // edits) or splices (paint-only edits — those still reach the canvas
  // through the rebuilt AdapterBlocks).
  const contextKey = `${baseStyle.fontFamily}\u0000${baseStyle.fontSize}\u0000${registry.epoch}`;
  if (contextKey !== lastContextKey) {
    cacheGeneration += 1;
    lastContextKey = contextKey;
  }

  const base = baselineRunStyle(baseStyle);
  const definitions = registry.definitions;

  // M-REFS — the ONE per-call scan (memoized on the doc object — one
  // walk per doc version, shared by every referenceTable node AND the
  // pageless NodeView). Computed lazily-adjacent here so every
  // projection branch below closes over the same identity.
  const refScan = scanCollections(pm);

  const blocks: AdapterBlock[] = [];
  const semantic: Block[] = [];
  const dropped = new Set<string>();
  let pendingBreakBefore = false;

  // #58 — the sectionBreak nodes in doc order (the walk collects;
  // the resolution below turns them into the engine's table).
  const sectionBreaksCollected: {
    afterBlock: number;
    setup: PageSetup | null;
    type: 'nextPage' | 'continuous';
  }[] = [];

  // #58 — the NPC sidecar: every pageBreak/sectionBreak atom with the
  // block following it (the view paints formatting-mark badges just
  // above that block's first line — view-only ink, never printed: the
  // print walk reads the engine's layout, not this sidecar).
  const breakFacts: {
    kind: 'pageBreak' | 'sectionBreak';
    type: 'nextPage' | 'continuous';
    pos: number;
    afterBlockId: string | null;
  }[] = [];
  let pendingBreakFact: { kind: 'pageBreak' | 'sectionBreak'; type: 'nextPage' | 'continuous' } | null = null;

  // #58 — the PRE-SCAN: a band container may carry a sectionId whose
  // break node sits LATER in doc order (band containers at the doc
  // start precede every break), so the tag→section-index map must be
  // known before the walk reaches either. One cheap top-level pass
  // (breaks are top-level atoms). Stale tags (a break deleted without
  // the merge-on-delete law's cleanup) resolve to the doc default —
  // content preserved, never dropped.
  const sectionIdToIndex = new Map<string, number>();
  pm.forEach((node) => {
    if (node.type.name === 'sectionBreak') {
      const tag = node.attrs?.sectionId;
      if (typeof tag === 'string' && tag && !sectionIdToIndex.has(tag)) {
        sectionIdToIndex.set(tag, sectionIdToIndex.size);
      }
    }
  });

  // M-HEADER-FOOTER-2 — the band routing: children of headerBlock/
  // footerBlock land in the engine's BandSet (never in flow order)
  // while their AdapterBlocks ride BOTH `blocks` (the shared sidecar —
  // real PM positions, emitted in `from` order) and `bandBlocks`.
  const bandSemantic: {
    header: Block[];
    footer: Block[];
    firstHeader: Block[];
    firstFooter: Block[];
  } = { header: [], footer: [], firstHeader: [], firstFooter: [] };
  // #58 — the per-section band buckets (tagged containers): section
  // index → its override regions, merged in doc order.
  const perSectionBands = new Map<
    number,
    { header: Block[]; footer: Block[]; firstHeader: Block[]; firstFooter: Block[] }
  >();
  const bandBlocks: AdapterBlock[] = [];
  const bandBlockIds = new Set<string>();
  let sawBandNode = false;

  /** Commit one band child: semantic → its region (the doc default by
   *  default; #58 tagged overrides push into their section's bucket),
   *  adapter → both lists. */
  const pushBand = (
    conv: CachedConversion,
    node: PMNode,
    pos: number,
    region: 'header' | 'footer' | 'firstHeader' | 'firstFooter',
    semanticList: Block[] = bandSemantic[region],
  ): void => {
    semanticList.push(conv.semantic);
    const adapter = { ...conv.adapter, from: pos, to: pos + node.nodeSize };
    blocks.push(adapter);
    bandBlocks.push(adapter);
    bandBlockIds.add(adapter.id);
  };

  /** Cache-aware projection of one PM node. Reuses the cached
   * conversion only when the sibling facts are unchanged (see
   * CachedConversion); a stale-marker or stale-indent hit reconverts.
   * codeBlock blocks always carry the code paint hint — merged here so
   * the cache comparison and the stored facts agree. */
  const projected = (node: PMNode, projectionIn: Projection, pos: number): CachedConversion => {
    const projection: Projection =
      projectionIn.kind === 'codeBlock' && !projectionIn.paint?.code
        ? { ...projectionIn, paint: { ...projectionIn.paint, code: true } }
        : projectionIn;
    const cached = nodeCache.get(node);
    if (
      cached &&
      cached.gen === cacheGeneration &&
      cached.indentLeft === projection.indentLeft &&
      // M-PAGEFIELD: the total gates ONLY field-bearing conversions (a
      // widened total re-converts — the fixpoint's pass 2); field-free
      // conversions are total-independent and reuse at ANY warm total
      // (storing the total on them would break reuse whenever the
      // caller's total differs).
      (cached.fieldTotal == null || cached.fieldTotal === fieldTotal) &&
      paintEqual(cached.paint, projection.paint) &&
      // M-REFS: the scan fact — a referenceTable node reuses its
      // conversion only under the SAME doc scan (a retitle elsewhere
      // keeps the node object but changes the scan object). Every
      // other kind carries undefined on both sides (no-op test).
      cached.scan === projection.scan &&
      // M-REFS: the page-strings fact — a re-resolved number is a NEW
      // array (identity-stable when unchanged), so the ToC reconverts
      // exactly when its numbers moved.
      cached.refPages === projection.refPages &&
      // M-REFS-9: the number-display fact (a preset flip changes the
      // numbers/decor without touching the PM children — the same
      // sibling-fact pattern as the scan/pages facts).
      cached.numberDisplay === projection.numberDisplay
    ) {
      return cached;
    }
    const blockId = node.attrs?.blockId;
    if (typeof blockId !== 'string' || !blockId) {
      throw new Error(
        `[adapter] ${projection.kind} at offset ${pos} has no blockId — ` +
          'BlockIdExtension must mint ids on creation/load/paste before any layout call'
      );
    }
    const conv = convertNode(node, projection, blockId, base, definitions, dropped, fieldTotal);
    nodeCache.set(node, conv);
    return conv;
  };

  /** Commit one projected block: forced breakBefore from a PRECEDING
   * pageBreak is a sibling fact, applied per call (the clone breaks
   * object identity for that one block and the engine re-hashes it;
   * forced-break blocks are rare). Positions are always fresh. */
  const push = (conv: CachedConversion, node: PMNode, pos: number): void => {
    const block = pendingBreakBefore
      ? { ...conv.semantic, flow: { breakBefore: 'page' as const } }
      : conv.semantic;
    // #58 — a pending pageBreak NPC attaches to THIS block (the block
    // it forces — the marker paints just above its first line).
    if (pendingBreakFact) {
      breakFacts.push({ ...pendingBreakFact, pos, afterBlockId: block.id });
      pendingBreakFact = null;
    }
    pendingBreakBefore = false;
    semantic.push(block);
    blocks.push({ ...conv.adapter, from: pos, to: pos + node.nodeSize });
  };

  /** Any block a list item may hold. `marker` is the item's own hint —
   * only its paragraph/heading carries it. */
  const walkListItemChild = (
    child: PMNode,
    childPos: number,
    depth: number,
    indentLeft: number,
    marker: ListMarkerHint
  ): void => {
    const name = child.type.name;
    if (name === 'paragraph' || name === 'heading') {
      push(projected(child, { kind: name, indentLeft, paint: { marker } }, childPos), child, childPos);
    } else if (name === 'bulletList' || name === 'orderedList') {
      walkList(child, childPos, depth + 1);
    } else if (name === 'codeBlock') {
      push(projected(child, { kind: 'codeBlock', indentLeft }, childPos), child, childPos);
    } else if (name === 'horizontalRule') {
      push(
        projected(child, { kind: 'paragraph', indentLeft, paint: { rule: true } }, childPos),
        child,
        childPos
      );
    } else if (name === 'blockquote') {
      walkBlockquote(child, childPos);
    } else {
      throw new UnsupportedDocError(
        `[adapter] unsupported block kind '${name}' inside a list item at offset ${childPos}`
      );
    }
  };

  /** A list: each listItem's inner blocks project with the item's
   * marker hint; ordered indexes are computed per-list — a sibling
   * deletion reindexes the remainder (O(changed) reconversions). */
  const walkList = (list: PMNode, listPos: number, depth: number): void => {
    const kind: 'bullet' | 'ordered' = list.type.name === 'orderedList' ? 'ordered' : 'bullet';
    const styleType = list.attrs?.listStyleType ?? defaultListStyle(kind);
    let index = 0;
    list.forEach((item, itemRel) => {
      if (item.type.name !== 'listItem') {
        throw new UnsupportedDocError(
          `[adapter] unexpected node '${item.type.name}' inside a ${list.type.name}`
        );
      }
      index += 1;
      // PM forEach offsets are CONTENT-relative (Fragment.forEach
      // starts at 0): a child's position = parent position + 1 + rel.
      const itemPos = listPos + 1 + itemRel;
      const marker: ListMarkerHint = { kind, depth, index, styleType };
      const indentLeft = depth * LIST_INDENT_PX;
      item.forEach((child, rel) => {
        walkListItemChild(child, itemPos + 1 + rel, depth, indentLeft, marker);
      });
    });
  };

  /** A blockquote: each inner paragraph/heading projects with
   * indentLeft 32 and the blockquote paint hint (left border + tint). */
  const walkBlockquote = (bq: PMNode, bqPos: number): void => {
    bq.forEach((child, rel) => {
      // Content-relative offsets (see walkList): +1 for the parent's
      // opening boundary.
      const childPos = bqPos + 1 + rel;
      const name = child.type.name;
      if (name === 'paragraph' || name === 'heading') {
        push(
          projected(child, { kind: name, indentLeft: LIST_INDENT_PX, paint: { blockquote: true } }, childPos),
          child,
          childPos
        );
      } else if (name === 'bulletList' || name === 'orderedList') {
        walkList(child, childPos, 1);
      } else if (name === 'codeBlock') {
        push(projected(child, { kind: 'codeBlock', indentLeft: LIST_INDENT_PX }, childPos), child, childPos);
      } else if (name === 'horizontalRule') {
        push(
          projected(child, { kind: 'paragraph', indentLeft: LIST_INDENT_PX, paint: { rule: true } }, childPos),
          child,
          childPos
        );
      } else {
        throw new UnsupportedDocError(
          `[adapter] unsupported block kind '${name}' inside a blockquote at offset ${childPos}`
        );
      }
    });
  };

  pm.forEach((node, offset) => {
    const name = node.type.name;

    // M-HEADER-FOOTER-2 — the band containers: route their children OUT
    // of the body flow into the engine's BandSet (never in flow order).
    // Paragraph/heading children only — a structural child (table, …)
    // throws the sentinel so the view falls back to pageless (which
    // renders the container natively), the loud-throws family's law.
    if (name === 'headerBlock' || name === 'footerBlock') {
      sawBandNode = true;
      const variant: HeaderFooterVariant = node.attrs?.variant === 'first' ? 'first' : 'default';
      const region = regionOf(name, variant)!;
      // #58 — the SECTION TAG: a container tagged with a known
      // sectionId feeds THAT section's override; untagged (or stale —
      // the break is gone) containers are the DOC DEFAULT every
      // non-overriding section inherits (the tagged-containers
      // decision). Two containers with the same key merge in doc order.
      // The FINAL section's reserved id maps to the last index (it has
      // no break node of its own).
      const tag = node.attrs?.sectionId;
      const sectionIndex =
        tag === FINAL_SECTION_ID
          ? sectionBreaksCollected.length
          : typeof tag === 'string' && tag && sectionIdToIndex.has(tag)
            ? sectionIdToIndex.get(tag)!
            : null;
      const pushTo = (region2: 'header' | 'footer' | 'firstHeader' | 'firstFooter'): void => {
        node.forEach((child: PMNode, rel: number) => {
          const childName = child.type.name;
          if (childName !== 'paragraph' && childName !== 'heading') {
            throw new UnsupportedDocError(
              `[adapter] unsupported band child '${childName}' inside ${name} at offset ${offset}: band content is paragraph/heading only`,
            );
          }
          pushBand(
            projected(child, { kind: childName, indentLeft: 0 }, offset + 1 + rel),
            child,
            offset + 1 + rel,
            region2,
          );
        });
      };
      if (sectionIndex === null) {
        pushTo(region);
      } else {
        const bucket = perSectionBands.get(sectionIndex) ?? {
          header: [],
          footer: [],
          firstHeader: [],
          firstFooter: [],
        };
        perSectionBands.set(sectionIndex, bucket);
        node.forEach((child: PMNode, rel: number) => {
          const childName = child.type.name;
          if (childName !== 'paragraph' && childName !== 'heading') {
            throw new UnsupportedDocError(
              `[adapter] unsupported band child '${childName}' inside ${name} at offset ${offset}: band content is paragraph/heading only`,
            );
          }
          pushBand(
            projected(child, { kind: childName, indentLeft: 0 }, offset + 1 + rel),
            child,
            offset + 1 + rel,
            region,
            bucket[region],
          );
        });
      }
      return;
    }

    if (name === 'pageBreak') {
      // Forced page break on the FOLLOWING block. A trailing pageBreak
      // (nothing follows) has no block to force — the engine derives
      // pages from placed lines, so it is simply skipped.
      pendingBreakBefore = true;
      // #58 — the NPC sidecar (the marker paints just above the
      // following block's first line).
      pendingBreakFact = { kind: 'pageBreak' as const, type: 'nextPage' as const };
      return;
    }

    if (name === 'sectionBreak') {
      // #58 SECTIONS — the node is NOT part of the IR (the pageBreak
      // law): it is collected as a section boundary. `afterBlock` = the
      // last projected block's index (−1 when the break opens the doc);
      // the RESOLUTION below turns the collected breaks into the
      // engine's section-start table. The engine's boundary law does
      // the forced close — no pendingBreakBefore here.
      sectionBreaksCollected.push({
        afterBlock: semantic.length - 1,
        setup: (node.attrs?.setup ?? null) as PageSetup | null,
        type: node.attrs?.type === 'continuous' ? 'continuous' : 'nextPage',
      });
      // #58 — the NPC sidecar: the break's kind, type, and the block
      // FOLLOWING it (the view paints the marker just above that
      // block's first line — at a page top for nextPage, mid-flow for
      // continuous). The position rides for the pageless surface.
      breakFacts.push({
        kind: 'sectionBreak',
        type: node.attrs?.type === 'continuous' ? 'continuous' : 'nextPage',
        pos: offset,
        afterBlockId: semantic[semantic.length - 1]?.id ?? null,
      });
      return;
    }

    if (name === 'paragraph' || name === 'heading') {
      const styleId = typeof node.attrs?.styleId === 'string' && node.attrs.styleId
        ? node.attrs.styleId
        : 'normal';
      push(
        projected(
          node,
          styleId === 'caption'
            ? { kind: name, indentLeft: 0, paint: { caption: true } }
            : { kind: name, indentLeft: 0 },
          offset,
        ),
        node,
        offset,
      );
    } else if (name === 'bulletList' || name === 'orderedList') {
      walkList(node, offset, 1);
    } else if (name === 'blockquote') {
      walkBlockquote(node, offset);
    } else if (name === 'codeBlock') {
      push(projected(node, { kind: 'codeBlock', indentLeft: 0 }, offset), node, offset);
    } else if (name === 'horizontalRule') {
      // No atomic union member in the engine (receipt: Block =
      // paragraph | heading | codeBlock) — project as a single-line
      // paragraph with a rule paint hint. One LineBox can never
      // fragment across pages.
      push(projected(node, { kind: 'paragraph', indentLeft: 0, paint: { rule: true } }, offset), node, offset);
    } else if (name === 'image') {
      // M-IMAGES-1 — the image joins the projection. src is OPAQUE
      // (echoes through to placed[]); dims are REQUIRED DOCUMENT DATA
      // (the engine's ImageBlock contract — never fetched at layout
      // time). A dim-less node is the PENDING-BACKFILL state (legacy
      // docs): throw the sentinel so the view falls back to pageless
      // (which renders the node view's natural-size <img>) until the
      // backfill writes the attrs — the standard update path then
      // re-enters paginated (the fallback resets on every successful
      // layout, PaginatedView's relayout receipt).
      const imgAttrs = node.attrs as {
        src?: string | null;
        width?: number | null;
        height?: number | null;
        alt?: string;
        align?: string | null;
        keepNext?: boolean | null;
        float?: { dx?: unknown; dy?: unknown; z?: unknown } | null;
      };
      if (typeof imgAttrs.width !== 'number' || typeof imgAttrs.height !== 'number') {
        throw new UnsupportedDocError(
          `[adapter] image at offset ${offset} lacks dims — pending backfill (the open path measures legacy images)`
        );
      }
      push(
        projected(
          node,
          {
            kind: 'image',
            indentLeft: 0,
            src: String(imgAttrs.src ?? ''),
            width: imgAttrs.width,
            height: imgAttrs.height,
            alt: imgAttrs.alt ?? '',
            align: imgAttrs.align === 'center' || imgAttrs.align === 'right' ? imgAttrs.align : 'left',
            keepNext: imgAttrs.keepNext === true,
            float:
              imgAttrs.float && typeof imgAttrs.float === 'object'
                ? {
                    dx: Number(imgAttrs.float.dx) || 0,
                    dy: Number(imgAttrs.float.dy) || 0,
                    z: imgAttrs.float.z === 'behind' ? 'behind' : 'front',
                  }
                : null,
          },
          offset,
        ),
        node,
        offset,
      );
    } else if (name === 'equation') {
      // M-EQ — the equation joins the projection (see convertNode's
      // equation arm for the dims ruling; color stays out of the
      // engine — paint-only, derived shell-side).
      const eqAttrs = node.attrs as { latex?: string; align?: string; scale?: unknown };
      push(
        projected(
          node,
          {
            kind: 'equation',
            indentLeft: 0,
            latex: String(eqAttrs.latex ?? ''),
            align:
              eqAttrs.align === 'left' || eqAttrs.align === 'right' ? eqAttrs.align : 'center',
            scale: typeof eqAttrs.scale === 'number' ? eqAttrs.scale : 1,
          },
          offset,
        ),
        node,
        offset,
      );
    } else if (name === 'table') {
      // M-TABLES — the table joins the projection: one engine
      // TableBlock + the cell-paragraph map (see the conversion).
      push(projected(node, { kind: 'table', indentLeft: 0 }, offset), node, offset);
    } else if (name === 'referenceTable') {
      // M-REFS — the reference table joins the projection: one engine
      // ReferenceTableBlock per node, entries from the per-call SCAN
      // (the doc-version fact — the conversion cache reuses only under
      // the same scan object; a retitle elsewhere reconverts). The
      // sidecar (entry slices → PM targets) rides the AdapterBlock.
      // The page strings ride the resolver's identity-stable map.
      push(
        projected(
          node,
          {
            kind: 'referenceTable',
            indentLeft: 0,
            refKind: node.attrs?.kind === 'figures' || node.attrs?.kind === 'index' ? node.attrs.kind : 'toc',
            refDepth: typeof node.attrs?.depth === 'number' ? node.attrs.depth : 3,
            scan: refScan,
            refPages: referencePages?.get(String(node.attrs?.blockId ?? '')),
            numberDisplay: node.attrs?.numberDisplay === 'none' ? 'none' : 'plain',
          },
          offset,
        ),
        node,
        offset,
      );
    } else {
      // THE THROW LIST (M6.1, pruned by M-IMAGES-1, M-TABLES and
      // M-EQ): the last true future feature is (drawing).
      throw new UnsupportedDocError(
        `[adapter] unsupported block kind '${name}' at offset ${offset}: future features ` +
          '(drawing) — the pageless fallback renders them until the engine supports them'
      );
    }
  });

  warnDroppedAttrs(dropped);

  // M-HEADER-FOOTER-2 — assemble the BandSet (absent when no band nodes
  // rode the doc: old files, nothing enabled — the engine then reserves
  // nothing). differentFirstPage rides bandOptions (per call, L4); the
  // engine picks the first-page vs rest regions off it.
  const bands = sawBandNode
    ? {
        ...(bandSemantic.header.length ? { header: bandSemantic.header } : {}),
        ...(bandSemantic.footer.length ? { footer: bandSemantic.footer } : {}),
        ...(bandSemantic.firstHeader.length ? { firstHeader: bandSemantic.firstHeader } : {}),
        ...(bandSemantic.firstFooter.length ? { firstFooter: bandSemantic.firstFooter } : {}),
        ...(bandOptions?.differentFirstPage ? { differentFirstPage: true } : {}),
        // #58 — the per-section overrides (only sections that carry
        // tagged containers; every other section inherits).
        ...(perSectionBands.size
          ? {
              perSection: Array.from(perSectionBands.entries()).map(([section, b]) => ({
                section,
                ...(b.header.length ? { header: b.header } : {}),
                ...(b.footer.length ? { footer: b.footer } : {}),
                ...(b.firstHeader.length ? { firstHeader: b.firstHeader } : {}),
                ...(b.firstFooter.length ? { firstFooter: b.firstFooter } : {}),
              })),
            }
          : {}),
      }
    : undefined;

  // #58 — THE SECTION RESOLUTION: the collected breaks (each carrying
  // the PRECEDING section's props — Word's sectPr spelling) become the
  // engine's section-START table. Section 0 begins at the doc start
  // with break 0's geometry; boundary k (k ≥ 1) sits after break k−1
  // and carries break k's geometry; the FINAL section (after the last
  // break) rides the layout opts — the engine appends the doc
  // defaults itself (the store-level pageSetup IS the final section's,
  // the store law). ABSENT when no breaks: the additive law.
  let sections: SectionBoundary[] | undefined;
  if (sectionBreaksCollected.length > 0) {
    // A break without props (hand-crafted/legacy): continuity — the
    // PREVIOUS section's geometry, else the doc defaults. The Section
    // dialog is the fix-it surface.
    const geometryOf = (setup: PageSetup | null, prev: PageSetup | null): SectionBoundary['geometry'] => {
      const effective: PageSetup = setup ?? prev ?? (pageSetup ?? FALLBACK_PAGE_SETUP);
      const lo = toLayoutOptions(effective);
      return { page: lo.page, margins: lo.margins };
    };
    // THE COMPLETE TABLE (n breaks → n+1 sections): section 0 at the
    // doc start (break 0's props), section k after break k−1 (break
    // k's props), and the FINAL section after the LAST break riding
    // the doc's pageSetup (the store law). The engine consumes it
    // verbatim — no implicit append (it could not know the last
    // break's position).
    let prevSetup: PageSetup | null = sectionBreaksCollected[0]!.setup;
    sections = [
      {
        afterBlock: -1,
        geometry: geometryOf(sectionBreaksCollected[0]!.setup, null),
      },
      ...sectionBreaksCollected.slice(1).map((brk, j) => {
        const geometry = geometryOf(brk.setup, prevSetup);
        prevSetup = brk.setup ?? prevSetup;
        return {
          afterBlock: sectionBreaksCollected[j]!.afterBlock,
          geometry,
          // The crossed boundary's type = the break AT it (break j's
          // node sits where section j+1 starts — its 'type' attr).
          type: sectionBreaksCollected[j]!.type,
        };
      }),
      {
        afterBlock: sectionBreaksCollected[sectionBreaksCollected.length - 1]!.afterBlock,
        geometry: geometryOf(pageSetup ?? null, prevSetup),
        // The final boundary = the LAST break's position — its type.
        type: sectionBreaksCollected[sectionBreaksCollected.length - 1]!.type,
      },
    ]
  }

  return {
    doc: { blocks: semantic, baseStyle, bands },
    blocks,
    bandBlocks,
    bandBlockIds,
    breakFacts,
    ...(sections ? { sections } : {}),
  };
}
