import { describe, it, expect } from 'vitest';
import {
  pageTops,
  stackSize,
  pageGridLayout,
  pageIndexAtPoint,
  pageIndexAtY,
} from '@/lib/paginated/pageStack';
import type { PageGeometry } from '@tensor-editor/engine';

// #101 — split view: the column-aware grid arithmetic. Columns 1
// collapses to the classic vertical stack BIT-FOR-BIT (every existing
// consumer keeps its exact coordinates); columns 2 arranges row-major
// — pages in a row share the row's top, each column owns a left. The
// point hit disambiguates a y spanning two side-by-side pages by x.

const PAGE_W = 816;
const PAGE_H = 1056;
const GAP = 32;

/** Letter pages; `size` overrides for mixed-size cases. */
function pages(n: number, size?: Partial<{ width: number; height: number }>) {
  return Array.from({ length: n }, () => ({
    size: { width: size?.width ?? PAGE_W, height: size?.height ?? PAGE_H },
  })) as Pick<PageGeometry, 'size'>[];
}

describe('pageGridLayout — the columns-1 identity', () => {
  it('is bit-identical to the classic stack: tops = pageTops, lefts all 0, size = stackSize', () => {
    const ps = pages(5);
    const grid = pageGridLayout(ps, GAP, 1);
    expect(grid.tops).toEqual(pageTops(ps, GAP));
    expect(grid.lefts).toEqual([0, 0, 0, 0, 0]);
    expect(grid.size).toEqual(stackSize(ps, GAP));
    expect(grid.columns).toBe(1);
  });

  it('clamps absurd column counts (0, negatives, floats) to the identity', () => {
    const ps = pages(3);
    for (const cols of [0, -2, 1.9]) {
      const grid = pageGridLayout(ps, GAP, cols as number);
      expect(grid.tops).toEqual(pageTops(ps, GAP));
      expect(grid.lefts).toEqual([0, 0, 0]);
    }
  });

  it('handles the empty doc', () => {
    const grid = pageGridLayout([], GAP, 2);
    expect(grid.tops).toEqual([]);
    expect(grid.lefts).toEqual([]);
    expect(grid.size).toEqual({ width: 0, height: 0 });
  });
});

describe('pageGridLayout — the two-column rows', () => {
  it('pairs pages row-major: row-mates share a top, the second column owns left = width + gap', () => {
    const ps = pages(4);
    const grid = pageGridLayout(ps, GAP, 2);
    // Row 0: pages 0 and 1.
    expect(grid.tops[0]).toBe(0);
    expect(grid.tops[1]).toBe(0);
    expect(grid.lefts[0]).toBe(0);
    expect(grid.lefts[1]).toBe(PAGE_W + GAP);
    // Row 1: pages 2 and 3, one row height + gap below.
    expect(grid.tops[2]).toBe(PAGE_H + GAP);
    expect(grid.tops[3]).toBe(PAGE_H + GAP);
    expect(grid.lefts[2]).toBe(0);
    expect(grid.lefts[3]).toBe(PAGE_W + GAP);
    // The scrollable area: two columns wide, two rows tall.
    expect(grid.size.width).toBe(PAGE_W * 2 + GAP);
    expect(grid.size.height).toBe(PAGE_H * 2 + GAP);
  });

  it('uses the TALLEST member for each row and the WIDEST for each column (mixed sections)', () => {
    // Page 1 is taller; page 2 is wider — section mixing. Columns
    // accumulate the widest member across EVERY row of that column,
    // so a wide page in row 1 pushes the next column right.
    const ps = [
      { size: { width: PAGE_W, height: PAGE_H } },
      { size: { width: PAGE_W, height: PAGE_H + 100 } },
      { size: { width: PAGE_W + 50, height: PAGE_H } },
      { size: { width: PAGE_W, height: PAGE_H } },
    ] as Pick<PageGeometry, 'size'>[];
    const grid = pageGridLayout(ps, GAP, 2);
    // Row 0's height = page 1's (the taller).
    expect(grid.tops[0]).toBe(0);
    expect(grid.tops[1]).toBe(0);
    expect(grid.tops[2]).toBe(PAGE_H + 100 + GAP);
    expect(grid.tops[3]).toBe(PAGE_H + 100 + GAP);
    // Column 1's left = column 0's widest member (page 2's 866) + gap.
    expect(grid.lefts[1]).toBe(PAGE_W + 50 + GAP);
    expect(grid.lefts[3]).toBe(PAGE_W + 50 + GAP);
    // The stack width = the columns' widest members + the gap.
    expect(grid.size.width).toBe(PAGE_W + 50 + GAP + PAGE_W);
  });

  it('handles an ODD page count: the last page sits alone in its row', () => {
    const ps = pages(3);
    const grid = pageGridLayout(ps, GAP, 2);
    expect(grid.tops[2]).toBe(PAGE_H + GAP);
    expect(grid.lefts[2]).toBe(0);
    expect(grid.size.height).toBe(PAGE_H * 2 + GAP);
  });
});

describe('pageIndexAtPoint — the column-disambiguated hit', () => {
  const ps = pages(4);
  const grid = pageGridLayout(ps, GAP, 2);

  it('picks the SECOND column page when x lands right of the first sheet', () => {
    // Row 0's y, x inside page 1's sheet.
    expect(pageIndexAtPoint(grid, ps, PAGE_W + GAP + 100, PAGE_H / 2)).toBe(1);
    // Row 1's y, x inside page 3's sheet.
    expect(pageIndexAtPoint(grid, ps, PAGE_W + GAP + 100, PAGE_H + GAP + PAGE_H / 2)).toBe(3);
  });

  it('picks the FIRST column page when x lands inside it', () => {
    expect(pageIndexAtPoint(grid, ps, 100, PAGE_H / 2)).toBe(0);
    expect(pageIndexAtPoint(grid, ps, 100, PAGE_H + GAP + PAGE_H / 2)).toBe(2);
  });

  it('falls back to the NEAREST COLUMN in the column gutter (no sheet owns the x)', () => {
    // x in the vertical gutter between columns, y in row 0 → the
    // column resolution picks the NEAREST column (the first whose left
    // is at/past the click — Word's nearest-text posture) → page 1.
    expect(pageIndexAtPoint(grid, ps, PAGE_W + GAP / 2, PAGE_H / 2, GAP)).toBe(1);
    // A gutter click left of column 0 → the nearest is column 0.
    expect(pageIndexAtPoint(grid, ps, -40, PAGE_H / 2, GAP)).toBe(0);
  });

  it('routes ROW-GAP clicks by column (the second gap half belongs to the next row)', () => {
    // y inside the inter-row gap (1056..1088), x in each column: the
    // second half of the gap belongs to the NEXT ROW — of the CLICK'S
    // column (a y-only bump would jump to the other column).
    expect(pageIndexAtPoint(grid, ps, 100, PAGE_H + GAP / 2 + 4, GAP)).toBe(2);
    expect(pageIndexAtPoint(grid, ps, PAGE_W + GAP + 100, PAGE_H + GAP / 2 + 4, GAP)).toBe(3);
    // The gap's FIRST half stays with the current row.
    expect(pageIndexAtPoint(grid, ps, 100, PAGE_H + GAP / 2 - 4, GAP)).toBe(0);
    expect(pageIndexAtPoint(grid, ps, PAGE_W + GAP + 100, PAGE_H + GAP / 2 - 4, GAP)).toBe(1);
  });

  it('falls back to the nearest page of the click column beyond the stack (clamped)', () => {
    // Below every sheet, x in the LEFT column: the nearest content is
    // the last page OF THAT COLUMN (row 1's left page) — not the
    // doc's last page (the old y-only walk's answer).
    expect(pageIndexAtPoint(grid, ps, 100, PAGE_H * 10, GAP)).toBe(2);
    // Same y, x in the RIGHT column → the last page of that column.
    expect(pageIndexAtPoint(grid, ps, PAGE_W + GAP + 100, PAGE_H * 10, GAP)).toBe(3);
    // ABOVE the stack: the nearest page of the click's column.
    expect(pageIndexAtPoint(grid, ps, PAGE_W + GAP + 100, -50, GAP)).toBe(1);
    expect(pageIndexAtPoint(grid, ps, 100, -50, GAP)).toBe(0);
  });
});

describe('pageIndexAtY — the stack walk (the split-view fallback law)', () => {
  it('reads the ROW tops in split view: a y maps by the walk alone', () => {
    const ps = pages(4);
    const grid = pageGridLayout(ps, GAP, 2);
    // The walk picks the LAST page whose row-top <= y — in a shared
    // row that is the row's LAST page (the x disambiguation is
    // pageIndexAtPoint's job).
    expect(pageIndexAtY(grid.tops, ps.length, PAGE_H / 2)).toBe(1);
    expect(pageIndexAtY(grid.tops, ps.length, PAGE_H + GAP + PAGE_H / 2)).toBe(3);
  });
});
