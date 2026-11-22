import { useLayoutEffect, useRef } from 'react';
import type { PageGeometry, PlacedRect } from '@tensor-editor/engine';

/**
 * The paginated cell paint: fills + grid strokes from the engine's
 * placed[] (kind 'tableCell'; the shell draws, never computes), mounted
 * between the behind-floats and the block canvases so fills/strokes sit
 * UNDER the cell text. 'all' strokes every cell edge (shared edges
 * double-draw at the same 1px — deliberate); 'outer' strokes this page's
 * union frame (aggregated engine geometry, never re-derived); 'none' =
 * fills only. The hairline gray matches pageless var(--border).
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

    // 2. STROKES — merged boundary segments (1px uniform): touching
    //    same-x/same-y segments merge into ONE stroke — shared inner
    //    edges paint once (per-cell double-draw made them a px thicker
    //    than the outer frame); a merged cell's gap survives. A
    //    rowspan>1 cell emits one rect per band slice — grouped by
    //    anchor identity, only the group's first emits a top edge and
    //    its last a bottom edge (neighbors' real boundaries unaffected).
    const border = cells[0]?.cell?.border ?? 'all';
    if (border === 'none') return;
    interface Seg {
      at: number;
      a: number;
      b: number;
    }
    // Group slices by anchor identity, y-ordered; isTop/isBottom default
    // TRUE — a multi-slice group demotes non-first/last slices.
    const cellGroups = new Map<string, { rects: { p: (typeof cells)[number]; isTop: boolean; isBottom: boolean }[] }>();
    for (const p of cells) {
      if (!p.cell) continue;
      const key = `${p.blockId}:${p.cell.row}:${p.cell.col}`;
      const group = cellGroups.get(key);
      if (group) group.rects.push({ p, isTop: true, isBottom: true });
      else cellGroups.set(key, { rects: [{ p, isTop: true, isBottom: true }] });
    }
    for (const group of cellGroups.values()) {
      if (group.rects.length <= 1) continue;
      group.rects.sort((a, b) => a.p.rect.y - b.p.rect.y);
      group.rects.forEach((r, i) => {
        r.isTop = i === 0;
        r.isBottom = i === group.rects.length - 1;
      });
    }
    const vSegs: Seg[] = [];
    const hSegs: Seg[] = [];
    for (const p of cells) {
      const { x, y, width, height } = p.rect;
      vSegs.push({ at: x, a: y, b: y + height });
      vSegs.push({ at: x + width, a: y, b: y + height });
      // Horizontal edges: internal slice boundaries are skipped — the
      // merged cell reads as one region.
      const group = cellGroups.get(`${p.blockId}:${p.cell?.row}:${p.cell?.col}`);
      const slice = group?.rects.find((r) => r.p === p);
      if (!slice || slice.isTop) hSegs.push({ at: y, a: x, b: x + width });
      if (!slice || slice.isBottom) hSegs.push({ at: y + height, a: x, b: x + width });
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
      for (const list of byAt.values()) {
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
