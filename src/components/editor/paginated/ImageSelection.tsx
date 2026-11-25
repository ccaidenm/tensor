import { useRef, useState } from 'react';
import type { PageGeometry, PlacedRect } from '@tensor-editor/engine';
import type { Editor } from '@tiptap/core';

/**
 * The selected image's overlay: the placed rect as selection state +
 * direct manipulation. RESIZE: each corner drags its own edges, the
 * OPPOSITE corner the ANCHOR; aspect-locked by default (Shift = free);
 * overlay-only preview, attrs commit on RELEASE (PM relayout; the
 * engine re-fits — fit-down reasserts). FLOAT DRAG: overlay transform
 * during the drag; the ANCHOR-RELATIVE (dx,dy) commits on drop (the
 * engine re-derives the anchor and clamps to the page box — the shell
 * never clamps). An unfloated drag floats it.
 */

type Corner = 'nw' | 'ne' | 'sw' | 'se';

/** The resize floor (the crossing rule): a drag may pass THROUGH/PAST
 *  the anchored corner; both axes clamp at the floor DURING the
 *  preview, the anchor never flips, and the commit floors the same way
 *  (no position jump on release). */
const MIN_DRAG = 16;

/** The Word anchor rule: each corner anchors its OPPOSITE. */
const ANCHORED: Record<Corner, Corner> = {
  nw: 'se',
  ne: 'sw',
  sw: 'ne',
  se: 'nw',
};

const CORNER_CURSOR: Record<Corner, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
};

const CORNER_POS: Record<Corner, { x: string; y: string }> = {
  nw: { x: '0%', y: '0%' },
  ne: { x: '100%', y: '0%' },
  sw: { x: '0%', y: '100%' },
  se: { x: '100%', y: '100%' },
};

interface ImageSelectionProps {
  geometry: PageGeometry;
  placed: PlacedRect;
  editor: Editor;
  pos: number;
  zoom: number;
  /** Float drag commit (anchor-relative delta; commit is the caller's
   *  command). OPTIONAL: absent for an INLINE object — in-flow objects
   *  have no float placement (body drag inert, cursor neutral). */
  onFloatDrag?: (dx: number, dy: number) => void;
}

type Drag =
  | { kind: 'resize'; corner: Corner; startX: number; startY: number; aspect: number; free: boolean }
  | { kind: 'float'; startX: number; startY: number };

export function ImageSelection({
  geometry,
  placed,
  editor,
  pos,
  zoom,
  onFloatDrag,
}: ImageSelectionProps) {
  const dragRef = useRef<Drag | null>(null);
  const [preview, setPreview] = useState<{ w: number; h: number } | null>(null);
  const [move, setMove] = useState<{ dx: number; dy: number } | null>(null);

  const baseW = preview?.w ?? placed.rect.width;
  const baseH = preview?.h ?? placed.rect.height;

  // RESIZE anchor math: the OPPOSITE corner of the placed rect stays
  // fixed; the preview spans from that anchor to the dragged corner.
  function onHandleDown(corner: Corner, e: React.PointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = {
      kind: 'resize',
      corner,
      startX: e.clientX,
      startY: e.clientY,
      aspect: placed.rect.height / Math.max(1, placed.rect.width),
      free: !e.shiftKey, // DEFAULT aspect-locked; Shift = free
    };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function onHandleMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag || drag.kind !== 'resize') return;
    const dx = (e.clientX - drag.startX) / zoom;
    const dy = (e.clientY - drag.startY) / zoom;
    // Corner sign: the dragged corner's own directions grow the
    // width/height relative to the ANCHORED opposite corner.
    const sx = drag.corner === 'ne' || drag.corner === 'se' ? 1 : -1;
    const sy = drag.corner === 'sw' || drag.corner === 'se' ? 1 : -1;
    let w = Math.max(MIN_DRAG, placed.rect.width + sx * dx);
    let h = Math.max(MIN_DRAG, placed.rect.height + sy * dy);
    if (!drag.free) {
      // ASPECT-LOCKED (default): the dominant axis drives; the other
      // follows by the placed ratio.
      const hByW = Math.max(MIN_DRAG, w * drag.aspect);
      const wByH = Math.max(MIN_DRAG, h / drag.aspect);
      if (Math.abs(dx) >= Math.abs(dy)) {
        h = hByW;
      } else {
        w = wByH;
      }
    }
    // WYSIWYG CLAMP: the preview cannot exceed the page's content box —
    // the ENGINE re-fits anything larger, so an unclamped preview would
    // grow and snap back on commit. The preview STICKS at the limit;
    // the commit lands where the preview is. #74 — the clamp is the
    // image's COLUMN's width under columns.
    const slot = placed.column != null ? geometry.columns?.[placed.column] : undefined;
    w = Math.min(w, slot ? slot.width : geometry.contentBox.width);
    h = Math.min(h, geometry.contentBox.height);
    setPreview({ w: Math.max(MIN_DRAG, w), h: Math.max(MIN_DRAG, h) });
  }

  function commitResize() {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!preview || !drag || drag.kind !== 'resize') {
      setPreview(null);
      return;
    }
    // COMMIT the DRAGGED SIZE — the placed dims the user saw, not a
    // ratio over the intrinsic attrs: an oversized upload is ENGINE-FITTED
    // for display (placed ≠ intrinsic), so a ratio commit would be
    // re-fitted right back. The dragged size IS the document size;
    // fit-down still reasserts on reflow.
    const newWidth = Math.max(MIN_DRAG, Math.round(preview.w));
    const newHeight = Math.max(MIN_DRAG, Math.round(preview.h));
    editor
      .chain()
      .command(({ tr, dispatch }) => {
        if (dispatch) {
          tr.setNodeAttribute(pos, 'width', newWidth);
          tr.setNodeAttribute(pos, 'height', newHeight);
        }
        return true;
      })
      .run();
    setPreview(null);
  }

  // FLOAT DRAG: the selection body is the drag zone. Absent for INLINE
  // objects — the body drag is inert, the cursor neutral.
  function onBodyDown(e: React.PointerEvent) {
    if (!onFloatDrag) return;
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = { kind: 'float', startX: e.clientX, startY: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function onBodyMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag || drag.kind !== 'float') return;
    setMove({
      dx: (e.clientX - drag.startX) / zoom,
      dy: (e.clientY - drag.startY) / zoom,
    });
  }

  function commitFloat() {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!onFloatDrag || !move || !drag || drag.kind !== 'float') {
      setMove(null);
      return;
    }
    onFloatDrag(Math.round(move.dx), Math.round(move.dy));
    setMove(null);
  }

  // The anchored preview rect: drawn FROM the fixed opposite corner.
  const anchor = dragRef.current?.kind === 'resize' ? ANCHORED[dragRef.current.corner] : null;
  let left = geometry.contentBox.x + placed.rect.x;
  let top = geometry.contentBox.y + placed.rect.y;
  if (anchor) {
    // The anchor's absolute point (in page coords):
    const ax = geometry.contentBox.x + placed.rect.x + (anchor === 'ne' || anchor === 'se' ? placed.rect.width : 0);
    const ay = geometry.contentBox.y + placed.rect.y + (anchor === 'sw' || anchor === 'se' ? placed.rect.height : 0);
    left = anchor === 'ne' || anchor === 'se' ? ax - baseW : ax;
    top = anchor === 'sw' || anchor === 'se' ? ay - baseH : ay;
  }
  const moveTransform = move ? `translate(${move.dx}px, ${move.dy}px)` : undefined;

  const cursor = dragRef.current ? 'grab' : onFloatDrag ? 'move' : 'default';

  return (
    <div
      data-testid="image-selection"
      className="absolute"
      style={{
        left: `${left}px`,
        top: `${top}px`,
        width: `${baseW}px`,
        height: `${baseH}px`,
        outline: '2px solid var(--primary)',
        transform: moveTransform,
        cursor,
      }}
      onPointerDown={onBodyDown}
      onPointerMove={onBodyMove}
      onPointerUp={() => {
        if (dragRef.current?.kind === 'float') commitFloat();
        else commitResize();
      }}
    >
      {(Object.keys(CORNER_POS) as Corner[]).map((corner) => (
        <div
          key={corner}
          data-testid={`image-handle-${corner}`}
          className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-border bg-primary"
          style={{
            left: CORNER_POS[corner].x,
            top: CORNER_POS[corner].y,
            // Per-corner CSS diagonal cursor; 'grab' during the drag (above).
            cursor: `${CORNER_CURSOR[corner]}`,
          }}
          onPointerDown={(e) => onHandleDown(corner, e)}
          onPointerMove={onHandleMove}
          onPointerUp={() => commitResize()}
        />
      ))}
    </div>
  );
}
