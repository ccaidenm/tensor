import { Node } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { EquationNodeView } from '@/components/editor/EquationNodeView';

/**
 * Block atom; the LATEX SOURCE is the only document data — KaTeX's
 * HTML is a projection, never persisted. Only our own marker parses
 * in (also the export serialization — #39/#37); display-only in v1.
 */

export interface EquationAttrs {
  latex: string;
  align: 'left' | 'center' | 'right';
  /** Paint-only text color (hex); null = inherit the document default
   *  (derived per blockId by the shell). Paint-only = not engine data,
   *  not hashed. */
  color: string | null;
  /** Layout-relevant font scale — folded into the EquationMetrics
   *  fontSize key, which rides the engine hash (edits re-measure). */
  scale: number;
}

export const EquationNode = Node.create({
  name: 'equation',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      latex: { default: '' },
      align: { default: 'center' },
      color: { default: null },
      scale: { default: 1 },
    };
  },

  // PM's clipboard rides text/html — the node must parse back from its
  // own marker or an internal copy loses the equation; external math
  // formats never match the Tensor-only marker.
  parseHTML() {
    return [
      {
        tag: 'div[data-tensor-equation="true"]',
        getAttrs: (el) => {
          const attrs = (el as HTMLElement).dataset as unknown as Record<string, string>;
          return {
            latex: attrs.latex ?? '',
            align: attrs.align && ['left', 'center', 'right'].includes(attrs.align)
              ? attrs.align
              : 'center',
            color: attrs.color ?? null,
            scale: attrs.scale ? Number(attrs.scale) : 1,
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const a = node.attrs as Record<string, unknown>;
    return [
      'div',
      {
        'data-tensor-equation': 'true',
        'data-latex': String(a.latex ?? ''),
        ...(a.align !== 'center' ? { 'data-align': String(a.align) } : {}),
        ...(a.color ? { 'data-color': String(a.color) } : {}),
        ...(typeof a.scale === 'number' && a.scale !== 1 ? { 'data-scale': String(a.scale) } : {}),
      },
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(EquationNodeView);
  },

  addCommands() {
    return {
      // Insert at the cursor (insertPageBreak's split dance), then
      // NodeSelection on the node — that opens the editor popover. A
      // non-empty TEXT selection becomes the initial source, replaced.
      insertEquation:
        () =>
        ({ tr, dispatch, state }) => {
          const equationType = state.schema.nodes.equation;
          const { selection } = state;
          const { $from } = selection;

          let newTr = tr;
          let initialLatex = '';
          if (!selection.empty && selection instanceof TextSelection) {
            initialLatex = state.doc.textBetween(selection.from, selection.to, ' ', ' ');
            newTr = newTr.delete(selection.from, selection.to);
          }

          const $cursor = newTr.doc.resolve(newTr.mapping.map($from.pos));

          let insertPos: number;

          const atBlockStart = $cursor.parentOffset === 0;
          const atBlockEnd = $cursor.parentOffset === $cursor.parent.content.size;

          if (atBlockStart) {
            insertPos = $cursor.before();
          } else if (atBlockEnd) {
            insertPos = $cursor.after();
          } else {
            const splitPos = $cursor.pos;
            newTr = newTr.split(splitPos);
            // The split's raw map lands INSIDE a half, not the between-
            // blocks boundary (PM would fit-shift the insert and
            // NodeSelection.create fails). Resolve, then `before()`.
            const $mapped = newTr.doc.resolve(newTr.mapping.map(splitPos));
            insertPos = $mapped.before($mapped.depth);
          }

          const equationNode = equationType.create({ latex: initialLatex, align: 'center' });
          newTr = newTr.insert(insertPos, equationNode);
          const nodePos = insertPos;

          newTr = newTr.setSelection(
            NodeSelection.create(newTr.doc, nodePos),
          );

          if (dispatch) dispatch(newTr);
          return true;
        },
    };
  },
});

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    equation: {
      insertEquation: () => ReturnType;
    };
  }
}