import { useLayoutEffect, useRef } from 'react';
import type { PageGeometry, PlacedRect } from '@tensor-editor/engine';

/**
 * M-TABLES — the paginated cell paint: fills + grid strokes from the
 * engine's placed[] (kind 'tableCell' — the bands' paint geometry; the
 * shell draws, never computes). Sibling of ImageLayer INSIDE the sheet,
 * mounted BETWEEN the behind-floats and the block canvases: fills and
 * strokes sit UNDER the cell text (the paint-order receipt).
 *
 * BORDER PRESETS: 'all' strokes every cell's four edges (shared edges
 * double-draw at the same 1px — a collapse illusion, deliberate);
 * 'outer' strokes the union frame of THIS page's table rects (a page
 * fragment's frame — the aggregation of engine-issued geometry, the
 * paintedBounds precedent — never a re-derivation of layout);
 * 'none' draws fills only.
 *
 * The canvas has no theme — the hairline is the block-decor family's
 * gray (paint.ts's QUOTE_BORDER_COLOR neighbor), matching the pageless
 * var(--border) in light mode on the white paper canvas.
 */

const TABLE_BORDER_COLOR = '#d4d4d8';

interface TableCellLayerProps {
  geometry: PageGeometry;
  /** This page's tableCell rects (document order). */
  cells: readonly PlacedRect[];
}

export function TableCellLayer({ geometry, cells }: TableCellLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || cells.length === 0) return;
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
    canvas.width = Math.round(geometry.size.width * dpr);
    canvas.height = Math.round(geometry.size.height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cbx = geometry.contentBox.x;
    const cby = geometry.contentBox.y;

    // 1. FILLS (under everything).
    for (const p of cells) {
      if (!p.cell?.fill) continue;
      ctx.fillStyle = p.cell.fill;
      ctx.fillRect(cbx + p.rect.x, cby + p.rect.y, p.rect.width, p.rect.height);
    }

    // 2. STROKES — MERGED boundary segments (1px, uniform): every cell
    //    edge is a boundary SEGMENT; same-x (vertical) / same-y
    //    (horizontal) segments that touch or overlap merge into ONE
    //    stroke — shared inner edges paint ONCE (the per-cell double-
    //    draw made them a px thicker than the outer frame). A boundary
    //    interrupted by a merged cell keeps its gap: the merged cell's
    //    edges don't reach the interrupted x/y, so the segments stay
    //    disjoint and the gap survives (the "truly merged" look).
    const border = cells[0]?.cell?.border ?? 'all';
    if (border === 'none') return;
    interface Seg {
      at: number;
      a: number;
      b: number;
    }
    const vSegs: Seg[] = [];
    const hSegs: Seg[] = [];
    for (const p of cells) {
      const { x, y, width, height } = p.rect;
      vSegs.push({ at: x, a: y, b: y + height });
      vSegs.push({ at: x + width, a: y, b: y + height });
      hSegs.push({ at: y, a: x, b: x + width });
      hSegs.push({ at: y + height, a: x, b: x + width });
    }
    // Group by the line's position; merge touching/overlapping spans
    // (the tolerance absorbs the band-boundary's exact shared y).
    function mergeSegs(segs: Seg[]): Seg[] {
      const byAt = new Map<number, Seg[]>();
      for (const s of segs) {
        const list = byAt.get(s.at);
        if (list) list.push(s);
        else byAt.set(s.at, [s]);
      }
      const out: Seg[] = [];
      for (const [at, list] of byAt) {
        list.sort((p, q) => p.a - q.a);
        let cur = { ...list[0]! };
        for (let i = 1; i < list.length; i++) {
          const s = list[i]!;
          if (s.a <= cur.b + 0.5) cur.b = Math.max(cur.b, s.b);
          else {
            out.push(cur);
            cur = { ...s };
          }
        }
        out.push(cur);
      }
      return out;
    }
    ctx.fillStyle = TABLE_BORDER_COLOR;
    if (border === 'outer') {
      // The page fragment's union frame only — the rects' bounding box.
      let x1 = Infinity;
      let y1 = Infinity;
      let x2 = -Infinity;
      let y2 = -Infinity;
      for (const p of cells) {
        x1 = Math.min(x1, p.rect.x);
        y1 = Math.min(y1, p.rect.y);
        x2 = Math.max(x2, p.rect.x + p.rect.width);
        y2 = Math.max(y2, p.rect.y + p.rect.height);
      }
      ctx.fillRect(cbx + x1, cby + y1, x2 - x1, 1);
      ctx.fillRect(cbx + x1, cby + y2 - 1, x2 - x1, 1);
      ctx.fillRect(cbx + x1, cby + y1, 1, y2 - y1);
      ctx.fillRect(cbx + x2 - 1, cby + y1, 1, y2 - y1);
    } else {
      for (const s of mergeSegs(vSegs)) ctx.fillRect(cbx + s.at, cby + s.a, 1, s.b - s.a);
      for (const s of mergeSegs(hSegs)) ctx.fillRect(cbx + s.a, cby + s.at, s.b - s.a, 1);
    }
  }, [geometry, cells]);

  if (cells.length === 0) return null;
  return (
    <canvas
      data-testid="table-cell-layer"
      data-page-index={geometry.index}
      ref={canvasRef}
      className="pointer-events-none absolute left-0"
      style={{ top: 0, width: `${geometry.size.width}px`, height: `${geometry.size.height}px` }}
    />
  );
}
