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
// The referenceTable's entries are real paragraphs the generator
// maintains; the adapter joins them to targets via the shared scan.
import {
  entriesForKind,
  scanCollections,
  type CollectionScan,
  type ReferenceKind,
} from '@/lib/references/scan';
// The two-pass resolver's map type (referencePages.ts).
import type { ReferencePagesMap } from './referencePages';
import {
  baselineRunStyle,
  resolveBlockTier,
  resolveFlowTier,
  resolveRun,
  transformText,
  type BlockTierAttrs,
  type RunStyle,
} from '@/lib/styles/resolve';
export type { TextAlign } from './positionMap';

/**
 * PM doc -> engine SemanticDoc: pure conversion, no measurement, no
 * DOM reads (L1 — the engine computes, the shell paints; this is the
 * shell->engine handoff). Unsupported kinds throw
 * UnsupportedDocError — the ONLY class the PaginatedView fallback
 * catches; everything else crashes loudly in dev.
 *
 * The pageBreak node is not part of the IR: it becomes
 * flow.breakBefore: 'page' on the following in-flow block (floated
 * blocks pass it through — validateFloatFlow refuses flow on floats).
 * Paragraphs and headings carry their own flow attrs, resolved
 * attr-over-style through resolveFlowTier and merged with the stamp.
 */

/** The unsupported-kind sentinel; the fallback catches ONLY this class. */
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
 * Shell-side paint hints, mirrored on AdapterBlock.paint. hashBlock
 * never sees them, so an ordered reindex produces a new Block object
 * with an unchanged hash — the cached placement survives; markers
 * are ink, never re-flow.
 */
export interface BlockPaint {
  marker?: ListMarkerHint;
  blockquote?: boolean;
  rule?: boolean;
  /** codeBlock backgrounds (the kind's paint face — carried here so the
   * painter stays hint-driven, one extras field for all block decor). */
  code?: boolean;
  /** A styleId 'caption' paragraph — the display toggle's paint hook. */
  caption?: boolean;
  /** A reference-table block — the field border is pure paint ink;
   *  the leader dots are real runs in the model, not a hint. */
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
   * Present IFF a table: the cell-paragraph map, the PM↔table-text
   * offset bridge. Runs/text are the canonical concatenation (rows
   * top-down, cells left-to-right); the slices tile the block text
   * exactly, so every text selection lives inside one slice.
   */
  table?: { paragraphs: { relStart: number; textStart: number; textLen: number }[] };
  /**
   * Present IFF a referenceTable: the entry map, the hit-offset →
   * navigation-target bridge. Each sidecar entry names one entry's
   * text slice + its PM targets (toc/figures: one; index: one per
   * occurrence); the placeholder carries one target-less entry.
   */
  reference?: ReferenceSidecar;
}

/** One reference-table sidecar entry — see AdapterBlock.reference. */
export interface ReferenceSidecarEntry {
  /** The paragraph's PM position relative to the container (pmStart =
   *  block.from + relStart) — the caret bridge into real entry text. */
  relStart: number;
  /**
   * The leader span's text length at the row's tail (0 = none). The
   * painter extends the dots with extra ink up to the page number —
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

/** The entry whose text slice contains `offset` (binary search on
 * textStart); null between slices — never happens today. */
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
   * Band blocks (header/footer children) in document order. The same
   * objects ride `blocks` (they hold real PM positions); this sidecar
   * carries the band membership.
   */
  bandBlocks: AdapterBlock[];
  /** Block ids that belong to bands. */
  bandBlockIds: Set<string>;
  /**
   * #58 — the resolved section-boundary table; absent when the doc
   * has no sectionBreak nodes. Each boundary is a section START
   * (afterBlock −1 = the doc start); the final section rides the
   * layout opts.
   */
  sections?: SectionBoundary[];
  /**
   * #58 — the NPC sidecar: every break atom with the block following
   * it. View-only ink; markers never print.
   */
  breakFacts: {
    kind: 'pageBreak' | 'sectionBreak' | 'columnBreak';
    type: 'nextPage' | 'continuous';
    pos: number;
    afterBlockId: string | null;
  }[];
}

/** Builtins only — identical to the pre-registry adapter. */
const BUILTIN_REGISTRY: StyleRegistrySnapshot = {
  definitions: builtinDefinitionsById(),
  epoch: 0,
};

// Dropped-attr policy: attrs/marks with no semantic-doc representation
// warn once per distinct dropped-set in dev — never silent. color,
// highlight, underline, strike, and left/center/right textAlign are
// painted (runDecor/align), not dropped. indexEntry and comment marks
// are recognized-quiet: model data the run walk never reads, no warn.
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
 * The identity cache: conversions memoized on the PM NODE object.
 * PM's structural sharing means unchanged blocks keep their object
 * references across doc versions, so they reuse their semantic Block
 * and AdapterBlock by reference (zero re-hashing). A baseStyle or
 * registry change invalidates everything via the generation tag.
 * Sibling facts (indentLeft, marker index) are not part of the node:
 * the cache stores them and reuses only when they are equal — a
 * reindexed item reconverts; an edit in item 7 leaves item 9's cached
 * objects identical.
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
  /** The warm page total the field placeholders were measured at;
   *  undefined on field-free blocks. */
  fieldTotal?: number;
  /** The scan object a referenceTable's entries were built under;
   *  undefined on every other kind. */
  scan?: CollectionScan;
  /** The resolved page strings (one per entry, identity-stable);
   *  undefined on every other kind. */
  refPages?: readonly string[];
  /** The number display the conversion was built under. */
  numberDisplay?: 'plain' | 'none';
}

const nodeCache = new WeakMap<PMNode, CachedConversion>();

/** Once-per-session warning: floated images carry no flow (the engine
 * refuses float+keepNext); the caption bond returns if the float is
 * removed. */
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

/** PM fontSize attr (CSS string; the UI writes 'NNpx') → core px;
 * pasted pt converts at the data boundary (96/72). */
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
 * PM lineHeight attr → the engine's multiplier. CSS semantics:
 * unitless → multiplier; '%' → /100; 'px'/'pt' → absolute ÷fontSize;
 * 'em' → as-is; 'normal'/junk → undefined. Outside [0.25, 4] →
 * undefined: garbage must degrade to single spacing, never a wreck.
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

// ─── Indent family mapping ────────────────────────────────────────
// PM indentLeft/indentRight are px (pass through); the legacy `indent`
// attr is steps of 32px, folded in additively; firstLineIndent is px
// (may be negative). Values the engine would throw on clamp to the
// nearest legal one and warn once in dev — never silent, never a
// layout crash.

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
  /** Block-tier left indent (px) — 0 for unindented blocks. */
  indentLeft: number;
  /** Paint hints (sibling facts — see CachedConversion). */
  paint?: BlockPaint;
  // ─── Image projection fields (kind 'image') ──────────────────────
  /** OPAQUE ref — 'media://<sha256>'; echoes to placed[]. */
  src?: string;
  width?: number;
  height?: number;
  alt?: string;
  align?: 'left' | 'center' | 'right';
  keepNext?: boolean;
  /** The anchored float echo (dx/dy/z). */
  float?: { dx: number; dy: number; z: 'front' | 'behind' } | null;
  // ─── Equation projection fields (kind 'equation') ────────────────
  /** OPAQUE LaTeX source — the node's only document data. */
  latex?: string;
  /** Font scale against the document default (default 1). */
  scale?: number;
  // ─── referenceTable projection fields ─────────────────────────────
  /** The collection kind ('toc' | 'figures' | 'index'). */
  refKind?: ReferenceKind;
  /** The ToC's heading-depth option (node attr; other kinds ignore). */
  refDepth?: number;
  /** The doc-version fact the entries were built under: the node
   * object survives a heading retitle, so reuse requires the same
   * scan object. */
  scan?: CollectionScan;
  /** The resolved page strings, one per entry; reuse requires the
   * same array object. */
  refPages?: readonly string[];
  /** The number display: 'plain' (default) or 'none' (no numbers). */
  numberDisplay?: 'plain' | 'none';
}

/**
 * The pageless <pre> look: monospace at the document-default size,
 * one run per source line ('\n' kept at the end of its line — the
 * engine's breaker honors the separators and measures blank lines
 * under the first run's style).
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

/** Resolved RunStyle → engine TextStyle. lineHeight passes through
 * verbatim (absent stays absent — the engine's absent ≡ 1.0
 * invariant); 'normal' fontVariant is stripped (explicit 'normal'
 * must not hash differently from absent). */
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
 * text, align, spacing, indent, hints. Cached on the node object;
 * PM positions (from/to) are deliberately NOT cached — they depend
 * on preceding siblings and are recomputed per call. All style
 * resolution flows through resolve.ts.
 */
interface RunConversion {
  runs: Run[];
  runDecor: RunDecor[];
  text: string;
}

/**
 * One paragraph-like node's children → runs/decor/text. inlineImage
 * children map to InlineImageRuns; other non-text inline children
 * throw the sentinel. Shared by the flow tier and table cells.
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
        // INLINE OBJECTS: an inlineImage child maps to an
        // InlineImageRun (one U+FFFC token in the block text keeps
        // the PM-offset identity). A pageField child's run text is
        // the MEASURED PLACEHOLDER (the warm total's max-width
        // digits); the painter substitutes the per-page value at
        // draw time.
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
      // mark, not a separate mark; a standalone 'fontFamily' mark is
      // supported defensively.
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

      // One resolver (resolve.ts): base < para style < charStyle <
      // direct marks, per property.
      const resolved = resolveRun({ base, para: paraDef, char: charDef, direct });

      // Direct lineHeight parses against the RESOLVED font size and
      // beats the tiers; the attr value passes through verbatim.
      const attrLineHeight = parseLineHeight(node.attrs?.lineHeight, resolved.fontSize);
      const tierLineHeight = charDef?.properties.lineHeight ?? paraDef?.properties.lineHeight;
      const lineHeight = attrLineHeight !== undefined ? attrLineHeight : tierLineHeight;

      // Dropped-attr detection (warned once, never silent). Painted,
      // not dropped: color/highlight/underline/strike, left/center/
      // right textAlign. Mapped: spaceBefore/After, the indent family.
      // justify stays loud. tensor-ref: links are recognized-quiet
      // model data for the exporters.
      if (child.marks.some((m) => m.type.name === 'link')) {
        const href = child.marks.find((m) => m.type.name === 'link')?.attrs?.href;
        if (typeof href !== 'string' || !href.startsWith('tensor-ref:')) dropped.add('link');
      }

      // Run TEXT is transformed HERE so the engine measures the
      // transformed text (uppercase is wider); transformText is
      // length-preserving, so offsets stay PM-identical.
      const runText = transformText(child.text, resolved.textTransform);
      runs.push({ text: runText, style: textStyleOf(resolved, lineHeight) });
      runDecor.push({
        color: resolved.color !== '#000000' ? resolved.color : undefined,
        // The highlight tier cascades like color.
        highlight: resolved.highlight !== '' ? resolved.highlight : undefined,
        underline: resolved.underline,
        strike: resolved.strike,
      });
      text += runText;
  });
  return { runs, runDecor, text };
}

/**
 * An empty paragraph/heading emits ONE zero-length run with the
 * block's effective style, so an empty paragraph in a 2.0-spaced
 * style measures 2.0 and its NPC ¶ paints at the right size.
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

  // Images convert structurally: no runs, no text, no BlockTier;
  // align is their horizontal control. A floated block NEVER carries
  // flow (the engine throws on float+keepNext): float present → flow
  // omitted entirely, warned once.
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

  // Equations convert structurally, the image arm's shape. Dims are
  // NOT projected — derived facts the engine asks the EquationMetrics
  // port for at layout time (the adapter is pure). fontSize is the
  // document default scaled by the node's `scale` attr; color is
  // paint-only. No float/flow: display equations are strictly in
  // flow.
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

  // The table projects WHOLE (one engine TableBlock): each cell's
  // paragraphs through the shared walkProseRuns into the canonical
  // concatenation; non-paragraph cell content throws the sentinel
  // (v1: paragraphs only). The AdapterBlock carries the cell map.
  if (kind === 'table') {
    const rows: TableBlock['rows'] = [];
    const tableRuns: Run[] = [];
    const tableDecor: RunDecor[] = [];
    const paragraphs: { relStart: number; textStart: number; textLen: number }[] = [];
    let tableText = '';
    // Position walk with a MANUAL cursor: PM forEach offsets are
    // CONTENT-relative (the third arg is an index, never a position),
    // so the cursor tracks each child's position relative to the
    // TABLE node.
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
          // Every cell paragraph's slice gets a trailing '\n' (the
          // engine advances textOffset the same way), so empty cells
          // own a distinct textStart.
          tableText += conv.text + '\n';
          // The paragraph's first text position, TABLE-relative:
          // the paragraph node at `cursor` (relative to the table),
          // its text at +1.
          paragraphs.push({ relStart: cursor + 1, textStart, textLen: conv.text.length });
          cursor += para.nodeSize;
        });
        cursor = cellPos + cell.nodeSize;
        // Per-cell padding override (per-side; null inherits).
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
      // The row's minimum height (Word's "at least"); null = content
      // height.
      const rowMin = row.attrs?.minHeight;
      // The row's split control (Word's w:cantSplit) — true = atomic.
      const rowCantSplit = row.attrs?.cantSplit;
      rows.push({
        isHeader: allHeader,
        minHeight: typeof rowMin === 'number' && rowMin > 0 ? rowMin : null,
        ...(rowCantSplit === true ? { cantSplit: true } : {}),
        cells,
      });
    });

    const borderStyle = node.attrs?.borderStyle;
    const alignAttr = node.attrs?.align;
    // Outer margins: top/bottom ride the block tier's spacing;
    // left/right narrow the engine's table box.
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
    // The table's default cell padding (per-side; null inherits).
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
    // Table-level pagination flags, emitted only when set (like
    // paragraphs).
    const tableFlow = resolveFlowTier(null, {
      keepNext: node.attrs?.keepNext,
      keepLines: node.attrs?.keepLines,
      keepPrevious: node.attrs?.keepPrevious,
      breakBefore: node.attrs?.breakBefore,
      breakAfter: node.attrs?.breakAfter,
    });
    const semantic: TableBlock = {
      id: blockId,
      kind: 'table',
      rows,
      borderStyle: borderStyle === 'none' || borderStyle === 'outer' ? borderStyle : 'all',
      // Table alignment within the content box.
      align: alignAttr === 'center' || alignAttr === 'right' ? alignAttr : 'left',
      ...(spaceBefore != null ? { spaceBefore } : {}),
      ...(spaceAfter != null ? { spaceAfter } : {}),
      ...(marginLR ? { margin: marginLR } : {}),
      ...(cellPadding ? { cellPadding } : {}),
      ...(tableFlow ? { flow: tableFlow } : {}),
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

  // The reference table converts from its REAL CHILDREN (the
  // container model): each child's runs flow through the shared
  // prose walk, plus the synthetic tab + page-number runs (layout
  // facts, never persisted PM text). The sidecar bridges hit-offsets
  // to entry text and navigation targets; the placeholder converts
  // like any entry with zero targets.
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
    // The resolver's per-entry page strings — undefined on cold start.
    const refPagesInput = projection.refPages;
    // Hoisted: the sidecar reads it outside the row loop.
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
      // placeholder).
      const refId = typeof child.attrs.refId === 'string' && child.attrs.refId ? child.attrs.refId : null;
      let targets: number[] = [];
      if (refId) {
        const match = scanEntries.find((e) =>
          refKind === 'index' ? e.text === refId : e.targets[0]?.blockId === refId
        );
        targets = match ? match.targets.map((t) => t.pos) : [];
      }

      const indentLeft = Math.max(0, ownIndentLeft(child));
      // The leader span: the generator writes a refLeader-marked dots
      // span as the row's LAST text node. Its LENGTH is detected from
      // the inline node (never guessed from text) and rides the
      // sidecar — the engine lays out the seed verbatim, the painter
      // extends the dots to fill the gap to the page number.
      let leaderLen = 0;
      const lastInline = child.childCount > 0 ? child.child(child.childCount - 1) : null;
      if (
        lastInline?.isText &&
        lastInline.marks.some((m) => m.type.name === 'refLeader')
      ) {
        leaderLen = lastInline.text?.length ?? 0;
      }

      // The engine entry: the row's real runs + the synthetic tab +
      // THE PAGE NUMBER (the resolver's string, '' while unresolved —
      // a layout fact, so a re-resolved number re-breaks exactly this
      // block). numberDisplay 'none' drops the number entirely.
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
      // The synthetic pair rides the canonical text too.
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
      // Sibling facts for the reuse test: the scan (compared by
      // reference), the page strings, and the number display.
      scan: projection.scan,
      refPages: projection.refPages,
      numberDisplay: projection.numberDisplay,
    };
  }

  // Headings resolve through `heading-{level}` (the styleId attr's
  // twin); paragraphs through their styleId attr ('normal' default).
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
    // An empty codeBlock emits one zero-length mono run, so the
    // blank line matches its siblings.
    if (runs.length === 0) {
      runs.push({ text: '', style: { fontFamily: 'monospace', fontSize: base.fontSize } });
    }
  } else {
    // Table cell paragraphs share the same walk.
    const prose = walkProseRuns(node, kind, paraDef, base, definitions, dropped, fieldTotal);
    runs.push(...prose.runs);
    runDecor.push(...prose.runDecor);
    text = prose.text;
  }

  // Empty paragraphs/headings inherit through the shared helper.
  if (
    runs.length === 0 &&
    (node.type.name === 'paragraph' || node.type.name === 'heading')
  ) {
    runs.push(emptyTextBlockRun(node, paraDef, base));
  }

  // Direct attrs beat the paragraph style's geometry, which beats
  // the baseline; the legacy `indent` steps fold into the attr side.
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

  // Flow-flag cascade (direct attrs beat the paragraph style's flow
  // properties). resolveFlowTier returns undefined when nothing
  // resolves — the block then carries no `flow` field (hashBlock
  // covers flow; an empty object would churn every hash). Paragraphs
  // and headings only; embedded cell/entry paragraphs have no flow.
  const flow =
    kind === 'paragraph' || kind === 'heading'
      ? resolveFlowTier(paraDef, {
          keepNext: node.attrs?.keepNext,
          keepLines: node.attrs?.keepLines,
          keepPrevious: node.attrs?.keepPrevious,
          widowControl: node.attrs?.widowControl,
          breakBefore: node.attrs?.breakBefore,
          breakAfter: node.attrs?.breakAfter,
        })
      : undefined;

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

  // 'justify' is engine work: dropped to left with the same
  // one-time warning (the pageless CSS renders it natively).
  const align: TextAlign = tier.align === 'justify' ? 'left' : tier.align;
  if (tier.align === 'justify') dropped.add('textAlign (justify — engine work)');
  const spaceBefore = tier.spaceBefore != null && tier.spaceBefore > 0 ? tier.spaceBefore : undefined;
  const spaceAfter = tier.spaceAfter != null && tier.spaceAfter > 0 ? tier.spaceAfter : undefined;

  const hints = projection.paint ?? {};
  // Semantic-side hint spelling; the engine ignores all of them.
  const hintFields = {
    ...(hints.marker ? { listMarker: hints.marker } : {}),
    ...(hints.blockquote ? { blockquote: true } : {}),
    ...(hints.rule ? { rule: true } : {}),
    ...(hints.code ? { code: true } : {}),
  };
  // Tab stops, normalized (sorted, deduped, absent when empty); the
  // breaker does not consume them yet.
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
    ...(flow ? { flow } : {}),
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
    // The sibling-fact key is the BASE indent — own-attr changes
    // produce a new node object and miss the WeakMap.
    indentLeft: projection.indentLeft,
    paint: projection.paint,
    // The warm total rides only on field-bearing blocks — a widened
    // total must miss their caches; field-free blocks are
    // total-independent.
    fieldTotal: runs.some((r) => (r as { fieldKind?: string }).fieldKind != null) ? fieldTotal : undefined,
  };
}

export function pmDocToSemantic(
  pm: PMNode,
  baseStyle: TextStyle,
  registry: StyleRegistrySnapshot = BUILTIN_REGISTRY,
  /** Band options read PER CALL: the different-first-page flag
   *  travels in .wpdoc metadata. */
  bandOptions?: { differentFirstPage?: boolean },
  /** Resolved page strings per referenceTable blockId (the
   *  fixpoint's input), one string per entry; absent on cold start —
   *  the caller passes the resolver's identity-stable output. */
  referencePages?: ReferencePagesMap,
  /** The warm page total: the field runs' measured placeholder is
   *  the max-width digit string; the fixpoint re-lays-out when the
   *  real total widens. Absent on cold start. */
  fieldTotal?: number,
  /** #58 — the FINAL section's props, read per call; the adapter
   *  resolves the complete boundary table with it. Absent → the
   *  Letter/Normal fallback (defensive; real callers pass the store). */
  pageSetup?: PageSetup,
): AdapterResult {
  // The registry epoch: a baseStyle change or definition edit
  // invalidates the identity cache wholesale; the engine then decides
  // per block what re-breaks via contentHash or splices.
  const contextKey = `${baseStyle.fontFamily}\u0000${baseStyle.fontSize}\u0000${registry.epoch}`;
  if (contextKey !== lastContextKey) {
    cacheGeneration += 1;
    lastContextKey = contextKey;
  }

  const base = baselineRunStyle(baseStyle);
  const definitions = registry.definitions;

  // The ONE per-call scan (memoized on the doc object), shared by
  // every referenceTable node and the pageless NodeView.
  const refScan = scanCollections(pm);

  const blocks: AdapterBlock[] = [];
  const semantic: Block[] = [];
  const dropped = new Set<string>();
  // #74 — the pending forced-break spelling ('page' or 'column'),
  // merged into the following block's flow.
  let pendingBreakBefore: 'page' | 'column' | null = null;
  // A breakAfter attr badges the NEXT in-flow block.
  let pendingAfterBreakFact: { pos: number } | null = null;

  // #58 — the sectionBreak nodes in doc order (the walk collects;
  // the resolution below turns them into the engine's table).
  const sectionBreaksCollected: {
    afterBlock: number;
    setup: PageSetup | null;
    type: 'nextPage' | 'continuous';
  }[] = [];

  // #58 — the NPC sidecar: every break atom with the block following
  // it; view-only ink, never printed.
  const breakFacts: {
    kind: 'pageBreak' | 'sectionBreak' | 'columnBreak';
    type: 'nextPage' | 'continuous';
    pos: number;
    afterBlockId: string | null;
  }[] = [];
  let pendingBreakFact: {
    kind: 'pageBreak' | 'sectionBreak' | 'columnBreak';
    type: 'nextPage' | 'continuous';
  } | null = null;

  // PRE-SCAN: a band container's sectionId may sit before its break
  // node in doc order, so the tag→index map must exist before the
  // walk. Stale tags resolve to the doc default.
  const sectionIdToIndex = new Map<string, number>();
  pm.forEach((node) => {
    if (node.type.name === 'sectionBreak') {
      const tag = node.attrs?.sectionId;
      if (typeof tag === 'string' && tag && !sectionIdToIndex.has(tag)) {
        sectionIdToIndex.set(tag, sectionIdToIndex.size);
      }
    }
  });

  // Band routing: header/footer children go to the engine's BandSet
  // (never flow order); their AdapterBlocks ride both lists.
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

  /** Commit one band child: semantic → its region, adapter → both
   *  lists. */
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

  /** Cache-aware projection: reuses only when the sibling facts are
   *  unchanged. codeBlocks always carry the code hint — merged here
   *  so the cache comparison and the stored facts agree. */
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
      // The total gates only field-bearing conversions (a widened
      // total re-converts); field-free ones reuse at any total.
      (cached.fieldTotal == null || cached.fieldTotal === fieldTotal) &&
      paintEqual(cached.paint, projection.paint) &&
      // The scan fact: a referenceTable reuses only under the SAME
      // doc scan (a retitle keeps the node but changes the scan).
      cached.scan === projection.scan &&
      // A re-resolved number is a new array — reconvert exactly when
      // the numbers moved.
      cached.refPages === projection.refPages &&
      // The number-display fact (a preset flip reconverts).
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

  /** Commit one projected block. The pageBreak stamp MERGES over the
   *  block's own flow (breakBefore is the one field the stamp owns).
   *  A FLOATED block passes the pending break through — the engine
   *  refuses breakBefore on floats; its ruling: put the forced break
   *  on the following text block. Positions are always fresh. */
  const push = (conv: CachedConversion, node: PMNode, pos: number): void => {
    const floated =
      conv.semantic.kind === 'image' && (conv.semantic as { float?: unknown }).float != null;
    const block =
      pendingBreakBefore && !floated
        ? { ...conv.semantic, flow: { ...conv.semantic.flow, breakBefore: pendingBreakBefore } }
        : conv.semantic;
    // #58 — a pending pageBreak NPC attaches to THIS block (the block
    // it forces — the marker paints just above its first line).
    let stampedHere = false;
    if (pendingBreakFact && !floated) {
      breakFacts.push({ ...pendingBreakFact, pos, afterBlockId: block.id });
      pendingBreakFact = null;
      stampedHere = true;
    }
    // The previous block's breakAfter anchors HERE, unless the
    // explicit node's badge already covers the edge.
    if (pendingAfterBreakFact && !floated && !stampedHere) {
      breakFacts.push({ kind: 'pageBreak', type: 'nextPage', pos: pendingAfterBreakFact.pos, afterBlockId: block.id });
    }
    pendingAfterBreakFact = null;
    // Direct-attr forced breaks badge like the node spelling;
    // style-tier breaks never badge (a style would paint every
    // heading).
    const directBreakBefore = node.attrs?.breakBefore;
    if (
      !floated &&
      !stampedHere &&
      (directBreakBefore === 'page' || directBreakBefore === 'column')
    ) {
      breakFacts.push({
        kind: directBreakBefore === 'page' ? 'pageBreak' : 'columnBreak',
        type: 'nextPage',
        pos,
        afterBlockId: block.id,
      });
    }
    if (!floated && node.attrs?.breakAfter === 'page') {
      pendingAfterBreakFact = { pos };
    }
    if (!floated) pendingBreakBefore = null;
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

    // Band containers: route their children OUT of the body flow into
    // the engine's BandSet. Paragraph/heading only — anything else
    // throws the sentinel (pageless renders it).
    if (name === 'headerBlock' || name === 'footerBlock') {
      sawBandNode = true;
      const variant: HeaderFooterVariant = node.attrs?.variant === 'first' ? 'first' : 'default';
      const region = regionOf(name, variant)!;
      // #58 — the SECTION TAG: a known sectionId feeds THAT section's
      // override; untagged or stale containers are the doc default.
      // The FINAL section's reserved id maps to the last index.
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
      pendingBreakBefore = 'page';
      // #58 — the NPC sidecar (the marker paints just above the
      // following block's first line).
      pendingBreakFact = { kind: 'pageBreak' as const, type: 'nextPage' as const };
      return;
    }

    if (name === 'columnBreak') {
      // #74 — forced column break on the FOLLOWING block (the
      // pageBreak law); a trailing one is simply skipped.
      pendingBreakBefore = 'column';
      // The NPC sidecar: the marker paints at its column's frame.
      pendingBreakFact = { kind: 'columnBreak' as const, type: 'nextPage' as const };
      return;
    }

    if (name === 'sectionBreak') {
      // #58 — the node is NOT part of the IR: collected as a section
      // boundary; afterBlock = the last projected block's index. The
      // engine's boundary law does the forced close.
      sectionBreaksCollected.push({
        afterBlock: semantic.length - 1,
        setup: (node.attrs?.setup ?? null) as PageSetup | null,
        type: node.attrs?.type === 'continuous' ? 'continuous' : 'nextPage',
      });
      // The NPC sidecar: the break's kind/type and the block following
      // it; the position rides for the pageless surface.
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
      // No atomic union member — project as a single-line paragraph
      // with a rule paint hint (one LineBox, never fragments).
      push(projected(node, { kind: 'paragraph', indentLeft: 0, paint: { rule: true } }, offset), node, offset);
    } else if (name === 'image') {
      // src is OPAQUE; dims are REQUIRED. A dim-less node is the
      // pending-backfill state of legacy docs: throw the sentinel so
      // the view falls back to pageless until the backfill writes
      // the attrs.
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
      // See convertNode's equation arm for the dims ruling.
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
      // One engine TableBlock + the cell map (see the conversion).
      push(projected(node, { kind: 'table', indentLeft: 0 }, offset), node, offset);
    } else if (name === 'referenceTable') {
      // One engine ReferenceTableBlock per node; the page strings ride
      // the resolver's identity-stable map.
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
      // The last true future feature is (drawing).
      throw new UnsupportedDocError(
        `[adapter] unsupported block kind '${name}' at offset ${offset}: future features ` +
          '(drawing) — the pageless fallback renders them until the engine supports them'
      );
    }
  });

  warnDroppedAttrs(dropped);

  // Assemble the BandSet (absent when no band nodes rode the doc);
  // differentFirstPage rides bandOptions.
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
  // the PRECEDING section's props, Word's sectPr spelling) become the
  // engine's section-START table; the FINAL section rides the layout
  // opts. ABSENT when no breaks.
  let sections: SectionBoundary[] | undefined;
  if (sectionBreaksCollected.length > 0) {
    // A break without props (hand-crafted/legacy): continuity — the
    // PREVIOUS section's geometry, else the doc defaults. The Section
    // dialog is the fix-it surface.
    const geometryOf = (setup: PageSetup | null, prev: PageSetup | null): SectionBoundary['geometry'] => {
      const effective: PageSetup = setup ?? prev ?? (pageSetup ?? FALLBACK_PAGE_SETUP);
      const lo = toLayoutOptions(effective);
      // #74 COLUMNS — the section's spec rides the geometry verbatim
      // (the engine's boundary law swaps it with page/margins); absent
      // ≡ one column, so the field is simply omitted.
      return { page: lo.page, margins: lo.margins, ...(lo.columns ? { columns: lo.columns } : {}) };
    };
    // n breaks → n+1 sections: section 0 at the doc start (break 0's
    // props), section k after break k−1, the final section after the
    // LAST break riding the doc's pageSetup. The engine consumes it
    // verbatim — no implicit append.
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
