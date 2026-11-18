import { fitDownImage, type LayoutResult, type PageGeometry, type TextMetrics, type TextStyle } from '@tensor-editor/engine';
import { pageIndexAtY, pageTops } from './pageStack';
import type { AdapterBlock } from './adapter';
import { alignOffset, blockWrapWidth, lineColumnFrame } from './positionMap';

/** #74 — the click's COLUMN index: the page's resolved grid facts +
 * the content-box-relative x. A click inside a column's band picks
 * that column; gutter/margin clicks clamp to the nearest column's
 * range (the first column whose left edge is at/past the click, else
 * the last column — a margin click routes to the nearest text, Word's
 * posture). Single-column pages → 0 (the one lane). */
function clickColumnOf(page: PageGeometry, x: number): number {
  if (!page.columns || page.columns.length === 0) return 0;
  const found = page.columns.findIndex((c) => x >= c.x && x < c.x + c.width);
  if (found >= 0) return found;
  const next = page.columns.findIndex((c) => c.x >= x);
  return next >= 0 ? next : page.columns.length - 1;
}

// THE NEAREST-LINE RULE (from the legacy dead-zone fixtures): clicks
// resolve to the nearest line WITHIN the nearest sheet — a click in a
// page margin or the inter-sheet gap clamps to that sheet's nearest
// line, and x beyond a line's end resolves to that line's end position.
// The spacer/gap geometry that made the legacy clicks ambiguous no
// longer exists; this is clamping, never correction.

/** M-HEADER-FOOTER-3: the band-extent rule's slack — the painted band
 * rect grown by this many px is the click target (aiming slack; outside
 * it, margin clicks fall through to the body's nearest-line clamp). */
const BAND_HIT_PAD = 6;

export interface HitResult {
  blockId: string;
  /** Offset into the block's concatenated run text. */
  offset: number;
  /**
   * M-HEADER-FOOTER-3: the hit's page (the sheet the click resolved
   * against — gap-half ownership applied) and, IFF the hit is band
   * content, which band. The shell's active-band-page tracking rides
   * these (echo projections resolve the clicked page's echo).
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
  localY: number
): HitResult | null {
  if (result.pages.length === 0) return null;
  // #58 — per-page geometry: invert the CUMULATIVE tops table (pages
  // may differ per section), then read the hit page's own contentBox.
  const tops = pageTops(result.pages, pageGap);
  let pageIndex = pageIndexAtY(tops, result.pages.length, localY);
  {
    const sec = result.pages[pageIndex]!;
    const pageH = sec.size.height;
    const pageEnd = tops[pageIndex]! + pageH;
    // Gap ownership: the second half of a gap belongs to the next sheet.
    if (localY > pageEnd + pageGap / 2 && pageIndex < result.pages.length - 1) {
      pageIndex += 1;
    }
  }
  pageIndex = Math.min(Math.max(pageIndex, 0), result.pages.length - 1);
  const cb = result.pages[pageIndex]!.contentBox;
  const pageTop = tops[pageIndex]!;

  const pageLines = result.lines.filter((l) => l.pageIndex === pageIndex);
  if (pageLines.length === 0) return null;

  // M-HEADER-FOOTER-2 — the FLOW track: band lines never join the
  // nearest-line clamps (their rects sit OUTSIDE the content box:
  // negative-y headers, below-box footers — mixing them into the
  // first/last flow clamps would misplace every margin click).
  const flowLines = pageLines.filter((l) => !l.band);

  const y = localY - pageTop - cb.y;
  // Declared BEFORE the band rule: the hoisted glyphWalk closes over
  // it, and the band rule calls glyphWalk — a TDZ violation here was
  // the every-band-click crash (caught by the M-3 caret test).
  const x = localX - cb.x;

  // M-HEADER-FOOTER-3 — THE BAND-EXTENT RULE (tightened from the v2
  // strip rule): a click routes to the band ONLY within the band's
  // PAINTED EXTENT (its first line's top to its last line's bottom,
  // ± BAND_HIT_PAD). The v2 rule claimed the ENTIRE margin strip, so a
  // single click in the margin below the header (or above the footer)
  // "triggered" the band instead of the body's nearest-line clamp —
  // Word routes margin clicks to the body; band clicks to the band.
  // Outside the extent (or no band on the page) → the body clamps.
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

  // Flow clamps (body lines only — a band-only page has none, and its
  // clicks are owned by the band rule above). #74 — the clamps are
  // COLUMN-scoped: the click's lane's first/last line, so a click
  // above/below column 2 clamps to column 2's endpoints, never column
  // 1's (the single-column page has one lane — identical behavior).
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

  // M-TABLES — THE CELL-FIRST RULE: a click inside a tableCell rect
  // resolves within THAT cell (the lane's own lines, y-clamped),
  // regardless of parallel neighbors. The bands' rects tile the table;
  // the per-glyph walk over a wrong lane would land the caret across
  // the cell wall.
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
    // (rect.x IS indentLeft). A click in the marker GUTTER (x < indent)
    // falls through the nearest-glyph loop and resolves to the item's
    // first position — the nearest-line rule stays symmetric with paint.
    // #74 — the align container and the clamp width are the line's
    // COLUMN's (the engine broke the line at the column's width).
    const frame = lineColumnFrame(result.pages[pageIndex]!, line);
    const baseX = line.rect.x + alignOffset(block.align, line.rect.width, frame.left + frame.width - line.rect.x);
    // M-PAGEFIELD: the per-page INK SHIFT accumulates across the walk
    // (fieldShiftBefore — the same derivation paint/lineOffsetX use).
    // Drawn ink sits at measured - shift; the walk compensates so
    // clicks on SHIFTED ink map to the true offsets.
    let shift = 0;
    for (let si = 0; si < line.segments.length; si++) {
      const seg = line.segments[si]!;
      const run = block.runs[seg.runIndex];
      if (!run) continue;
      // M-RULER Phase 4: the cursor seeds from the ENGINE's placed x —
      // prefix sums cannot model tab advances. A \t's advance is the gap
      // to the next segment's x (the placed pen jump); the tab resolves
      // by the same glyph-midpoint rule over that jump.
      let cursor = baseX + seg.x - shift;
      // M-PAGEFIELD: the DRAWN number owns its width (LEFT-anchored at
      // the slot start — the paint ruling); clicks inside it map to the
      // field atom (ONE PM position — the inlineImage precedent). The
      // slack past the drawn number shifts into the NEXT segment's
      // cursor, so clicks on the shifted trailing ink stay true.
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
        // M-IMAGES-2 — the object token: ONE position per object (the
        // engine's unbreakable-token contract). The ENTIRE painted
        // advance belongs to the object — a click anywhere inside it
        // resolves to its offset (the token position BEFORE the node).
        // The clamp width is the cell's LANE CONTENT width for table
        // lines (the engine's own clamp input), else the block's BASE
        // wrap width — the SAME inputs the engine's clamp used. #74 —
        // the base wrap is the COLUMN's width.
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

  // Lines tile the content box (band-wise contiguity) — table cell
  // lines are lane content (skipped: the cell-first rule above owns
  // them); band lines are band content (the strip rule above owns
  // them); exactly one flow line contains y. #74 — the match is
  // COLUMN-scoped: the click's lane's lines share the slot index, so a
  // column-2 click resolves to column 2's line at that y, never
  // column 1's (the M-TABLES cell-lane rule generalized; the
  // single-column page has one lane — identical behavior).
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
