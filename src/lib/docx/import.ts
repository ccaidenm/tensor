import type { JSONContent } from '@tiptap/core';
import { findMatchingPreset, type PageSetup } from '@/lib/document/pageSetup';
import { defaultHeaderFooterSettings, type HeaderFooterSettings } from '@/lib/document/headerFooter';
import type { LineNumbersSetting } from '@/lib/document/schema';
import type { DocumentCoreProperties } from '@/lib/document/coreProperties';
import type { StyleDefinition, StyleProperties } from '@/lib/styles/types';
import { BUNDLED_FONTS } from '@/lib/fonts/bundled';
import { ommlToLatex } from './omml';
import { emuToPx, halfPointsToPx, twipToPx } from './units';
import { oKids, oSub, oat, oflag, onum, ovalNum, parseOrdered, type ONode } from './oxml';

/**
 * M-DOCX — THE IMPORT MAPPING (#38a). OOXML → Tensor JSON — the inverse
 * of export.ts through the same semantic tables.
 *
 * THE PARSER LAW: document.xml is parsed with preserveOrder into the
 * ONode model — ORDER IS CONTENT in a word processor (fast-xml-parser's
 * default mode GROUPS same-named children, which reordered paragraphs
 * and tables and scrambled tab sequences in the first gate run; the
 * grouped shape is fundamentally wrong for body XML). styles.xml,
 * numbering.xml and core.xml use the same ONode model for one set of
 * traversal helpers.
 *
 * THE LOUD POSTURE, import-side: Word content Tensor cannot model is
 * counted, never silently dropped (the report surfaces as the open
 * path's notice): tracked deletions are ACCEPTED (standard), comments
 * skipped, footnote/endnote references skipped (the feature is M3),
 * TOC fields import as their cached static text, PAGE-family fields
 * are dropped (ruling 5), webp/emf/wmf images refused, inline
 * equations dropped (Tensor's equations are display-only), even/odd
 * headers collapsed, section breaks collapsed to one (#57).
 *
 * FONTS (ruling 4): the flow collects the families the file references,
 * and anything outside Tensor's bundled catalog is offered to the user
 * — keep original names (render falls back; Word round-trips true) or
 * substitute bundled families. The policy rewrites rFonts values at
 * map time; it never touches anything else.
 */

// ─── The Word styleId → Tensor styleId spelling (the export's inverse) ──

function tensorStyleId(wordId: string): string {
  if (wordId.startsWith('Tensor-')) return wordId.slice('Tensor-'.length);
  switch (wordId) {
    case 'Normal': return 'normal';
    case 'Quote': return 'quote';
    case 'Caption': return 'caption';
    default: {
      const heading = /^Heading([1-6])$/.exec(wordId);
      if (heading) return `heading-${heading[1]}`;
      return wordId; // custom ids ride verbatim
    }
  }
}

// ─── Fonts (ruling 4) ────────────────────────────────────────────────────

const KNOWN_FAMILIES = new Set<string>([...BUNDLED_FONTS.map((f) => f.family), 'system-ui']);

const SUBSTITUTIONS: Record<string, string> = {
  Calibri: 'Open Sans',
  'Calibri Light': 'Source Serif 4',
  'Segoe UI': 'Open Sans',
  Aptos: 'Open Sans',
  'Aptos Display': 'Source Serif 4',
  Candara: 'Open Sans',
  Corbel: 'Open Sans',
  Cambria: 'Source Serif 4',
  Constantia: 'Source Serif 4',
  Garamond: 'Crimson Pro',
  'Book Antiqua': 'Source Serif 4',
  Palatino: 'Crimson Pro',
  'Century Gothic': 'Sora',
  Consolas: 'JetBrains Mono',
  'Cascadia Code': 'JetBrains Mono',
  'Cascadia Mono': 'JetBrains Mono',
  'Sitka Text': 'Merriweather',
  'Sitka Heading': 'Merriweather',
};

/** The closest bundled family for one Word font (name table, then a
 *  keyword pass, then the sans default). */
export function substituteFontFamily(family: string): string {
  const exact = SUBSTITUTIONS[family];
  if (exact) return exact;
  const lower = family.toLowerCase();
  if (/(mono|code|consol|courier)/.test(lower)) return 'JetBrains Mono';
  if (/script|hand|comic/.test(lower)) return 'Nunito';
  if (/sans/.test(lower)) return 'Open Sans';
  if (/serif|roman|book|cambria|garamond|minion/.test(lower)) return 'Source Serif 4';
  if (/display|playfair|head/.test(lower)) return 'Playfair Display';
  return 'Open Sans';
}

/** THE rFonts RESOLUTION: a literal ascii/hAnsi wins; the theme slot
 *  (asciiTheme="minorHAnsi" — how modern Word spells it) resolves
 *  through theme1.xml; the policy applies to the RESOLVED name. */
function resolveFontFamily(rFonts: ONode | undefined, theme: DocxThemeFonts | undefined, policy: 'keep' | 'substitute'): string | undefined {
  if (!rFonts) return undefined;
  const literal = oat(rFonts, 'ascii') ?? oat(rFonts, 'hAnsi');
  if (literal) return applyFontPolicy(literal, policy);
  const themed = themeSlot(theme, oat(rFonts, 'asciiTheme') ?? oat(rFonts, 'hAnsiTheme'));
  if (themed) return applyFontPolicy(themed, policy);
  return undefined;
}

function applyFontPolicy(family: string | undefined, policy: 'keep' | 'substitute'): string | undefined {
  if (!family) return undefined;
  if (policy === 'substitute' && !KNOWN_FAMILIES.has(family)) return substituteFontFamily(family);
  return family;
}

export function isKnownFontFamily(family: string): boolean {
  return KNOWN_FAMILIES.has(family);
}

// ─── The report ──────────────────────────────────────────────────────────

export interface DocxImportReport {
  trackedChanges: number;
  comments: number;
  tocFields: number;
  pageFields: number;
  otherFields: number;
  inlineEquations: number;
  degradedEquations: number;
  refusedImages: number;
  wrapAroundFloats: number;
  vertAligns: number;
  evenOddHeaders: number;
  internalLinks: number;
  sectionBreaks: number;
  /** #58 — a NON-first section's titlePg (per-section first-page has
   *  no v1 model; the doc flag governs page 0 = section 0's first). */
  perSectionFirstPage: number;
  textboxes: number;
  footnotes: number;
  unknownNodes: number;
  unknownNumbering: number;
}

function emptyReport(): DocxImportReport {
  return {
    trackedChanges: 0, comments: 0, tocFields: 0, pageFields: 0, otherFields: 0,
    inlineEquations: 0, degradedEquations: 0, refusedImages: 0, wrapAroundFloats: 0,
    vertAligns: 0, evenOddHeaders: 0, internalLinks: 0, sectionBreaks: 0, perSectionFirstPage: 0,
    textboxes: 0, footnotes: 0, unknownNodes: 0, unknownNumbering: 0,
  };
}

export function docxImportNoticeLines(report: DocxImportReport): string[] {
  const lines: string[] = [];
  if (report.tocFields > 0) {
    lines.push(`Word ToC converted to a live Tensor ToC (${report.tocFields}) — entries regenerate from the document's headings`);
  }
  if (report.trackedChanges > 0) {
    lines.push(`Tracked changes imported as final text (${report.trackedChanges} deletions accepted)`);
  }
  if (report.comments > 0) lines.push(`Comments skipped (${report.comments})`);
  if (report.pageFields > 0) {
    lines.push(`Page-number fields dropped (${report.pageFields}) — Tensor page numbers land with issue #34`);
  }
  if (report.otherFields > 0) {
    lines.push(`Other fields kept as their cached text (${report.otherFields})`);
  }
  if (report.footnotes > 0) {
    lines.push(`Footnote/endnote references dropped (${report.footnotes}) — the feature lands in a later update`);
  }
  if (report.inlineEquations > 0) {
    lines.push(`Inline equations dropped (${report.inlineEquations}) — Tensor equations are display-only`);
  }
  if (report.degradedEquations > 0) {
    lines.push(`Equations with unsupported parts imported as text (${report.degradedEquations})`);
  }
  if (report.refusedImages > 0) {
    lines.push(`Images in formats Tensor cannot read skipped (${report.refusedImages}) — emf/wmf`);
  }
  if (report.wrapAroundFloats > 0) {
    lines.push(`Floating images imported as overlays (${report.wrapAroundFloats}) — text wrap-around and page-anchored placement approximate`);
  }
  if (report.vertAligns > 0) {
    lines.push(`Sub/superscripts dropped (${report.vertAligns}) — the feature lands in a later update`);
  }
  if (report.textboxes > 0) lines.push(`Text boxes/shapes skipped (${report.textboxes})`);
  if (report.evenOddHeaders > 0) {
    lines.push(`Even-page headers/footers collapsed (${report.evenOddHeaders})`);
  }
  if (report.internalLinks > 0) {
    lines.push(`Internal links imported as plain text (${report.internalLinks})`);
  }
  if (report.perSectionFirstPage > 0) {
    lines.push(`Per-section first-page settings collapsed to the document's (${report.perSectionFirstPage})`);
  }
  if (report.unknownNumbering > 0) {
    lines.push(`Unknown list numbering formats mapped to decimal (${report.unknownNumbering})`);
  }
  if (report.unknownNodes > 0) {
    lines.push(`Unknown Word constructs skipped (${report.unknownNodes})`);
  }
  return lines;
}

// ─── Style properties from rPr/pPr (ONode) ───────────────────────────────

function runPropsFromRPr(rPr: ONode | undefined, policy: 'keep' | 'substitute', theme?: DocxThemeFonts, themeColors?: DocxThemeColors): StyleProperties {
  const props: StyleProperties = {};
  if (!rPr) return props;
  const family = resolveFontFamily(oSub(rPr, 'rFonts'), theme, policy);
  if (family) props.fontFamily = family;
  const sz = ovalNum(rPr, 'sz');
  if (sz != null) props.fontSize = halfPointsToPx(sz);
  if (oflag(oSub(rPr, 'b')) === true) props.bold = true;
  if (oflag(oSub(rPr, 'i')) === true) props.italic = true;
  if (oSub(rPr, 'strike') || oSub(rPr, 'dstrike')) props.strike = true;
  const underline = oSub(rPr, 'u');
  if (underline && oat(underline, 'val') !== 'none') props.underline = true;
  const colorNode = oSub(rPr, 'color');
  const colorVal = oat(colorNode, 'val');
  const colorResolved = colorVal && colorVal !== 'auto'
    ? colorVal
    : resolveThemeColor(themeColors, oat(colorNode, 'themeColor'), oat(colorNode, 'themeShade'), oat(colorNode, 'themeTint'));
  if (colorResolved) props.color = `#${colorResolved.toUpperCase()}`;
  const highlight = oat(oSub(rPr, 'highlight'), 'val');
  const shading = oSub(rPr, 'shd');
  const fill = shading ? oat(shading, 'fill') : undefined;
  const themeFill = shading ? oat(shading, 'themeFill') : undefined;
  const fillResolved = fill && fill !== 'auto'
    ? fill
    : resolveThemeColor(themeColors, themeFill, shading ? oat(shading, 'themeFillShade') : undefined, shading ? oat(shading, 'themeFillTint') : undefined);
  const highlightHex = highlight && highlight !== 'none'
    ? HIGHLIGHT_NAME_TO_HEX[highlight.toLowerCase()]
    : fillResolved ? fillResolved : undefined;
  if (highlightHex) props.highlight = `#${highlightHex.toUpperCase()}`;
  if (oSub(rPr, 'smallCaps')) props.fontVariant = 'small-caps';
  if (oSub(rPr, 'caps')) props.textTransform = 'uppercase';
  return props;
}

/** Word's named highlight values → hex (the export table's inverse). */
const HIGHLIGHT_NAME_TO_HEX: Record<string, string> = {
  yellow: 'FFFF00', green: '00FF00', cyan: '00FFFF', magenta: 'FF00FF',
  blue: '0000FF', red: 'FF0000', darkblue: '00008B', darkcyan: '008B8B',
  darkgreen: '006400', darkmagenta: '8B008B', darkred: '8B0000',
  darkyellow: '808000', darkgray: '808080', lightgray: 'C0C0C0',
  black: '000000', white: 'FFFFFF',
};

function paraPropsFromPPPr(pPr: ONode | undefined): StyleProperties {
  const props: StyleProperties = {};
  if (!pPr) return props;
  const spacing = oSub(pPr, 'spacing');
  if (spacing) {
    const before = onum(spacing, 'before');
    if (before != null) props.spaceBefore = twipToPx(before);
    const after = onum(spacing, 'after');
    if (after != null) props.spaceAfter = twipToPx(after);
    const line = onum(spacing, 'line');
    const rule = oat(spacing, 'lineRule');
    if (line != null && rule === 'auto' && line > 0) props.lineHeight = line / 240;
  }
  const ind = oSub(pPr, 'ind');
  if (ind) {
    const left = onum(ind, 'left');
    if (left != null) props.indentLeft = twipToPx(left);
    const right = onum(ind, 'right');
    if (right != null) props.indentRight = twipToPx(right);
    const hanging = onum(ind, 'hanging');
    const firstLine = onum(ind, 'firstLine');
    if (hanging != null) props.firstLineIndent = -twipToPx(hanging);
    else if (firstLine != null) props.firstLineIndent = twipToPx(firstLine);
  }
  const jc = oat(oSub(pPr, 'jc'), 'val');
  if (jc === 'center' || jc === 'right' || jc === 'both') {
    props.textAlign = jc === 'both' ? 'justify' : jc;
  }
  return props;
}

/** Flatten a Word style's basedOn chain over the doc defaults (memoized,
 *  cycle-guarded). */
function resolveStyleProps(
  id: string,
  raw: Map<string, { basedOn?: string; run: StyleProperties; para: StyleProperties }>,
  docDefaults: StyleProperties,
  memo: Map<string, StyleProperties>,
): StyleProperties {
  if (memo.has(id)) return memo.get(id)!;
  const own = raw.get(id);
  let base: StyleProperties = { ...docDefaults };
  if (own?.basedOn && own.basedOn !== id) {
    base = resolveStyleProps(own.basedOn, raw, docDefaults, memo);
  }
  const merged: StyleProperties = { ...base, ...own?.run, ...own?.para };
  memo.set(id, merged);
  return merged;
}

// ─── The trees ───────────────────────────────────────────────────────────

export interface DocxThemeFonts {
  minor: string | null;
  major: string | null;
}

/** The theme's color scheme: dk1/lt1/dk2/lt2/accent1-6/hlink — the
 *  names Word's themeColor attributes reference. sysClr entries carry
 *  lastClr (windowText → 000000); srgbClr entries the literal val. */
export interface DocxThemeColors {
  [name: string]: string;
}

function themeColors(themePart: string | undefined): DocxThemeColors | undefined {
  if (!themePart) return undefined;
  const root = parseOrdered(themePart);
  const clrScheme = oSub(oSub(root, 'themeElements'), 'clrScheme');
  if (!clrScheme) return undefined;
  const colors: DocxThemeColors = {};
  for (const kid of clrScheme.kids) {
    const srgb = oSub(kid, 'srgbClr');
    const sys = oSub(kid, 'sysClr');
    const hex = srgb ? oat(srgb, 'val') : sys ? oat(sys, 'lastClr') : undefined;
    if (hex) colors[kid.tag] = hex.toUpperCase();
  }
  return colors;
}

/** OOXML themeShade/themeTint (00–FF hex): shade scales toward black,
 *  tint mixes toward white. Returns the resolved 6-digit hex. */
function applyShadeTint(hex: string, shade: string | undefined, tint: string | undefined): string {
  const base = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const shadeVal = shade ? parseInt(shade, 16) : null;
  const tintVal = tint ? parseInt(tint, 16) : null;
  const factor = shadeVal != null ? shadeVal / 255 : null;
  const mixed = base.map((c) => {
    if (factor != null) return Math.round(c * factor);
    if (tintVal != null) return Math.round(c * (tintVal / 255) + 255 * (1 - tintVal / 255));
    return c;
  });
  return mixed.map((c) => c.toString(16).padStart(2, '0').toUpperCase()).join('');
}

/** Resolve a theme color reference (themeColor + optional shade/tint). */
function resolveThemeColor(
  theme: DocxThemeColors | undefined,
  name: string | undefined,
  shade: string | undefined,
  tint: string | undefined,
): string | undefined {
  if (!theme || !name) return undefined;
  const key = name === 'dark1' ? 'dk1' : name === 'light1' ? 'lt1' : name;
  const base = theme[key] ?? theme['accent1'];
  if (!base) return undefined;
  return applyShadeTint(base, shade, tint);
}

export interface DocxTrees {
  document: ONode;
  styles: ONode | undefined;
  numbering: ONode | undefined;
  core: ONode | undefined;
  theme: DocxThemeFonts | undefined;
  themeColors: DocxThemeColors | undefined;
  /** rId → resolved part name (word/-prefixed) or external URL. */
  rels: Map<string, { target: string; external: boolean }>;
  parts: Record<string, Uint8Array>;
}

/** Theme font resolution: modern Word documents reference fonts as
 *  asciiTheme="minorHAnsi" (pointing at theme1.xml), never literal
 *  names — without this the document's real font is invisible to the
 *  mapper and the ruling-4 dialog never fires. */
function themeFonts(themePart: string | undefined): DocxThemeFonts | undefined {
  if (!themePart) return undefined;
  const root = parseOrdered(themePart);
  const fontScheme = oSub(oSub(root, 'themeElements'), 'fontScheme');
  if (!fontScheme) return undefined;
  const pick = (kind: string): string | null => {
    const latin = oSub(oSub(fontScheme, kind), 'latin');
    const face = oat(latin, 'typeface');
    return face && face !== '+mn-lt' && face !== '+mj-lt' ? face : null;
  };
  return { minor: pick('minorFont'), major: pick('majorFont') };
}

/** rFonts asciiTheme/hAnsiTheme spellings → the theme font. */
function themeSlot(theme: DocxThemeFonts | undefined, slot: string | undefined): string | undefined {
  if (!theme || !slot) return undefined;
  return slot.toLowerCase().startsWith('major') ? theme.major ?? undefined : theme.minor ?? undefined;
}

export function parseDocxTrees(parts: Record<string, Uint8Array>): DocxTrees {
  const decode = (b: Uint8Array) => new TextDecoder().decode(b);
  const document = parts['word/document.xml'] ? parseOrdered(decode(parts['word/document.xml'])) : { tag: 'document', attrs: {}, kids: [], text: '' };
  const styles = parts['word/styles.xml'] ? parseOrdered(decode(parts['word/styles.xml'])) : undefined;
  const numbering = parts['word/numbering.xml'] ? parseOrdered(decode(parts['word/numbering.xml'])) : undefined;
  const core = parts['docProps/core.xml'] ? parseOrdered(decode(parts['docProps/core.xml'])) : undefined;
  const themePart = parts['word/theme/theme1.xml'] ? decode(parts['word/theme/theme1.xml']) : undefined;
  const theme = themeFonts(themePart);
  const clr = themeColors(themePart);

  const rels = new Map<string, { target: string; external: boolean }>();
  const relsXml = parts['word/_rels/document.xml.rels'];
  if (relsXml) {
    const root = parseOrdered(decode(relsXml));
    for (const rel of oKids(root, 'Relationship')) {
      const id = oat(rel, 'Id');
      const target = oat(rel, 'Target');
      const external = oat(rel, 'TargetMode') === 'External';
      if (id && target) {
        rels.set(id, { target: external ? target : `word/${target.replace(/^\//, '')}`, external });
      }
    }
  }
  return { document, styles, numbering, core, theme, themeColors: clr, rels, parts };
}

/** The font families the file references (styles.xml + document.xml).
 *  The theme fonts count ONLY when something references them via
 *  asciiTheme/hAnsiTheme — every docx carries a default theme part
 *  (Calibri) that the document may never use; flagging it would fire
 *  the font dialog on documents that don't touch it. */
export function collectFontFamilies(trees: DocxTrees): { known: string[]; unknown: string[] } {
  const families = new Set<string>();
  const themeSlots = new Set<string>();
  const scan = (node: ONode | undefined): void => {
    if (!node) return;
    if (node.tag === 'rFonts') {
      for (const slot of ['ascii', 'hAnsi'] as const) {
        const family = oat(node, slot);
        if (family) families.add(family);
      }
      for (const slot of ['asciiTheme', 'hAnsiTheme'] as const) {
        const slotName = oat(node, slot);
        if (slotName) themeSlots.add(slotName);
      }
    }
    for (const kid of node.kids) scan(kid);
  };
  scan(trees.styles);
  scan(trees.document);
  // The referenced theme slots resolve through theme1.xml.
  if (trees.theme) {
    for (const slot of themeSlots) {
      const family = themeSlot(trees.theme, slot);
      if (family) families.add(family);
    }
  }
  const known: string[] = [];
  const unknown: string[] = [];
  for (const family of families) {
    (KNOWN_FAMILIES.has(family) ? known : unknown).push(family);
  }
  return { known, unknown };
}

// ─── The mapping context ─────────────────────────────────────────────────

interface MapContext {
  policy: 'keep' | 'substitute';
  theme: DocxThemeFonts | undefined;
  themeColors: DocxThemeColors | undefined;
  mediaPartToId: Map<string, string>;
  report: DocxImportReport;
  numberingMap: Map<string, string>;
  /** Restart fidelity: numId → the level-0 startOverride (Word's own
   *  "this list starts at N"), riding the rebuilt list's start. */
  numberingStarts: Map<string, number>;
  numberingLevels: Map<string, Map<number, { fmt: string; text: string }>>;
  /** the field state machine (spans paragraphs via the run mapping) */
  fieldDepth: number;
  fieldInstr: string[];
  /** THE TOC CONVERSION (the user's ruling): a Word TOC field's cached
   *  paragraphs are CAPTURED (never emitted as static text) and, at the
   *  field's end, built into a Tensor referenceTable {kind: 'toc'} —
   *  whose entries the generator immediately rebuilds from the
   *  document's headings. A live ToC from a dead field. */
  tocCapture: { depth: number; entries: JSONContent[] } | null;
  tocEnd: boolean;
}

type FieldKind = 'toc' | 'page' | 'hyperlink' | 'other' | null;

function fieldKind(instr: string): FieldKind {
  const keyword = instr.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
  if (keyword === 'TOC') return 'toc';
  if (keyword === 'PAGE' || keyword === 'NUMPAGES') return 'page';
  if (keyword === 'HYPERLINK') return 'hyperlink';
  return 'other';
}

function countField(ctx: MapContext, kind: FieldKind, instr: string): void {
  if (kind == null) return;
  if (ctx.tocCapture && kind === 'page') return; // the ToC's own PAGEREFs

  if (kind === 'toc') ctx.report.tocFields += 1;
  else if (kind === 'page') ctx.report.pageFields += 1;
  else if (kind === 'hyperlink') { /* the link shape carries it */ }
  else if (instr.trim()) ctx.report.otherFields += 1;
}

function currentFieldKind(ctx: MapContext): FieldKind {
  const instr = ctx.fieldInstr[ctx.fieldInstr.length - 1];
  if (instr == null) return null;
  return fieldKind(instr);
}

// ─── Runs → inline content ───────────────────────────────────────────────

interface RunFormat {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  underline?: boolean;
  highlightHex?: string;
  color?: string;
  fontFamily?: string;
  fontSizePx?: number;
  charStyleId?: string;
}

function runFormatFromRPr(rPr: ONode | undefined, ctx: MapContext): RunFormat {
  const format: RunFormat = {};
  if (!rPr) return format;
  void ctx.theme;
  if (oflag(oSub(rPr, 'b')) === true) format.bold = true;
  if (oflag(oSub(rPr, 'i')) === true) format.italic = true;
  if (oSub(rPr, 'strike') || oSub(rPr, 'dstrike')) format.strike = true;
  const underline = oSub(rPr, 'u');
  if (underline && oat(underline, 'val') !== 'none') format.underline = true;
  const highlight = oat(oSub(rPr, 'highlight'), 'val');
  const shading = oSub(rPr, 'shd');
  const fill = shading ? oat(shading, 'fill') : undefined;
  const themeFill = shading ? oat(shading, 'themeFill') : undefined;
  const fillResolved = fill && fill !== 'auto'
    ? fill
    : resolveThemeColor(ctx.themeColors, themeFill, shading ? oat(shading, 'themeFillShade') : undefined, shading ? oat(shading, 'themeFillTint') : undefined);
  const highlightHex = highlight && highlight !== 'none'
    ? HIGHLIGHT_NAME_TO_HEX[highlight.toLowerCase()]
    : fillResolved ? fillResolved : undefined;
  if (highlightHex) format.highlightHex = highlightHex.toUpperCase();
  const colorNode = oSub(rPr, 'color');
  const colorVal = oat(colorNode, 'val');
  const themeColor = oat(colorNode, 'themeColor');
  const colorResolved = colorVal && colorVal !== 'auto'
    ? colorVal
    : resolveThemeColor(ctx.themeColors, themeColor, oat(colorNode, 'themeShade'), oat(colorNode, 'themeTint'));
  if (colorResolved) format.color = colorResolved.toUpperCase();
  const family = resolveFontFamily(oSub(rPr, 'rFonts'), ctx.theme, ctx.policy);
  if (family) format.fontFamily = family;
  const sz = ovalNum(rPr, 'sz');
  if (sz != null) format.fontSizePx = halfPointsToPx(sz);
  // vertAlign (sub/superscript) has NO Tensor mark — dropped, counted.
  if (oSub(rPr, 'vertAlign')) ctx.report.vertAligns += 1;
  const rStyle = oat(oSub(rPr, 'rStyle'), 'val');
  if (rStyle) format.charStyleId = tensorStyleId(rStyle);
  return format;
}

function marksFor(format: RunFormat): { type: string; attrs?: Record<string, unknown> }[] {
  const marks: { type: string; attrs?: Record<string, unknown> }[] = [];
  if (format.bold) marks.push({ type: 'bold' });
  if (format.italic) marks.push({ type: 'italic' });
  if (format.strike) marks.push({ type: 'strike' });
  if (format.underline) marks.push({ type: 'underline' });
  if (format.highlightHex) marks.push({ type: 'highlight', attrs: { color: `#${format.highlightHex}` } });
  const textStyle: Record<string, unknown> = {};
  if (format.color) textStyle.color = `#${format.color}`;
  if (format.fontFamily) textStyle.fontFamily = format.fontFamily;
  if (format.fontSizePx != null) textStyle.fontSize = format.fontSizePx;
  if (Object.keys(textStyle).length) marks.push({ type: 'textStyle', attrs: textStyle });
  if (format.charStyleId) marks.push({ type: 'charStyle', attrs: { styleId: format.charStyleId } });
  return marks;
}

interface RunPieces {
  pieces: JSONContent[];
  pageBreaks: number;
  hasContent: boolean;
}

function mapRunChildren(run: ONode, format: RunFormat, ctx: MapContext, rels: DocxTrees['rels']): RunPieces {
  const pieces: JSONContent[] = [];
  let textBuffer = '';
  let pageBreaks = 0;
  let hasContent = false;

  const flushText = (): void => {
    if (textBuffer) {
      pieces.push({ type: 'text', text: textBuffer, marks: marksFor(format) });
      textBuffer = '';
      hasContent = true;
    }
  };

  for (const kid of run.kids) {
    // The page-field suppression is PER KID: the machine's own
    // elements (fldChar/instrText) must run inside the field's range —
    // only the CONTENT is suppressed (the cached page digits).
    const suppressed = currentFieldKind(ctx) === 'page';
    switch (kid.tag) {
      case 't':
        if (!suppressed) textBuffer += kid.text;
        break;
      case 'tab':
        if (!suppressed) textBuffer += '\t';
        break;
      case 'noBreakHyphen':
        if (!suppressed) textBuffer += '-';
        break;
      case 'br': {
        if (oat(kid, 'type') === 'page') pageBreaks += 1;
        else { flushText(); pieces.push({ type: 'hardBreak' }); hasContent = true; }
        break;
      }
      case 'drawing': {
        if (suppressed) break;
        flushText();
        const image = mapDrawing(kid, ctx, rels);
        if (image) { pieces.push(image); hasContent = true; }
        break;
      }
      case 'oMath':
        flushText();
        ctx.report.inlineEquations += 1;
        break;
      case 'footnoteReference':
      case 'endnoteReference':
        flushText();
        ctx.report.footnotes += 1;
        break;
      case 'pict':
      case 'object':
        flushText();
        ctx.report.textboxes += 1;
        break;
      case 'fldChar': {
        // THE FIELD MACHINE (spans paragraphs via ctx): begin pushes an
        // instr accumulator; separate counts the field's kind; end pops.
        const type = oat(kid, 'fldCharType');
        if (type === 'begin') {
          ctx.fieldDepth += 1;
          ctx.fieldInstr.push('');
        } else if (type === 'separate') {
          const instr = ctx.fieldInstr[ctx.fieldInstr.length - 1] ?? '';
          const kind = fieldKind(instr);
          if (kind === 'toc' && !ctx.tocCapture) {
            ctx.tocCapture = { depth: parseTocDepth(instr), entries: [] };
            ctx.report.tocFields += 1;
          } else if (kind !== 'page') {
            // PAGE/NUMPAGES import as live fields — never counted as
            // dropped content.
            countField(ctx, kind, instr);
          }
        } else if (type === 'end') {
          const popped = ctx.fieldInstr.pop() ?? '';
          ctx.fieldDepth = Math.max(0, ctx.fieldDepth - 1);
          if (fieldKind(popped) === 'toc') ctx.tocEnd = true;
          else if (fieldKind(popped) === 'page' && !ctx.tocCapture) {
            // M-PAGEFIELD: the field IMPORTS as the live node — the
            // cached digits between separate/end stay suppressed.
            const keyword = popped.trim().split(/\s+/)[0]?.toUpperCase() ?? 'PAGE';
            pieces.push({ type: 'pageField', attrs: { kind: keyword === 'NUMPAGES' ? 'pages' : 'page' } });
            hasContent = true;
          }
        }
        break;
      }
      case 'instrText': {
        const top = ctx.fieldInstr[ctx.fieldInstr.length - 1];
        if (top != null) ctx.fieldInstr[ctx.fieldInstr.length - 1] = top + kid.text;
        break;
      }
      default:
        break; // proofErr, lastRenderedPageBreak, etc. ride quietly
    }
  }
  flushText();
  return { pieces, pageBreaks, hasContent };
}

function mapDrawing(drawing: ONode, ctx: MapContext, rels: DocxTrees['rels']): JSONContent | null {
  const inline = oSub(drawing, 'inline');
  const anchor = inline ? undefined : oSub(drawing, 'anchor');
  const root = inline ?? anchor;
  if (!root) return null;
  const extent = oSub(root, 'extent');
  const cx = onum(extent, 'cx');
  const cy = onum(extent, 'cy');
  const blip = findBlip(root);
  const embedId = blip ? oat(blip, 'embed') : undefined;
  const docPr = oSub(root, 'docPr');
  const alt = oat(docPr, 'descr') ?? oat(docPr, 'name') ?? '';
  if (embedId == null || cx == null || cy == null) return null;
  const rel = rels.get(embedId);
  if (!rel || rel.external) { ctx.report.refusedImages += 1; return null; }
  const mediaId = ctx.mediaPartToId.get(rel.target);
  if (!mediaId) { ctx.report.refusedImages += 1; return null; }

  // THE FLOAT INVERSE: an anchored drawing → Tensor's overlay model
  // ({dx, dy, z}). Word's offsets are EMU from the chosen relative-to
  // (column/paragraph ≈ Tensor's anchor-relative px — the same frame).
  // behindDoc is the z-order. Text-wrap shapes (square/tight/topAnd-
  // Bottom) and page/margin anchoring have NO Tensor spelling — the
  // placement approximates, LOUDLY counted.
  let float: { dx: number; dy: number; z: 'front' | 'behind' } | null = null;
  if (anchor) {
    const posH = oSub(anchor, 'positionH');
    const posV = oSub(anchor, 'positionV');
    // wp:posOffset is a CHILD ELEMENT carrying the EMU value as text.
    const dx = parseFloat(oSub(posH, 'posOffset')?.text ?? '0') || 0;
    const dy = parseFloat(oSub(posV, 'posOffset')?.text ?? '0') || 0;
    const behind = (oat(anchor, 'behindDoc') ?? '0') === '1';
    float = { dx: Math.round(emuToPx(dx)), dy: Math.round(emuToPx(dy)), z: behind ? 'behind' : 'front' };
    const wraps = ['wrapSquare', 'wrapTight', 'wrapTopAndBottom'].some((w) => oSub(anchor, w) != null);
    const absolute = ['page', 'margin'].includes(oat(posH, 'relativeFrom') ?? '') || ['page', 'margin'].includes(oat(posV, 'relativeFrom') ?? '');
    if (wraps || absolute) ctx.report.wrapAroundFloats += 1;
  }

  return {
    type: anchor ? 'image' : 'image',
    attrs: {
      src: `media://${mediaId}`,
      width: Math.round(cx / 9525),
      height: Math.round(cy / 9525),
      alt,
      ...(float ? { float } : {}),
    },
  };
}

function findBlip(node: ONode): ONode | undefined {
  const direct = oSub(node, 'blip');
  if (direct) return direct;
  for (const kid of node.kids) {
    const hit = findBlip(kid);
    if (hit) return hit;
  }
  return undefined;
}

// ─── Paragraphs ──────────────────────────────────────────────────────────

interface ParagraphResult {
  json: JSONContent | null;
  numPr: { numId: number; ilvl: number } | null;
  /**
   * #58 — the paragraph's OWN sectPr when it carries one (Word's
   * mid-doc section break spelling: the sectPr rides the section's
   * LAST paragraph's pPr; the body-level sectPr is the final one).
   * The body walk flushes it AFTER the paragraph's content emits (the
   * content belongs to the ENDING section — the break follows it).
   */
  sectPr?: ONode;
}

function mapParagraph(p: ONode, ctx: MapContext, rels: DocxTrees['rels']): ParagraphResult {
  const pPr = oSub(p, 'pPr');
  const ownSectPr = oSub(pPr, 'sectPr');
  const numPrNode = oSub(pPr, 'numPr');
  const numId = numPrNode ? ovalNum(numPrNode, 'numId') : null;
  const ilvl = numPrNode ? (ovalNum(numPrNode, 'ilvl') ?? 0) : 0;

  const attrs: Record<string, unknown> = {};
  let styleId = oat(oSub(pPr, 'pStyle'), 'val');
  // Word's own numbering machinery adds the ListParagraph style to
  // every list paragraph — a Word-internal artifact, not document data.
  if (styleId === 'ListParagraph') styleId = undefined;
  const headingLevel = styleId ? /^heading-([1-6])$/.exec(tensorStyleId(styleId)) : null;
  if (styleId) attrs.styleId = tensorStyleId(styleId);
  const jc = oat(oSub(pPr, 'jc'), 'val');
  if (jc === 'center' || jc === 'right' || jc === 'both') {
    attrs.textAlign = jc === 'both' ? 'justify' : jc;
  }
  const spacing = oSub(pPr, 'spacing');
  if (spacing) {
    const before = onum(spacing, 'before');
    if (before != null) attrs.spaceBefore = twipToPx(before);
    const after = onum(spacing, 'after');
    if (after != null) attrs.spaceAfter = twipToPx(after);
    const line = onum(spacing, 'line');
    const rule = oat(spacing, 'lineRule');
    if (line != null && line > 0) {
      attrs.lineHeight = rule === 'auto' ? `${line / 240}` : `${twipToPx(line)}px`;
    }
  }
  const ind = oSub(pPr, 'ind');
  if (ind) {
    const left = onum(ind, 'left');
    if (left != null) attrs.indentLeft = twipToPx(left);
    const right = onum(ind, 'right');
    if (right != null) attrs.indentRight = twipToPx(right);
    const hanging = onum(ind, 'hanging');
    const firstLine = onum(ind, 'firstLine');
    if (hanging != null) attrs.firstLineIndent = -twipToPx(hanging);
    else if (firstLine != null) attrs.firstLineIndent = twipToPx(firstLine);
  }
  const tabs = oSub(pPr, 'tabs');
  if (tabs) {
    const stops = oKids(tabs, 'tab')
      .map((tab) => ({ val: oat(tab, 'val'), pos: onum(tab, 'pos') }))
      .filter((stop): stop is { val: string; pos: number } => stop.pos != null && stop.val !== 'clear')
      .map((stop) => ({
        position: twipToPx(stop.pos),
        alignment: stop.val === 'center' ? 'center' : stop.val === 'right' ? 'right' : 'left',
      }));
    if (stops.length) attrs.tabStops = stops;
  }

  // The runs — the field state machine lives in the run mapping and
  // spans paragraphs (fldChar begin/separate/end + instrText).
  const content: JSONContent[] = [];
  const ommlMarkers: ONode[] = [];
  let pageBreaks = 0;
  for (const kid of p.kids) {
    switch (kid.tag) {
      case 'r': {
        const format = runFormatFromRPr(oSub(kid, 'rPr'), ctx);
        const mapped = mapRunChildren(kid, format, ctx, rels);
        pageBreaks += mapped.pageBreaks;
        content.push(...mapped.pieces);
        break;
      }
      case 'hyperlink': {
        // Internal anchors (w:anchor) have no relationship — plain text
        // + counted (#57's bookmark model lands later).
        if (oat(kid, 'anchor') != null) {
          if (!ctx.tocCapture) ctx.report.internalLinks += 1;
          for (const run of oKids(kid, 'r')) {
            const format = runFormatFromRPr(oSub(run, 'rPr'), ctx);
            content.push(...mapRunChildren(run, format, ctx, rels).pieces);
          }
          break;
        }
        const relId = oat(kid, 'id');
        const rel = relId ? rels.get(relId) : undefined;
        if (!rel || !rel.external) {
          if (!ctx.tocCapture) ctx.report.internalLinks += 1;
          for (const run of oKids(kid, 'r')) {
            const format = runFormatFromRPr(oSub(run, 'rPr'), ctx);
            content.push(...mapRunChildren(run, format, ctx, rels).pieces);
          }
          break;
        }
        for (const run of oKids(kid, 'r')) {
          const format = runFormatFromRPr(oSub(run, 'rPr'), ctx);
          for (const piece of mapRunChildren(run, format, ctx, rels).pieces) {
            content.push(
              piece.type === 'text'
                ? { ...piece, marks: [...(piece.marks ?? []), { type: 'link', attrs: { href: rel.target } }] }
                : piece,
            );
          }
        }
        break;
      }
      case 'fldSimple': {
        const instr = oat(kid, 'instr') ?? '';
        const kind = fieldKind(instr);
        if (kind === 'toc') {
          // THE CONVERSION'S OTHER HALF: a Word TOC field (simple
          // spelling — the export emits it this way) becomes a LIVE
          // Tensor referenceTable; the generator rebuilds the entries
          // from the document's headings on open.
          ctx.report.tocFields += 1;
          content.push({
            type: 'referenceTable',
            attrs: { kind: 'toc', depth: parseTocDepth(instr), leaders: true, numberDisplay: 'plain' },
          });
          break;
        }
        if (kind === 'page') {
          // M-PAGEFIELD: the field IMPORTS as the live node.
          const keyword = instr.trim().split(/\s+/)[0]?.toUpperCase() ?? 'PAGE';
          content.push({ type: 'pageField', attrs: { kind: keyword === 'NUMPAGES' ? 'pages' : 'page' } });
          break;
        }
        countField(ctx, kind, instr);
        for (const run of oKids(kid, 'r')) {
          const format = runFormatFromRPr(oSub(run, 'rPr'), ctx);
          content.push(...mapRunChildren(run, format, ctx, rels).pieces);
        }
        break;
      }
      case 'ins': {
        // tracked INSERTION — keep the content (accepted-final posture)
        for (const run of oKids(kid, 'r')) {
          const format = runFormatFromRPr(oSub(run, 'rPr'), ctx);
          content.push(...mapRunChildren(run, format, ctx, rels).pieces);
        }
        break;
      }
      case 'del':
        // tracked DELETION — the accepted-final view drops it, counted
        ctx.report.trackedChanges += 1;
        break;
      case 'commentRangeStart':
      case 'commentRangeEnd':
      case 'commentReference':
        ctx.report.comments += 1;
        break;
      case 'oMath':
      case 'oMathPara': {
        // INLINE math in Word's spelling — Tensor's equations are
        // display-only: SOLO oMath(s) become the display equation; ones
        // among text are dropped + counted. oMathPara wraps display
        // math and rides the same resolution.
        for (const math of kid.tag === 'oMathPara' ? oKids(kid, 'oMath') : [kid]) {
          ommlMarkers.push(math);
        }
        break;
      }
      case 'sdt': {
        const inner = oSub(kid, 'sdtContent');
        if (inner) {
          for (const run of oKids(inner, 'r')) {
            const format = runFormatFromRPr(oSub(run, 'rPr'), ctx);
            content.push(...mapRunChildren(run, format, ctx, rels).pieces);
          }
          for (const math of oKids(inner, 'oMath')) ommlMarkers.push(math);
        }
        break;
      }
      case 'pPr':
      case 'bookmarkStart':
      case 'bookmarkEnd':
      case 'proofErr':
      case 'lastRenderedPageBreak':
      case 'mathPr':
        break; // the paragraph's own properties + invisible machinery
      default:
        ctx.report.unknownNodes += 1;
        break;
    }
  }

  // The display-equation resolution: solo oMath(s) in an otherwise
  // empty paragraph ARE the display spelling (Word writes oMathPara
  // wrappers, but oMath alone happens too).
  const textPieces = content.filter((piece) => piece.type !== 'equation');
  if (ommlMarkers.length > 0 && textPieces.length === 0) {
    const equations = ommlMarkers.map((oMath) => {
      const { latex, degraded } = ommlToLatex(oMath);
      ctx.report.degradedEquations += degraded;
      return { type: 'equation', attrs: { latex } } as JSONContent;
    });
    return { json: equations.length === 1 ? equations[0]! : { type: 'paragraph', content: equations }, numPr: null };
  }
  if (ommlMarkers.length > 0) {
    ctx.report.inlineEquations += ommlMarkers.length;
  }

  const merged = mergeRuns(content);

  // THE HEADING MAPPING: Word spells headings as pStyle HeadingN — the
  // Tensor spelling is the heading NODE with its level. The runs ride
  // like any paragraph's (content never drops).
  if (headingLevel) {
    return {
      json: { type: 'heading', attrs: { ...attrs, level: Number(headingLevel[1]) }, ...(merged.length ? { content: merged } : {}) },
      numPr: null,
    };
  }

  // A bottom-bordered EMPTY paragraph is Word's horizontal rule.
  const pBdr = pPr ? oSub(pPr, 'pBdr') : undefined;
  if (pBdr && merged.length === 0 && pageBreaks === 0 && oSub(pBdr, 'bottom')) {
    return { json: { type: 'horizontalRule' }, numPr: null };
  }

  if (pageBreaks > 0 && merged.length === 0) {
    // Word's UI inserts page breaks as their own (otherwise empty)
    // paragraph — the Tensor spelling is the pageBreak block.
    return { json: { type: 'pageBreak' }, numPr: null };
  }
  if (pageBreaks > 0) {
    // Mixed content + a break: the break is lost (counted) — rare.
    ctx.report.unknownNodes += pageBreaks;
    return { json: { type: 'paragraph', attrs, content: merged }, numPr: numId != null ? { numId, ilvl } : null };
  }
  return {
    json: merged.length ? { type: 'paragraph', attrs, content: merged } : { type: 'paragraph', attrs },
    numPr: numId != null ? { numId, ilvl } : null,
    ...(ownSectPr ? { sectPr: ownSectPr } : {}),
  };
}

/** Consecutive text runs with identical marks merge (cleaner JSON and
 *  a stable round-trip). */
function mergeRuns(content: JSONContent[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const piece of content) {
    const last = out[out.length - 1];
    if (
      piece.type === 'text' && last?.type === 'text' &&
      JSON.stringify(last.marks ?? null) === JSON.stringify(piece.marks ?? null)
    ) {
      last.text = `${last.text}${piece.text}`;
    } else {
      out.push(piece);
    }
  }
  return out;
}

// ─── Tables ──────────────────────────────────────────────────────────────

function mapTable(tbl: ONode, ctx: MapContext, rels: DocxTrees['rels']): JSONContent {
  const tblPr = oSub(tbl, 'tblPr');
  const borders = tblPr ? oSub(tblPr, 'tblBorders') : undefined;
  let borderStyle = 'all';
  if (borders) {
    const visible = (side: string): boolean => {
      const v = oat(oSub(borders, side), 'val') ?? 'none';
      return v !== 'none' && v !== 'nil';
    };
    const outer = visible('top') || visible('bottom') || visible('left') || visible('right');
    const inside = visible('insideH') || visible('insideV');
    borderStyle = !outer && !inside ? 'none' : inside ? 'all' : 'outer';
  }
  const align = oat(oSub(tblPr, 'jc'), 'val');

  const grid = oSub(tbl, 'tblGrid');
  const gridWidths = grid
    ? oKids(grid, 'gridCol').map((col) => {
        const w = onum(col, 'w');
        return w != null ? Math.round(twipToPx(w)) : 0;
      })
    : [];

  // The vMerge inverse: Tensor rows carry ORIGIN cells only. Word's
  // continuation cells FOLD into the origin's rowspan and vanish.
  const openMerges = new Map<number, { ref: JSONContent; span: number }>();
  const rows: JSONContent[] = oKids(tbl, 'tr').map((tr) => {
    const repeatHeader = oflag(oSub(oSub(tr, 'trPr'), 'tblHeader')) === true;
    const cells: JSONContent[] = [];
    let col = 0;
    for (const tc of oKids(tr, 'tc')) {
      const tcPr = oSub(tc, 'tcPr');
      const gridSpan = Math.max(1, ovalNum(tcPr, 'gridSpan') ?? 1);
      const vMerge = tcPr ? oSub(tcPr, 'vMerge') : undefined;
      const isContinue = vMerge != null && (oat(vMerge, 'val') ?? 'continue') !== 'restart';
      if (isContinue) {
        // THE FOLD: the continuation cell grows its origin's rowspan
        // and vanishes (Tensor carries origin cells only).
        const open = openMerges.get(col);
        if (open) {
          open.ref.attrs = { ...(open.ref.attrs ?? {}), rowspan: Number((open.ref.attrs as { rowspan?: number } | undefined)?.rowspan ?? 1) + 1 };
          openMerges.delete(col);
        }
        col += gridSpan;
        continue;
      }
      // A real cell under an open merge (Word always writes the
      // continuation, but tolerate the omission): the merge ends here.
      openMerges.delete(col);
      const origin = mapCell(tc, gridWidths, col, gridSpan, ctx, rels, repeatHeader);
      cells.push(origin);
      if (vMerge) openMerges.set(col, { ref: origin, span: gridSpan });
      col += gridSpan;
    }
    return { type: 'tableRow', content: cells };
  });

  return {
    type: 'table',
    attrs: { borderStyle, ...(align === 'center' || align === 'right' ? { align } : {}) },
    content: rows,
  };
}

function mapCell(
  tc: ONode,
  gridWidths: number[],
  col: number,
  gridSpan: number,
  ctx: MapContext,
  rels: DocxTrees['rels'],
  header: boolean,
): JSONContent {
  const tcPr = oSub(tc, 'tcPr');
  const shading = tcPr ? oSub(tcPr, 'shd') : undefined;
  const fill = shading ? oat(shading, 'fill') : undefined;
  const cellMargins = tcPr ? oSub(tcPr, 'tcMar') : undefined;
  const padding: Record<string, number> = {};
  if (cellMargins) {
    for (const side of ['top', 'bottom', 'left', 'right'] as const) {
      const w = onum(oSub(cellMargins, side), 'w');
      if (w != null) padding[side] = Math.round(twipToPx(w));
    }
  }
  const colwidth = gridWidths.slice(col, col + gridSpan).filter((w) => w > 0);

  const content: JSONContent[] = [];
  for (const kid of tc.kids) {
    if (kid.tag === 'p') {
      const mapped = mapParagraph(kid, ctx, rels);
      if (mapped.json) content.push(promoteSoloImage(mapped.json));
    } else if (kid.tag === 'tbl') {
      content.push(mapTable(kid, ctx, rels));
    }
  }

  return {
    type: header ? 'tableHeader' : 'tableCell',
    attrs: {
      ...(gridSpan > 1 ? { colspan: gridSpan } : {}),
      ...(colwidth.length ? { colwidth } : {}),
      ...(fill && fill !== 'auto' ? { backgroundColor: `#${fill.toUpperCase()}` } : {}),
      ...(Object.keys(padding).length ? { padding } : {}),
    },
    content: content.length ? content : [{ type: 'paragraph' }],
  };
}

// ─── Lists ───────────────────────────────────────────────────────────────

function numberingTables(numbering: ONode | undefined, ctx: MapContext): void {
  if (!numbering) return;
  for (const abs of oKids(numbering, 'abstractNum')) {
    const abstractId = oat(abs, 'abstractNumId');
    if (abstractId == null) continue;
    const levels = new Map<number, { fmt: string; text: string }>();
    for (const lvl of oKids(abs, 'lvl')) {
      const ilvl = onum(lvl, 'ilvl');
      const fmt = oat(oSub(lvl, 'numFmt'), 'val');
      const marker = oat(oSub(lvl, 'lvlText'), 'val');
      if (ilvl != null && fmt) levels.set(ilvl, { fmt, text: marker ?? '' });
    }
    ctx.numberingLevels.set(abstractId, levels);
  }
  for (const num of oKids(numbering, 'num')) {
    const numId = oat(num, 'numId');
    const abstract = ovalNum(num, 'abstractNumId');
    if (numId != null && abstract != null) ctx.numberingMap.set(numId, String(abstract));
    // Restart fidelity: Word's startOverride at level 0 IS the list's
    // start (Tensor's ordered-list start attr).
    for (const override of oKids(num, 'lvlOverride')) {
      if ((onum(override, 'ilvl') ?? 0) !== 0) continue;
      const startOverride = onum(oSub(override, 'startOverride'), 'val');
      if (startOverride != null && numId != null) ctx.numberingStarts.set(numId, startOverride);
    }
  }
}

function listSpec(numId: number, ilvl: number, ctx: MapContext): { listType: 'bulletList' | 'orderedList'; styleType: string; start?: number } {
  const abstractId = ctx.numberingMap.get(String(numId));
  const levels = abstractId ? ctx.numberingLevels.get(abstractId) : undefined;
  const level = levels?.get(ilvl);
  const fmt = level?.fmt ?? 'decimal';
  if (!level) ctx.report.unknownNumbering += 1;
  // Restart fidelity: the num's level-0 startOverride IS the Tensor
  // start (only meaningful for the list's own top level).
  const start = ilvl === 0 ? ctx.numberingStarts.get(String(numId)) : undefined;
  if (fmt === 'bullet') {
    const marker = level?.text ?? '';
    const styleType = marker === 'o' ? 'circle' : marker === '\u25A0' || marker === '\u25AA' ? 'square' : 'disc';
    return { listType: 'bulletList', styleType };
  }
  const ordered: Record<string, string> = {
    decimal: 'decimal',
    lowerRoman: 'lower-roman',
    upperRoman: 'upper-roman',
    lowerLetter: 'lower-alpha',
    upperLetter: 'upper-alpha',
  };
  const styleType = ordered[fmt];
  if (styleType) return { listType: 'orderedList', styleType, ...(start != null && start !== 1 ? { start } : {}) };
  ctx.report.unknownNumbering += 1;
  return { listType: 'orderedList', styleType: 'decimal', ...(start != null && start !== 1 ? { start } : {}) };
}

// ─── Section properties → page setup + bands ─────────────────────────────

interface SectionResult {
  pageSetup: PageSetup;
  headerFooter: HeaderFooterSettings;
  lineNumbers: LineNumbersSetting | null;
  bands: JSONContent[];
  /** #58 — Word's sectPr `type`: how THIS section begins
   *  ('continuous' | 'nextPage' — the default). */
  type: 'nextPage' | 'continuous';
}

function mapSection(sectPr: ONode, ctx: MapContext, trees: DocxTrees): SectionResult {
  const pgSz = oSub(sectPr, 'pgSz');
  let widthPt = Math.round((onum(pgSz, 'w') ?? 12240) / 20);
  let heightPt = Math.round((onum(pgSz, 'h') ?? 15840) / 20);
  const landscape = oat(pgSz, 'orient') === 'landscape';
  // The stored (Tensor) spelling is PORTRAIT dims + an orientation flag.
  if (landscape) [widthPt, heightPt] = [heightPt, widthPt];
  const presetKey = findMatchingPreset(Math.min(widthPt, heightPt), Math.max(widthPt, heightPt));
  const pageSetup: PageSetup = {
    pageSize: presetKey ?? 'custom',
    margins: { top: 72, bottom: 72, left: 72, right: 72 },
    pageGap: 32,
    orientation: landscape ? 'landscape' : undefined,
  };
  if (!presetKey) {
    pageSetup.customWidth = Math.min(widthPt, heightPt);
    pageSetup.customHeight = Math.max(widthPt, heightPt);
  }
  const pgMar = oSub(sectPr, 'pgMar');
  if (pgMar) {
    // twips → pt: ÷20 (the store holds POINTS).
    const top = onum(pgMar, 'top');
    const bottom = onum(pgMar, 'bottom');
    const left = onum(pgMar, 'left');
    const right = onum(pgMar, 'right');
    if (top != null) pageSetup.margins.top = Math.round(top / 20);
    if (bottom != null) pageSetup.margins.bottom = Math.round(bottom / 20);
    if (left != null) pageSetup.margins.left = Math.round(left / 20);
    if (right != null) pageSetup.margins.right = Math.round(right / 20);
  }

  const headerFooter = defaultHeaderFooterSettings();
  headerFooter.differentFirstPage = oSub(sectPr, 'titlePg') != null;

  // #58 — the section START type (Word's w:type; absent = nextPage).
  const startType: 'nextPage' | 'continuous' =
    oat(oSub(sectPr, 'type'), 'val') === 'continuous' ? 'continuous' : 'nextPage';

  const lineNumbers: LineNumbersSetting | null = (() => {
    const ln = oSub(sectPr, 'lnNumType');
    if (!ln) return null;
    const countBy = onum(ln, 'countBy') ?? 1;
    const restart = oat(ln, 'restart') ?? 'continuous';
    return { enabled: true, mode: restart === 'newPage' ? 'per-page' : 'continuous', countBy: Math.max(1, countBy) };
  })();

  const bands: JSONContent[] = [];
  for (const ref of [...oKids(sectPr, 'headerReference'), ...oKids(sectPr, 'footerReference')]) {
    const type = oat(ref, 'type') ?? 'default';
    const relId = oat(ref, 'id');
    const rel = relId ? trees.rels.get(relId) : undefined;
    if (!rel || rel.external) continue;
    if (type === 'even') { ctx.report.evenOddHeaders += 1; continue; }
    const part = trees.parts[rel.target];
    if (!part) continue;
    const root = parseOrdered(new TextDecoder().decode(part));
    // The part roots are w:hdr / w:ftr.
    const body = root.tag === 'hdr' || root.tag === 'ftr' ? root : (oSub(root, 'hdr') ?? oSub(root, 'ftr'));
    if (!body) continue;
    const content: JSONContent[] = [];
    for (const p of oKids(body, 'p')) {
      const mapped = mapParagraph(p, ctx, trees.rels);
      if (mapped.json) content.push(mapped.json);
    }
    bands.push({
      type: ref.tag === 'headerReference' ? 'headerBlock' : 'footerBlock',
      attrs: { variant: type === 'first' ? 'first' : 'default' },
      content,
    });
  }

  return { pageSetup, headerFooter, lineNumbers, bands, type: startType };
}

// ─── Core properties ─────────────────────────────────────────────────────

function mapCoreProperties(core: ONode | undefined): DocumentCoreProperties {
  if (!core) return {};
  const pick = (tag: string): string | undefined => {
    const value = oSub(core, tag)?.text ?? '';
    return value.trim() || undefined;
  };
  return {
    ...(pick('title') ? { title: pick('title') } : {}),
    ...(pick('creator') ? { author: pick('creator') } : {}),
    ...(pick('subject') ? { subject: pick('subject') } : {}),
    ...(pick('keywords') ? { keywords: pick('keywords') } : {}),
    ...(pick('description') ? { comments: pick('description') } : {}),
  };
}

// ─── Styles import ───────────────────────────────────────────────────────

function importStyles(trees: DocxTrees, policy: 'keep' | 'substitute'): { definitions: StyleDefinition[] } {
  const stylesRoot = trees.styles;
  const docDefaults = runPropsFromRPr(
    oSub(oSub(oSub(stylesRoot, 'docDefaults'), 'rPrDefault'), 'rPr'),
    policy,
    trees.theme,
    trees.themeColors,
  );

  const raw = new Map<string, { basedOn?: string; name: string; kind: 'paragraph' | 'character'; run: StyleProperties; para: StyleProperties }>();
  const referenced = collectReferencedStyleIds(trees.document);
  for (const style of oKids(stylesRoot, 'style')) {
    const id = oat(style, 'styleId');
    const kind = oat(style, 'type');
    if (id == null || (kind !== 'paragraph' && kind !== 'character')) continue;
    raw.set(id, {
      basedOn: oat(oSub(style, 'basedOn'), 'val') ?? undefined,
      name: oat(oSub(style, 'name'), 'val') ?? id,
      kind: kind === 'character' ? 'character' : 'paragraph',
      run: runPropsFromRPr(oSub(style, 'rPr'), policy, trees.theme, trees.themeColors),
      para: paraPropsFromPPPr(oSub(style, 'pPr')),
    });
  }

  // Referenced ids + their basedOn chains, plus the builtin tiers Word
  // always implies (Heading/Normal).
  const wanted = new Set<string>(['Normal', ...[1, 2, 3, 4, 5, 6].map((n) => `Heading${n}`)]);
  for (const id of referenced) wanted.add(id);
  for (const id of [...wanted]) {
    let cursor: string | undefined = id;
    const guard = new Set<string>();
    while (cursor && raw.has(cursor) && !guard.has(cursor)) {
      guard.add(cursor);
      wanted.add(cursor);
      cursor = raw.get(cursor)?.basedOn;
    }
  }

  const memo = new Map<string, StyleProperties>();
  const definitions: StyleDefinition[] = [];
  for (const id of wanted) {
    const entry = raw.get(id);
    if (!entry) continue; // referenced but undefined — Word default styling
    definitions.push({
      id: tensorStyleId(id),
      name: entry.name,
      kind: entry.kind,
      properties: pruneDefaults(resolveStyleProps(id, raw, docDefaults, memo)),
    });
  }
  return { definitions };
}

function collectReferencedStyleIds(document: ONode): Set<string> {
  const ids = new Set<string>();
  const scan = (node: ONode): void => {
    if (node.tag === 'pStyle' || node.tag === 'rStyle') {
      const val = oat(node, 'val');
      if (val) ids.add(val);
    }
    for (const kid of node.kids) scan(kid);
  };
  scan(document);
  return ids;
}

/** Style properties at their defaults are dropped — the doc layer then
 *  overrides globals only where Word's styles actually differ. */
function pruneDefaults(props: StyleProperties): StyleProperties {
  const out: StyleProperties = { ...props };
  if (out.textAlign === 'left') delete out.textAlign;
  if (out.textTransform === 'none') delete out.textTransform;
  if (out.fontVariant === 'normal') delete out.fontVariant;
  return out;
}

// ─── The body assembler ──────────────────────────────────────────────────

export interface DocxImportParsed {
  json: JSONContent;
  pageSetup: PageSetup;
  headerFooter: HeaderFooterSettings;
  lineNumbers: LineNumbersSetting | null;
  coreProperties: DocumentCoreProperties;
  styleDefinitions: StyleDefinition[];
  report: DocxImportReport;
}

export function mapDocxDocument(
  trees: DocxTrees,
  opts: { fontPolicy: 'keep' | 'substitute'; mediaPartToId: Map<string, string> },
): DocxImportParsed {
  const ctx: MapContext = {
    policy: opts.fontPolicy,
    theme: trees.theme,
    themeColors: trees.themeColors,
    mediaPartToId: opts.mediaPartToId,
    report: emptyReport(),
    numberingMap: new Map(),
    numberingStarts: new Map(),
    numberingLevels: new Map(),
    fieldDepth: 0,
    fieldInstr: [],
    tocCapture: null,
    tocEnd: false,
  };
  numberingTables(trees.numbering, ctx);
  const styles = importStyles(trees, ctx.policy);

  const body = oSub(trees.document, 'body');

  // The body walk with the LIST MACHINE: consecutive numbered
  // paragraphs (same numId, nesting by ilvl) rebuild PM lists; any
  // non-numbered block ends the run (numbering restarts there). The
  // ONode walk preserves document order — p/tbl interleaving is real.
  const output: JSONContent[] = [];
  const listStack: { numId: number; list: JSONContent; lastItem: JSONContent }[] = [];
  let sectionBreaks = 0;

  // ── #58 SECTIONS — the un-collapse (#57): Word's mid-doc sectPr
  // ends the PRECEDING section (its props describe everything since
  // the previous break); the FINAL sectPr (the walk's last) is the
  // store's pageSetup. The walk can't know which sectPr is last, so
  // each mapping is held PENDING and flushed when the NEXT sectPr
  // arrives — the survivor is the final section (store props +
  // UNTAGGED band containers = the doc default; every flushed one
  // emits a sectionBreak node + ITS OWN tagged band containers).
  const flushedSections: {
    setup: PageSetup;
    sectionId: string;
    bands: JSONContent[];
    /** The section's own titlePg (the doc flag resolves from the FIRST). */
    titlePg: boolean;
  }[] = [];
  let pendingSection: (SectionResult & { sectionId: string }) | null = null;
  let sectionOrdinal = 0;
  // The FOLLOWING sectPr's start type — the boundary AT the flushed
  // break is where that section begins (the break node's `type` attr).
  let nextStartType: 'nextPage' | 'continuous' = 'nextPage';

  const flushPendingSection = (): void => {
    if (!pendingSection) return;
    const sectionId = `sec-imp-${sectionOrdinal}`;
    flushedSections.push({
      setup: pendingSection.pageSetup,
      sectionId,
      bands: pendingSection.bands,
      titlePg: pendingSection.headerFooter.differentFirstPage === true,
    });
    output.push({
      type: 'sectionBreak',
      attrs: { setup: pendingSection.pageSetup, sectionId, type: nextStartType },
    });
    sectionOrdinal += 1;
    pendingSection = null;
    nextStartType = 'nextPage';
  };

  const feedList = (numId: number, ilvl: number, paragraph: JSONContent): void => {
    // The stack holds levels 0..depth; feeding level L keeps 0..L —
    // popping down to length L+1 (the old `> ilvl` popped the TARGET
    // level and split every two-item list into two).
    while (listStack.length > ilvl + 1) listStack.pop();
    let level = ilvl;
    if (level > 0 && !listStack[level - 1]) level = listStack.length; // orphan depth — clamp
    const top = listStack[level];
    const item: JSONContent = { type: 'listItem', content: [paragraph] };
    if (top && top.numId === numId) {
      if (level === 0) top.list.content!.push(item);
      else listStack[level - 1]!.lastItem.content!.push(item);
      listStack[level].lastItem = item;
      return;
    }
    const spec = listSpec(numId, level, ctx);
    const list: JSONContent = {
      type: spec.listType,
      attrs: { listStyleType: spec.styleType, ...(spec.start != null ? { start: spec.start } : {}) },
      content: [item],
    };
    if (level === 0) output.push(list);
    else listStack[level - 1]!.lastItem.content!.push(list);
    listStack[level] = { numId, list, lastItem: item };
    listStack.length = level + 1;
  };

  const emitBlock = (block: JSONContent, numPr: { numId: number; ilvl: number } | null): void => {
    const promoted = numPr ? block : promoteSoloImage(block);
    if (numPr) feedList(numPr.numId, numPr.ilvl, promoted);
    else {
      listStack.length = 0; // any non-numbered block ends the list run
      output.push(promoted);
    }
  };

  /** THE CAPTURE-AWARE EMIT: while a TOC field is being read, mapped
   *  paragraphs are its entries; the field's end builds the live
   *  referenceTable. */
  const emitMapped = (mapped: ParagraphResult): void => {
    if (!mapped.json) return;
    if (ctx.tocCapture) {
      ctx.tocCapture.entries.push(mapped.json);
      listStack.length = 0; // a ToC block ends any open list run
      if (ctx.tocEnd) {
        output.push(buildTocRefTable(ctx.tocCapture));
        ctx.tocCapture = null;
        ctx.tocEnd = false;
      }
      return;
    }
    ctx.tocEnd = false;
    emitBlock(mapped.json, mapped.numPr);
  };

  for (const kid of body?.kids ?? []) {
    switch (kid.tag) {
      case 'p': {
        const mapped = mapParagraph(kid, ctx, trees.rels);
        // The paragraph's content belongs to the ENDING section — it
        // emits BEFORE the break node (Word: the sectPr rides the
        // section's last paragraph's pPr; the break follows it).
        emitMapped(mapped);
        if (mapped.sectPr) {
          const incoming = mapSection(mapped.sectPr, ctx, trees);
          nextStartType = incoming.type;
          if (pendingSection) sectionBreaks += 1;
          flushPendingSection();
          pendingSection = { ...incoming, sectionId: '' };
        }
        break;
      }
      case 'tbl':
        if (!ctx.tocCapture) emitBlock(mapTable(kid, ctx, trees.rels), null);
        break;
      case 'sectPr': {
        // #58 — the delayed flush: the PREVIOUS pending sectPr ends a
        // section HERE (a real mid-doc break); this mapping becomes
        // the new pending (the final survivor becomes the store's).
        const incomingSection = mapSection(kid, ctx, trees);
        nextStartType = incomingSection.type;
        if (pendingSection) sectionBreaks += 1;
        flushPendingSection();
        pendingSection = { ...incomingSection, sectionId: '' };
        break;
      }
      case 'ins': {
        // block-level tracked insertion — its paragraphs are kept
        for (const p of oKids(kid, 'p')) {
          emitMapped(mapParagraph(p, ctx, trees.rels));
        }
        break;
      }
      case 'del':
        ctx.report.trackedChanges += 1; // deleted paragraphs accepted
        break;
      case 'sdt': {
        const inner = oSub(kid, 'sdtContent');
        for (const p of oKids(inner, 'p')) {
          emitMapped(mapParagraph(p, ctx, trees.rels));
        }
        for (const tbl of oKids(inner, 'tbl')) {
          if (!ctx.tocCapture) emitBlock(mapTable(tbl, ctx, trees.rels), null);
        }
        break;
      }
      case 'bookmarkStart':
      case 'bookmarkEnd':
        break;
      default:
        ctx.report.unknownNodes += 1;
        break;
    }
  }
  ctx.report.sectionBreaks = sectionBreaks;

  // ── #58 — the band INHERITANCE CHAIN (Word's "link to previous" is
  // CHAINED: section k's header = its own refs ?? section k−1's
  // resolved). Our model is two-level (section override ?? doc
  // default), so the chain MATERIALIZES: each flushed section whose
  // effective bands differ from the FINAL section's effective bands
  // gets its own tagged containers; matching sections emit NOTHING
  // (they inherit the doc default = the final's effective — exact
  // visual fidelity, no dead containers).
  const finalBands = pendingSection?.bands ?? [];
  const effectiveOf = (own: JSONContent[], inherited: JSONContent[]): JSONContent[] => {
    // Per region (headerBlock/footerBlock × variant): own wins, else
    // the inherited resolved set.
    const resolved = [...inherited];
    for (const band of own) {
      const variant = (band.attrs as { variant?: string } | null)?.variant === 'first' ? 'first' : 'default';
      const idx = resolved.findIndex(
        (b) => b.type === band.type && ((b.attrs as { variant?: string } | null)?.variant === 'first' ? 'first' : 'default') === variant,
      );
      if (idx >= 0) resolved[idx] = band;
      else resolved.push(band);
    }
    return resolved;
  };
  let chain: JSONContent[] = [];
  const sectionBands: { sectionId: string; effective: JSONContent[] }[] = [];
  for (const flushed of flushedSections) {
    chain = effectiveOf(flushed.bands, chain);
    sectionBands.push({ sectionId: flushed.sectionId, effective: chain });
  }
  const finalEffective = effectiveOf(finalBands, chain);
  const sameBands = (a: JSONContent[], b: JSONContent[]): boolean =>
    a.length === b.length && a.every((band, i) => {
      if (b[i]!.type !== band.type) return false;
      if (((b[i]!.attrs as { variant?: string } | null)?.variant === 'first' ? 'first' : 'default') !==
          ((band.attrs as { variant?: string } | null)?.variant === 'first' ? 'first' : 'default')) return false;
      return JSON.stringify(b[i]!.content ?? []) === JSON.stringify(band.content ?? []);
    });

  const taggedHeaderBlocks: JSONContent[] = [];
  const taggedFooterBlocks: JSONContent[] = [];
  for (const entry of sectionBands) {
    for (const band of entry.effective) {
      const type = band.type === 'headerBlock' ? 'headerBlock' : 'footerBlock';
      const match = finalEffective.find(
        (b) => b.type === type &&
          ((b.attrs as { variant?: string } | null)?.variant === 'first' ? 'first' : 'default') ===
            ((band.attrs as { variant?: string } | null)?.variant === 'first' ? 'first' : 'default'),
      );
      if (match && sameBands([match], [band])) continue; // inherits the doc default
      const json = structuredClone(band);
      json.attrs = { ...(json.attrs as Record<string, unknown> | undefined), sectionId: entry.sectionId };
      (type === 'headerBlock' ? taggedHeaderBlocks : taggedFooterBlocks).push(json);
    }
  }

  // The FINAL section's effective bands = the UNTAGGED doc default
  // (every non-overriding section inherits them — the two-level model).
  const headerBlocks = finalEffective.filter((b) => b.type === 'headerBlock');
  const footerBlocks = finalEffective.filter((b) => b.type === 'footerBlock');

  // titlePg: the doc-level flag governs the DOC's page 0 (section 0's
  // first page) — the FIRST section's titlePg. A non-first section's
  // titlePg has no v1 model (per-section first-page) — counted.
  const firstTitlePg = flushedSections[0]?.titlePg === true;
  let otherTitlePgs = 0;
  for (let i = 1; i < flushedSections.length; i++) {
    if (flushedSections[i]!.titlePg) otherTitlePgs += 1;
  }
  if (pendingSection?.headerFooter.differentFirstPage === true && sectionBreaks > 0) {
    otherTitlePgs += 1; // the final section's titlePg (a non-first section)
  }
  if (otherTitlePgs > 0) ctx.report.perSectionFirstPage += otherTitlePgs;

  return {
    json: { type: 'doc', content: [...taggedHeaderBlocks, ...headerBlocks, ...output, ...footerBlocks, ...taggedFooterBlocks] },
    pageSetup: pendingSection?.pageSetup ?? { pageSize: 'Letter', margins: { top: 72, bottom: 72, left: 72, right: 72 }, pageGap: 32 },
    headerFooter: {
      ...(pendingSection?.headerFooter ?? defaultHeaderFooterSettings()),
      differentFirstPage: firstTitlePg || (sectionBreaks === 0 && (pendingSection?.headerFooter.differentFirstPage === true)),
    },
    lineNumbers: pendingSection?.lineNumbers ?? null,
    coreProperties: mapCoreProperties(trees.core),
    styleDefinitions: styles.definitions,
    report: ctx.report,
  };
}

// ─── The promotion (export's inverse) ────────────────────────────────────

/** A paragraph whose ONLY content is one image is the standalone-figure
 *  spelling — it becomes the BLOCK image node. The paragraph's
 *  alignment (jc) transfers to the image's align attr, so centered
 *  figures round-trip. */
function promoteSoloImage(block: JSONContent): JSONContent {
  if (
    block.type === 'paragraph' &&
    Array.isArray(block.content) &&
    block.content.length === 1 &&
    block.content[0].type === 'image'
  ) {
    const image = block.content[0]!;
    const align = (block.attrs as { textAlign?: string } | undefined)?.textAlign;
    return {
      ...image,
      attrs: {
        ...(image.attrs ?? {}),
        ...(align === 'center' || align === 'right' ? { align } : {}),
      },
    };
  }
  return block;
}

/** THE TOC CONVERSION: Word's field becomes a Tensor referenceTable —
 *  the depth rides the \o switch ("1-3" → 3); the captured entry
 *  paragraphs seed the container (the generator rebuilds them from the
 *  document's headings on open — a live ToC from a dead field). */
function parseTocDepth(instr: string): number {
  const range = /\o\s+"?([0-9])[-\u2013]([0-9])"?/i.exec(instr);
  if (range) return Math.min(6, Math.max(1, Number(range[2])));
  const single = /\o\s+"?(\d)"?/i.exec(instr);
  if (single) return Math.min(6, Math.max(1, Number(single[1])));
  return 3;
}

function buildTocRefTable(capture: { depth: number; entries: JSONContent[] }): JSONContent {
  return {
    type: 'referenceTable',
    attrs: { kind: 'toc', depth: capture.depth, leaders: true, numberDisplay: 'plain' },
    content: capture.entries,
  };
}

// ─── Media ingest (the flow's seam) ──────────────────────────────────────

export interface DocxMediaEntry { id: string; ext: string; bytes: Uint8Array }

/** Content-address the media parts (sha256 — the MediaStore contract;
 *  identical images dedupe naturally). Returns the part→id map for the
 *  mapper and the entries for the store. */
export async function ingestDocxMedia(parts: Record<string, Uint8Array>): Promise<{ partToId: Map<string, string>; entries: DocxMediaEntry[] }> {
  const { sha256Hex } = await import('@/lib/media/insert');
  const partToId = new Map<string, string>();
  const entries: DocxMediaEntry[] = [];
  const byId = new Map<string, DocxMediaEntry>();
  for (const [name, bytes] of Object.entries(parts)) {
    if (!name.startsWith('word/media/')) continue;
    const ext = (name.split('.').pop() ?? 'png').toLowerCase();
    const id = await sha256Hex(bytes);
    partToId.set(name, id);
    if (!byId.has(id)) {
      const entry: DocxMediaEntry = { id, ext, bytes };
      byId.set(id, entry);
      entries.push(entry);
    }
  }
  return { partToId, entries };
}
