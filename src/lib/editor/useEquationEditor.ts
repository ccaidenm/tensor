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
 * PINNING: pointerdown inside the bubble pins it — the open state HOLDS
 * (no re-anchor, no close) while its own chrome is being clicked, but
 * its OWN attr writes (style buttons, palette inserts, typing) still
 * REFRESH the state's style attrs in place (the S/M/L/XL highlight
 * must follow the click — the mid-interaction refresh in update()).
 * The bubble's latex DRAFT is its own local state — state.latex only
 * seeds it at open, so refreshes never clobber mid-edit text.
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

/** Pageless anchor (VIEWPORT coords — the bubble renders fixed at
 *  body level): the node view's DOM box, bubble opens BELOW it,
 *  horizontally centered on the box (the bubble offsets by half its
 *  own width — the same number the bubble is styled at, w-80 = 320).
 *  Exported for the bubble's render-time re-derivation. */
const BUBBLE_HALF_WIDTH = 160;

export function equationDomAnchor(editor: Editor, pos: number): { left: number; top: number } {
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
      const { selection } = currentEditor.state;
      const equationSelection =
        selection instanceof NodeSelection && selection.node.type.name === 'equation'
          ? selection
          : null;
      if (!equationSelection) {
        // PINNED (interacting with the bubble's own chrome): HOLD —
        // e.g. an undo edge momentarily dropped the NodeSelection; the
        // deleted-while-open effect below owns the real close.
        if (pinnedRef.current) return;
        openPosRef.current = null;
        setState(null);
        return;
      }
      const pos = equationSelection.from;
      const known = openPosRef.current === pos;
      openPosRef.current = pos;
      const node = equationSelection.node;
      const attrs = {
        latex: node.attrs.latex as string,
        align: node.attrs.align as 'left' | 'center' | 'right',
        color: (node.attrs.color as string | null) ?? null,
        scale: (node.attrs.scale as number) ?? 1,
      };

      // THE MID-INTERACTION REFRESH (the stale-style-highlight fix):
      // while the bubble is pinned, its OWN attr writes (style buttons,
      // palette, typing) re-enter through 'update' events — the open
      // state must REFRESH (the S/M/L/XL highlight moves) without
      // re-anchoring (the bubble holds still while you click its
      // chrome) and without re-seeding the draft (the bubble's latex
      // state is its own; only the style attrs flow).
      if (known && pinnedRef.current) {
        setState((prev) =>
          prev && prev.pos === pos
            ? { ...prev, ...attrs }
            : {
                ...attrs,
                pos,
                coords: coordsFor ? coordsFor(pos) : equationDomAnchor(currentEditor, pos),
              },
        );
        return;
      }

      const coords = coordsFor
        ? coordsFor(pos)
        : equationDomAnchor(currentEditor, pos);
      setState((prev) =>
        prev && prev.pos === pos
          ? { ...prev, ...attrs, coords }
          : { ...attrs, pos, coords },
      );
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