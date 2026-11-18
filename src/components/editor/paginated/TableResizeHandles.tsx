import { useMemo } from 'react';
import type { PageGeometry, PlacedRect } from '@tensor-editor/engine';
import { CELL_MIN_TRACK } from '@tensor-editor/engine';
import type { Editor } from '@tiptap/core';
import { useConfigStore } from '@/lib/config/store';
import { setColumnWidthWord, setTableTracks } from '@/lib/editor/tableResize';

/**
 * M-TABLES — the column drag handles (Pages mode). The PM DOM is
 * hidden (law L3), so the stock columnResizing handles are unusable
 * here; the shell renders its own at each column boundary, derived
 * from the engine's placed cell rects (the boundary EDGES of the
 * page's rects — every column boundary is some cell's edge in a
 * well-formed grid, so the sorted distinct edges ARE the track edges;
 * the widths are their diffs).
 *
 * M-T4 — WORD DRAG SEMANTICS:
 *  - An INTERIOR boundary keeps the table's total width constant: the
 *    dragged column takes the new width, its right neighbor pays the
 *    delta (a fixed neighbor is written back, clamped at the track
 *    floor; a flexible neighbor re-absorbs engine-side).
 *  - The RIGHTMOST edge is the TABLE border, not a column boundary:
 *    dragging it scales EVERY track proportionally (setTableTracks),
 *    clamped to [cols × CELL_MIN_TRACK, the table box]. The old
 *    behavior set only the last column's width — the still-flexible
 *    columns re-inflated to fill the content box, so the table could
 *    never shrink ("backwards spacing").
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
    const out: {
      blockId: string;
      col: number;
      x: number;
      top: number;
      height: number;
      /** The dragged column's left edge (its width's other bound). */
      colLeft: number;
      /** The dragged column's current effective width. */
      oldWidth: number;
      /** The table's rightmost edge? (scale-all behavior) */
      rightmost: boolean;
      /** Effective track widths (rightmost scaling input). */
      widths: number[];
      /** The table's current total width. */
      total: number;
      /** #74 — the table's flow slot (the scale-all max's bound). */
      column?: number;
    }[] = [];
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
      const widths = sorted.slice(1).map((x, i) => x - sorted[i]!);
      const total = sorted[sorted.length - 1]! - sorted[0]!;
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
          colLeft: sorted[i - 1]!,
          oldWidth: widths[i - 1]!,
          rightmost: i === sorted.length - 1,
          widths,
          total,
          // #74 — the table's flow slot (the scale-all max's bound).
          column: rects[0]!.column,
        });
      }
    }
    return out;
  }, [cells]);

  function startDrag(e: React.PointerEvent, h: (typeof handles)[number]) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const z = useConfigStore.getState().config.editor.zoomLevel / 100;
    const onMove = (ev: PointerEvent) => {
      const tablePos = tablePosOf(h.blockId);
      if (tablePos == null) return;
      const dx = (ev.clientX - startX) / z;
      if (h.rightmost) {
        // The TABLE border: scale every track to the new total. #74 —
        // the max is the table's COLUMN's width under columns (the
        // engine's track derivation runs against the slot).
        const min = h.widths.length * CELL_MIN_TRACK;
        const slot = h.column != null ? geometry.columns?.[h.column] : undefined;
        const max = slot ? slot.width : geometry.contentBox.width;
        const newTotal = Math.min(max, Math.max(min, h.total + dx));
        const scale = newTotal / h.total;
        setTableTracks(editor, tablePos, h.widths.map((w) => w * scale));
      } else {
        // Interior: the neighbor pays — the total stays constant.
        setColumnWidthWord(editor, tablePos, h.col, h.x + dx - h.colLeft, h.oldWidth);
      }
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
          data-rightmost={h.rightmost ? 'true' : 'false'}
          className="pointer-events-auto absolute cursor-col-resize"
          style={{
            left: `${cbx + h.x - HANDLE_HIT_PX / 2}px`,
            top: `${cby + h.top}px`,
            width: `${HANDLE_HIT_PX}px`,
            height: `${h.height}px`,
          }}
          onPointerDown={(e) => startDrag(e, h)}
        />
      ))}
    </>
  );
}
