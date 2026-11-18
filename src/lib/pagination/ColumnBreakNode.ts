import { Node, mergeAttributes } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    columnBreak: {
      insertColumnBreak: () => ReturnType;
    };
  }
}

/**
 * #74 COLUMNS — the manual column break (the pageBreak node's twin:
 * "THE ADAPTER TRANSLATES — the node is NOT part of the IR"). The atom
 * forces the FOLLOWING block to open the next flow slot (the next
 * column, else the next page — Word's newsletter-flow early wrap).
 * Same split-dance, same following-paragraph guard, same selection
 * landing as insertPageBreak; the adapter stamps
 * `flow.breakBefore: 'column'` on the following block and emits the
 * columnBreak NPC fact (the BreakMarks badge at the anchor line's
 * column). Deletion is plain (the pageBreak posture — the
 * merge-on-delete law is sectionBreak-only).
 */
export const ColumnBreakNode = Node.create({
  name: 'columnBreak',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  parseHTML() {
    return [{ tag: 'div[data-column-break]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-column-break': 'true',
        class: 'column-break-marker',
        contenteditable: 'false',
      }),
    ];
  },

  addCommands() {
    return {
      insertColumnBreak:
        () =>
        ({ tr, dispatch, state }) => {
          const columnBreakType = state.schema.nodes.columnBreak;
          const paragraphType = state.schema.nodes.paragraph;
          const { $from } = state.selection;

          let newTr = tr;
          let insertPos: number;

          const atBlockStart = $from.parentOffset === 0;
          const atBlockEnd = $from.parentOffset === $from.parent.content.size;

          if (atBlockStart) {
            insertPos = $from.before();
          } else if (atBlockEnd) {
            insertPos = $from.after();
          } else {
            const splitPos = $from.pos;
            newTr = newTr.split(splitPos);
            insertPos = newTr.mapping.map(splitPos);
          }

          const columnBreakNode = columnBreakType.create();
          newTr = newTr.insert(insertPos, columnBreakNode);
          const afterPos = insertPos + columnBreakNode.nodeSize;

          const resolvedAfter = newTr.doc.resolve(afterPos);
          const nodeAfter = resolvedAfter.nodeAfter;

          let selectionPos: number;
          if (nodeAfter && nodeAfter.isTextblock) {
            selectionPos = afterPos + 1;
          } else {
            const paragraph = paragraphType.create();
            newTr = newTr.insert(afterPos, paragraph);
            selectionPos = afterPos + 1;
          }

          const selection = TextSelection.create(newTr.doc, selectionPos);
          newTr = newTr.setSelection(selection);

          if (dispatch) dispatch(newTr);
          return true;
        },
    };
  },
});
