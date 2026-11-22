import { Extension, Mark, type Editor } from '@tiptap/core';
import { Plugin, type Transaction } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { headingStyleId, isHeadingStyleId } from '@/lib/styles/types';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    styleCommands: {
      /** Apply a paragraph-kind style: set styleId; heading entries
       *  convert the node, any other entry converts a heading back
       *  to a paragraph. */
      applyParagraphStyle: (styleId: string) => ReturnType;
      /** Apply a character-kind style as the charStyle mark. Replaces
       *  any existing charStyle on the span and stacks with
       *  bold/italic/textStyle. */
      applyCharStyle: (styleId: string) => ReturnType;
      removeCharStyle: () => ReturnType;
    };
  }
}

/**
 * The charStyle mark — a reference into the style registry, never
 * stamped props. One char style per span: `excludes` is its own
 * name, so applying charStyle{b} over charStyle{a} replaces it,
 * while bold/italic/textStyle still stack.
 */
export const CharStyleMark = Mark.create({
  name: 'charStyle',
  keepOnSplit: true,
  addAttributes() {
    return {
      styleId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-char-style') ?? undefined,
        renderHTML: (attributes: { styleId?: string | null }) => ({
          'data-char-style': attributes.styleId,
          class: `wp-charstyle-${attributes.styleId}`,
        }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-char-style]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', HTMLAttributes, 0];
  },
});

/**
 * Heading sync: a heading's style identity is always
 * `heading-{level}` — any doc-changing transaction re-aligns
 * mismatches (a heading typed over a custom paragraph takes it too).
 */
function syncHeadingStyleIds(doc: PMNode, tr: Transaction): boolean {
  let modified = false;
  doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return;
    const expected = headingStyleId(node.attrs.level ?? 1);
    if (node.attrs.styleId !== expected) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, styleId: expected });
      modified = true;
    }
  });
  return modified;
}

/** Load-path twin of the appendTransaction sync — covers creation
 *  paths that never dispatch a doc-changed transaction. */
export function ensureStyleSync(editor: Editor): void {
  const { state, view } = editor;
  const tr = state.tr;
  if (syncHeadingStyleIds(state.doc, tr)) view.dispatch(tr);
}

export const StyleCommandsExtension = Extension.create({
  name: 'styleCommands',

  addCommands() {
    return {
      applyParagraphStyle:
        (styleId: string) =>
        ({ editor, commands, chain }: { editor: Editor; commands: any; chain: any }) => {
          const { state } = editor;
          const $from = state.selection.$from;
          const parent = $from.parent;
          const parentName = parent.type.name;
          if (parentName !== 'paragraph' && parentName !== 'heading') return false;

          if (isHeadingStyleId(styleId)) {
            // Heading entries convert the node (Word: heading styles
            // are node-kind + level); the sync plugin aligns styleId.
            const level = parseInt(styleId.slice('heading-'.length), 10);
            return chain().focus().setHeading({ level }).run();
          }
          if (parentName === 'heading') {
            // Every non-heading paragraph style converts the heading
            // back to a paragraph carrying the styleId.
            return chain()
              .focus()
              .setParagraph()
              .updateAttributes('paragraph', { styleId })
              .run();
          }
          return commands.focus() && commands.updateAttributes('paragraph', { styleId });
        },

      applyCharStyle:
        (styleId: string) =>
        ({ state, tr, dispatch }: { state: any; tr: any; dispatch: any }) => {
          const { from, to, empty } = state.selection;
          const mark = state.schema.marks.charStyle.create({ styleId });
          if (dispatch) {
            if (empty) {
              // Collapsed caret: store the mark for the next input
              // (setMark semantics), replacing any stored charStyle —
              // one char style per span holds for typed text too.
              const stored = (state.storedMarks ?? []).filter((m: any) => m.type.name !== 'charStyle');
              tr.setStoredMarks([...stored, mark]);
            } else {
              // addMark replaces same-type marks (the excludes-self
              // rule), including across multi-node selections.
              tr.addMark(from, to, mark);
            }
            dispatch(tr);
          }
          return true;
        },

      removeCharStyle:
        () =>
        ({ state, tr, dispatch }: { state: any; tr: any; dispatch: any }) => {
          const { from, to } = state.selection;
          if (dispatch) {
            tr.removeMark(from, to, state.schema.marks.charStyle.type);
            dispatch(tr);
          }
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((t) => t.docChanged)) return null;
          const tr = newState.tr;
          return syncHeadingStyleIds(newState.doc, tr) ? tr : null;
        },
      }),
    ];
  },
});
