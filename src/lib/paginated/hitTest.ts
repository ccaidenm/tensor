import { fitDownImage, type LayoutResult, type PageGeometry, type TextMetrics, type TextStyle } from '@tensor-editor/engine';
import { pageGridLayout, pageIndexAtPoint } from './pageStack';
import type { AdapterBlock } from './adapter';
import { alignOffset, blockWrapWidth, lineColumnFrame } from './positionMap';

/**
 * #74 — the click's COLUMN index from the content-box-relative x.
 * Gutter/margin clicks clamp to the nearest column (Word's posture);
 * single-column pages → 0.
 */
function clickColumnOf(page: PageGeometry, x: number): number {
  if (!page.columns || page.columns.length === 0) return 0;
  const found = page.columns.findIndex((c) => x >= c.x && x < c.x + c.width);
  if (found >= 0) return found;
  const next = page.columns.findIndex((c) => c.x >= x);
  return next >= 0 ? next : page.columns.length - 1;
}

// THE NEAREST-LINE RULE: clicks resolve to the nearest line WITHIN
// the nearest sheet — margin/gap clicks clamp to that sheet's nearest
// line; x beyond a line's end resolves to that line's end position.

/** The band-extent rule's slack: the painted band rect grown by this
 * many px is the click target. */
const BAND_HIT_PAD = 6;

export interface HitResult {
  blockId: string;
  /** Offset into the block's concatenated run text. */
  offset: number;
  /**
   * The hit's page (the sheet the click resolved against — gap-half
   * ownership applied) and, IFF band content, which band. The shell's
   * active-band-page tracking rides these.
   */
  pageIndex: number;
  band?: 'header' | 'footer';
}

/** @param localX/localY stack-local (pre-zoom) px. */
export function hitTest(
  result: LayoutResult,
  blocks: readonly AdapterBlock[],
  metrics: TextMetrics,
  pageGap: number,
  localX: number,
  localY: number,
  /** #101 — SPLIT VIEW: the paginated desk's page arrangement (the
   *  column-aware point hit; absent = the classic stack). */
  pageColumns: 1 | 2 = 1
): HitResult | null {
  if (result.pages.length === 0) return null;
  // #58 — invert the grid (pages may differ per section), then read
  // the hit page's own contentBox.
  const grid = pageGridLayout(result.pages, pageGap, pageColumns);
  const tops = grid.tops;
  // #101 — the POINT hit: a y spans two pages side by side, so the
  // column disambiguates by x; the fallback resolves row by y,
  // column by x inside the grid hit.
  let pageIndex = pageIndexAtPoint(grid, result.pages, localX, localY, pageGap);
  pageIndex = Math.min(Math.max(pageIndex, 0), result.pages.length - 1);
  const cb = result.pages[pageIndex]!.contentBox;
  const pageTop = tops[pageIndex]!;

  const pageLines = result.lines.filter((l) => l.pageIndex === pageIndex);
  if (pageLines.length === 0) return null;

  // Band lines never join the nearest-line clamps — their rects sit
  // OUTSIDE the content box; mixing them in would misplace every
  // margin click.
  const flowLines = pageLines.filter((l) => !l.band);

  const y = localY - pageTop - cb.y;
  // Declared BEFORE the band rule: the hoisted glyphWalk closes over
  // it — a TDZ violation here was the every-band-click crash.
  const x = localX - cb.x;

  // THE BAND-EXTENT RULE: a click routes to the band ONLY within its
  // PAINTED EXTENT (first line's top to last line's bottom, ±
  // BAND_HIT_PAD) — outside it, margin clicks fall to the body's
  // nearest-line clamp (Word routes margin clicks to the body).
  const headerStrip = y < 0;
  const footerStrip = y >= cb.height;
  if (headerStrip || footerStrip) {
    const which: 'header' | 'footer' = headerStrip ? 'header' : 'footer';
    const bandLines = pageLines
      .filter((l) => l.band === which)
      .sort((a, b) => a.rect.y - b.rect.y);
    if (bandLines.length > 0) {
      const bandFirst = bandLines[0]!;
      const bandLast = bandLines[bandLines.length - 1]!;
      const inExtent =
        y >= bandFirst.rect.y - BAND_HIT_PAD &&
        y <= bandLast.rect.y + bandLast.rect.height + BAND_HIT_PAD;
      if (inExtent) {
        const line =
          y < bandFirst.rect.y
            ? bandFirst
            : bandLines.find((l) => y >= l.rect.y && y < l.rect.y + l.rect.height) ?? bandLast;
        const block = blocks.find((b) => b.id === line.blockId);
        if (!block) return null;
        const hit = glyphWalk(line, block);
        return hit ? { ...hit, pageIndex, band: which } : null;
      }
    }
  }

  // Flow clamps (body lines only). #74 — COLUMN-scoped: a click
  // above/below column 2 clamps to column 2's endpoints, never
  // column 1's.
  const clickColumn = clickColumnOf(result.pages[pageIndex]!, x);
  const laneFlow = flowLines.filter((l) => (l.column ?? 0) === clickColumn);
  if (laneFlow.length > 0) {
    const first = laneFlow[0]!;
    const last = laneFlow[laneFlow.length - 1]!;
    if (y < first.rect.y)
      return { blockId: first.blockId, offset: first.rangeStart, pageIndex };
    if (y >= last.rect.y + last.rect.height) {
      return { blockId: last.blockId, offset: last.rangeEnd, pageIndex };
    }
  }
  const bodyLast = laneFlow[laneFlow.length - 1];

  // THE CELL-FIRST RULE: a click inside a tableCell rect resolves
  // within THAT cell (its own lines, y-clamped) — a walk over a wrong
  // lane would land the caret across the cell wall.
  const pageCells = result.placed.filter(
    (pr) => pr.pageIndex === pageIndex && pr.kind === 'tableCell',
  );
  const hitCell = pageCells.find(
    (pr) =>
      x >= pr.rect.x && x <= pr.rect.x + pr.rect.width && y >= pr.rect.y && y <= pr.rect.y + pr.rect.height,
  );
  // Hoisted (function declaration): the band-strip rule above and the
  // cell-first rule below both call it.
  function glyphWalk(line: (typeof pageLines)[number], block: AdapterBlock): HitResult | null {
    // Same offset the painter and caret use — the indent-narrowed box
    // (rect.x IS indentLeft); a click in the marker GUTTER falls
    // through the glyph loop to the item's first position.
    // #74 — the align container and clamp width are the COLUMN's.
    const frame = lineColumnFrame(result.pages[pageIndex]!, line);
    const baseX = line.rect.x + alignOffset(block.align, line.rect.width, frame.left + frame.width - line.rect.x);
    // The per-page ink shift accumulates across the walk
    // (fieldShiftBefore); the walk compensates so clicks on SHIFTED
    // ink map to the true offsets.
    let shift = 0;
    for (let si = 0; si < line.segments.length; si++) {
      const seg = line.segments[si]!;
      const run = block.runs[seg.runIndex];
      if (!run) continue;
      // The cursor seeds from the ENGINE's placed x (prefix sums
      // cannot model tabs); a tab resolves by the glyph-midpoint rule
      // over its pen jump.
      let cursor = baseX + seg.x - shift;
      // The DRAWN number owns its width (left-anchored at the slot
      // start); clicks inside it map to the field atom (one PM
      // position). The slack past it shifts into the NEXT segment's
      // cursor.
      if ((run as { fieldKind?: string }).fieldKind && run.kind !== 'inlineImage') {
        const fk = (run as { fieldKind?: string }).fieldKind;
        const style = (run as { style: TextStyle }).style;
        const slot = metrics.measure(block.text.slice(seg.start, seg.end), style);
        const resolved =
          fk === 'pages'
            ? slot
            : metrics.measure(String(pageIndex + 1), style);
        if (x < cursor + resolved) {
          return { blockId: line.blockId, offset: seg.start, pageIndex };
        }
        shift += Math.max(0, slot - resolved);
        continue;
      }
      if (run.kind === 'inlineImage') {
        // The object token: ONE position per object — the entire
        // painted advance belongs to it. The clamp width is the cell's
        // LANE CONTENT width for table lines, else the block's BASE
        // wrap width — the same inputs the engine's clamp used.
        const wrap = line.tableCell ? line.tableCell.width : blockWrapWidth(frame.width, block);
        const dims = fitDownImage(run.width, run.height, wrap, Infinity);
        if (x < cursor + dims.width) return { blockId: line.blockId, offset: seg.start, pageIndex };
        continue;
      }
      const isTab = seg.end === seg.start + 1 && block.text[seg.start] === '\t';
      const nextSeg = line.segments[si + 1];
      for (let i = seg.start; i < seg.end; i++) {
        const w = isTab
          ? (nextSeg ? nextSeg.x : line.rect.width) - seg.x
          : metrics.measure(block.text[i]!, run.style);
        if (x < cursor + w / 2) return { blockId: line.blockId, offset: i, pageIndex };
        cursor += w;
      }
    }
    return { blockId: line.blockId, offset: line.rangeEnd, pageIndex };
  }
  if (hitCell?.cell) {
    const block = blocks.find((b) => b.id === hitCell.blockId);
    if (block) {
      // The cell's OWN lines (lane identity: the anchor's row/col), y-ordered.
      const laneLines = pageLines
        .filter(
          (l) =>
            l.blockId === hitCell.blockId &&
            l.tableCell &&
            l.tableCell.row === hitCell.cell!.row &&
            l.tableCell.col === hitCell.cell!.col,
        )
        .sort((a, b) => a.rect.y - b.rect.y);
      const laneFirst = laneLines[0];
      const laneLast = laneLines[laneLines.length - 1];
      if (laneFirst && laneLast) {
        // The lane's y-clamp: above the text → the slice's start; below
        // → the line's end (the cell's remaining height is slack).
        const line =
          y < laneFirst.rect.y
            ? laneFirst
            : laneLines.find((l) => y >= l.rect.y && y < l.rect.y + l.rect.height) ?? laneLast;
        const hit = glyphWalk(line, block);
        return hit ? { ...hit, pageIndex } : null;
      }
    }
  }

  // Lines tile the content box; cell lines are lane content (the
  // cell-first rule owns them), band lines band content (the strip
  // rule owns them) — exactly one flow line contains y. #74 — the
  // match is COLUMN-scoped: a column-2 click resolves to column 2's
  // line at that y.
  const line =
    laneFlow.find(
      (l) => !l.tableCell && !l.band && y >= l.rect.y && y < l.rect.y + l.rect.height,
    ) ?? bodyLast;
  if (!line) return null;

  const block = blocks.find((b) => b.id === line.blockId);
  if (!block) return null;
  const hit = glyphWalk(line, block);
  return hit ? { ...hit, pageIndex } : null;
}
