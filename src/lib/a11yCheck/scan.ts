import type { Node as PMNode } from '@tiptap/pm/model';
import type { ResolvedPos } from '@tiptap/pm/model';
import type { StyleDefinition, StyleProperties } from '@/lib/styles/types';
import { headingStyleId } from '@/lib/styles/types';
import { lookupStyle } from '@/lib/styles/registry';
import { baselineRunStyle, resolveNormalBase, resolveRun } from '@/lib/styles/resolve';
import { aaThreshold, contrastRatio, isLargeText } from './contrast';
import type { A11yIssue, A11yScanContext, A11yScanResult } from './types';

/**
 * M-A11Y — the scan: three content checks over the PM doc, pure and
 * on-demand (the issue's "not continuously in the background" is the
 * caller's law — this module just computes when asked).
 *
 * THE BAND RULING (the session's locked decision): band content —
 * headers and footers — IS screen-reader content, so the alt and
 * contrast checks INCLUDE it (a header's background chain is its
 * section's page color, the same math as body text); band HEADINGS
 * stay OUT of the hierarchy check — a header's H2 is chrome, not body
 * outline (the ToC scan's ruling, and Word's own reading).
 *
 * THE BACKGROUND CHAIN for a text run, first-present-layer-wins
 * (matching the paint order — the highlight fillRect covers the cell
 * fill covers the page): highlight (the resolveRun cascade, with the
 * adapter's #fef08a default) → the enclosing table cell's
 * backgroundColor → the containing section's pageColor (the
 * breakOrdinalList math, bit-for-bit with the paint side) → white.
 * Paint-only approximations (the blockquote/code tints are hardcoded
 * constants, not document data) are deliberately NOT in the chain.
 *
 * The foreground resolves through resolveRun — THE one cascade (the
 * adapter's own law, never a parallel resolver): color/highlight marks
 * > charStyle > paragraph/heading style > the #000000 baseline.
 */

/** Top-level band container names (HeaderFooterNodes' containers). */
const BAND_KINDS = new Set(['headerBlock', 'footerBlock']);

/** PageSheet's bg-white — pageColor ''/undefined everywhere. */
const PAGE_WHITE = '#ffffff';

/** The adapter's DEFAULT_HIGHLIGHT — a colorless highlight mark. */
const DEFAULT_HIGHLIGHT = '#fef08a';

/** The merged-span snippet cap — enough context to recognize the text,
 * never enough to become a wall. */
const SNIPPET_MAX = 60;

interface SectionBreakInfo {
  pos: number;
  color: string | undefined;
}

/** Top-level sectionBreaks with their page colors ('' inherits —
 * resolved against the doc default at use, the paint side's law). */
function sectionBreaksOf(doc: PMNode): SectionBreakInfo[] {
  const out: SectionBreakInfo[] = [];
  doc.forEach((node, offset) => {
    if (node.type.name !== 'sectionBreak') return;
    const setup = node.attrs.setup as { pageColor?: unknown } | null | undefined;
    const color =
      typeof setup?.pageColor === 'string' && setup.pageColor ? setup.pageColor : undefined;
    out.push({ pos: offset, color });
  });
  return out;
}

/** The section page color for a top-level block starting at
 * `topStart` — the sections.ts index math (breaks strictly before),
 * with an unset break inheriting the doc default. */
function pageColorFor(
  breaks: SectionBreakInfo[],
  docPageColor: string | undefined,
  topStart: number,
): string | undefined {
  let index = 0;
  for (const b of breaks) {
    if (b.pos < topStart) index += 1;
    else break;
  }
  return index < breaks.length ? (breaks[index]!.color ?? docPageColor) : docPageColor;
}

/** The nearest enclosing cell's backgroundColor, if any (cells don't
 * nest; the first hit is the one that paints under the text). */
function cellBackgroundAt($pos: ResolvedPos): string | undefined {
  for (let d = 1; d <= $pos.depth; d++) {
    const node = $pos.node(d);
    if (node.type.name !== 'tableCell' && node.type.name !== 'tableHeader') continue;
    const bg = node.attrs.backgroundColor;
    if (typeof bg === 'string' && bg) return bg;
  }
  return undefined;
}

/** The paragraph/heading style definition for a text node's parent
 * block (the effectiveSelectionRunStyle spelling, node-side). */
function paragraphStyleOf(
  parent: PMNode,
  definitions: Record<string, StyleDefinition>,
): StyleDefinition | null {
  if (parent.type.name === 'heading') {
    const level = typeof parent.attrs.level === 'number' ? parent.attrs.level : 1;
    return lookupStyle(headingStyleId(level), definitions);
  }
  if (parent.type.name === 'paragraph') {
    const styleId = typeof parent.attrs.styleId === 'string' && parent.attrs.styleId
      ? parent.attrs.styleId
      : 'normal';
    return lookupStyle(styleId, definitions);
  }
  return null;
}

/** One bad-contrast span: adjacent text leaves with the SAME resolved
 * style merge into one issue (PM splits text at formatting
 * boundaries; an identical verdict across the boundary is one
 * finding, not fragments). */
interface ContrastSpan {
  from: number;
  to: number;
  key: string;
  text: string;
  ratio: number;
  large: boolean;
}

const scanCache = new WeakMap<
  PMNode,
  {
    definitions: Record<string, StyleDefinition>;
    pageColor: string | undefined;
    baseFontFamily: string;
    baseFontSize: number;
    result: A11yScanResult;
  }
>();

/**
 * The scan. Memoized on the PM doc object (the references scan's
 * stability law): the panel's live re-checking walks nothing until the
 * doc reference, the registry's merged definitions object, or the
 * page color actually changes.
 */
export function scanAccessibility(doc: PMNode, ctx: A11yScanContext): A11yScanResult {
  const cached = scanCache.get(doc);
  if (
    cached &&
    cached.definitions === ctx.definitions &&
    cached.pageColor === (ctx.pageColor ?? undefined) &&
    cached.baseFontFamily === ctx.baseFontFamily &&
    cached.baseFontSize === ctx.baseFontSize
  ) {
    return cached.result;
  }
  const result = computeScan(doc, ctx);
  scanCache.set(doc, {
    definitions: ctx.definitions,
    pageColor: ctx.pageColor ?? undefined,
    baseFontFamily: ctx.baseFontFamily,
    baseFontSize: ctx.baseFontSize,
    result,
  });
  return result;
}

function computeScan(doc: PMNode, ctx: A11yScanContext): A11yScanResult {
  const altIssues: A11yIssue[] = [];
  const headingIssues: A11yIssue[] = [];
  const contrastIssues: A11yIssue[] = [];
  let skippedRuns = 0;

  const docPageColor =
    typeof ctx.pageColor === 'string' && ctx.pageColor ? ctx.pageColor : undefined;
  const breaks = sectionBreaksOf(doc);
  const base = baselineRunStyle(
    resolveNormalBase(ctx.baseFontFamily, ctx.baseFontSize, ctx.definitions),
  );

  // ── ALT + CONTRAST (bands included — header/footer content is
  // screen-reader content; the locked band ruling) ──────────────────
  const spans: ContrastSpan[] = [];
  doc.descendants((node, pos) => {
    const name = node.type.name;
    if (name === 'image' || name === 'inlineImage') {
      // MISSING ALT: the attr is a plain string defaulting to '' —
      // unwritten (a decorative marking, landing with the schema in
      // the follow-up commit, will exempt presentational ink).
      const alt = node.attrs?.alt;
      if (typeof alt !== 'string' || alt.trim() === '') {
        altIssues.push({
          kind: 'altText',
          severity: 'error',
          message: 'Image is missing alt text',
          pos,
          src: typeof node.attrs?.src === 'string' ? node.attrs.src : '',
        });
      }
      return; // atoms — no text inside
    }
    if (!node.isText) return;
    const text = node.text ?? '';
    if (!text.trim()) return; // whitespace ink never carries meaning

    const $pos = doc.resolve(pos);
    const direct: StyleProperties = {};
    const textStyleMark = node.marks.find((m) => m.type.name === 'textStyle');
    const textStyle = textStyleMark?.attrs as Record<string, unknown> | undefined;
    if (typeof textStyle?.color === 'string' && textStyle.color) direct.color = textStyle.color;
    if (typeof textStyle?.fontSize === 'string' && textStyle.fontSize) {
      const px = parseFloat(textStyle.fontSize);
      if (Number.isFinite(px) && px > 0) direct.fontSize = px;
    }
    if (node.marks.some((m) => m.type.name === 'bold')) direct.bold = true;
    const highlightMark = node.marks.find((m) => m.type.name === 'highlight');
    if (highlightMark) {
      const color = highlightMark.attrs?.color;
      direct.highlight = typeof color === 'string' && color ? color : DEFAULT_HIGHLIGHT;
    }
    const charStyleMark = node.marks.find((m) => m.type.name === 'charStyle');
    const charDef = charStyleMark
      ? lookupStyle(String(charStyleMark.attrs?.styleId ?? ''), ctx.definitions)
      : null;

    const resolved = resolveRun({
      base,
      para: paragraphStyleOf($pos.parent, ctx.definitions),
      char: charDef,
      direct,
    });

    // The background chain: highlight > cell fill > section page
    // color > white (first present layer — the paint order).
    const background =
      resolved.highlight !== ''
        ? resolved.highlight
        : (cellBackgroundAt($pos) ??
          pageColorFor(breaks, docPageColor, $pos.before(1)) ??
          PAGE_WHITE);

    const ratio = contrastRatio(resolved.color, background);
    if (ratio == null) {
      // A color in the chain was unparseable or semi-transparent —
      // counted, never guessed (a checker that can't see declines to
      // pass or fail by assumption).
      skippedRuns += 1;
      return;
    }
    const large = isLargeText(resolved.fontSize, resolved.bold);
    if (ratio >= aaThreshold(large)) return;

    // Merge adjacent leaves with the identical style tuple (the
    // verdict's whole input) into one span.
    const key = `${resolved.color}\u0000${background}\u0000${resolved.fontSize}\u0000${resolved.bold}`;
    const last = spans[spans.length - 1];
    if (last && last.to === pos && last.key === key) {
      last.to = pos + node.nodeSize;
      if (last.text.length < SNIPPET_MAX) last.text += text;
    } else {
      spans.push({ from: pos, to: pos + node.nodeSize, key, text, ratio, large });
    }
  });

  for (const span of spans) {
    const snippet = span.text.length > SNIPPET_MAX ? `${span.text.slice(0, SNIPPET_MAX)}…` : span.text;
    contrastIssues.push({
      kind: 'contrast',
      severity: 'warning',
      message: `Low contrast (${span.ratio.toFixed(2)}:1) — AA needs ${aaThreshold(span.large)}:1`,
      pos: span.from,
      to: span.to,
      detail: snippet.trim(),
    });
  }

  // ── HEADING HIERARCHY (bands excluded — a header's heading is
  // chrome, never body outline; the ToC scan's ruling) ─────────────
  let prevLevel = 0;
  let h1Count = 0;
  doc.descendants((node, pos) => {
    if (BAND_KINDS.has(node.type.name)) return false;
    if (node.type.name !== 'heading') return;
    const level = typeof node.attrs.level === 'number' ? node.attrs.level : 1;
    const text = node.textContent.trim();
    const snippet = text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text;
    if (prevLevel > 0 && level > prevLevel + 1) {
      headingIssues.push({
        kind: 'headingHierarchy',
        severity: 'warning',
        message: `Heading level skipped — H${level} follows H${prevLevel}`,
        pos,
        detail: snippet,
      });
    }
    if (level === 1) {
      h1Count += 1;
      if (h1Count > 1) {
        headingIssues.push({
          kind: 'headingHierarchy',
          severity: 'warning',
          message: 'Multiple H1 headings — a document needs one top-level heading',
          pos,
          detail: snippet,
        });
      }
    }
    prevLevel = level;
  });

  return {
    issues: [...altIssues, ...headingIssues, ...contrastIssues],
    skippedRuns,
  };
}
