import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';

/**
 * M-EQ — the equation editor bubble's state machine, the
 * useLinkBubble shape with one simplification: there is no store and
 * no 'insert' mode. Opening is SELECTION-DRIVEN — the node's
 * insertEquation command (ribbon button, Alt+=, palette) creates an
 * empty equation and NodeSelections it, and a plain click on an
 * existing equation NodeSelections it; BOTH land here through the
 * selectionUpdate path, so the bubble is always editing a node that
 * already exists. Close is local (Done/X/Escape, or selecting away).
 *
 * PAGINATED ANCHOR (L3, the link bubble's law): the hidden PM view's
 * coordsAtPos must never position anything — paginated mode injects
 * coordsFor (the painted-rect resolver); pageless uses the node view's
 * own DOM box (the visible surface IS the PM view there).
 *
 * PINNING: pointerdown inside the bubble pins it — the attr writes the
 * bubble itself dispatches (live-apply per keystroke) fire 'update'
 * events that would otherwise re-run this path; pinned updates are
 * ignored, and the bubble holds its own draft (state.latex only seeds
 * it at open).
 */

export interface EquationEditorState {
  /** The equation node's PM position (NodeSelection.from). */
  pos: number;
  latex: string;
  align: 'left' | 'center' | 'right';
  /** M-EQ-2 style attrs (the bubble's ColorPickerButton + scale
   *  presets read these; null color = inherit the document default). */
  color: string | null;
  scale: number;
  coords: { left: number; top: number };
}

/** Pageless anchor: the node view's DOM box, bubble opens BELOW it,
 *  horizontally centered on the box (the bubble offsets by half its
 *  own width — the same number the bubble is styled at, w-80 = 320). */
const BUBBLE_HALF_WIDTH = 160;

function domAnchor(editor: Editor, pos: number): { left: number; top: number } {
  const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
  if (!dom) {
    const c = editor.view.coordsAtPos(pos);
    return { left: c.left, top: c.bottom };
  }
  const rect = dom.getBoundingClientRect();
  return {
    left: rect.left + rect.width / 2 - BUBBLE_HALF_WIDTH,
    top: rect.bottom + 4,
  };
}

export function useEquationEditor(
  editor: Editor | null,
  bubbleElRef: React.RefObject<HTMLElement | null>,
  coordsFor?: (pos: number) => { left: number; top: number },
) {
  const [state, setState] = useState<EquationEditorState | null>(null);
  const pinnedRef = useRef(false);
  // The OPEN-time latex — an attr write dispatched by the bubble itself
  // must not resurrect a closed bubble through the reactive path (the
  // update event arrives while pinned, but the guard is belt-and-braces
  // for the selectionUpdate that can trail it).
  const openPosRef = useRef<number | null>(null);

  const close = useCallback(() => {
    pinnedRef.current = false;
    openPosRef.current = null;
    setState(null);
  }, []);

  useEffect(() => {
    if (!editor) return;
    const currentEditor = editor;

    function update() {
      if (pinnedRef.current) return;
      const { selection } = currentEditor.state;
      const equationSelection =
        selection instanceof NodeSelection && selection.node.type.name === 'equation'
          ? selection
          : null;
      if (!equationSelection) {
        openPosRef.current = null;
        setState(null);
        return;
      }
      const pos = equationSelection.from;
      const known = openPosRef.current === pos;
      openPosRef.current = pos;
      const coords = coordsFor
        ? coordsFor(pos)
        : domAnchor(currentEditor, pos);
      // A re-fire for the ALREADY-open equation (the bubble's own attr
      // writes) must not clobber the user's draft — the bubble seeds
      // from state.latex at open only, so identical-pos re-fires are
      // skipped; a DIFFERENT equation re-anchors fresh.
      setState((prev) => {
        if (known && prev && prev.pos === pos) return prev;
        return {
          pos,
          latex: equationSelection.node.attrs.latex as string,
          align: equationSelection.node.attrs.align as 'left' | 'center' | 'right',
          color: (equationSelection.node.attrs.color as string | null) ?? null,
          scale: (equationSelection.node.attrs.scale as number) ?? 1,
          coords,
        };
      });
    }

    function handlePointerDown(e: PointerEvent) {
      const bubbleEl = bubbleElRef.current;
      const target = e.target as Node;
      pinnedRef.current = !!(bubbleEl && bubbleEl.contains(target));
    }

    currentEditor.on('selectionUpdate', update);
    currentEditor.on('update', update);
    document.addEventListener('pointerdown', handlePointerDown, true);

    return () => {
      currentEditor.off('selectionUpdate', update);
      currentEditor.off('update', update);
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [editor, bubbleElRef, coordsFor]);

  // An equation deleted while its bubble is open (Undo, context menu):
  // the node is gone — close instead of dispatching into a stale pos.
  useEffect(() => {
    if (!editor || !state) return;
    const { state: docState } = editor;
    const node = docState.doc.nodeAt(state.pos);
    if (!node || node.type.name !== 'equation') {
      close();
    }
  }, [editor, state, close]);

  return { state, close };
}