import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { getScrollParent } from './domUtils';

export interface FloatingToolbarPosition {
  left: number;
  top: number;
  bottom: number;
  placement: 'above' | 'below';
  /** Visual clearance (px) between the anchor edge and the toolbar —
   *  applied ONCE (the translateY). Text uses the room-checked
   *  placement with the tight gap; images force above their top edge. */
  gap: number;
}

const TOOLBAR_HEIGHT_ESTIMATE = 44;
const VIEWPORT_EDGE_PADDING = 8;

/**
 * The cell element under the (collapsed) caret, or null — collapsed
 * text rects are zero-width, so the CELL's rendered box is the honest
 * anchor (pageless only; the paginated view computes its own).
 */
function caretTableCellElement(ed: Editor): HTMLElement | null {
  try {
    const domAt = ed.view.domAtPos(ed.state.selection.from);
    const el = domAt.node instanceof HTMLElement ? domAt.node : domAt.node.parentElement;
    return (el?.closest('td, th') as HTMLElement | null) ?? null;
  } catch {
    return null;
  }
}

export function useFloatingToolbar(editor: Editor | null, enabled: boolean) {
  const [position, setPosition] = useState<FloatingToolbarPosition | null>(null);
  const isDragging = useRef(false);

  useEffect(() => {
    if (!editor || !enabled) {
      setPosition(null);
      return;
    }
    const currentEditor = editor;
    const dom = currentEditor.view.dom;

    function computeAndSetPosition() {
      const { state } = currentEditor;
      const { empty } = state.selection;

      // An equation NodeSelection shows NO floating toolbar — the
      // editor bubble is the equation's toolbar (a text-format strip
      // over an atom is noise).
      if (
        state.selection instanceof NodeSelection &&
        state.selection.node.type.name === 'equation'
      ) {
        setPosition(null);
        return;
      }

      if (empty) {
        // A caret parked inside a table cell still surfaces the table
        // context strip (Word parity) — anchored to the cell's box.
        const cellEl = caretTableCellElement(currentEditor);
        if (!cellEl) {
          setPosition(null);
          return;
        }
        const cellRect = cellEl.getBoundingClientRect();
        // jsdom lays out nothing (zero rects) — no reposition in tests.
        if (cellRect.width === 0 && cellRect.height === 0) return;
        const placement: 'above' | 'below' =
          cellRect.top > TOOLBAR_HEIGHT_ESTIMATE + VIEWPORT_EDGE_PADDING ? 'above' : 'below';
        setPosition({
          left: cellRect.left,
          top: cellRect.top,
          bottom: cellRect.bottom,
          placement,
          gap: VIEWPORT_EDGE_PADDING,
        });
        return;
      }

      // The real DOM selection's rendered geometry, not coordsAtPos —
      // coordsAtPos is unreliable at line-start/soft-wrap boundaries
      // (confirmed via direct measurement).
      const domSelection = window.getSelection();
      if (!domSelection || domSelection.rangeCount === 0) return;

      const range = domSelection.getRangeAt(0);
      // jsdom's Range lacks getClientRects (no layout); guard rather
      // than crash — the toolbar simply doesn't reposition in tests.
      if (typeof range.getClientRects !== 'function') return;
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      if (rects.length === 0) return;

      // The topmost real rendered line rect — reliable regardless of drag
      // direction or line-wrap ambiguity, since it's actual paint geometry,
      // not a position-to-coordinate translation.
      const topRect = rects.reduce((top, r) => (r.top < top.top ? r : top), rects[0]);

      const spaceAbove = topRect.top;
      const placement: 'above' | 'below' =
        spaceAbove > TOOLBAR_HEIGHT_ESTIMATE + VIEWPORT_EDGE_PADDING ? 'above' : 'below';

      setPosition({
        left: topRect.left,
        top: topRect.top,
        bottom: topRect.bottom,
        placement,
        gap: VIEWPORT_EDGE_PADDING,
      });
    }

    function handleMouseDown() {
      isDragging.current = true;
      setPosition(null); // hide immediately once a new drag starts
    }

    function handleMouseUp() {
      isDragging.current = false;
      // Selection is now final — compute position exactly once, using
      // settled, final coordinates rather than mid-drag ones.
      computeAndSetPosition();
    }

    function handleSelectionUpdate() {
      // While actively dragging, do NOT reposition (it caused erratic
      // jumping and interfered with the browser's drag-selection
      // tracking); keyboard selection changes still update immediately.
      if (isDragging.current) return;
      computeAndSetPosition();
    }

    const scrollParent = getScrollParent(dom);

    dom.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mouseup', handleMouseUp);
    currentEditor.on('selectionUpdate', handleSelectionUpdate);
    currentEditor.on('update', handleSelectionUpdate);
    if (scrollParent) {
      scrollParent.addEventListener('scroll', computeAndSetPosition, { passive: true });
    }

    return () => {
      dom.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mouseup', handleMouseUp);
      currentEditor.off('selectionUpdate', handleSelectionUpdate);
      currentEditor.off('update', handleSelectionUpdate);
      if (scrollParent) {
        scrollParent.removeEventListener('scroll', computeAndSetPosition);
      }
    };
  }, [editor, enabled]);

  return position;
}
