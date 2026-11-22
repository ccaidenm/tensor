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
 * #74 — the manual column break: forces the following block to open the
 * next flow slot (next column, else next page — Word's newsletter wrap).
 * The adapter stamps `flow.breakBefore: 'column'`; deletion is plain.
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
