import { Node } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { EquationNodeView } from '@/components/editor/EquationNodeView';

/**
 * M-EQ — the equation model (the issue: equations as FIRST-CLASS
 * typeset math, editable, round-tripping through .wpdoc).
 *
 * CUSTOM NODE, the ImageNode family's shape: a block atom with a
 * ReactNodeViewRenderer. The LATEX SOURCE is the node's ONLY document
 * data (the issue's law: "equation source stored as the node's actual
 * data/attribute, the rendered math being a display-only
 * transformation of that source") — KaTeX's HTML is never persisted,
 * never a clipboard payload, never anything but a projection of
 * `latex`.
 *
 * DISPLAY-ONLY v1 (the scope ruling): a display/block equation — its
 * own atomic block, Word's display-equation convention (default align
 * 'center'). Inline equations (a formula mid-sentence) are an explicit
 * follow-up: the paginated engine's inline-object paint is canvas
 * (drawImage) which equations cannot ride — a block slides into the
 * existing atomic machinery instead. The node design precludes
 * nothing: an inline node mirrors InlineImageNode later.
 *
 * parseHTML/renderHTML are SCOPED to our own data-tensor-equation
 * marker (the M-IMAGES-2.2 clipboard law): renderHTML emits the
 * marker + the source attrs — that is ALSO the future PDF/DOCX export
 * serialization (export consumes the marker's data-latex, issue #39/
 * #37 note); parseHTML matches ONLY the marker — pasted web-page math
 * (MathML, <math> tags, images of formulas) never parses in.
 *
 * Rendering is a projection (lib/equations/render.ts — the ONE KaTeX
 * surface); measurement is the engine's EquationMetrics port fed by
 * lib/equations/measure.ts. Neither lives here.
 */

export interface EquationAttrs {
  latex: string;
  align: 'left' | 'center' | 'right';
  /** Paint-only text color (hex). null = INHERIT the document's default
   *  text color (the resolveRun derivation the canvas text uses — the
   *  StylesStylesheet's .wp-style-normal color in pageless). Paint-only
   *  means: NOT engine data, NOT hashed — the radius precedent
   *  (M-IMAGES-1.5); the shell derives the effective color per blockId
   *  from the PM doc. */
  color: string | null;
  /** Layout-relevant font scale against the document default (the
   *  adapter folds it into the EquationMetrics fontSize key — which
   *  rides the engine hash, so a scale edit re-measures + re-walks). */
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
      // M-EQ-2: paint-only style attrs — color null = inherit (the
      // document default text color); scale folds into the metrics
      // fontSize key adapter-side.
      color: { default: null },
      scale: { default: 1 },
    };
  },

  // The CLIPBOARD-SCOPED round-trip, verbatim in spirit from
  // ImageNode's: PM's clipboard rides text/html, so the node must
  // parse back from its own marker or an internal copy loses the
  // equation. External math formats are refused by construction — the
  // marker only exists in Tensor-produced HTML.
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
      // The insert command (ribbon button, Alt+=, palette): a new
      // equation at the cursor — same split dance as PageBreakNode's
      // insertPageBreak — then NodeSelection ON the node, which is what
      // opens the editor popover (the selection is the "click back into
      // one" arm's model state).
      // M-EQ-2 — SELECTION → EQUATION: a non-empty TEXT selection is
      // captured as the new equation's starting source and replaced by
      // the equation (the user typed "1/2+2=3a" as plain text, selected
      // it, hit the button — the editor opens WITH that source; the
      // WYSIWYG surface is where it gets restructured into styled
      // math). Node/Cell selections fall through to the plain insert.
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
            // THE BOUNDARY (M-REFS fix — the shared dance's latent bug,
            // caught by the referenceTable's mid-heading-caret repro):
            // the split's raw map lands INSIDE a half (assoc 1 → the
            // right half's content start; assoc −1 → the left half's
            // last content position) — NEITHER is the between-blocks
            // boundary, so a block insert there doesn't fit, PM
            // fit-shifts it, and NodeSelection.create finds nothing.
            // RESOLVE the mapped position instead: it sits at the right
            // half's content start, whose `before()` IS the half's open
            // boundary — the exact between-siblings spot.
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