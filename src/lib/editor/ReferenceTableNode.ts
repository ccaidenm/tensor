import { Node, type Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { toast } from '@/components/ui/toast';
import { ReferenceTableNodeView } from '@/components/editor/ReferenceTableNodeView';
import { selectionInBand } from '@/lib/editor/headerFooterCommands';
import { findTableUnderSelection } from '@/lib/editor/TableExtensions';
import { useDocumentStore } from '@/lib/document/store';
import {
  REFERENCE_KINDS,
  entriesForKind,
  scanCollections,
  type ReferenceKind,
} from '@/lib/references/scan';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    referenceTable: {
      /** Insert a reference-table block at the cursor (the split-dance
       * below); NodeSelection ON it after insert (the click-to-select
       * ruling's insert twin). */
      insertReferenceTable: (kind: ReferenceKind, depth?: number) => ReturnType;
    };
  }
}

/**
 * M-REFS — the reference-table NODE (issue #31): one generic block
 * atom parameterized by kind (ToC / Table of Figures / Index). THE
 * ATOM-FIELD RULING: the node's ONLY document data is { kind, depth }
 * — entries are NEVER stored; they are a live projection of the
 * document (references/scan.ts), recomputed per doc version. Auto-
 * update is inherent (a rescan IS the update), .wpdoc round-trips
 * need zero new schema fields, and undo never has to reconcile stored
 * entries with a changed document.
 *
 * depth is the ToC's heading-depth option (the insert dialog's picker;
 * default 3 = H1–H3, the issue's minimum). Other kinds ignore it. It
 * rides the attr so a future options UI is one attribute write — never
 * a migration.
 *
 * CLIPBOARD (the equation/clipboard law): parseHTML matches ONLY
 * Tensor's own data-tensor-ref-table marker — external HTML never
 * parses in; internal copy/paste copies the LIVE FIELD, and the paste
 * target rescans against ITS document (a ToC pasted into another doc
 * lists THAT doc's headings — the atom-field ruling's consequence).
 */
export const ReferenceTableNode = Node.create({
  name: 'referenceTable',
  group: 'block',
  atom: true,
  draggable: true,

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
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-tensor-ref-table]' }];
  },

  renderHTML({ node }) {
    const { kind, depth } = node.attrs as { kind: ReferenceKind; depth: number };
    return [
      'div',
      {
        'data-tensor-ref-table': 'true',
        'data-kind': kind,
        ...(kind === 'toc' ? { 'data-depth': String(depth) } : {}),
      },
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ReferenceTableNodeView);
  },

  /**
   * M-REFS — the CLIPBOARD TEXT (the "select the content" ask): the
   * entries are a live projection with no PM positions, so the node's
   * schema-level `toText` (the TipTap v3 text-serializer seam the core
   * clipboard extension consumes) serializes THE VISIBLE LIST — title
   * + entries, live-scanned at copy time. Ctrl+C on the selected
   * block, or any selection spanning it, lands the content in
   * external apps; internal paste still gets the live FIELD through
   * the HTML marker (toText owns text/plain only).
   *
   * THE GUARD (pinned by the interaction suite): TipTap applies every
   * extension's extendNodeSchema to EVERY node's schema build (the
   * reduce over all extensions) — without the name check this toText
   * would leak onto paragraph/heading and hijack every copy.
   */
  extendNodeSchema(extension: { name: string }) {
    if (extension.name !== 'referenceTable') return {};
    return {
      toText: ({ node }: { node: PMNode }) => {
        const kind: ReferenceKind =
          node.attrs.kind === 'figures' || node.attrs.kind === 'index' ? node.attrs.kind : 'toc';
        const depth = typeof node.attrs.depth === 'number' ? node.attrs.depth : 3;
        const meta = REFERENCE_KINDS[kind];
        const editor = useDocumentStore.getState().editor;
        if (!editor) return meta.title;
        const entries = entriesForKind(scanCollections(editor.state.doc), kind, depth);
        return [meta.title, ...entries.map((e) => e.text)].join('\n');
      },
    };
  },

  addCommands() {
    return {
      insertReferenceTable:
        (kind: ReferenceKind, depth = 3) =>
        ({ tr, dispatch, state }) => {
          const referenceTableType = state.schema.nodes.referenceTable;
          const { selection } = state;
          const { $from } = selection;

          // The split-dance (the equation/pageBreak insert law): an
          // empty paragraph at block start/end collapses around the
          // insert; a mid-text cursor splits first. Selection content
          // is never captured (unlike insertEquation — a collection is
          // never built from the selection).
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
            insertPos = newTr.mapping.map(splitPos);
          }

          const node = referenceTableType.create({ kind, depth });
          newTr = newTr.insert(insertPos, node);
          // NodeSelection ON the node (the Word-style click ruling's
          // insert twin: the block is selected, one Delete removes it).
          newTr = newTr.setSelection(NodeSelection.create(newTr.doc, insertPos));

          if (dispatch) dispatch(newTr);
          return true;
        },
    };
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
  // one Delete away); the block scans itself empty and shows its
  // placeholder until the document grows entries.
  return editor.chain().focus().insertReferenceTable(kind, depth).run();
}
