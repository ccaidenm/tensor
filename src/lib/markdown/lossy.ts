import type { JSONContent } from '@tiptap/core';

/**
 * M-MD — the lossy classifier. ONE walk over the document JSON answers
 * "what would this export lose?", and the answer gates the export
 * (ruling 2): content Markdown cannot represent produces a CONFIRM
 * before the save dialog — never a silent loss, never a post-hoc
 * apology.
 *
 * THE LINE (the inserted-image cry-wolf fix): the confirm fires for
 * (a) content that DISAPPEARS (band text, reference tables, page
 * breaks) and (b) TEXT formatting Markdown cannot express (custom
 * styles, colors, fonts, sizes, alignment, spacing, indents, tab
 * stops). OBJECT DECORATION does not warn — images, equations, tables
 * and lists are all REPRESENTED in Markdown and merely lose paint
 * attrs (size, shading, borders, numbering style); those are
 * documented in docs/markdown.md, and warning on them would fire at
 * the first inserted image (insert always stamps natural dimensions).
 *
 * The classifier is deliberately coarse: the user is asked about
 * CATEGORIES, not per-node minutiae. The same walk defines what
 * "clean" means: a document none of whose categories fire exports with
 * NO dialog — headings, lists, bold, images through the stock handlers
 * are not lossy by definition.
 */

export interface MarkdownLossyReport {
  /** headerBlock/footerBlock regions that carry content — the band
   *  text is document-level structure with no Markdown spelling. */
  headerFooterRegions: number;
  /** referenceTable containers — their entries are DERIVED content
   *  (the generator owns them); neither container nor entries export. */
  referenceTables: number;
  /** pageBreak atoms — Markdown has no page concept. */
  pageBreaks: number;
  /** Any dropped formatting at all (marks, style ids, alignment,
   *  spacing, indents, tab stops, image sizing, table decoration). */
  customFormatting: boolean;
}

/**
 * Marks that round-trip through Markdown (stock handlers or the
 * official extension's conventions). Everything else visible is a loss.
 * indexEntry/refLeader are INVISIBLE structural marks (reference
 * machinery) — they carry no formatting a reader would miss.
 */
const KEPT_MARKS = new Set([
  'bold',
  'italic',
  'strike',
  'code',
  'link',
  'highlight',
  'underline',
  'indexEntry',
  'refLeader',
]);

export function analyzeMarkdownLossy(doc: JSONContent): MarkdownLossyReport {
  const report: MarkdownLossyReport = {
    headerFooterRegions: 0,
    referenceTables: 0,
    pageBreaks: 0,
    customFormatting: false,
  };
  walk(doc, report);
  return report;
}

/** Whether the export needs the confirm dialog at all. */
export function hasLossyContent(report: MarkdownLossyReport): boolean {
  return (
    report.headerFooterRegions > 0 ||
    report.referenceTables > 0 ||
    report.pageBreaks > 0 ||
    report.customFormatting
  );
}

/** The structured loss lines — the dialog's bullets (only the
 *  categories present). */
export function markdownLossyLines(report: MarkdownLossyReport): string[] {
  const lines: string[] = [];
  if (report.headerFooterRegions > 0) {
    lines.push(
      `Header/footer content (${report.headerFooterRegions} region${
        report.headerFooterRegions === 1 ? '' : 's'
      })`,
    );
  }
  if (report.referenceTables > 0) {
    lines.push(`Reference tables (${report.referenceTables})`);
  }
  if (report.pageBreaks > 0) {
    lines.push(`Page breaks (${report.pageBreaks})`);
  }
  if (report.customFormatting) {
    lines.push(
      'Custom formatting (fonts, colors, sizes, alignment, spacing, indents, custom styles)',
    );
  }
  return lines;
}

/** The plain-text spelling of the same report (tests / logs). */
export function buildLossyWarning(report: MarkdownLossyReport): string {
  return [
    'This document uses content that Markdown cannot represent:',
    ...markdownLossyLines(report).map((line) => `• ${line}`),
    '',
    'The exported file may not look like this document.',
  ].join('\n');
}

/** A band container counts only when it holds something real — an
 *  empty region (all children content-less) is not lost content. */
function bandHasContent(node: JSONContent): boolean {
  return (
    Array.isArray(node.content) &&
    node.content.some(
      (child) => Array.isArray(child.content) && child.content.length > 0,
    )
  );
}

function walk(node: JSONContent, report: MarkdownLossyReport): void {
  switch (node.type) {
    case 'headerBlock':
    case 'footerBlock':
      if (bandHasContent(node)) report.headerFooterRegions += 1;
      return; // the band content is skipped wholesale — don't descend
    case 'referenceTable':
      report.referenceTables += 1;
      return; // entries are derived projection — counted with the container
    case 'pageBreak':
      report.pageBreaks += 1;
      return;
  }
  checkFormatting(node, report);
  if (Array.isArray(node.content)) {
    for (const child of node.content) walk(child, report);
  }
}

function truthy(value: unknown): boolean {
  return value !== null && value !== undefined && value !== 0 && value !== '' && value !== false;
}

/** The per-node formatting checks. Defaults are the schema defaults —
 *  only deviations from them are losses. */
function checkFormatting(node: JSONContent, report: MarkdownLossyReport): void {
  // Text marks: anything outside the kept set (or a textStyle actually
  // carrying color/font/size) is dropped formatting.
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      if (child.type !== 'text' || !Array.isArray(child.marks)) continue;
      for (const mark of child.marks) {
        if (mark.type === 'textStyle') {
          const attrs = mark.attrs as Record<string, unknown> | undefined;
          if (attrs && (truthy(attrs.color) || truthy(attrs.fontFamily) || truthy(attrs.fontSize))) {
            report.customFormatting = true;
          }
        } else if (!KEPT_MARKS.has(mark.type)) {
          report.customFormatting = true;
        }
      }
    }
  }

  const attrs = (node.attrs ?? {}) as Record<string, unknown>;

  switch (node.type) {
    case 'paragraph':
    case 'heading': {
      // styleId invariant: every block carries one; the implicit tier
      // default ('normal' / 'heading-N') is NOT a loss — a custom id is.
      const tierDefault = node.type === 'heading' ? `heading-${attrs.level ?? 1}` : 'normal';
      if (typeof attrs.styleId === 'string' && attrs.styleId !== tierDefault) {
        report.customFormatting = true;
      }
      if (truthy(attrs.textAlign)) report.customFormatting = true;
      if (truthy(attrs.lineHeight)) report.customFormatting = true;
      if (truthy(attrs.firstLineIndent)) report.customFormatting = true;
      if (truthy(attrs.indent)) report.customFormatting = true;
      if (truthy(attrs.indentLeft)) report.customFormatting = true;
      if (truthy(attrs.indentRight)) report.customFormatting = true;
      if (truthy(attrs.spaceBefore)) report.customFormatting = true;
      if (truthy(attrs.spaceAfter)) report.customFormatting = true;
      if (truthy(attrs.tabStops)) report.customFormatting = true;
      if (truthy(attrs.refId)) report.customFormatting = true;
      return;
    }
    case 'bulletList':
    case 'orderedList':
    case 'table':
    case 'tableCell':
    case 'tableHeader':
    case 'image':
    case 'inlineImage':
    case 'equation':
      // OBJECT DECORATION — documented, never warned. These objects are
      // all REPRESENTED in Markdown (the image renders, the cells keep
      // their text, the equation's latex travels); only their paint
      // attrs drop (image size/align/radius/float, cell shading/
      // padding, table borders/flow, list numbering styles, equation
      // align/color/scale). Warning on them cried wolf at the first
      // inserted image — insert always stamps natural dimensions — so
      // the confirm reserves itself for what disappears or how TEXT
      // reads (see the paragraph/heading case above).
      return;
  }
}
