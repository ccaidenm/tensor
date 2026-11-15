/**
 * #58 SECTIONS — the page STACK arithmetic. Pages may differ in size
 * (per-section geometry), so the uniform stride (pages[0].height ×
 * index) is gone: every stack-local y offset reads the CUMULATIVE
 * tops table, and every hit-test inverts it. One derivation, shared
 * by the sheet layout, the overlays, the caret, and the hit-testers
 * (the L1 container-offset law — engine facts in, container offsets
 * out; never a second formula).
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