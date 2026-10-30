import type { JSONContent } from '@tiptap/core';
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  PageBreak,
  PageOrientation,
  Packer,
  Paragraph,
  SimpleField,
  ShadingType,
  Tab,
  TabStopType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType,
  VerticalMergeType,
  WidthType,
} from 'docx';
import { Math as DocxMath, latexToMath } from 'docx/math';
import type { DocxCoreProperties } from '@/lib/document/coreProperties';
import { PAGE_SIZES, type PageSetup } from '@/lib/document/pageSetup';
import type { HeaderFooterSettings } from '@/lib/document/headerFooter';
import type { StyleDefinition, StyleProperties } from '@/lib/styles/types';
import { LEGACY_HEADING_FALLBACK } from '@/lib/styles/builtins';
import { transformText } from '@/lib/styles/resolve';
import type { TextTransform } from '@/lib/styles/types';
import { pxToHalfPoints, pxToTwip, ptToTwip, toPx } from './units';

/**
 * M-DOCX — THE EXPORT MAPPING (#37a). Tensor JSON → the `docx` builders.
 *
 * THE LAW: this file is one direction of the ONE mapping layer; the
 * import side (#38a) is its inverse through the same tables. Every
 * mapping decision is either 1:1 with the model, or a LOUD report
 * entry (never a silent drop — the markdown posture, scaled):
 *
 *  - Skipped + counted: referenceTable containers (their entries are
 *    derived content; the real TOC field lands in #37b), floated
 *    images (exported inline — offset mapping is #37b), equations the
 *    LaTeX→OMML converter can't read (exported as their literal
 *    latex), images in formats Word cannot embed (webp/svg), unknown
 *    node types, missing media.
 *  - Direct: everything else — the case comments carry the receipts.
 *
 * UNITS: content geometry is px → twips (×15) / half-points (×1.5);
 * page geometry is pt → twips (×20); images are px → EMU. All via
 * units.ts — the one seam.
 */

// ─── Word's named highlight palette (w:highlight w:val) — hexes beyond
// this set ride w:shd (run shading), which Word renders identically.
const NAMED_HIGHLIGHTS = {
  FFFF00: 'yellow',
  '00FF00': 'green',
  '00FFFF': 'cyan',
  FF00FF: 'magenta',
  '0000FF': 'blue',
  FF0000: 'red',
  '00008B': 'darkBlue',
  '008B8B': 'darkCyan',
  '006400': 'darkGreen',
  '8B008B': 'darkMagenta',
  '8B0000': 'darkRed',
  '808000': 'darkYellow',
  '808080': 'darkGray',
  C0C0C0: 'lightGray',
} as const;
type WordHighlightName = (typeof NAMED_HIGHLIGHTS)[keyof typeof NAMED_HIGHLIGHTS];

/** Tensor list style types (CSS spellings) → OOXML numFmt + lvlText. */
const LIST_FORMATS: Record<string, { format: (typeof LevelFormat)[keyof typeof LevelFormat]; text: string }> = {
  disc: { format: LevelFormat.BULLET, text: '•' },
  circle: { format: LevelFormat.BULLET, text: '○' },
  square: { format: LevelFormat.BULLET, text: '▪' },
  decimal: { format: LevelFormat.DECIMAL, text: '%1.' },
  'lower-roman': { format: LevelFormat.LOWER_ROMAN, text: '%1.' },
  'upper-roman': { format: LevelFormat.UPPER_ROMAN, text: '%1.' },
  'lower-alpha': { format: LevelFormat.LOWER_LETTER, text: '%1.' },
  'upper-alpha': { format: LevelFormat.UPPER_LETTER, text: '%1.' },
};
const FALLBACK_LIST_FORMAT = LIST_FORMATS.decimal!;

/** Word styleId spellings for the Tensor builtin tiers. */
const HEADING_WORD_IDS: Record<number, string> = {
  1: 'Heading1', 2: 'Heading2', 3: 'Heading3',
  4: 'Heading4', 5: 'Heading5', 6: 'Heading6',
};

/** Tensor styleId → the Word styleId the export emits/references.
 *  Custom ids get the Tensor- prefix so they can never collide with
 *  Word's builtin styles ('caption'/'quote' exist on the Word side). */
function wordStyleId(id: string): string {
  const heading = /^heading-([1-6])$/.exec(id);
  if (heading) return HEADING_WORD_IDS[Number(heading[1])]!;
  if (id === 'normal') return 'Normal';
  return `Tensor-${id}`;
}

export interface DocxExportMedia {
  bytes: Uint8Array;
  ext: string;
}

export interface DocxExportInput {
  json: JSONContent;
  pageSetup: PageSetup;
  headerFooter: HeaderFooterSettings | null;
  coreProperties: DocxCoreProperties;
  /** The RESOLVED registry (code+global+doc merged) — the styles the
   *  document's styleIds reference. */
  styleDefinitions: StyleDefinition[];
  /** The config-derived base (what 'normal' falls through to). */
  baseStyle: { fontFamily: string; fontSize: number };
  media: Map<string, DocxExportMedia>;
}

export interface DocxExportReport {
  equationsAsText: number;
  floatedImagesInline: number;
  missingImages: number;
  unsupportedImages: number;
  unknownListStyles: number;
  unknownNodes: Record<string, number>;
}

export function docxReportLines(report: DocxExportReport): string[] {
  const lines: string[] = [];
  if (report.equationsAsText > 0) {
    lines.push(`Equations exported as plain text (${report.equationsAsText}) — the converter could not read the LaTeX`);
  }
  if (report.floatedImagesInline > 0) {
    lines.push(`Floating images exported inline (${report.floatedImagesInline})`);
  }
  if (report.missingImages > 0) {
    lines.push(`Missing images left as placeholders (${report.missingImages})`);
  }
  if (report.unsupportedImages > 0) {
    lines.push(`Images Word cannot embed (${report.unsupportedImages}) — webp/svg formats`);
  }
  if (report.unknownListStyles > 0) {
    lines.push(`List numbering styles mapped to decimal (${report.unknownListStyles})`);
  }
  const unknown = Object.entries(report.unknownNodes);
  if (unknown.length > 0) {
    lines.push(`Unsupported content: ${unknown.map(([type, n]) => `${type} (${n})`).join(', ')}`);
  }
  return lines;
}

interface WalkState {
  report: DocxExportReport;
  media: Map<string, DocxExportMedia>;
  defs: Map<string, StyleDefinition>;
  /** Per-reference instance counters — each top-level list restarts. */
  instances: { next: (reference: string) => number };
  /** THE NUMBERING REDESIGN: one abstractNum per top-level list
   *  instance, whose LEVELS carry the formats of the actual nesting
   *  (level 0 = the list's own style, level 1 = a nested list's style,
   *  …). Word derives list nesting from ilvl, so mixed nesting (a
   *  roman list inside a bullet list) needs per-level formats — six
   *  identical levels cannot express it, and a separate numId per
   *  nested list would render flat. */
  numberingLevels: Map<string, (string | undefined)[]>;
  listIds: { next: number };
  /** A TOC field was emitted — Document features.updateFields makes
   *  Word refresh fields on open. */
  needsUpdateFields: boolean;
}

/** Record a nesting level's format on the reference (idempotent per
 *  walk — the first writer wins, matching the document's first use). */
function registerLevel(state: WalkState, reference: string, level: number, styleType: string): void {
  const levels = state.numberingLevels.get(reference) ?? [];
  if (levels[level] == null) levels[level] = styleType;
  state.numberingLevels.set(reference, levels);
}

// ─── Style helpers ───────────────────────────────────────────────────────

function toAlignment(align: string | undefined): (typeof AlignmentType)[keyof typeof AlignmentType] | undefined {
  switch (align) {
    case 'left': return AlignmentType.LEFT;
    case 'center': return AlignmentType.CENTER;
    case 'right': return AlignmentType.RIGHT;
    case 'justify': return AlignmentType.JUSTIFIED;
    default: return undefined;
  }
}

interface RunProps {
  font?: string;
  size?: number;
  bold?: boolean;
  italics?: boolean;
  underline?: { type: (typeof UnderlineType)[keyof typeof UnderlineType] };
  strike?: boolean;
  color?: string;
  smallCaps?: boolean;
}

function styleRunProps(props: StyleProperties): RunProps {
  const out: RunProps = {};
  if (props.fontFamily) out.font = props.fontFamily;
  const sizePx = toPx(props.fontSize);
  if (sizePx != null) out.size = pxToHalfPoints(sizePx);
  if (props.bold) out.bold = true;
  if (props.italic) out.italics = true;
  if (props.underline) out.underline = { type: UnderlineType.SINGLE };
  if (props.strike) out.strike = true;
  if (props.color) out.color = props.color.replace('#', '').toUpperCase();
  if (props.fontVariant === 'small-caps') out.smallCaps = true;
  return out;
}

// ─── Run mapping ─────────────────────────────────────────────────────────

interface RunFormat extends RunProps {
  highlight?: WordHighlightName;
  shading?: { type: typeof ShadingType.CLEAR; fill: string };
  style?: string;
  /** The charStyle's textTransform (applies to the run's own text). */
  transform?: TextTransform;
}

function applyMark(format: RunFormat, mark: JSONContent, state: WalkState): void {
  switch (mark.type) {
    case 'bold': format.bold = true; break;
    case 'italic': format.italics = true; break;
    case 'strike': format.strike = true; break;
    case 'code': format.font = 'Courier New'; break;
    case 'underline': format.underline = { type: UnderlineType.SINGLE }; break;
    case 'link': break; // handled by the link grouper
    case 'highlight': {
      const hex = String((mark.attrs as { color?: string } | null)?.color ?? '').replace('#', '').toUpperCase();
      const named = (NAMED_HIGHLIGHTS as Record<string, WordHighlightName | undefined>)[hex];
      if (named) format.highlight = named;
      else format.shading = { type: ShadingType.CLEAR, fill: hex || 'FFFF00' };
      break;
    }
    case 'textStyle': {
      const attrs = (mark.attrs ?? {}) as { color?: string; fontFamily?: string; fontSize?: number };
      if (attrs.color) format.color = attrs.color.replace('#', '').toUpperCase();
      if (attrs.fontFamily) format.font = attrs.fontFamily;
      const markSize = toPx(attrs.fontSize);
      if (markSize != null) format.size = pxToHalfPoints(markSize);
      break;
    }
    case 'charStyle': {
      const id = String((mark.attrs as { styleId?: string } | null)?.styleId ?? '');
      const def = id ? state.defs.get(id) : undefined;
      if (def) {
        format.style = wordStyleId(id);
        if (def.properties.textTransform && def.properties.textTransform !== 'none') {
          format.transform = def.properties.textTransform;
        }
      }
      break;
    }
    default: break; // invisible/structural marks (indexEntry, refLeader, spell)
  }
}

/** THE TAB LAW (the Word-for-Web lesson): tabs split the text into
 *  SEPARATE RUNS with a w:tab run between — one run mixing t/tab/t
 *  would round-trip through any grouped XML reading with the pieces
 *  REORDERED (document order is content). The format carries to every
 *  piece. Returns a single-element array for tab-free text. */
function mapTextRuns(node: JSONContent, state: WalkState, opts: RunOpts = {}): TextRun[] {
  const format: RunFormat = {};
  let text = typeof node.text === 'string' ? node.text : '';
  for (const mark of node.marks ?? []) {
    if (opts.skipLinkMark && mark.type === 'link') continue;
    applyMark(format, mark, state);
  }
  // TEXT TRANSFORMS ride the text (Word has no paragraph transform):
  // the paragraph style's, then the charStyle's — the last one wins,
  // matching how the resolver layers them.
  const transforms: TextTransform[] = [];
  if (opts.paragraphStyle?.textTransform && opts.paragraphStyle.textTransform !== 'none') {
    transforms.push(opts.paragraphStyle.textTransform);
  }
  if (format.transform && format.transform !== 'none') transforms.push(format.transform);
  const effective = transforms[transforms.length - 1];
  if (effective) text = transformText(text, effective);
  // NO paragraph-style cascade here: the Word STYLE carries the style
  // properties (inlining them onto runs is redundant and pollutes the
  // round-trip — the imported run would carry marks the source never
  // had). Direct marks ride alone; the style does the rest.
  const pieces = text.split('\t');
  return pieces.map((piece, index) => {
    if (index === 0) return piece === '' ? new TextRun({}) : new TextRun({ text: piece, ...runFormatOpts(format) });
    const tabRun = new TextRun({ children: [new Tab()], ...runFormatOpts(format) });
    return piece === '' ? tabRun : [tabRun, new TextRun({ text: piece, ...runFormatOpts(format) })];
  }).flat();
}

/** The RunFormat → TextRun options bag (minus text/children). */
function runFormatOpts(format: RunFormat): object {
  return {
    bold: format.bold,
    italics: format.italics,
    strike: format.strike,
    underline: format.underline,
    color: format.color,
    font: format.font,
    size: format.size,
    highlight: format.highlight,
    shading: format.shading,
    smallCaps: format.smallCaps,
    style: format.style,
  };
}

interface RunOpts {
  /** The resolved paragraph style's cascade (fills gaps below marks). */
  paragraphStyle?: StyleProperties;
  skipLinkMark?: boolean;
}

type InlineChild = TextRun | ImageRun | ExternalHyperlink;

/** Consecutive link-marked texts group into ONE ExternalHyperlink —
 *  the OOXML hyperlink is a run CONTAINER, not a mark. */
function mapInlineContent(nodes: JSONContent[], state: WalkState, paragraphStyle?: StyleProperties): InlineChild[] {
  const out: InlineChild[] = [];
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i]!;
    const linkMark = node.type === 'text' ? node.marks?.find((m) => m.type === 'link') : undefined;
    if (linkMark) {
      const href = String((linkMark.attrs as { href?: string } | null)?.href ?? '');
      const group: JSONContent[] = [];
      let j = i;
      while (j < nodes.length) {
        const next = nodes[j]!;
        const nextLink = next.type === 'text' ? next.marks?.find((m) => m.type === 'link') : undefined;
        if (nextLink && String((nextLink.attrs as { href?: string } | null)?.href ?? '') === href) {
          group.push(next);
          j += 1;
        } else break;
      }
      out.push(new ExternalHyperlink({
        link: href,
        children: group.flatMap((n) => mapTextRuns(n, state, { paragraphStyle, skipLinkMark: true })),
      }));
      i = j;
      continue;
    }
    if (node.type === 'text') {
      out.push(...mapTextRuns(node, state, { paragraphStyle }));
    } else if (node.type === 'inlineImage') {
      out.push(mapImageRun(node, state));
    } else if (node.type === 'hardBreak') {
      // OOXML's line break rides a run with break-before (w:br).
      out.push(new TextRun({ break: 1 }));
    } else {
      state.report.unknownNodes[node.type ?? 'unknown'] = (state.report.unknownNodes[node.type ?? 'unknown'] ?? 0) + 1;
    }
    i += 1;
  }
  return out;
}

function mapImageRun(node: JSONContent, state: WalkState): TextRun | ImageRun {
  const attrs = (node.attrs ?? {}) as { src?: string; width?: number | null; height?: number | null; alt?: string; float?: unknown };
  const id = typeof attrs.src === 'string' ? attrs.src.replace(/^media:\/\//, '') : '';
  const entry = state.media.get(id);
  if (!entry) {
    state.report.missingImages += 1;
    return new TextRun({ text: '[missing image]', italics: true });
  }
  const type = imageType(entry.ext);
  const width = toPx(attrs.width);
  const height = toPx(attrs.height);
  if (!type || width == null || height == null || width <= 0 || height <= 0) {
    state.report.unsupportedImages += 1;
    return new TextRun({ text: '[image not embeddable]', italics: true });
  }
  if (attrs.float != null) {
    // Floated images ride #37b (offset mapping) — inline for now, LOUD.
    state.report.floatedImagesInline += 1;
  }
  return new ImageRun({
    type,
    data: entry.bytes,
    transformation: { width: Math.round(width), height: Math.round(height) },
    altText: { title: attrs.alt || 'image', description: attrs.alt || 'image', name: attrs.alt || 'image' },
  });
}

function imageType(ext: string): 'png' | 'jpg' | 'gif' | 'bmp' | null {
  switch (ext.toLowerCase()) {
    case 'png': return 'png';
    case 'jpg': case 'jpeg': return 'jpg';
    case 'gif': return 'gif';
    case 'bmp': return 'bmp';
    default: return null; // svg/webp — Word's own writer never embeds them inline
  }
}

// ─── Paragraph options (the ONE path both constructors share) ───────────

interface ParagraphOptionsBag {
  paragraphStyle?: StyleProperties;
  options: {
    heading?: (typeof HeadingLevel)[keyof typeof HeadingLevel];
    style?: string;
    alignment?: (typeof AlignmentType)[keyof typeof AlignmentType];
    spacing?: { before?: number; after?: number; line?: number; lineRule?: 'auto' | 'atLeast' };
    indent?: { left?: number; right?: number; firstLine?: number; hanging?: number };
    tabStops?: { type: (typeof TabStopType)[keyof typeof TabStopType]; position: number }[];
  };
}

/** The spacing bag (px attrs → OOXML): before/after in twips; the line
 *  height rides `line` — a px spelling becomes an atLeast height, a
 *  unitless multiplier becomes 240ths-of-a-line with rule `auto`. */
function paragraphSpacing(attrs: Record<string, unknown> | undefined): { before?: number; after?: number; line?: number; lineRule?: 'auto' | 'atLeast' } {
  const spacing: { before?: number; after?: number; line?: number; lineRule?: 'auto' | 'atLeast' } = {};
  const before = toPx(attrs?.spaceBefore);
  if (before != null) spacing.before = pxToTwip(before);
  const after = toPx(attrs?.spaceAfter);
  if (after != null) spacing.after = pxToTwip(after);
  const lh = attrs?.lineHeight;
  if (typeof lh === 'string' && lh.trim()) {
    if (lh.trim().endsWith('px')) {
      spacing.line = pxToTwip(parseFloat(lh));
      spacing.lineRule = 'atLeast';
    } else {
      const mult = parseFloat(lh);
      if (Number.isFinite(mult) && mult > 0) {
        spacing.line = Math.round(mult * 240);
        spacing.lineRule = 'auto';
      }
    }
  }
  return spacing;
}

function paragraphOptions(node: JSONContent, state: WalkState): ParagraphOptionsBag {
  const attrs = (node.attrs ?? {}) as Record<string, unknown>;
  const isHeading = node.type === 'heading';
  const styleId = typeof attrs.styleId === 'string' ? attrs.styleId : isHeading ? `heading-${attrs.level ?? 1}` : 'normal';
  const def = state.defs.get(styleId);
  const paragraphStyle = def?.properties;

  const headingLevel = isHeading
    ? ([undefined, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6][Number(attrs.level ?? 1)] ?? HeadingLevel.HEADING_1)
    : undefined;

  const spacing = paragraphSpacing(attrs);

  const firstLine = toPx(attrs.firstLineIndent);
  const indent: ParagraphOptionsBag['options']['indent'] = {};
  const indentLeft = toPx(attrs.indentLeft);
  if (indentLeft != null) indent.left = pxToTwip(indentLeft);
  const indentRight = toPx(attrs.indentRight);
  if (indentRight != null) indent.right = pxToTwip(indentRight);
  // Negative firstLineIndent IS a hanging indent in OOXML terms.
  if (firstLine != null && firstLine > 0) indent.firstLine = pxToTwip(firstLine);
  if (firstLine != null && firstLine < 0) indent.hanging = pxToTwip(-firstLine);

  const tabStops = Array.isArray(attrs.tabStops)
    ? (attrs.tabStops as { position: number | string; alignment: string }[])
        .map((stop) => ({ stop, position: toPx(stop.position) }))
        .filter((entry): entry is { stop: { position: number | string; alignment: string }; position: number } => entry.position != null)
        .map(({ stop, position }) => ({
          type: stop.alignment === 'center' ? TabStopType.CENTER : stop.alignment === 'right' ? TabStopType.RIGHT : TabStopType.LEFT,
          position: pxToTwip(position),
        }))
    : undefined;

  const options: ParagraphOptionsBag['options'] = {
    heading: headingLevel,
    style: !isHeading && styleId !== 'normal' ? wordStyleId(styleId) : undefined,
    alignment: toAlignment(typeof attrs.textAlign === 'string' ? attrs.textAlign : paragraphStyle?.textAlign),
    ...(Object.keys(spacing).length ? { spacing } : {}),
    ...(Object.keys(indent).length ? { indent } : {}),
    ...(tabStops ? { tabStops } : {}),
  };
  return { paragraphStyle, options };
}

function mapParagraph(node: JSONContent, state: WalkState): Paragraph {
  const { paragraphStyle, options } = paragraphOptions(node, state);
  return new Paragraph({ ...options, children: mapInlineContent(node.content ?? [], state, paragraphStyle) });
}

/** THE HEADING paragraph option: the level rides the options bag (used
 *  by mapParagraph via paragraphOptions) — the heading's TEXT rides
 *  like any paragraph's (content never drops). */

// ─── Lists ───────────────────────────────────────────────────────────────

function listReference(styleType: string): string {
  return `t-list-${styleType.replace(/[^a-z0-9]/gi, '-')}`;
}
void listReference;

/** PM lists nest as list(listItem(paragraph, list…)). Every list — top
 *  or nested — maps its ITEMS onto the TOP-LEVEL list's numbering
 *  instance at its nesting depth (Word derives nesting from ilvl); a
 *  nested list registers its OWN format at that level. Numbering
 *  restarts where Tensor's does because each top-level list is a fresh
 *  reference+instance. */
function mapList(node: JSONContent, level: number, reference: string, instance: number, state: WalkState): Paragraph[] {
  const out: Paragraph[] = [];
  for (const item of node.content ?? []) {
    if (item.type !== 'listItem') continue;
    for (const child of item.content ?? []) {
      if (child.type === 'paragraph' || child.type === 'heading') {
        const { paragraphStyle, options } = paragraphOptions(child, state);
        out.push(new Paragraph({
          ...options,
          numbering: { reference, level, instance },
          children: mapInlineContent(child.content ?? [], state, paragraphStyle),
        }));
      } else if (child.type === 'bulletList' || child.type === 'orderedList') {
        const childStyle = String((child.attrs as { listStyleType?: string } | null)?.listStyleType ?? (child.type === 'orderedList' ? 'decimal' : 'disc'));
        registerLevel(state, reference, level + 1, childStyle);
        out.push(...mapList(child, level + 1, reference, instance, state));
      } else {
        state.report.unknownNodes[child.type ?? 'unknown'] = (state.report.unknownNodes[child.type ?? 'unknown'] ?? 0) + 1;
      }
    }
  }
  return out;
}

function numberingConfigs(state: WalkState): { reference: string; levels: object[] }[] {
  const configs: { reference: string; levels: object[] }[] = [];
  for (const [reference, levelStyles] of state.numberingLevels) {
    const levels = Array.from({ length: 6 }, (_, level) => {
      const styleType = levelStyles[level] ?? 'decimal';
      const spec = LIST_FORMATS[styleType] ?? FALLBACK_LIST_FORMAT;
      if (!LIST_FORMATS[styleType]) state.report.unknownListStyles += 1;
      return {
        level,
        format: spec.format,
        text: spec.text.replace('%1', `%${level + 1}`),
        alignment: AlignmentType.LEFT,
      };
    });
    configs.push({ reference, levels });
  }
  return configs;
}

// ─── Tables ──────────────────────────────────────────────────────────────

function tableBorders(style: string | undefined): object {
  const none = { style: BorderStyle.NONE, size: 0, color: 'auto' };
  const single = { style: BorderStyle.SINGLE, size: 4, color: 'auto' };
  switch (style) {
    case 'none':
      return { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none };
    case 'outer':
      return { top: single, bottom: single, left: single, right: single, insideHorizontal: none, insideVertical: none };
    default: // 'all'
      return { top: single, bottom: single, left: single, right: single, insideHorizontal: single, insideVertical: single };
  }
}

function mapTable(node: JSONContent, state: WalkState): Table {
  const attrs = (node.attrs ?? {}) as Record<string, unknown>;
  const rows = (node.content ?? []).filter((r) => r.type === 'tableRow');

  // The grid: total columns = the widest row's span sum; column widths
  // come from the first row carrying colwidth arrays (px → twips).
  let totalCols = 0;
  let gridWidths: number[] | null = null;
  for (const row of rows) {
    const cells = row.content ?? [];
    let sum = 0;
    const widths: number[] = [];
    let carried = true;
    for (const cell of cells) {
      const span = Number((cell.attrs as { colspan?: number } | null)?.colspan ?? 1);
      sum += span;
      const cw = (cell.attrs as { colwidth?: (number | string | null)[] | null } | null)?.colwidth;
      if (Array.isArray(cw) && cw.length) {
        widths.push(...cw.map((w) => { const px = toPx(w); return px == null ? 0 : pxToTwip(px); }));
      } else { carried = false; for (let k = 0; k < span; k++) widths.push(0); }
    }
    if (sum > totalCols) totalCols = sum;
    if (gridWidths === null && carried && widths.length) gridWidths = widths;
  }

  // The vMerge grid: Tensor rows carry ORIGIN cells only (prosemirror-
  // tables semantics) — the CONTINUATION cells Word requires are
  // SYNTHESIZED here, interleaved in column order with the real cells.
  const openSpans = new Map<number, number>();
  const docxRows = rows.map((row) => {
    const cells = row.content ?? [];
    const built: TableCell[] = [];
    let col = 0;
    let i = 0;
    while (i < cells.length || col < totalCols) {
      const open = openSpans.get(col) ?? 0;
      if (open > 0) {
        openSpans.set(col, open - 1);
        built.push(new TableCell({ verticalMerge: VerticalMergeType.CONTINUE, children: [new Paragraph('')] }));
        col += 1;
        continue;
      }
      const cell = cells[i];
      if (!cell) { col += 1; continue; }
      const cellAttrs = (cell.attrs ?? {}) as Record<string, unknown>;
      const colspan = Number(cellAttrs.colspan ?? 1);
      const rowspan = Number(cellAttrs.rowspan ?? 1);
      if (rowspan > 1) openSpans.set(col, rowspan - 1);
      built.push(mapCell(cell, state));
      col += colspan;
      i += 1;
    }
    // A leading all-header row repeats across page breaks (Word's own
    // table convention, and what Tensor's tableHeader cells mean).
    const allHeader = cells.length > 0 && cells.every((c) => c.type === 'tableHeader');
    return new TableRow({ children: built, tableHeader: allHeader });
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE }, // the lib emits pct in fiftieths
    borders: tableBorders(typeof attrs.borderStyle === 'string' ? attrs.borderStyle : 'all') as never,
    columnWidths: gridWidths?.some((w) => w > 0) ? gridWidths : undefined,
    alignment: attrs.align === 'center' ? AlignmentType.CENTER : attrs.align === 'right' ? AlignmentType.RIGHT : undefined,
    rows: docxRows,
  });
}

function mapCell(node: JSONContent, state: WalkState): TableCell {
  const attrs = (node.attrs ?? {}) as Record<string, unknown>;
  const colspan = Number(attrs.colspan ?? 1);
  const rowspan = Number(attrs.rowspan ?? 1);
  const shading = attrs.backgroundColor
    ? { type: ShadingType.CLEAR, fill: String(attrs.backgroundColor).replace('#', '').toUpperCase() }
    : undefined;
  const padding = (attrs.padding ?? null) as { top?: number; bottom?: number; left?: number; right?: number } | null;
  const margins = padding
    ? {
        ...(toPx(padding.top) != null ? { top: pxToTwip(toPx(padding.top)!) } : {}),
        ...(toPx(padding.bottom) != null ? { bottom: pxToTwip(toPx(padding.bottom)!) } : {}),
        ...(toPx(padding.left) != null ? { left: pxToTwip(toPx(padding.left)!) } : {}),
        ...(toPx(padding.right) != null ? { right: pxToTwip(toPx(padding.right)!) } : {}),
      }
    : undefined;
  return new TableCell({
    ...(colspan > 1 ? { columnSpan: colspan } : {}),
    ...(rowspan > 1 ? { verticalMerge: VerticalMergeType.RESTART } : {}),
    ...(shading ? { shading } : {}),
    ...(margins && Object.keys(margins).length ? { margins } : {}),
    children: mapBlocks(node.content ?? [], state),
  });
}

// ─── The block walker ────────────────────────────────────────────────────

function mapBlocks(nodes: JSONContent[], state: WalkState): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'paragraph':
      case 'heading':
        out.push(mapParagraph(node, state));
        break;
      case 'bulletList':
      case 'orderedList': {
        const styleType = String((node.attrs as { listStyleType?: string } | null)?.listStyleType ?? (node.type === 'orderedList' ? 'decimal' : 'disc'));
        const reference = `t-list-${state.listIds.next++}`;
        registerLevel(state, reference, 0, styleType);
        const instance = state.instances.next(reference);
        out.push(...mapList(node, 0, reference, instance, state));
        break;
      }
      case 'table':
        out.push(mapTable(node, state));
        break;
      case 'image': {
        // A block image is its own paragraph; align rides jc; the
        // keepNext bond (caption below) rides keepNext. A placeholder
        // (missing/unsupported — already counted in the report) still
        // EMITS, so the image's position stays visible in Word.
        const attrs = (node.attrs ?? {}) as { align?: string; keepNext?: boolean };
        const run = mapImageRun(node, state);
        out.push(new Paragraph({
          alignment: toAlignment(attrs.align),
          keepNext: attrs.keepNext === true || undefined,
          children: [run],
        }));
        break;
      }
      case 'equation': {
        const latex = String((node.attrs as { latex?: string } | null)?.latex ?? '');
        try {
          out.push(new Paragraph({ children: [new DocxMath({ children: latexToMath(latex) })] }));
        } catch {
          state.report.equationsAsText += 1;
          out.push(new Paragraph({ children: [new TextRun({ text: latex, italics: true })] }));
        }
        break;
      }
      case 'pageBreak':
        out.push(new Paragraph({ children: [new PageBreak()] }));
        break;
      case 'horizontalRule':
        // Word's own horizontal-line spelling: an empty paragraph whose
        // bottom border draws the rule.
        out.push(new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'auto', space: 1 } },
          children: [],
        }));
        break;
      case 'headerBlock':
      case 'footerBlock':
        break; // bands are collected by buildDocx, never body flow
      case 'referenceTable': {
        // THE TOC FIELD (the round-trip closes): a Tensor referenceTable
        // exports as Word's OWN TOC field — the entries are derived
        // content (Tensor's generator owns them Tensor-side; Word owns
        // them Word-side), so the field carries an instruction and
        // Word refreshes it on open (updateFields). The in-place save
        // loop then never loses a ToC.
        const refAttrs = (node.attrs ?? {}) as { kind?: string; depth?: number };
        const depth = Math.min(6, Math.max(1, Number(refAttrs.depth ?? 3)));
        state.needsUpdateFields = true;
        out.push(new Paragraph({
          children: [new SimpleField(`TOC \\o "1-${depth}"`, 'Right-click this field and choose Update Field to build the table of contents.')],
        }));
        break;
      }
      default:
        state.report.unknownNodes[node.type ?? 'unknown'] = (state.report.unknownNodes[node.type ?? 'unknown'] ?? 0) + 1;
        break;
    }
  }
  return out;
}

/** Per-build instance counters — a fresh counter per export (module
 *  state would leak across documents). */
function makeInstanceCounter(): { next: (reference: string) => number } {
  const counters = new Map<string, number>();
  return {
    next: (reference) => {
      const next = (counters.get(reference) ?? 0) + 1;
      counters.set(reference, next);
      return next;
    },
  };
}


// ─── Bands → header/footer parts ─────────────────────────────────────────

interface Bands {
  headerDefault: JSONContent[];
  headerFirst: JSONContent[];
  footerDefault: JSONContent[];
  footerFirst: JSONContent[];
}

function collectBands(nodes: JSONContent[]): Bands {
  const bands: Bands = { headerDefault: [], headerFirst: [], footerDefault: [], footerFirst: [] };
  for (const node of nodes) {
    const variant = (node.attrs as { variant?: string } | null)?.variant === 'first' ? 'first' : 'default';
    if (node.type === 'headerBlock') {
      if (variant === 'first') bands.headerFirst = node.content ?? [];
      else bands.headerDefault = node.content ?? [];
    } else if (node.type === 'footerBlock') {
      if (variant === 'first') bands.footerFirst = node.content ?? [];
      else bands.footerDefault = node.content ?? [];
    }
  }
  return bands;
}

function bandToPart(children: JSONContent[], kind: 'header' | 'footer', state: WalkState): Header | Footer | undefined {
  const blocks = mapBlocks(children, state);
  if (!blocks.length) return undefined;
  return kind === 'header' ? new Header({ children: blocks }) : new Footer({ children: blocks });
}

// ─── The styles config ───────────────────────────────────────────────────

function styleParagraphProps(props: StyleProperties | undefined): object {
  if (!props) return {};
  const spacing = paragraphSpacing({
    spaceBefore: props.spaceBefore,
    spaceAfter: props.spaceAfter,
    lineHeight: props.lineHeight != null ? String(props.lineHeight) : undefined,
  });
  const left = toPx(props.indentLeft);
  const right = toPx(props.indentRight);
  const firstLine = toPx(props.firstLineIndent);
  const indent = {
    ...(left != null ? { left: pxToTwip(left) } : {}),
    ...(right != null ? { right: pxToTwip(right) } : {}),
    ...(firstLine != null && firstLine > 0 ? { firstLine: pxToTwip(firstLine) } : {}),
    ...(firstLine != null && firstLine < 0 ? { hanging: pxToTwip(-firstLine) } : {}),
  };
  return {
    ...(props.textAlign ? { alignment: toAlignment(props.textAlign) } : {}),
    ...(Object.keys(spacing).length ? { spacing } : {}),
    ...(Object.keys(indent).length ? { indent } : {}),
  };
}

/** paragraphSpacing is defined below on the paragraph-options path —
 *  hoisted reference via function declaration (it is). */
function buildStylesConfig(input: DocxExportInput, defs: Map<string, StyleDefinition>): object {
  const normal = defs.get('normal')?.properties;
  const baseRun = {
    font: normal?.fontFamily ?? input.baseStyle.fontFamily,
    size: pxToHalfPoints(normal?.fontSize ?? input.baseStyle.fontSize),
  };

  const heading = (level: number): object => {
    const props = defs.get(`heading-${level}`)?.properties
      ?? LEGACY_HEADING_FALLBACK[`heading-${level}`]
      ?? { bold: true };
    return {
      run: { ...styleRunProps(props), bold: props.bold ?? true },
      paragraph: { ...styleParagraphProps(props), keepNext: true, keepLines: true },
    };
  };

  const paragraphStyles: object[] = [];
  const characterStyles: object[] = [];
  for (const def of input.styleDefinitions) {
    if (def.id === 'normal' || /^heading-[1-6]$/.test(def.id)) continue;
    if (def.kind === 'paragraph') {
      paragraphStyles.push({
        id: wordStyleId(def.id),
        name: def.name,
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: styleRunProps(def.properties),
        paragraph: styleParagraphProps(def.properties),
      });
    } else {
      characterStyles.push({
        id: wordStyleId(def.id),
        name: def.name,
        basedOn: 'DefaultParagraphFont',
        quickFormat: true,
        run: styleRunProps(def.properties),
      });
    }
  }

  return {
    default: {
      document: { run: baseRun },
      heading1: heading(1),
      heading2: heading(2),
      heading3: heading(3),
      heading4: heading(4),
      heading5: heading(5),
      heading6: heading(6),
    },
    paragraphStyles,
    characterStyles,
  };
}

// ─── Page geometry ───────────────────────────────────────────────────────

function pageDims(pageSetup: PageSetup): { width: number; height: number; orientation?: typeof PageOrientation.LANDSCAPE } {
  let widthPt: number;
  let heightPt: number;
  if (pageSetup.pageSize === 'custom' && pageSetup.customWidth != null && pageSetup.customHeight != null) {
    widthPt = pageSetup.customWidth;
    heightPt = pageSetup.customHeight;
  } else {
    const base = PAGE_SIZES[pageSetup.pageSize] ?? PAGE_SIZES.Letter!;
    widthPt = base.width;
    heightPt = base.height;
  }
  const landscape = pageSetup.orientation === 'landscape';
  // NO manual swap: the docx lib flips width/height itself when the
  // orientation is landscape (verified in the test run — passing
  // pre-swapped dims got flipped BACK to portrait geometry).
  return {
    width: ptToTwip(widthPt),
    height: ptToTwip(heightPt),
    orientation: landscape ? PageOrientation.LANDSCAPE : undefined,
  };
}

// ─── The assembler ───────────────────────────────────────────────────────

export async function buildDocx(input: DocxExportInput): Promise<{ bytes: Uint8Array; report: DocxExportReport }> {
  const state: WalkState = {
    report: { equationsAsText: 0, floatedImagesInline: 0, missingImages: 0, unsupportedImages: 0, unknownListStyles: 0, unknownNodes: {} },
    media: input.media,
    defs: new Map(input.styleDefinitions.map((d) => [d.id, d])),
    instances: makeInstanceCounter(),
    numberingLevels: new Map(),
    listIds: { next: 1 },
    needsUpdateFields: false,
  };

  const bands = collectBands(input.json.content ?? []);
  const body = mapBlocks(input.json.content ?? [], state);

  const { width, height, orientation } = pageDims(input.pageSetup);
  const differentFirst = input.headerFooter?.differentFirstPage === true;

  const headerDefault = bandToPart(bands.headerDefault, 'header', state);
  const headerFirst = differentFirst ? bandToPart(bands.headerFirst, 'header', state) ?? new Header({ children: [] }) : undefined;
  const footerDefault = bandToPart(bands.footerDefault, 'footer', state);
  const footerFirst = differentFirst ? bandToPart(bands.footerFirst, 'footer', state) ?? new Footer({ children: [] }) : undefined;

  const doc = new Document({
    ...input.coreProperties,
    ...(input.pageSetup.pageColor ? { background: { color: input.pageSetup.pageColor.replace('#', '').toUpperCase() } } : {}),
    ...(state.needsUpdateFields ? { features: { updateFields: true } } : {}),
    styles: buildStylesConfig(input, state.defs) as never,
    numbering: { config: numberingConfigs(state) as never },
    sections: [
      {
        properties: {
          page: {
            size: { width, height, orientation },
            margin: {
              top: ptToTwip(input.pageSetup.margins.top),
              bottom: ptToTwip(input.pageSetup.margins.bottom),
              left: ptToTwip(input.pageSetup.margins.left),
              right: ptToTwip(input.pageSetup.margins.right),
            },
          },
          titlePage: differentFirst || undefined,
        },
        headers: {
          ...(headerDefault ? { default: headerDefault } : {}),
          ...(headerFirst ? { first: headerFirst } : {}),
        },
        footers: {
          ...(footerDefault ? { default: footerDefault } : {}),
          ...(footerFirst ? { first: footerFirst } : {}),
        },
        children: body,
      },
    ],
  });

  // The webview path: toBlob (toBuffer is Node-only — the spike lesson).
  const blob = await Packer.toBlob(doc);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), report: state.report };
}
