/**
 * #58 SECTIONS — the page STACK arithmetic. Pages may differ in size
 * (per-section geometry), so the uniform stride (pages[0].height ×
 * index) is gone: every stack-local y offset reads the CUMULATIVE
 * tops table, and every hit-test inverts it. One derivation, shared
 * by the sheet layout, the overlays, the caret, and the hit-testers
 * (the L1 container-offset law — engine facts in, container offsets
 * out; never a second formula).
 *
 * #101 — SPLIT VIEW: the stack arithmetic is COLUMN-AWARE. `columns`
 * (1 = the classic vertical stack — bit-identical) arranges the pages
 * row-major: page 0 | page 1 in row 0, page 2 | page 3 in row 1, ….
 * Pages in a row share its top; each column owns a left offset. One
 * derivation, shared by the sheet layout and every hit-tester.
 */

import type { PageGeometry } from '@tensor-editor/engine';

/** The stack-local TOP of each page's sheet (px, pre-zoom): a running
 *  sum of the previous pages' heights plus one gap each. */
export function pageTops(
  pages: ReadonlyArray<Pick<PageGeometry, 'size'>>,
  gap: number,
): number[] {
  const tops: number[] = new Array(pages.length);
  let y = 0;
  for (let i = 0; i < pages.length; i++) {
    tops[i] = y;
    y += pages[i]!.size.height + gap;
  }
  return tops;
}

/** The page whose sheet spans a stack-local y (clamped to the doc).
 *  Linear walk — page counts are small and the callers are
 *  event-driven (never per-line). */
export function pageIndexAtY(
  tops: number[],
  pageCount: number,
  localY: number,
): number {
  let page = 0;
  for (let i = 0; i < pageCount; i++) {
    if (tops[i]! <= localY) page = i;
    else break;
  }
  return Math.max(0, Math.min(pageCount - 1, page));
}

/** The stack's total size (the scrollable sheet area). */
export function stackSize(
  pages: ReadonlyArray<Pick<PageGeometry, 'size'>>,
  gap: number,
): { width: number; height: number } {
  let width = 0;
  let height = 0;
  for (const page of pages) {
    width = Math.max(width, page.size.width);
    height += page.size.height;
  }
  if (pages.length > 1) height += (pages.length - 1) * gap;
  return { width, height: height || 0 };
}

/**
 * #101 — SPLIT VIEW: the COLUMN-AWARE grid — the one derivation the
 * split-view surfaces share. Row-major arrangement: page i sits in
 * row floor(i / columns), column i % columns. Pages in a row share
 * its top (the row's height = the tallest member); each column owns
 * a left offset (the column's width = the widest member). `columns`
 * 1 collapses to the classic vertical stack bit-for-bit.
 */
export interface PageGridLayout {
  /** Per page: the row's top (stack-local px). */
  tops: number[];
  /** Per page: the column's left (stack-local px). */
  lefts: number[];
  /** The column count (echoed for the callers' branches). */
  columns: number;
  /** The scrollable sheet area's total size. */
  size: { width: number; height: number };
  /** The per-column x-ranges (the widest-member widths) and the
   *  per-row y-ranges (the tallest-member heights) — the hit-test's
   *  GAP ROUTING: a click in a row/column gutter or margin resolves
   *  row by y (second gap half → next row) and column by x (nearest
   *  column — Word's nearest-text posture), never y-only. */
  columnRanges: { left: number; width: number }[];
  rowRanges: { top: number; height: number }[];
}

export function pageGridLayout(
  pages: ReadonlyArray<Pick<PageGeometry, 'size'>>,
  gap: number,
  columns: number,
): PageGridLayout {
  if (columns <= 1) {
    const tops = pageTops(pages, gap);
    return {
      tops,
      lefts: pages.map(() => 0),
      columns: 1,
      size: stackSize(pages, gap),
      columnRanges: [{ left: 0, width: stackSize(pages, gap).width }],
      rowRanges: pages.map((p, i) => ({ top: tops[i]!, height: p.size.height })),
    };
  }
  const cols = Math.max(1, Math.floor(columns));
  // Per-column widths (the widest member) and per-row heights.
  const colWidths: number[] = new Array(cols).fill(0);
  const rowHeights: number[] = [];
  for (let i = 0; i < pages.length; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    colWidths[c] = Math.max(colWidths[c]!, pages[i]!.size.width);
    if (r === rowHeights.length) rowHeights.push(0);
    rowHeights[r] = Math.max(rowHeights[r]!, pages[i]!.size.height);
  }
  // The column lefts (the cumulative widest-member widths + gaps).
  const colLefts: number[] = [];
  let x = 0;
  for (let c = 0; c < cols; c++) {
    colLefts.push(x);
    x += colWidths[c]! + gap;
  }
  // The row tops (the cumulative tallest-member heights + gaps).
  const rowTops: number[] = [];
  let y = 0;
  for (let r = 0; r < rowHeights.length; r++) {
    rowTops.push(y);
    y += rowHeights[r]! + gap;
  }
  const tops: number[] = new Array(pages.length);
  const lefts: number[] = new Array(pages.length);
  for (let i = 0; i < pages.length; i++) {
    tops[i] = rowTops[Math.floor(i / cols)]!;
    lefts[i] = colLefts[i % cols]!;
  }
  const width = colWidths.reduce((s, w) => s + w, 0) + Math.max(0, cols - 1) * gap;
  const height = rowHeights.reduce((s, h) => s + h, 0) + Math.max(0, rowHeights.length - 1) * gap;
  const columnRanges = colWidths.map((w, c) => ({ left: colLefts[c]!, width: w }));
  const rowRanges = rowHeights.map((h, r) => ({ top: rowTops[r]!, height: h }));
  return {
    tops,
    lefts,
    columns: cols,
    size: { width: pages.length ? width : 0, height: pages.length ? height : 0 },
    columnRanges,
    rowRanges,
  };
}

/**
 * #101 — SPLIT VIEW: the POINT hit — the page whose sheet contains
 * the stack-local (x, y). In split view a y spans TWO pages (side by
 * side), so the column disambiguates by x. The fallback (no sheet
 * contains the point — a gutter, a margin, the inter-row gap, or
 * beyond the stack) resolves the ROW and the COLUMN separately:
 * the row by y (the last row whose top ≤ y, the gap's second half
 * owned by the NEXT row — the classic stack's gap law, now row-wise),
 * the column by x (containment, else the NEAREST column — Word's
 * nearest-text posture for margin/gutter clicks), then row-major
 * composition, clamped to the doc. columns 1 collapses to the
 * historical y-only walk + gap bump bit-for-bit.
 */
export function pageIndexAtPoint(
  grid: PageGridLayout,
  pages: ReadonlyArray<Pick<PageGeometry, 'size'>>,
  localX: number,
  localY: number,
  /** The page gap — the gap-ownership half. */
  gap = 0,
): number {
  for (let i = 0; i < pages.length; i++) {
    const withinX =
      localX >= grid.lefts[i]! && localX < grid.lefts[i]! + pages[i]!.size.width;
    const withinY =
      localY >= grid.tops[i]! && localY < grid.tops[i]! + pages[i]!.size.height;
    if (withinX && withinY) return i;
  }
  // THE ROW: the last row whose top ≤ y; the gap's second half belongs
  // to the next row.
  let row = 0;
  for (let r = 0; r < grid.rowRanges.length; r++) {
    if (grid.rowRanges[r]!.top <= localY) row = r;
    else break;
  }
  const rr = grid.rowRanges[row]!;
  if (localY > rr.top + rr.height + gap / 2 && row < grid.rowRanges.length - 1) {
    row += 1;
  }
  // THE COLUMN: containment, else the nearest (the first column whose
  // left is at/past the click, else the last).
  let col = 0;
  const found = grid.columnRanges.findIndex(
    (c) => localX >= c.left && localX < c.left + c.width,
  );
  if (found >= 0) col = found;
  else {
    const next = grid.columnRanges.findIndex((c) => c.left >= localX);
    col = next >= 0 ? next : grid.columnRanges.length - 1;
  }
  return Math.min(row * grid.columns + col, pages.length - 1);
}
