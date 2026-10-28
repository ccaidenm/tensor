import { Node, type Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { toast } from '@/components/ui/toast';
import { ReferenceTableNodeView } from '@/components/editor/ReferenceTableNodeView';
import { selectionInBand } from '@/lib/editor/headerFooterCommands';
import { findTableUnderSelection } from '@/lib/editor/TableExtensions';
import type { ReferenceKind } from '@/lib/references/scan';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    referenceTable: {
      /** Insert a reference-table container at the cursor (the
       * split-dance below); the generator fills its children in the
       * same tick (NodeSelection after — deletable, Delete works). */
      insertReferenceTable: (kind: ReferenceKind, depth?: number) => ReturnType;
    };
  }
}

/**
 * M-REFS — the reference-table NODE (issue #31), THE CONTAINER MODEL:
 * one generic block container parameterized by kind (ToC / Table of
 * Figures / Index) whose children are the entries — REAL paragraphs,
 * plain body text: natively selectable, formattable, copyable. The
 * GENERATOR (lib/references/generator.ts) maintains the children
 * against the live scan (keyed by refId — unchanged rows never
 * rewritten). Entry rows end with the LEADER DOTS span (real text,
 * refLeader-marked, user-formattable — the engine stretches the
 * painted dots to the page number at the span's own style).
 *
 * PM-NATIVE RENDERING (round 5 — the ghost fix): NO React NodeView —
 * the container renders through renderHTML like every ordinary node,
 * so DOM sync is 100% ProseMirror's own, battle-tested path in BOTH
 * the pageless editor AND the paginated hidden-input view. The two
 * NodeView jobs moved to pure-PM machinery:
 *  - the FIELD BORDER: a node DECORATION (data-bordered) while the
 *    selection sits inside — CSS draws the box (selection-driven, the
 *    user's ruling; no React boundary can desync it).
 *  - Ctrl/Cmd+click NAVIGATION: handleClickOn (a PM view prop).
 *
 * depth is the ToC's heading-depth option; `leaders` toggles the dots
 * span (both contextual-tab buttons; attrs are the M3 options UI's
 * landing spot). NO title row (the user's round-5 ruling: "if the
 * user wants a title they can type 'Table of Contents'" — the
 * generator seeds rows only).
 *
 * CLIPBOARD (the equation/clipboard law): parseHTML matches ONLY
 * Tensor's own data-tensor-ref-table marker — external HTML never
 * parses in; internal copy/paste copies the live rows, and the paste
 * target's generator reconciles them against ITS document.
 */
export const ReferenceTableNode = Node.create({
  name: 'referenceTable',
  group: 'block',
  content: 'paragraph*',

  addAttributes() {
    return {
      kind: {
        default: 'toc' as ReferenceKind,
        parseHTML: (element) =>
          ['toc', 'figures', 'index'].includes(element.getAttribute('data-kind') ?? '')
            ? (element.getAttribute('data-kind') as ReferenceKind)
            : 'toc',
      },
      depth: {
        default: 3,
        parseHTML: (element) => {
          const n = Number(element.getAttribute('data-depth'));
          return Number.isFinite(n) ? Math.min(6, Math.max(1, Math.round(n))) : 3;
        },
      },
      /**
       * M-REFS — the LEADERS toggle: dot leaders between entry text
       * and page number (default on). The generator owns the span's
       * presence; the user owns its formatting.
       */
      leaders: {
        default: true,
        parseHTML: (element) => element.getAttribute('data-leaders') !== 'false',
      },
      /**
       * M-REFS-9 — the NUMBER DISPLAY (the presets' number arm):
       * 'plain' (default — resolved page numbers as plain runs) or
       * 'none' (no numbers at all — the entries stand alone). The
       * whole TOC is ALWAYS hyperlinking invisibly (M-REFS-11 — the
       * rows carry the semantic link mark to their targets and
       * Ctrl+click follows); there is no hyperlink OPTION.
       */
      numberDisplay: {
        default: 'plain' as 'plain' | 'none',
        parseHTML: (element) =>
          element.getAttribute('data-numbers') === 'none' ? ('none' as const) : ('plain' as const),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-tensor-ref-table]' }];
  },

  renderHTML({ node }) {
    const { kind, depth, leaders, numberDisplay } = node.attrs as {
      kind: ReferenceKind;
      depth: number;
      leaders: boolean;
      numberDisplay: 'plain' | 'none';
    };
    return [
      'div',
      {
        'data-tensor-ref-table': 'true',
        'data-kind': kind,
        ...(kind === 'toc' ? { 'data-depth': String(depth) } : {}),
        ...(leaders === false ? { 'data-leaders': 'false' } : {}),
        ...(numberDisplay !== 'plain' ? { 'data-numbers': numberDisplay } : {}),
      },
      // The container's content hole — the entry rows are REAL
      // children (the CLIPBOARD serialization; the live editor renders
      // through the NodeView).
      0,
    ];
  },

  addCommands() {
    return {
      insertReferenceTable:
        (kind: ReferenceKind, depth = 3) =>
        ({ tr, dispatch, state }) => {
          const referenceTableType = state.schema.nodes.referenceTable;
          const { selection } = state;
          const { $from } = selection;

          // The split-dance (the equation/pageBreak insert law — with
          // the boundary fix): an empty paragraph at block start/end
          // collapses around the insert; a mid-text cursor splits and
          // the RESOLVED mapped position's before() is the exact
          // between-siblings spot (the raw map lands INSIDE a half —
          // the "cannot insert" crash, pinned by the repro tests).
          let newTr = tr;
          const atBlockStart = $from.parentOffset === 0;
          const atBlockEnd = $from.parentOffset === $from.parent.content.size;

          let insertPos: number;
          if (atBlockStart) {
            insertPos = $from.before();
          } else if (atBlockEnd) {
            insertPos = $from.after();
          } else {
            const splitPos = $from.pos;
            newTr = newTr.split(splitPos);
            const $mapped = newTr.doc.resolve(newTr.mapping.map(splitPos));
            insertPos = $mapped.before($mapped.depth);
          }

          const node = referenceTableType.create({ kind, depth });
          newTr = newTr.insert(insertPos, node);
          // NodeSelection ON the node (the click ruling's insert twin:
          // the block is selected, one Delete removes it). The
          // generator fills the children in the same tick.
          newTr = newTr.setSelection(NodeSelection.create(newTr.doc, insertPos));

          if (dispatch) dispatch(newTr);
          return true;
        },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ReferenceTableNodeView);
  },
});

/**
 * The ONE insertion path (the insertCaptionForImage precedent — every
 * surface converges here): refusal checks + toast + the command.
 * REFUSALS (honest, never silent): header/footer bands (band content
 * is chrome — a ToC in a header would rescan per band) and table cells
 * (cells hold paragraphs only; the adapter's cell contract would
 * throw the UnsupportedDocError sentinel — refuse before that).
 */
export function insertReferenceTableAtSelection(
  editor: Editor,
  kind: ReferenceKind,
  depth = 3
): boolean {
  if (selectionInBand(editor)) {
    void toast.add({
      title: 'Cannot insert here',
      description: 'Reference tables cannot be placed inside a header or footer.',
    });
    return false;
  }
  if (findTableUnderSelection(editor.state)) {
    void toast.add({
      title: 'Cannot insert here',
      description: 'Reference tables cannot be placed inside a table cell.',
    });
    return false;
  }
  // The command leaves a NodeSelection on the new block (deletable,
  // one Delete away). The container inserts EMPTY — the generator's
  // appendTransaction pass fills its children (rows, or the
  // placeholder) in the SAME tick, before paint.
  return editor.chain().focus().insertReferenceTable(kind, depth).run();
}

