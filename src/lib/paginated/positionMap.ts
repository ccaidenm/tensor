import type { Node as PMNode } from '@tiptap/pm/model';
import { fitDownImage, type LayoutResult, type LineBox, type PageGeometry, type TextMetrics, type TextStyle } from '@tensor-editor/engine';
import { pageTops } from './pageStack';
import type { AdapterBlock } from './adapter';

// All selection state lives in PM — the painted selection, caret, and
// highlights are projections. This module bridges PM's coordinate
// space and the engine's: PM pos <-> (block, offset) <-> LineBox
// ranges -> stack-local painted rects.

export type TextAlign = 'left' | 'center' | 'right';

/** THE one alignment-offset function (justify is engine work) —
 * paint, caret, selection rects, and hitTest all consume it. */
export function alignOffset(align: TextAlign, lineWidth: number, contentWidth: number): number {
  if (align === 'center') return (contentWidth - lineWidth) / 2;
  if (align === 'right') return contentWidth - lineWidth;
  return 0;
}

/**
 * #74 — the COLUMN frame a line flows in, content-box-relative.
 * Single-column pages return the content box itself (bit-identical).
 * Align containers, wrap-width inputs, and selection clamps all
 * consume this — the one derivation.
 */
export function lineColumnFrame(page: PageGeometry, line: LineBox): { left: number; width: number } {
  if (page.columns && line.column != null) {
    const slot = page.columns[line.column];
    if (slot) return { left: slot.x, width: slot.width };
  }
  return { left: 0, width: page.contentBox.width };
}

export interface PaintedRect {
  pageIndex: number;
  /** Stack-local px (pre-zoom). */
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface BlockOffset {
  block: AdapterBlock;
  offset: number;
}

/**
 * A table's text is the canonical cell-paragraph concatenation; a PM
 * pos inside a cell maps through the cell-paragraph map. Structural
 * positions clamp to the nearest preceding slice's end — text
 * selections never sit there (cells are isolating).
 */
function tablePosToOffset(block: AdapterBlock, pos: number): number {
  const paras = block.table!.paragraphs;
  let found = null as (typeof paras)[number] | null;
  for (const p of paras) {
    if (block.from + p.relStart <= pos) found = p;
    else break;
  }
  if (!found) return paras[0]?.textStart ?? 0;
  const rel = pos - (block.from + found.relStart);
  return Math.min(found.textStart + rel, found.textStart + found.textLen);
}

function tableOffsetToPmPos(block: AdapterBlock, offset: number): number {
  const paras = block.table!.paragraphs;
  let found = null as (typeof paras)[number] | null;
  for (const p of paras) {
    if (p.textStart <= offset) found = p;
    else break;
  }
  if (!found) return block.from + 1;
  const delta = Math.min(Math.max(offset - found.textStart, 0), found.textLen);
  return block.from + found.relStart + delta;
}

// The ENTRY map bridge, one lane per entry; the synthetic tab/number
// suffix clamps to the entry's end (a layout fact with no PM position).
function refPosToOffset(block: AdapterBlock, pos: number): number {
  const entries = block.reference!.entries;
  let found = null as (typeof entries)[number] | null;
  for (const e of entries) {
    if (block.from + e.relStart <= pos) found = e;
    else break;
  }
  if (!found) return entries[0]?.textStart ?? 0;
  const rel = pos - (block.from + found.relStart);
  return Math.min(found.textStart + rel, found.textStart + found.textLen);
}

function refOffsetToPmPos(block: AdapterBlock, offset: number): number {
  const entries = block.reference!.entries;
  let found = null as (typeof entries)[number] | null;
  for (const e of entries) {
    if (e.textStart <= offset) found = e;
    else break;
  }
  if (!found) return block.from + 1;
  const delta = Math.min(Math.max(offset - found.textStart, 0), found.textLen);
  return block.from + found.relStart + delta;
}

/**
 * PM pos -> (block, text offset). pos at a block's start maps to
 * offset 0; pos at/after a block's end clamps to its text end.
 *
 * PM positions and block-text offsets diverge at FIELD
 * runs: a field is one PM position but its measured placeholder is N
 * block-text characters; a linear mapping shifts everything after it
 * by (N-1). Both prose mapping directions route through this table.
 */
interface ProseRunSpan {
  /** PM position of the run's first char, relative to from+1. */
  pmStart: number;
  /** Block-text offset of the run's first char. */
  blockStart: number;
  pmLen: number;
  blockLen: number;
  /** The atom's PM position (field runs only). */
  fieldPmStart: number | null;
}

function proseRunMap(block: AdapterBlock): ProseRunSpan[] {
  const spans: ProseRunSpan[] = [];
  let pm = 0;
  let bt = 0;
  for (const run of block.runs) {
    if (run.kind === 'inlineImage') {
      // ONE PM position (the atom), ONE block char (\uFFFC) — no
      // divergence, but the table must still account for both sides.
      spans.push({ pmStart: pm, blockStart: bt, pmLen: 1, blockLen: 1, fieldPmStart: null });
      pm += 1;
      bt += 1;
      continue;
    }
    const text = run.text;
    const field = (run as { fieldKind?: string }).fieldKind != null;
    if (field) {
      spans.push({ pmStart: pm, blockStart: bt, pmLen: 1, blockLen: text.length, fieldPmStart: pm });
    } else {
      spans.push({ pmStart: pm, blockStart: bt, pmLen: text.length, blockLen: text.length, fieldPmStart: null });
    }
    pm += field ? 1 : text.length;
    bt += text.length;
  }
  return spans;
}

/** PM-relative -> block offset for a prose block (field-aware). */
function prosePmRelToOffset(block: AdapterBlock, rel: number): number {
  const spans = proseRunMap(block);
  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i]!;
    const nextPm = i + 1 < spans.length ? spans[i + 1]!.pmStart : sp.pmStart + sp.pmLen;
    if (rel >= sp.pmStart && rel < nextPm) {
      // Inside (or at the start edge of) this run. A FIELD run's whole
      // PM span maps to the placeholder START (the atom is one
      // position — its caret/selection point is the slot's left edge).
      if (sp.fieldPmStart != null) return sp.blockStart;
      return sp.blockStart + Math.min(rel - sp.pmStart, sp.blockLen);
    }
  }
  return block.text.length;
}

/** Block offset -> PM-relative for a prose block (field-aware). */
function proseOffsetToPmRel(block: AdapterBlock, offset: number): number {
  const spans = proseRunMap(block);
  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i]!;
    const nextBt = i + 1 < spans.length ? spans[i + 1]!.blockStart : sp.blockStart + sp.blockLen;
    if (offset >= sp.blockStart && offset < nextBt) {
      // Any offset inside a field's placeholder maps to the ATOM.
      if (sp.fieldPmStart != null) return sp.fieldPmStart;
      return sp.pmStart + Math.min(offset - sp.blockStart, sp.pmLen);
    }
  }
  return spans.length
    ? spans[spans.length - 1]!.pmStart + spans[spans.length - 1]!.pmLen
    : 0;
}

export function pmPosToBlockOffset(
  blocks: readonly AdapterBlock[],
  pos: number
): BlockOffset | null {
  if (blocks.length === 0) return null;
  if (pos <= blocks[0].from) return { block: blocks[0], offset: 0 };
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = blocks[mid];
    if (pos > b.from && pos <= b.to) {
      // Tables resolve through the cell-paragraph map.
      if (b.table) return { block: b, offset: tablePosToOffset(b, pos) };
      // A reference table resolves through the ENTRY map (the same
      // bridge as cells).
      if (b.reference) return { block: b, offset: refPosToOffset(b, pos) };
      // Prose maps through the RUN TABLE (field-aware).
      return { block: b, offset: prosePmRelToOffset(b, pos - (b.from + 1)) };
    }
    if (pos <= b.from) hi = mid - 1;
    else lo = mid + 1;
  }
  return null;
}

export function blockOffsetToPmPos(block: AdapterBlock, offset: number): number {
  if (block.table) return tableOffsetToPmPos(block, offset);
  if (block.reference) return refOffsetToPmPos(block, offset);
  // Prose maps through the RUN TABLE (field-aware).
  return block.from + 1 + proseOffsetToPmRel(block, offset);
}

/**
 * The LineBox containing a text offset. Boundary offsets belong to
 * the later line; end-of-text belongs to the last. A table cell's
 * EMPTY-ranged lines (slice [k, k)) match on rangeStart exactly, so
 * the caret routes to the clicked empty cell.
 */
export function lineForOffset(lines: readonly LineBox[], offset: number): LineBox | null {
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (!first || !last) return null;
  if (offset < first.rangeStart) return first;
  // Rule 1 — an EMPTY-ranged cell line matches on rangeStart exactly.
  for (const l of lines) {
    if (l.rangeStart === l.rangeEnd && offset === l.rangeStart) return l;
  }
  if (offset >= last.rangeEnd) return last;
  // Rule 2 — a shared end/start boundary belongs to the LATER line.
  for (const l of lines) {
    if (offset >= l.rangeStart && offset < l.rangeEnd) return l;
  }
  // Rule 3 — a caret at a line's end that is no line's start belongs
  // to the line it ends.
  for (const l of lines) {
    if (l.rangeEnd === offset) return l;
  }
  return last;
}

/**
 * The per-page ink shift. Band geometry is shared
 * across pages, so a field's slot is measured at the warm total's
 * digits; the number actually drawn on this page is narrower slack.
 * The paint closes the slack as ink: the number draws left-anchored
 * and every segment after it shifts left by the accumulated slack.
 * Consumers: lineOffsetX (hence caret/selection/search), paint,
 * hitTest.
 */
export function fieldShiftBefore(
  line: LineBox,
  block: AdapterBlock,
  metrics: TextMetrics,
  segIndex: number
): number {
  let shift = 0;
  for (let i = 0; i < segIndex && i < line.segments.length; i++) {
    const seg = line.segments[i]!;
    const run = block.runs[seg.runIndex] as
      | { kind?: string; fieldKind?: string; style?: TextStyle; text?: string }
      | undefined;
    if (!run || run.kind === 'inlineImage' || !run.fieldKind) continue;
    if (run.fieldKind !== 'page') continue; // 'pages': resolved == slot
    const slot = metrics.measure(block.text.slice(seg.start, seg.end), run.style!);
    const resolved = metrics.measure(String(line.pageIndex + 1), run.style!);
    shift += Math.max(0, slot - resolved);
  }
  return shift;
}

/**
 * x (content-box px) of a text offset within its line, measured with
 * the layout's own metrics. `objectMaxWidth` makes the walk
 * object-aware (an offset past an inline object pays the object's
 * placed advance); without it the walk is text-only (legacy callers).
 */
export function lineOffsetX(
  line: LineBox,
  block: AdapterBlock,
  offset: number,
  metrics: TextMetrics,
  _objectMaxWidth?: number
): number {
  // The breaker EMITS each segment's placed x — the walk seeds from
  // it instead of accumulating measured prefix sums (which cannot
  // model tab advances). objectMaxWidth is legacy: the engine's
  // placement already includes an inline object's advance.
  for (let si = 0; si < line.segments.length; si++) {
    const seg = line.segments[si]!;
    // Ink after a field shifts by the accumulated slack (see
    // fieldShiftBefore); caret and rects agree with the paint.
    const shift = fieldShiftBefore(line, block, metrics, si);
    // Boundary offsets belong to the LATER segment (the lineForOffset
    // rule) — its seeded x is the boundary's x.
    if (offset <= seg.start) return line.rect.x + seg.x - shift;
    const run = block.runs[seg.runIndex];
    const x = line.rect.x + seg.x - shift;
    if (offset < seg.end) {
      // Inside this segment: add the segment-local prefix. A tab
      // segment owns exactly one live position (its start — the pen
      // before the jump); offset == seg.end belongs to the next
      // segment, which the break above routes there.
      if (run && run.kind !== 'inlineImage' && block.text[seg.start] !== '\t') {
        return x + metrics.measure(block.text.slice(seg.start, offset), run.style);
      }
      return x;
    }
  }
  // Past the last segment (the line's end): the placed pen.
  return (
    line.rect.x +
    line.rect.width -
    fieldShiftBefore(line, block, metrics, line.segments.length)
  );
}

/** The block's BASE wrap width — the engine's breakLines maxWidth and
 *  the inline object clamp's input (one derivation, exported for the
 *  callers that previously re-derived it inline). */
export function blockWrapWidth(contentWidth: number, block: AdapterBlock): number {
  return contentWidth - (block.indentLeft ?? 0) - (block.indentRight ?? 0);
}

/**
 * The inline object's painted rect (the selection overlay's
 * geometry): the token's line, baseline-seated, the object's placed
 * dims — the SAME numbers paint.ts's drawImage uses. Rect is
 * content-box-relative.
 */
export function inlineObjectRect(
  blocks: readonly AdapterBlock[],
  result: LayoutResult,
  pos: number,
  metrics: TextMetrics
): import('@tensor-editor/engine').PlacedRect | null {
  const bo = pmPosToBlockOffset(blocks, pos);
  if (!bo) return null;
  const { block, offset } = bo;
  const page0 = result.pages[0];
  const line = lineForOffset(result.lines.filter((l) => l.blockId === block.id), offset);
  if (!page0 || !line) return null;
  // #58 — the line's OWN page carries the contentBox (mixed sections).
  // #74 — the wrap and align containers are the line's COLUMN's.
  const frame = lineColumnFrame(result.pages[line.pageIndex]!, line);
  const wrap = blockWrapWidth(frame.width, block);
  const seg = line.segments.find((s) => offset >= s.start && offset < s.end);
  const run = seg ? block.runs[seg.runIndex] : undefined;
  if (!seg || !run || run.kind !== 'inlineImage') return null;
  const dims = fitDownImage(run.width, run.height, wrap, Infinity);
  const off = alignOffset(block.align, line.rect.width, frame.left + frame.width - line.rect.x);
  // The object's left edge: everything before the token advanced
  // (text measured + earlier objects' placed widths).
  const left = off + lineOffsetX(line, block, offset, metrics, wrap);
  // BOTTOM-AT-BASELINE (the engine's seating rule — verticalFor grows
  // the line's ascent by the placed height): the object's top is the
  // baseline minus its height.
  return {
    blockId: block.id,
    kind: 'image',
    src: run.src,
    alt: run.alt,
    pageIndex: line.pageIndex,
    rect: {
      x: left,
      y: line.rect.y + (line.baseline - dims.height),
      width: dims.width,
      height: dims.height,
    },
  };
}

/**
 * The span walk shared by every range-rect derivation: PM range ->
 * per-line {line, [s,e), block} spans. ONE derivation, no forks.
 *
 * `bandPage`: a band block's lines resolve only on the ACTIVE page's
 * echo (echoes share blockId and range; unfiltered, selection would
 * paint on every page). Absent: all echoes pass (spell/search).
 * `surface`: a selection spanning band and body paints only the
 * anchor's surface — a paint-time clamp, PM state untouched.
 */
function matchSpans(
  blocks: readonly AdapterBlock[],
  result: LayoutResult,
  from: number,
  to: number,
  bandPage?: number,
  surface?: 'band' | 'body',
  bandBlockIds?: ReadonlySet<string>
): { line: LineBox; s: number; e: number; block: AdapterBlock }[] {
  if (to <= from) return [];
  const a = pmPosToBlockOffset(blocks, from);
  const b = pmPosToBlockOffset(blocks, to);
  if (!a || !b) return [];
  const spans: { line: LineBox; s: number; e: number; block: AdapterBlock }[] = [];
  const ai = blocks.indexOf(a.block);
  const bi = blocks.indexOf(b.block);
  for (let i = ai; i <= bi; i++) {
    const block = blocks[i];
    // The cross-surface clamp: skip blocks of the other surface.
    if (surface != null && bandBlockIds != null) {
      const isBand = bandBlockIds.has(block.id);
      if (surface === 'band' ? !isBand : isBand) continue;
    }
    const startOff = i === ai ? a.offset : 0;
    const endOff = i === bi ? b.offset : block.text.length;
    if (endOff <= startOff) continue;
    for (const line of result.lines) {
      if (line.blockId !== block.id) continue;
      // The echo rule: an active-page filter for band lines.
      if (line.band != null && bandPage != null && line.pageIndex !== bandPage) continue;
      const s = Math.max(startOff, line.rangeStart);
      const e = Math.min(endOff, line.rangeEnd);
      if (e > s) spans.push({ line, s, e, block });
    }
  }
  return spans;
}

/**
 * PM range -> per-line painted rects: partial x-range on the
 * first/last line, full width on middle lines. Stack-local, pre-zoom
 * (the caller renders inside the transform). `bandPage` restricts
 * band echoes to the active page; `surface`/`bandBlockIds` clamp
 * cross-surface selections to the anchor's side.
 */
export function textRangeLineRects(
  blocks: readonly AdapterBlock[],
  result: LayoutResult,
  from: number,
  to: number,
  metrics: TextMetrics,
  pageGap: number,
  bandPage?: number,
  surface?: 'band' | 'body',
  bandBlockIds?: ReadonlySet<string>,
  /** #101 — the grid's ROW tops (row-mates share a top; the y-only
   *  pageTops walk is wrong for columns ≥ 2). Absent ≡ the legacy
   *  walk (columns 1 — bit-identical). */
  tops?: number[]
): PaintedRect[] {
  const spans = matchSpans(blocks, result, from, to, bandPage, surface, bandBlockIds);
  const page0 = result.pages[0];
  if (!page0 || spans.length === 0) return [];
  // #58 — cumulative tops table; each span reads ITS page's contentBox.
  const topsTable = tops ?? pageTops(result.pages, pageGap);

  return spans.map(({ line, s, e, block }, idx) => {
    const cb = result.pages[line.pageIndex]!.contentBox;
    const first = idx === 0;
    const last = idx === spans.length - 1;
    // Partial first/last lines ride the same alignOffset the caret and
    // hitTest use; middle lines span their COLUMN's width. The offset
    // input is the indent-narrowed box (rect.x IS indentLeft), so
    // centered/right-aligned indented blocks align inside their column.
    // #74 — the align container, wrap input, and middle-line right
    // edge are the line's COLUMN's; single-column ≡ the content box.
    const frame = lineColumnFrame(result.pages[line.pageIndex]!, line);
    const off =
      first || last
        ? alignOffset(block.align, line.rect.width, frame.left + frame.width - line.rect.x)
        : 0;
    const wrap = blockWrapWidth(frame.width, block);
    const x1 = first || last ? off + lineOffsetX(line, block, s, metrics, wrap) : line.rect.x;
    const x2 = first || last ? off + lineOffsetX(line, block, e, metrics, wrap) : frame.left + frame.width;
    // A cell line's rects clamp to the LANE (never stripe across
    // neighbors).
    const laneRight = line.tableCell ? line.rect.x + line.tableCell.width : null;
    const cx1 = laneRight != null ? Math.min(Math.max(x1, line.rect.x), laneRight) : x1;
    const cx2 = laneRight != null ? Math.min(Math.max(x2, line.rect.x), laneRight) : x2;
    return {
      pageIndex: line.pageIndex,
      left: cb.x + cx1,
      top: topsTable[line.pageIndex]! + cb.y + line.rect.y,
      width: cx2 - cx1,
      height: line.rect.height,
    };
  });
}

/**
 * Find-highlight geometry: the matched TEXT EXTENT (baseline −
 * ascent to baseline + descent of the matched runs), NOT the leading
 * box — a find match hugs the glyphs so adjacent lines show no
 * highlight bleed. x/width ride the same span walk as selection.
 */
export function textRangeTextExtents(
  blocks: readonly AdapterBlock[],
  result: LayoutResult,
  from: number,
  to: number,
  metrics: TextMetrics,
  pageGap: number,
  /** The active band page (bubble anchors); absent paints every echo
   *  (search highlights — the text is on every page). */
  bandPage?: number,
  /** #101 — the grid's ROW tops (row-mates share a top; the y-only
   *  pageTops walk is wrong for columns ≥ 2). Absent ≡ the legacy
   *  walk (columns 1 — bit-identical). */
  tops?: number[]
): PaintedRect[] {
  const spans = matchSpans(blocks, result, from, to, bandPage);
  const page0 = result.pages[0];
  if (!page0 || spans.length === 0) return [];
  // #58 — cumulative tops table; each span reads ITS page's contentBox.
  const topsTable = tops ?? pageTops(result.pages, pageGap);

  return spans.map(({ line, s, e, block }, idx) => {
    const cb = result.pages[line.pageIndex]!.contentBox;
    // The ECHO rule: a band line is ALWAYS a first/last (partial x) —
    // see the underline builder for the rationale.
    const first = idx === 0 || line.band != null;
    const last = idx === spans.length - 1 || line.band != null;
    // #74 — the align container, wrap input, and middle-line right
    // edge are the line's COLUMN's; single-column ≡ the content box.
    const frame = lineColumnFrame(result.pages[line.pageIndex]!, line);
    const off =
      first || last
        ? alignOffset(block.align, line.rect.width, frame.left + frame.width - line.rect.x)
        : 0;
    const wrap = blockWrapWidth(frame.width, block);
    const x1 = first || last ? off + lineOffsetX(line, block, s, metrics, wrap) : line.rect.x;
    const x2 = first || last ? off + lineOffsetX(line, block, e, metrics, wrap) : frame.left + frame.width;
    // The cell lane clamp (the selection rects' rule).
    const laneRight = line.tableCell ? line.rect.x + line.tableCell.width : null;
    const cx1 = laneRight != null ? Math.min(Math.max(x1, line.rect.x), laneRight) : x1;
    const cx2 = laneRight != null ? Math.min(Math.max(x2, line.rect.x), laneRight) : x2;

    // The matched runs' ink extent on this line.
    let ascent = 0;
    let descent = 0;
    for (const seg of line.segments) {
      const a = Math.max(s, seg.start);
      const b = Math.min(e, seg.end);
      if (a >= b) continue;
      const run = block.runs[seg.runIndex];
      if (!run) continue;
      if (run.kind === 'inlineImage') continue; // objects: engine-seated
      ascent = Math.max(ascent, metrics.ascent(run.style));
      descent = Math.max(descent, metrics.descent(run.style));
    }
    if (ascent + descent === 0) {
      // No matched glyphs on this line (empty textblock): fall back
      // to the block's effective style — the P1 zero-length run.
      const style = (block.runs[0] as { style?: TextStyle } | undefined)?.style;
      if (style) {
        ascent = metrics.ascent(style);
        descent = metrics.descent(style);
      }
    }
    const top = topsTable[line.pageIndex]! + cb.y + line.rect.y + line.baseline - ascent;
    return {
      pageIndex: line.pageIndex,
      left: cb.x + cx1,
      top,
      width: cx2 - cx1,
      height: ascent + descent,
    };
  });
}

/**
 * Spell-check line geometry: per-line FLAT underline bars for a PM
 * range — signal geometry, deliberately diverged from paint.ts's
 * typographic underline so a flag never reads as real underlined
 * text: lower (0.12·fontSize vs 0.08), bolder (max(2px, fontSize/12)),
 * softer (~15% transparency at the rendering surfaces). "Flat, not
 * squiggly" is the user's ruling.
 */
const SPELL_LINE_OFFSET = 0.12;
const SPELL_LINE_MIN_THICKNESS = 2;

export function textRangeUnderlineRects(
  blocks: readonly AdapterBlock[],
  result: LayoutResult,
  from: number,
  to: number,
  metrics: TextMetrics,
  pageGap: number,
  /** #101 — SPLIT VIEW: the grid's ROW tops (see textRangeLineRects). */
  tops?: number[]
): PaintedRect[] {
  void metrics; // (font-size comes from the runs' styles; kept for signature parity)
  const spans = matchSpans(blocks, result, from, to);
  const page0 = result.pages[0];
  if (!page0 || spans.length === 0) return [];
  // #58 — cumulative tops table; each span reads ITS page's contentBox.
  const topsTable = tops ?? pageTops(result.pages, pageGap);

  return spans.map(({ line, s, e, block }, idx) => {
    const cb = result.pages[line.pageIndex]!.contentBox;
    // The ECHO rule: a band line is ALWAYS a first/last (partial x);
    // each echo is its own line sequence, or the plain walk would
    // full-width the middle echoes.
    const first = idx === 0 || line.band != null;
    const last = idx === spans.length - 1 || line.band != null;
    // #74 — the align container, wrap input, and middle-line right
    // edge are the line's COLUMN's; single-column ≡ the content box.
    const frame = lineColumnFrame(result.pages[line.pageIndex]!, line);
    const off =
      first || last
        ? alignOffset(block.align, line.rect.width, frame.left + frame.width - line.rect.x)
        : 0;
    const wrap = blockWrapWidth(frame.width, block);
    const x1 = first || last ? off + lineOffsetX(line, block, s, metrics, wrap) : line.rect.x;
    const x2 = first || last ? off + lineOffsetX(line, block, e, metrics, wrap) : frame.left + frame.width;
    const laneRight = line.tableCell ? line.rect.x + line.tableCell.width : null;
    const cx1 = laneRight != null ? Math.min(Math.max(x1, line.rect.x), laneRight) : x1;
    const cx2 = laneRight != null ? Math.min(Math.max(x2, line.rect.x), laneRight) : x2;

    let fontSize = 0;
    for (const seg of line.segments) {
      const a = Math.max(s, seg.start);
      const b = Math.min(e, seg.end);
      if (a >= b) continue;
      const run = block.runs[seg.runIndex];
      if (!run || run.kind === 'inlineImage') continue;
      fontSize = Math.max(fontSize, run.style.fontSize);
    }
    if (fontSize === 0) {
      const style = (block.runs[0] as { style?: TextStyle } | undefined)?.style;
      if (style) fontSize = style.fontSize;
    }
    const thickness = Math.max(SPELL_LINE_MIN_THICKNESS, Math.round(fontSize / 12));
    const top =
      topsTable[line.pageIndex]! + cb.y + line.rect.y + line.baseline + SPELL_LINE_OFFSET * fontSize;
    return {
      pageIndex: line.pageIndex,
      left: cb.x + cx1,
      top,
      width: cx2 - cx1,
      height: thickness,
    };
  });
}

export interface CaretGeometry {
  pageIndex: number;
  x: number;
  y: number;
  height: number;
}

/**
 * The line's TEXT-BAND height (ink extent, leading excluded): the
 * baseline plus the max descent over the runs. An EMPTY line measures
 * under the block's own zero-length run (the P1 projection guarantees
 * one), so an empty paragraph's caret matches its neighbors.
 */
function textBandHeight(line: LineBox, block: AdapterBlock, metrics: TextMetrics): number | null {
  let descent = 0;
  let hasRuns = false;
  for (const seg of line.segments) {
    const run = block.runs[seg.runIndex];
    if (!run || run.kind === 'inlineImage') continue; // objects: engine-seated
    hasRuns = true;
    descent = Math.max(descent, metrics.descent(run.style));
  }
  if (!hasRuns) {
    const style = (block.runs[0] as { style?: TextStyle } | undefined)?.style;
    if (style) {
      hasRuns = true;
      descent = metrics.descent(style);
    }
  }
  return hasRuns ? line.baseline + descent : null;
}

export function caretGeometry(
  blocks: readonly AdapterBlock[],
  result: LayoutResult,
  head: number,
  metrics: TextMetrics,
  /** The active band page — a band block's echoes share
   *  rangeStart/rangeEnd, so lineForOffset would resolve the first
   *  echo; this filters to the active page's echo. */
  bandPage?: number
): CaretGeometry | null {
  const bo = pmPosToBlockOffset(blocks, head);
  if (!bo) return null;
  const lines = result.lines.filter(
    (l) =>
      l.blockId === bo.block.id &&
      (l.band == null || bandPage == null || l.pageIndex === bandPage)
  );
  const line = lineForOffset(lines, bo.offset);
  const page0 = result.pages[0];
  if (!line || !page0) return null;
  // #58 — the caret line's OWN page carries the contentBox (mixed
  // sections; a uniform doc is the degenerate same-page case).
  // #74 — the caret's wrap and align containers are the COLUMN's.
  const caretFrame = lineColumnFrame(result.pages[line.pageIndex]!, line);
  return {
    pageIndex: line.pageIndex,
    x:
      lineOffsetX(line, bo.block, bo.offset, metrics, blockWrapWidth(caretFrame.width, bo.block)) +
      // Indent-narrowed box (rect.x IS indentLeft): the caret x of a
      // centered/right-aligned indented block stays in its column.
      alignOffset(bo.block.align, line.rect.width, caretFrame.left + caretFrame.width - line.rect.x),
    // THE CARET IS THE TEXT BAND, not the line box (GDocs): the
    // bottom stops at the text's descent — a 2.0-spaced line never
    // stretches the caret across its leading. Selection rects keep
    // the full box.
    y: line.rect.y,
    height: textBandHeight(line, bo.block, metrics) ?? line.rect.height,
  };
}

export interface CaretStackRect {
  left: number;
  top: number;
  height: number;
}

/**
 * Caret rect in stack-local px: page stack offset + content box +
 * the caret's text-band geometry. Shared by the caret painter and the
 * caret-follow scroll. #58: pages may differ in size, so the caller
 * passes the cumulative page top (pageStack.pageTops) and the caret
 * page's own contentBox origin.
 */
export function caretStackRect(
  caret: CaretGeometry,
  contentX: number,
  contentY: number,
  pageTop: number
): CaretStackRect {
  return {
    left: contentX + caret.x,
    top: pageTop + contentY + caret.y,
    height: caret.height,
  };
}

export interface PaintedBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function paintedBounds(rects: readonly PaintedRect[]): PaintedBounds | null {
  if (rects.length === 0) return null;
  const b: PaintedBounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const r of rects) {
    b.left = Math.min(b.left, r.left);
    b.top = Math.min(b.top, r.top);
    b.right = Math.max(b.right, r.left + r.width);
    b.bottom = Math.max(b.bottom, r.top + r.height);
  }
  return b;
}

/** Word range around pos, from the doc model (PM ships no word
 * utilities; events land on the painted surface, so the range
 * derivation is owned here). */
export function wordRangeAround(doc: PMNode, pos: number): { from: number; to: number } {
  const $pos = doc.resolve(pos);
  const parentStart = $pos.start();
  const text = $pos.parent.textContent;
  const offset = pos - parentStart;
  const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch);
  let from = offset;
  let to = offset;
  while (from > 0 && isWordChar(text[from - 1])) from--;
  while (to < text.length && isWordChar(text[to])) to++;
  return from === to ? { from: pos, to: pos } : { from: parentStart + from, to: parentStart + to };
}

export function blockRangeAround(doc: PMNode, pos: number): { from: number; to: number } | null {
  const $pos = doc.resolve(pos);
  for (let i = $pos.depth; i >= 0; i--) {
    const node = $pos.node(i);
    if (node.inlineContent) return { from: $pos.start(i), to: $pos.start(i) + node.content.size };
  }
  return null;
}

/** The CELL node's position containing `pos` (or null). */
export function cellPosAt(doc: PMNode, pos: number): number | null {
  try {
    const $pos = doc.resolve(pos);
    for (let d = $pos.depth; d >= 0; d--) {
      const node = $pos.node(d);
      if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
        return $pos.before(d);
      }
    }
  } catch {
    return null;
  }
  return null;
}
