import type { Node as PMNode } from '@tiptap/pm/model';
import { fitDownImage, type LayoutResult, type LineBox, type TextMetrics, type TextStyle } from '@tensor-editor/engine';
import type { AdapterBlock } from './adapter';

// THE PRINCIPLE: all selection state changes go through PM
// transactions — the shell never tracks its own selection. The painted
// selection, search highlights, caret, and toolbar are projections of
// PM state, exactly as tracks are a projection of the doc.
//
// This module is the bridge between PM's coordinate space and the
// engine's: PM pos <-> (block, offset-in-block) <-> LineBox ranges, and
// from there to stack-local painted rects shared by every overlay.

export type TextAlign = 'left' | 'center' | 'right';

/** THE one alignment-offset function (left/center/right; justify is
 * engine work, out of the shell). Consumed by paint, caret, selection
 * rects, and hitTest — a second derivation anywhere is the asymmetry
 * bug class this kills. */
export function alignOffset(align: TextAlign, lineWidth: number, contentWidth: number): number {
  if (align === 'center') return (contentWidth - lineWidth) / 2;
  if (align === 'right') return contentWidth - lineWidth;
  return 0;
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
 * M-TABLES — the table block's text is the CANONICAL cell-paragraph
 * concatenation; a PM pos inside a cell maps through the block's
 * cell-paragraph map (each entry: relStart = the paragraph's first
 * text position relative to the TABLE node — pmStart = from +
 * relStart — and its text slice). Structural positions (row/cell
 * boundaries — a CellSelection's anchor points live here) clamp to
 * the nearest preceding slice's end: text selections can never sit
 * there (cells are isolating), and the cell-selection overlay has its
 * own path. The slices tile the block text exactly.
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

// M-REFS: the ENTRY map bridge — the table cell map's shape, ONE lane
// per entry (the container's children are real paragraphs; a plain
// click/caret/selection inside an entry line resolves to the TRUE PM
// position inside it). The synthetic tab/number suffix past an
// entry's textLen clamps to that entry's end (the number is a LAYOUT
// fact with no PM position).
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

/** PM pos -> (block, text offset). Boundaries: pos at a block's start
 * maps to offset 0; pos at/after a block's end clamps to its text end
 * (a selection ending at the next block's start projects onto this
 * block's last position). pos before the first block maps into it. */
/**
 * M-PAGEFIELD — THE PROSE RUN MAP: PM positions and block-text offsets
 * diverge at FIELD runs. A field is ONE PM position (an inline atom)
 * but its measured placeholder is N block-text characters (the warm
 * total's digits — the slot the engine breaks lines at). A linear
 * pos<->offset mapping shifts everything after a field by (N-1),
 * which clamps selections at the field and lands carets one char into
 * the next run — the reported "not selectable" bug. Both mapping
 * directions for prose blocks route through this table.
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
      // M-TABLES: a table's pos resolves through the cell-paragraph map.
      if (b.table) return { block: b, offset: tablePosToOffset(b, pos) };
      // M-REFS: a reference table's pos resolves through the ENTRY
      // map (the container's children are real paragraphs — the
      // caret lives INSIDE entry text, same bridge as cells).
      if (b.reference) return { block: b, offset: refPosToOffset(b, pos) };
      // M-PAGEFIELD: prose maps through the RUN TABLE (field-aware —
      // the linear spelling shifted everything after a field).
      return { block: b, offset: prosePmRelToOffset(b, pos - (b.from + 1)) };
    }
    if (pos <= b.from) hi = mid - 1;
    else lo = mid + 1;
  }
  return null;
}

export function blockOffsetToPmPos(block: AdapterBlock, offset: number): number {
  // M-TABLES: through the cell-paragraph map.
  if (block.table) return tableOffsetToPmPos(block, offset);
  // M-REFS: through the ENTRY map (real entry text — a plain click in
  // an entry line places the caret at the true position).
  if (block.reference) return refOffsetToPmPos(block, offset);
  // M-PAGEFIELD: prose maps through the RUN TABLE (field-aware).
  return block.from + 1 + proseOffsetToPmRel(block, offset);
}

/**
 * The LineBox containing a text offset. Boundary offsets (== a line's
 * rangeStart) belong to the later line; end-of-text belongs to the last.
 * M-TABLES: a TABLE cell's lines can be EMPTY-ranged (an empty cell's
 * slice [k, k) — the separator law gives each a distinct k); those
 * match on rangeStart EXACTLY (inclusive end), so the caret routes to
 * the clicked empty cell instead of falling to the last line.
 */
export function lineForOffset(lines: readonly LineBox[], offset: number): LineBox | null {
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (!first || !last) return null;
  if (offset < first.rangeStart) return first;
  // M-TABLES rule 1 — an EMPTY-ranged cell line (an empty cell's slice
  // [k, k); the separator law gives each a distinct k) matches on
  // rangeStart exactly, so the caret routes to the clicked cell.
  for (const l of lines) {
    if (l.rangeStart === l.rangeEnd && offset === l.rangeStart) return l;
  }
  if (offset >= last.rangeEnd) return last;
  // Rule 2 — the half-open walk (the pinned prose boundary rule: an
  // offset shared by a line's end and the next line's start belongs to
  // the LATER line).
  for (const l of lines) {
    if (offset >= l.rangeStart && offset < l.rangeEnd) return l;
  }
  // Rule 3 — the caret at a line's END that is NOT any line's start
  // (the SEPARATOR position between cell paragraphs): it belongs to
  // the line it ends — the caret paints after that line's last glyph.
  for (const l of lines) {
    if (l.rangeEnd === offset) return l;
  }
  return last;
}

/**
 * M-PAGEFIELD — THE PER-PAGE INK SHIFT. A band line's geometry is
 * SHARED across pages (the engine echoes the same LineBoxes), so a
 * field's slot is measured at the WARM TOTAL's digits — the widest
 * page number, stable for every page. The DRAWN number on THIS page
 * (line.pageIndex) is narrower slack; Word re-lays footers per page,
 * our shared geometry cannot, so the PAINT closes the slack as ink:
 * the number draws LEFT-anchored in its slot and every segment after
 * it shifts left by the accumulated slack — page 3 renders "Page 3
 * of 10" exactly as Word does, page 10 shift 0. Derives wholly from
 * (line, block): the placeholder digits sit in the block text, the
 * resolved number is line.pageIndex+1 ('pages' fields have no slack
 * — the resolved total IS the slot). Consumers: lineOffsetX (hence
 * caret, selection rects, search extents — automatically), paint,
 * hitTest. Tabs after a field shift too (documented approximation:
 * a right-stop would misalign by the slack; rare in bands).
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

/** x (content-box px) of a text offset within its line, measured with
 * the same metrics instance that measured the layout. `objectMaxWidth`
 * (the block's BASE wrap width — contentBox − indents, the engine's
 * clamp input) makes the walk OBJECT-AWARE: an offset past an inline
 * object's token pays the object's PLACED advance (the same fit-down
 * the engine/painter used — data, never measured). Without it the
 * walk is text-only (legacy callers; a caret past an object would sit
 * at the object's LEFT edge — the zero-width selection rect bug). */
export function lineOffsetX(
  line: LineBox,
  block: AdapterBlock,
  offset: number,
  metrics: TextMetrics,
  _objectMaxWidth?: number
): number {
  // M-RULER Phase 4: the breaker EMITS each segment's placed x (the
  // pen walk) — the walk seeds from it instead of accumulating measured
  // prefix sums, which cannot model tab advances (a \t's jump is
  // pen-dependent; center/right stops reposition their text). The
  // objectMaxWidth parameter is legacy: the engine's placement already
  // includes an inline object's placed advance.
  for (let si = 0; si < line.segments.length; si++) {
    const seg = line.segments[si]!;
    // M-PAGEFIELD: ink after a field shifts by the accumulated slack
    // (the shared-geometry/per-page-ink ruling — see fieldShiftBefore).
    // The CARET and every rect derivation route through here, so they
    // agree with the paint by construction.
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
 * M-IMAGES-2.1 — the INLINE object's painted rect (the selection
 * overlay's geometry): the token's line, baseline-seated, the object's
 * placed dims — the SAME numbers paint.ts's drawImage uses. `pos` is
 * the PM position of the inlineImage NODE (a NodeSelection's from) —
 * it maps to the token offset (one position per object). Rect is
 * content-box-relative (the PlacedRect frame — the overlay consumer
 * adds the contentBox, identical to block images).
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
  const cb = page0.contentBox;
  const wrap = blockWrapWidth(cb.width, block);
  const seg = line.segments.find((s) => offset >= s.start && offset < s.end);
  const run = seg ? block.runs[seg.runIndex] : undefined;
  if (!seg || !run || run.kind !== 'inlineImage') return null;
  const dims = fitDownImage(run.width, run.height, wrap, Infinity);
  const off = alignOffset(block.align, line.rect.width, cb.width - line.rect.x);
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

/** The span walk shared by every range-rect derivation: PM range ->
 * per-line {line, [s,e), block} spans. ONE derivation, no forks.
 *
 * M-HEADER-FOOTER-3 — THE ECHO RULES (the band-ambiguity fix):
 *  - `bandPage` (selection/caret callers): a band block's lines resolve
 *    ONLY on the ACTIVE page's echo — echoes share blockId AND
 *    rangeStart/rangeEnd (the engine re-emits per page), so an
 *    unfiltered walk paints selection on EVERY page and mis-orders
 *    partial-x. Absent (spell/search callers): all echoes pass, and
 *    the rect builders treat each echo as its own first/last.
 *  - `surface` (the cross-surface clamp): a selection whose ends sit
 *    on different surfaces (band container vs body — reachable via
 *    shift+click) paints ONLY the anchor's surface. PM state is
 *    untouched — the clamp is on what we PAINT (the tablePosToOffset
 *    precedent: honest projection of an awkward selection).
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

/** PM range -> per-line painted rects: partial x-range on the selection's
 * first/last line, full content width on middle lines. Stack-local,
 * pre-zoom — the caller renders inside the transform (zoom law: no
 * compensation).
 *
 * M-HEADER-FOOTER-3: `bandPage` restricts band echoes to the active
 * page (selection callers); the `surface`/`bandBlockIds` pair clamps
 * cross-surface selections to the anchor's side. */
export function textRangeLineRects(
  blocks: readonly AdapterBlock[],
  result: LayoutResult,
  from: number,
  to: number,
  metrics: TextMetrics,
  pageGap: number,
  bandPage?: number,
  surface?: 'band' | 'body',
  bandBlockIds?: ReadonlySet<string>
): PaintedRect[] {
  const spans = matchSpans(blocks, result, from, to, bandPage, surface, bandBlockIds);
  const page0 = result.pages[0];
  if (!page0 || spans.length === 0) return [];
  const cb = page0.contentBox;
  const stride = page0.size.height + pageGap;

  return spans.map(({ line, s, e, block }, idx) => {
    const first = idx === 0;
    const last = idx === spans.length - 1;
    // Partial first/last lines ride the same alignOffset the caret and
    // hitTest use; middle lines span the full content width. The
    // offset's width input is the INDENT-NARROWED box
    // (contentWidth − line.rect.x — rect.x IS the engine's indentLeft):
    // centered/right-aligned indented blocks align inside their own
    // column, not the whole content box. Selection rects start at
    // indentLeft automatically (lineOffsetX begins at line.rect.x).
    const off =
      first || last
        ? alignOffset(block.align, line.rect.width, cb.width - line.rect.x)
        : 0;
    const wrap = blockWrapWidth(cb.width, block);
    const x1 = first || last ? off + lineOffsetX(line, block, s, metrics, wrap) : line.rect.x;
    const x2 = first || last ? off + lineOffsetX(line, block, e, metrics, wrap) : cb.width;
    // M-TABLES: a cell line's rects clamp to the LANE — a selection's
    // middle lines must never stripe across the neighboring cells.
    const laneRight = line.tableCell ? line.rect.x + line.tableCell.width : null;
    const cx1 = laneRight != null ? Math.min(Math.max(x1, line.rect.x), laneRight) : x1;
    const cx2 = laneRight != null ? Math.min(Math.max(x2, line.rect.x), laneRight) : x2;
    return {
      pageIndex: line.pageIndex,
      left: cb.x + cx1,
      top: stride * line.pageIndex + cb.y + line.rect.y,
      width: cx2 - cx1,
      height: line.rect.height,
    };
  });
}

/**
 * FIND-HIGHLIGHT GEOMETRY (P1): the matched TEXT EXTENT —
 * baseline − ascent to baseline + descent of the matched runs — NOT
 * the leading box. Different feature, different geometry than
 * selection (which keeps the full line box by standing ruling): a
 * find match hugs the glyphs so adjacent non-matching lines show no
 * highlight bleed. x/width ride the same span walk and offsets as
 * selection rects (one derivation, no forks).
 */
export function textRangeTextExtents(
  blocks: readonly AdapterBlock[],
  result: LayoutResult,
  from: number,
  to: number,
  metrics: TextMetrics,
  pageGap: number,
  /** M-HEADER-FOOTER-3: the active band page (bubble anchors); absent
   *  paints every echo (search highlights — the text is on every page). */
  bandPage?: number
): PaintedRect[] {
  const spans = matchSpans(blocks, result, from, to, bandPage);
  const page0 = result.pages[0];
  if (!page0 || spans.length === 0) return [];
  const cb = page0.contentBox;
  const stride = page0.size.height + pageGap;

  return spans.map(({ line, s, e, block }, idx) => {
    // M-HEADER-FOOTER-3 — the ECHO rule (search highlights): a band
    // line is ALWAYS a first/last (partial x); see the underline
    // builder for the full rationale.
    const first = idx === 0 || line.band != null;
    const last = idx === spans.length - 1 || line.band != null;
    const off =
      first || last
        ? alignOffset(block.align, line.rect.width, cb.width - line.rect.x)
        : 0;
    const wrap = blockWrapWidth(cb.width, block);
    const x1 = first || last ? off + lineOffsetX(line, block, s, metrics, wrap) : line.rect.x;
    const x2 = first || last ? off + lineOffsetX(line, block, e, metrics, wrap) : cb.width;
    // M-TABLES: the cell lane clamp (the selection rects' rule).
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
    const top = stride * line.pageIndex + cb.y + line.rect.y + line.baseline - ascent;
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
 * SPELL-CHECK LINE GEOMETRY: per-line FLAT underline bars for a PM
 * range — the same span walk as the find-highlight extents, but SIGNAL
 * geometry (the user's tuned ruling), deliberately a touch diverged
 * from paint.ts's typographic underline so a flag never reads as real
 * underlined text:
 *
 *  - LOWER: baseline + 0.12·fontSize (vs. 0.08 for real underlines);
 *  - BOLDER: max(2px, fontSize/12) (vs. max(1, fontSize/16));
 *  - SOFTER: the rendering surfaces add ~15% transparency
 *    (SpellHighlights' opacity / the pageless color-mix).
 *
 * "Flat, not squiggly" is the explicit user ruling on the shape.
 */
const SPELL_LINE_OFFSET = 0.12;
const SPELL_LINE_MIN_THICKNESS = 2;

export function textRangeUnderlineRects(
  blocks: readonly AdapterBlock[],
  result: LayoutResult,
  from: number,
  to: number,
  metrics: TextMetrics,
  pageGap: number
): PaintedRect[] {
  void metrics; // (font-size comes from the runs' styles; kept for signature parity)
  const spans = matchSpans(blocks, result, from, to);
  const page0 = result.pages[0];
  if (!page0 || spans.length === 0) return [];
  const cb = page0.contentBox;
  const stride = page0.size.height + pageGap;

  return spans.map(({ line, s, e, block }, idx) => {
    // M-HEADER-FOOTER-3 — the ECHO rule: a band line is ALWAYS a
    // first/last (partial x). Spell/search paint on EVERY echo (the
    // text renders on every page), and the plain first/middle/last
    // walk would full-width the middle echoes — the "one big bar under
    // the whole header" bug. Each echo is its own line sequence.
    const first = idx === 0 || line.band != null;
    const last = idx === spans.length - 1 || line.band != null;
    const off =
      first || last
        ? alignOffset(block.align, line.rect.width, cb.width - line.rect.x)
        : 0;
    const wrap = blockWrapWidth(cb.width, block);
    const x1 = first || last ? off + lineOffsetX(line, block, s, metrics, wrap) : line.rect.x;
    const x2 = first || last ? off + lineOffsetX(line, block, e, metrics, wrap) : cb.width;
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
      stride * line.pageIndex + cb.y + line.rect.y + line.baseline + SPELL_LINE_OFFSET * fontSize;
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
 * baseline plus the max descent over the line's runs. Under the M6
 * bottom-only ruling the box top IS the text top (baseline = ascent
 * from the box top), so the text band is exactly
 * [rect.y, rect.y + baseline + descent). An EMPTY line (no segments)
 * measures under the block's own zero-length run — the P1
 * empty-textblock projection guarantees one — so an empty paragraph's
 * caret matches its neighbors even at lineHeight ≠ 1.
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
  /** M-HEADER-FOOTER-3: the active band page — a band block's echoes
   *  share rangeStart/rangeEnd, so lineForOffset would resolve the
   *  FIRST echo (page 0) no matter where the caret was placed. Passing
   *  the active page filters to that page's echo; absent = page-0 echo
   *  (the pre-fix fallback, unchanged for body blocks). */
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
  return {
    pageIndex: line.pageIndex,
    x:
      lineOffsetX(line, bo.block, bo.offset, metrics, blockWrapWidth(page0.contentBox.width, bo.block)) +
      // Indent-narrowed box (rect.x IS indentLeft): the caret x of a
      // centered/right-aligned indented block stays in its column.
      alignOffset(bo.block.align, line.rect.width, page0.contentBox.width - line.rect.x),
    // THE CARET IS THE TEXT BAND, NOT THE LINE BOX (GDocs): top stays
    // at the box top (text, under the M6 ruling) but the bottom stops
    // at the text's descent — a 2.0-spaced line never stretches the
    // caret across its leading. Selection rects keep the full box.
    // At lineHeight 1.0 this is bit-identical to the box height.
    y: line.rect.y,
    height: textBandHeight(line, bo.block, metrics) ?? line.rect.height,
  };
}

export interface CaretStackRect {
  left: number;
  top: number;
  height: number;
}

/** Caret/caret-like rect in stack-local px: page stack offset +
 * content box + the caret's text-band geometry (top at the LineBox
 * top, height = text band). Shared by the caret painter and the
 * caret-follow scroll — one source of this arithmetic. */
export function caretStackRect(
  caret: CaretGeometry,
  contentX: number,
  contentY: number,
  pageHeight: number,
  pageGap: number
): CaretStackRect {
  return {
    left: contentX + caret.x,
    top: caret.pageIndex * (pageHeight + pageGap) + contentY + caret.y,
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

/** Word range around pos, from the doc model (PM ships no word utilities;
 * the legacy lesson was fighting PM's native path — here events land on
 * the painted surface, so owning the range derivation is required). */
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

/**
 * M-TABLES — the CELL node's position containing `pos` (or null): the
 * drag-select's cell-crossing probe and the cell-toolbar anchor's
 * lookup.
 */
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
