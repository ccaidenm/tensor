import { useMemo } from 'react';
import type { PageGeometry, PlacedRect } from '@tensor-editor/engine';
import type { Editor } from '@tiptap/core';
import { useConfigStore } from '@/lib/config/store';
import { setColumnWidth } from '@/lib/editor/tableResize';

/**
 * M-TABLES — the column drag handles (Pages mode). The PM DOM is
 * hidden (law L3), so the stock columnResizing handles are unusable
 * here; the shell renders its own at each column boundary, derived
 * from the engine's placed cell rects (the boundary EDGES of the
 * page's rects — every column boundary is some cell's edge in a
 * well-formed grid, so the sorted distinct edges ARE the track edges;
 * the widths are their diffs). Dragging boundary i (the right edge of
 * column i) live-dispatches the column's new colwidth; the flexible
 * columns re-absorb engine-side on the next layout — the SAME
 * semantics as the pageless drag (one extension family).
 *
 * The slice height = the table's span on THIS page (a page-split
 * table's handles ride each page's slice). Stack-local px inside the
 * zoom transform; the drag math divides the client delta by zoom.
 */

interface TableResizeHandlesProps {
  geometry: PageGeometry;
  /** This page's tableCell rects. */
  cells: readonly PlacedRect[];
  editor: Editor;
  /** blockId → the table node's PM position. */
  tablePosOf: (blockId: string) => number | null;
}

const HANDLE_HIT_PX = 9;

export function TableResizeHandles({ geometry, cells, editor, tablePosOf }: TableResizeHandlesProps) {
  const handles = useMemo(() => {
    const byTable = new Map<string, PlacedRect[]>();
    for (const p of cells) {
      if (p.kind !== 'tableCell') continue;
      const list = byTable.get(p.blockId) ?? [];
      list.push(p);
      byTable.set(p.blockId, list);
    }
    const out: { blockId: string; col: number; x: number; top: number; height: number }[] = [];
    for (const [blockId, rects] of byTable) {
      // The track edges: sorted distinct left+right edges.
      const edges = new Set<number>();
      let top = Infinity;
      let bottom = -Infinity;
      for (const r of rects) {
        edges.add(r.rect.x);
        edges.add(r.rect.x + r.rect.width);
        top = Math.min(top, r.rect.y);
        bottom = Math.max(bottom, r.rect.y + r.rect.height);
      }
      const sorted = [...edges].sort((a, b) => a - b);
      if (sorted.length < 2) continue;
      // Skip the table's LEFT edge (the first): the table's own left
      // boundary is not a column handle. Each remaining edge is the
      // RIGHT edge of the column whose index = its position among the
      // track edges.
      for (let i = 1; i < sorted.length; i++) {
        out.push({
          blockId,
          col: i - 1,
          x: sorted[i]!,
          top,
          height: bottom - top,
        });
      }
    }
    return out;
  }, [cells]);

  function startDrag(e: React.PointerEvent, blockId: string, col: number, boundaryX: number, colLeft: number) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const z = useConfigStore.getState().config.editor.zoomLevel / 100;
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / z;
      const tablePos = tablePosOf(blockId);
      if (tablePos == null) return;
      setColumnWidth(editor, tablePos, col, boundaryX + dx - colLeft);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  if (handles.length === 0) return null;
  const cbx = geometry.contentBox.x;
  const cby = geometry.contentBox.y;
  return (
    <>
      {handles.map((h, i) => (
        <div
          key={`${h.blockId}:${i}`}
          data-testid="table-col-handle"
          data-col={h.col}
          className="pointer-events-auto absolute cursor-col-resize"
          style={{
            left: `${cbx + h.x - HANDLE_HIT_PX / 2}px`,
            top: `${cby + h.top}px`,
            width: `${HANDLE_HIT_PX}px`,
            height: `${h.height}px`,
          }}
          onPointerDown={(e) => {
            // The column's left edge = the boundary below this one (the
            // previous track edge — recomputed from the SAME edges list
            // via the handle's data at drag start).
            const boundaryX = h.x;
            // The column's left edge: the previous edge of this table —
            // recompute here (handles know only their own edge).
            const edges = new Set<number>();
            for (const p of cells) {
              if (p.blockId !== h.blockId || p.kind !== 'tableCell') continue;
              edges.add(p.rect.x);
              edges.add(p.rect.x + p.rect.width);
            }
            const sorted = [...edges].sort((a, b) => a - b);
            const idx = sorted.indexOf(h.x);
            const colLeft = idx > 0 ? sorted[idx - 1]! : h.x;
            startDrag(e, h.blockId, h.col, boundaryX, colLeft);
          }}
        />
      ))}
    </>
  );
}
