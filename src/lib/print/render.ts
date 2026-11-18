import {
  fitDownImage,
  type LayoutResult,
  type LineBox,
  type TextStyle,
} from '@tensor-editor/engine';
import type { AdapterBlock, RunDecor } from '@/lib/paginated/adapter';
import { alignOffset, fieldShiftBefore, lineColumnFrame } from '@/lib/paginated/positionMap';
import type { TextMetricsPort } from '@/lib/print/metricsPort';
import { bulletMarkerText, orderedMarkerText } from '@/lib/print/markers';

export * from './types';
import type { PrintElement, PrintImage, PrintPage } from './types';

/**
 * M-PRINT (#43/#39) — THE PRINT RENDERER: the engine's placement facts
 * → positioned print elements. ONE walk, THREE consumers (the preview,
 * window.print, the PDF synthesizer). THE ONE-GEOMETRY LAW: every
 * position derives through the SAME functions the canvas paint uses —
 * alignOffset, fieldShiftBefore, fitDownImage — so printed output
 * matches the on-screen pagination by construction, which is #43's
 * core acceptance criterion.
 *
 * WHAT DOES NOT PRINT (the canvas/paint-vs-print split — ink vs.
 * editing state): NPC substitutes (¶/·/→), spell squiggles, search
 * highlights, selection, the muted-band desaturation (bands print
 * FULL ink — mute is an editing state), reference field borders
 * (selection-driven chrome), line-number gutters (chrome). WHAT
 * DOES: leader dots (part of the document's ink — the reference
 * tables' page numbers print resolved).
 */

const DEFAULT_TEXT_COLOR = '#000';
const QUOTE_BORDER_COLOR = '#d4d4d8';
const QUOTE_BG_COLOR = 'rgba(0, 0, 0, 0.04)';
const CODE_BG_COLOR = '#f4f4f5';
const RULE_COLOR = '#a1a1aa';
const LIST_INDENT_PX = 32;

export interface PrintRenderInput {
  result: LayoutResult;
  blocks: readonly AdapterBlock[];
  /** The REAL metrics (the on-screen singleton) — identical layout. */
  metrics: TextMetricsPort;
  /** sha → renderable URL (the bitmap cache's img.src). */
  bitmapSrc: (sha: string) => string | undefined;
  /** The warm page total (field placeholder width source). */
  fieldTotal: number;
}

export function renderPrintDocument(input: PrintRenderInput): PrintPage[] {
  const { result, blocks, metrics, bitmapSrc, fieldTotal } = input;
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const pages: PrintPage[] = result.pages.map((p) => ({
    index: p.index,
    width: p.size.width,
    height: p.size.height,
    elements: [],
  }));

  for (const page of pages) {
    const geo = result.pages[page.index]!;
    const cb = geo.contentBox;

    // 1. TABLE CELL FILLS (under everything).
    for (const p of result.placed) {
      if (p.kind !== 'tableCell' || p.pageIndex !== page.index) continue;
      if (!p.cell?.fill) continue;
      page.elements.push({
        kind: 'rect',
        x: cb.x + p.rect.x,
        top: cb.y + p.rect.y,
        width: p.rect.width,
        height: p.rect.height,
        fill: p.cell.fill,
      });
    }

    // 2. TABLE BORDERS — the merged boundary segments (shared inner
    //    edges stroke ONCE; rowspan slice internals vanish — the
    //    TableCellLayer algorithm, mirrored). The BORDER PRESET is the
    //    table's own (all/none/outer — 'outer' strokes the frame only).
    const cellRects = result.placed.filter(
      (p) => p.kind === 'tableCell' && p.pageIndex === page.index && p.cell,
    );
    const borderPreset = cellRects[0]?.cell?.border ?? 'all';
    for (const seg of mergedBorderSegments(cellRects, borderPreset)) {
      if (seg.vertical) {
        page.elements.push({
          kind: 'line',
          x: cb.x + seg.at,
          top: cb.y + seg.a,
          width: 1,
          height: seg.b - seg.a,
          color: '#000',
        });
      } else {
        page.elements.push({
          kind: 'line',
          x: cb.x + seg.a,
          top: cb.y + seg.at,
          width: seg.b - seg.a,
          height: 1,
          color: '#000',
        });
      }
    }

    // 3. BEHIND FLOATS (under the text ink).
    for (const p of result.placed) {
      if (p.kind !== 'image' || p.pageIndex !== page.index) continue;
      if (p.z !== 'behind') continue;
      page.elements.push(printImageOf(p, cb, bitmapSrc));
    }

    // 4. THE LINES (doc order): block decor under text, then ink.
    for (const line of result.lines) {
      if (line.pageIndex !== page.index) continue;
      const block = byId.get(line.blockId);
      if (!block) continue;
      renderLine(page.elements, line, block, cb, metrics, bitmapSrc, fieldTotal, page.index, lineColumnFrame(geo, line));
    }

    // 5. EQUATIONS (block atoms; DOM/KaTeX above the decor).
    for (const p of result.placed) {
      if (p.kind !== 'equation' || p.pageIndex !== page.index) continue;
      page.elements.push({
        kind: 'equation',
        x: cb.x + p.rect.x,
        top: cb.y + p.rect.y,
        width: p.rect.width,
        height: p.rect.height,
        latex: p.latex ?? '',
        fontSize: p.fontSize ?? 16,
        color: DEFAULT_TEXT_COLOR,
      });
    }

    // 6. BLOCK IMAGES + FRONT FLOATS (above text).
    for (const p of result.placed) {
      if (p.kind !== 'image' || p.pageIndex !== page.index) continue;
      if (p.z === 'behind') continue;
      page.elements.push(printImageOf(p, cb, bitmapSrc));
    }
  }

  return pages;
}

/** One line → elements (the paintLines mirror, positioned not drawn).
 *  `columnFrame` (#74): the line's COLUMN frame (content-box-relative
 *  left/width) — the decor surfaces and the align container are the
 *  column's; absent ≡ the content box (single-column, bit-identical). */
function renderLine(
  into: PrintElement[],
  line: LineBox,
  block: AdapterBlock,
  cb: { x: number; y: number; width: number },
  metrics: TextMetricsPort,
  bitmapSrc: (sha: string) => string | undefined,
  fieldTotal: number,
  pageIndex: number,
  columnFrame?: { left: number; width: number },
): void {
  const columnLeft = columnFrame?.left ?? 0;
  const columnWidth = columnFrame?.width ?? cb.width;
  const off = alignOffset(block.align, line.rect.width, columnLeft + columnWidth - line.rect.x);
  const baselineY = cb.y + line.rect.y + line.baseline;
  const baseX = cb.x + line.rect.x + off;

  // BLOCK DECOR (under the line's ink — element order IS paint order).
  // #74 — the tints span the COLUMN, not the content box.
  if (block.paint?.blockquote) {
    into.push({
      kind: 'rect',
      x: cb.x + columnLeft,
      top: cb.y + line.rect.y,
      width: columnWidth,
      height: line.rect.height,
      fill: QUOTE_BG_COLOR,
    });
    into.push({
      kind: 'rect',
      x: cb.x + columnLeft + 4,
      top: cb.y + line.rect.y,
      width: 3,
      height: line.rect.height,
      fill: QUOTE_BORDER_COLOR,
    });
  }
  if (block.paint?.code) {
    into.push({
      kind: 'rect',
      x: cb.x + columnLeft,
      top: cb.y + line.rect.y,
      width: columnWidth,
      height: line.rect.height,
      fill: CODE_BG_COLOR,
    });
  }

  // REFERENCE LEADER DOTS (real document ink — resolved page numbers
  // print; the field border does not).
  if (block.reference && block.reference.entries.length > 0 && line.segments.length > 1) {
    renderLeaderDots(into, line, block, baseX, baselineY, metrics);
  }

  // SEGMENTS: text / images / page fields.
  for (let si = 0; si < line.segments.length; si++) {
    const seg = line.segments[si]!;
    const run = block.runs[seg.runIndex];
    if (!run) continue;
    const shift = fieldShiftBefore(line, block, metrics, si);
    const x = baseX + seg.x - shift;
    const decor = block.runDecor[seg.runIndex] ?? ({} as RunDecor);

    if (run.kind === 'inlineImage') {
      // Inline objects: baseline-seated, the engine's clamp.
      // #74 — the base wrap is the COLUMN's width (the engine's clamp
      // input); the cell lane keeps its own width.
      const wrap = line.tableCell ? line.tableCell.width : columnWidth - (block.indentLeft ?? 0) - (block.indentRight ?? 0);
      const dims = fitDownImage(run.width, run.height, wrap, Infinity);
      const sha = run.src.startsWith('media://') ? run.src.slice('media://'.length) : null;
      const src = sha ? bitmapSrc(sha) : undefined;
      if (src) {
        into.push({
          kind: 'image',
          x,
          top: baselineY - dims.height,
          width: dims.width,
          height: dims.height,
          src,
          sha: sha ?? '',
          alt: run.alt,
          z: 'front',
        });
      }
      continue;
    }

    // THE PAGE FIELD: the print DOM positions per page — the resolved
    // string renders NATIVELY (the slot stays the placeholder's width,
    // the shift closes the slack — the same ink ruling as the canvas).
    if (run.fieldKind) {
      const resolved =
        run.fieldKind === 'pages' ? String(fieldTotal) : String(pageIndex + 1);
      const width = metrics.measure(resolved, run.style);
      into.push({
        kind: 'text',
        x,
        top: baselineY - metrics.ascent(run.style),
        baseline: baselineY,
        width,
        text: resolved,
        style: run.style,
        color: decor.color ?? DEFAULT_TEXT_COLOR,
        decoration: decorationOf(decor),
      });
      continue;
    }

    const segText = block.text.slice(seg.start, seg.end);
    if (segText === '') continue;
    // Tabs paint nothing (the next segment's x carries the jump).
    if (segText === '\t') continue;

    const width = metrics.measure(segText, run.style);
    if (decor.highlight) {
      into.push({
        kind: 'highlight',
        x,
        top: baselineY - metrics.ascent(run.style),
        width,
        height: metrics.ascent(run.style) + metrics.descent(run.style),
        color: decor.highlight,
      });
    }
    into.push({
      kind: 'text',
      x,
      top: baselineY - metrics.ascent(run.style),
      baseline: baselineY,
      width,
      text: segText,
      style: run.style,
      color: decor.color ?? DEFAULT_TEXT_COLOR,
      decoration: decorationOf(decor),
    });
  }

  // LIST MARKER (the block's first line, in the indent gutter).
  const marker = block.paint?.marker;
  if (marker && line.lineIndex === 0) {
    const markerStyle = (block.runs.find((r) => r.kind !== 'inlineImage') as
      | { style?: TextStyle }
      | undefined)?.style ?? { fontFamily: 'system-ui', fontSize: 16 };
    const markerText =
      marker.kind === 'bullet'
        ? bulletMarkerText(marker.styleType)
        : orderedMarkerText(marker.index, marker.styleType);
    const w = metrics.measure(markerText, markerStyle);
    const markerX =
      marker.kind === 'bullet'
        ? cb.x + line.rect.x - LIST_INDENT_PX + 1
        : cb.x + line.rect.x - 2 - w;
    into.push({
      kind: 'text',
      x: markerX,
      top: baselineY - metrics.ascent(markerStyle),
      baseline: baselineY,
      width: w,
      text: markerText,
      style: markerStyle,
      color: DEFAULT_TEXT_COLOR,
      decoration: '',
    });
  }

  // RULE (horizontalRule): 1px across the indent-narrowed width —
  // #74: to the COLUMN's right edge.
  if (block.paint?.rule) {
    into.push({
      kind: 'line',
      x: cb.x + line.rect.x,
      top: Math.round(cb.y + line.rect.y + line.baseline * 0.55),
      width: columnLeft + columnWidth - line.rect.x,
      height: 1,
      color: RULE_COLOR,
    });
  }
}

/** The leader-gap dots (the paint algorithm: no pads, the span's own
 *  style, from the seed's last glyph to the number's first). */
function renderLeaderDots(
  into: PrintElement[],
  line: LineBox,
  block: AdapterBlock,
  baseX: number,
  baselineY: number,
  metrics: TextMetricsPort,
): void {
  const segText = (s: { start: number; end: number }) => block.text.slice(s.start, s.end);
  const tabIdx = line.segments.findIndex((s) => segText(s) === '\t');
  if (tabIdx <= 0) return;
  const row = block.reference!.entries.find(
    (e) => line.rangeStart >= e.textStart && line.rangeStart < e.textStart + e.textLen,
  );
  const numberSeg = line.segments.slice(tabIdx + 1).find((s) => {
    const t = segText(s);
    return t !== '' && t !== '\t';
  });
  if (!row || row.leaderLen <= 0 || !numberSeg) return;
  const leaderSeg = line.segments[tabIdx - 1]!;
  const leaderRun = block.runs[leaderSeg.runIndex];
  if (!leaderRun || leaderRun.kind === 'inlineImage') return;
  const style = leaderRun.style;
  const dotW = metrics.measure('.', style);
  if (dotW <= 0) return;
  const gapStart = baseX + leaderSeg.x + metrics.measure(segText(leaderSeg), style);
  const gapEnd = baseX + numberSeg.x;
  const n = Math.max(0, Math.min(Math.floor((gapEnd - gapStart) / dotW), 500));
  if (n <= 0) return;
  const decor = block.runDecor[leaderSeg.runIndex] ?? ({} as RunDecor);
  into.push({
    kind: 'text',
    x: gapStart,
    top: baselineY - metrics.ascent(style),
    baseline: baselineY,
    width: n * dotW,
    text: '.'.repeat(n),
    style,
    color: decor.color ?? DEFAULT_TEXT_COLOR,
    decoration: '',
  });
}

/** THE MERGED BORDER SEGMENTS (the TableCellLayer algorithm). */
interface BorderSeg {
  at: number;
  a: number;
  b: number;
  vertical: boolean;
}

function mergedBorderSegments(
  cells: readonly {
    rect: { x: number; y: number; width: number; height: number };
    cell?: { row: number; col: number; border?: string };
  }[],
  preset: string,
): BorderSeg[] {
  if (preset === 'none' || cells.length === 0) return [];
  // Group rowspan slices by anchor identity (internal edges vanish).
  const groups = new Map<string, number>();
  for (const p of cells) {
    if (!p.cell) continue;
    const key = `${p.cell.row}:${p.cell.col}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const raw: { vertical: boolean; at: number; a: number; b: number; internal: boolean }[] = [];
  for (const p of cells) {
    if (!p.cell) continue;
    const { x, y, width, height } = p.rect;
    const multi = (groups.get(`${p.cell.row}:${p.cell.col}`) ?? 0) > 1;
    const isLeft = x;
    const isTop = y;
    raw.push({ vertical: true, at: x, a: y, b: y + height, internal: false });
    raw.push({ vertical: true, at: x + width, a: y, b: y + height, internal: false });
    // Multi-slice cells: only the group's outermost y edges are real
    // boundaries — the merge dedupes exact-touching segments; the
    // internal flag drops a rowspan's interior horizontal edges.
    void isLeft; void isTop;
    raw.push({ vertical: false, at: y, a: x, b: x + width, internal: multi });
    raw.push({ vertical: false, at: y + height, a: x, b: x + width, internal: multi });
  }
  if (preset === 'outer') {
    // The frame only: the union rect's boundary segments.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of cells) {
      minX = Math.min(minX, p.rect.x);
      minY = Math.min(minY, p.rect.y);
      maxX = Math.max(maxX, p.rect.x + p.rect.width);
      maxY = Math.max(maxY, p.rect.y + p.rect.height);
    }
    return [
      { vertical: true, at: minX, a: minY, b: maxY },
      { vertical: true, at: maxX, a: minY, b: maxY },
      { vertical: false, at: minY, a: minX, b: maxX },
      { vertical: false, at: maxY, a: minX, b: maxX },
    ];
  }
  // Merge same-line touching/overlapping segments; drop internals.
  const out: BorderSeg[] = [];
  for (const vertical of [true, false]) {
    const segs = raw.filter((s) => s.vertical === vertical && !s.internal);
    segs.sort((s1, s2) => s1.at - s2.at || s1.a - s2.a);
    let i = 0;
    while (i < segs.length) {
      const s = segs[i]!;
      let b = s.b;
      let j = i + 1;
      while (j < segs.length && segs[j]!.at === s.at && segs[j]!.a <= b) {
        b = Math.max(b, segs[j]!.b);
        j += 1;
      }
      out.push({ at: s.at, a: s.a, b, vertical });
      i = j;
    }
  }
  return out;
}

function printImageOf(
  p: { src?: string; alt?: string; rect: { x: number; y: number; width: number; height: number }; z?: 'front' | 'behind' },
  cb: { x: number; y: number },
  bitmapSrc: (sha: string) => string | undefined,
): PrintImage {
  const sha = p.src?.startsWith('media://') ? p.src.slice('media://'.length) : null;
  const src = sha ? bitmapSrc(sha) : undefined;
  return {
    kind: 'image',
    x: cb.x + p.rect.x,
    top: cb.y + p.rect.y,
    width: p.rect.width,
    height: p.rect.height,
    src: src ?? '',
    sha: sha ?? '',
    alt: p.alt ?? '',
    z: p.z ?? 'front',
  };
}

function decorationOf(decor: RunDecor): string {
  const parts: string[] = [];
  if (decor.underline) parts.push('underline');
  if (decor.strike) parts.push('line-through');
  return parts.join(' ');
}