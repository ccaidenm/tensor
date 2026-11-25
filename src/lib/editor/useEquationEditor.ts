import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';

/**
 * The equation bubble's state machine: opening is SELECTION-DRIVEN —
 * insert and plain-click both NodeSelection the node. coordsFor positions
 * the bubble in paginated mode; pointerdown inside pins, DRAFT stays local.
 */

export interface EquationEditorState {
  /** The equation node's PM position (NodeSelection.from). */
  pos: number;
  latex: string;
  align: 'left' | 'center' | 'right';
  /** Style attrs (the bubble's ColorPickerButton + scale presets read
   *  these; null color = inherit the document default). */
  color: string | null;
  scale: number;
  coords: { left: number; top: number };
}

/** Pageless anchor (VIEWPORT coords): the node view's DOM box, bubble
 *  below it, centered (offset by half its own width — the styled
 *  w-80 = 320). Exported for the bubble's render-time re-derivation. */
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
  // must not resurrect a closed bubble (the update event arrives while
  // pinned; the guard is belt-and-braces for the trailing selectionUpdate).
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

      // MID-INTERACTION REFRESH: while pinned, the bubble's OWN writes
      // re-enter through 'update' events — refresh the style attrs in
      // place, no re-anchor, no re-seed of the draft.
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