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
 * #31 — the reference-table NODE: one generic block container by kind
 * (ToC/Figures/Index) whose children are REAL paragraphs; the generator
 * maintains them against the live scan (keyed by refId, never rewritten).
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
       * Dot leaders between entry text and page number (default on).
       * The generator owns the span's presence; the user owns its
       * formatting.
       */
      leaders: {
        default: true,
        parseHTML: (element) => element.getAttribute('data-leaders') !== 'false',
      },
      /**
       * 'plain' (resolved page numbers) or 'none' (entries stand
       * alone). The TOC is ALWAYS hyperlinking invisibly (rows carry
       * the link mark; Ctrl+click follows) — no hyperlink option.
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
      // The content hole — entry rows are REAL children (the clipboard
      // serialization; the live editor renders through the NodeView).
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

          // The split-dance: mid-text, the RESOLVED mapped position's
          // before() is the between-siblings spot — the raw map lands
          // INSIDE a half ("cannot insert" crash).
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
          // NodeSelection ON the node: one Delete removes it. The
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
 * The ONE insertion path (every surface converges here): refusal
 * checks + toast + the command. Bands (chrome content) and table
 * cells (the adapter's cell contract would throw) are refused loudly.
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
  // The container inserts EMPTY — the generator's appendTransaction
  // fills the children in the SAME tick, before paint.
  return editor.chain().focus().insertReferenceTable(kind, depth).run();
}

