import { useRef, useState } from 'react';
import type { PageGeometry, PlacedRect } from '@tensor-editor/engine';
import type { Editor } from '@tiptap/core';

/**
 * M-IMAGES-2 — the selected image's overlay: the placed rect as the
 * selection state + the two direct-manipulation modes.
 *
 * RESIZE (R1 — the Word contract): EACH corner drags its own edges —
 * the OPPOSITE corner is the ANCHOR (NW anchors SE, NE anchors SW,
 * etc.); the preview grows/shrinks from it. Aspect-locked by DEFAULT,
 * Shift = free (the 1.5 ruling STANDS — only the anchor rule changed;
 * the old top-left-anchored-everywhere math made the top handles move
 * inverted). Preview is overlay-only (no relayout per mousemove);
 * attrs commit on RELEASE → the standard PM relayout → the ENGINE
 * re-fits (fit-down reasserts).
 *
 * CURSORS (R2): per-corner CSS diagonals — nw/se → 'nwse-resize',
 * ne/sw → 'nesw-resize'; 'grab' during an active drag.
 *
 * FLOAT DRAG (E-IMG-3): a body drag moves the image — overlay
 * transform during the drag (NO relayout per mousemove), and on drop
 * the ANCHOR-RELATIVE offset (dx,dy) commits (the engine re-derives
 * the anchor on the next layout and clamps the placed rect to the
 * page box — the shell never clamps). A drag on an unfloated image
 * floats it (front, Word behavior).
 */

type Corner = 'nw' | 'ne' | 'sw' | 'se';

/** M-IMAGES-2.1 — the resize floor (the crossing rule): a drag may
 *  pass THROUGH/PAST the anchored corner; both axes clamp at the
 *  floor DURING the preview, the anchor never flips, and no position
 *  jump happens on release (the commit floors the same way). */
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
  /** Float drag commit (anchor-relative delta; the node's current
   *  float lives in the selection state the caller reads — commit is
   *  the caller's command). OPTIONAL: absent for an INLINE object's
   *  selection — an in-flow object has no float placement of its own
   *  to drag into (the body drag is inert; the cursor stays neutral). */
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

  // ─── RESIZE: per-corner anchor math. The anchored frame: the
  // OPPOSITE corner of the placed rect stays fixed; the preview rect
  // spans from that anchor to the dragged corner.
  function onHandleDown(corner: Corner, e: React.PointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = {
      kind: 'resize',
      corner,
      startX: e.clientX,
      startY: e.clientY,
      aspect: placed.rect.height / Math.max(1, placed.rect.width),
      free: !e.shiftKey, // DEFAULT aspect-locked; Shift = free (1.5 ruling)
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
    // M-IMAGES-2.2 — WYSIWYG CLAMP: the preview cannot exceed the
    // page's content box. The ENGINE re-fits anything larger
    // (fit-down), so an unclamped preview used to grow with the drag
    // and then snap back on commit — "accepted the input and did
    // nothing". The preview now STICKS at the page limit: an honest
    // response, and the commit always lands where the preview is.
    // #74 — the clamp is the image's COLUMN's width under columns (the
    // engine will fit the placed rect into the slot).
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
    // COMMIT (M-IMAGES-2.2): the DRAGGED SIZE — the placed dims the
    // user saw — not a ratio over the intrinsic attrs. An upload
    // larger than the page is ENGINE-FITTED for display (placed ≠
    // intrinsic), so the old ratio-scaled intrinsic commit recomputed
    // attrs the engine re-fitted right back to the SAME placed rect —
    // "accepted the input and did nothing". The dragged size IS the
    // chosen document size; fit-down still reasserts on reflow.
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

  // ─── FLOAT DRAG: the body of the selection is the drag zone.
  // Absent for an INLINE object's selection (in-flow objects don't
  // float) — the body drag is inert, the cursor neutral.
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
            // R2: the per-corner CSS diagonal cursor (computed per
            // handle — the receipt); 'grab' during the drag (above).
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
