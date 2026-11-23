import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const PLACEHOLDER_TEXT = 'Start typing…';

function docIsEmpty(doc: EditorState['doc']): boolean {
  if (doc.childCount !== 1) return false;
  const first = doc.firstChild!;
  return first.isTextblock && first.content.size === 0;
}

/**
 * The empty-document placeholder: one widget decoration when the doc
 * is empty. Ephemeral ink — never real text (decoration widgets are
 * not document content, so there is nothing to delete). The paginated
 * canvas paints its own copy (paint.ts placeholder extra); this widget
 * serves the pageless surface (the paginated hidden view is invisible).
 */
export const PlaceholderExtension = Extension.create({
  name: 'tensorPlaceholder',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('tensorPlaceholder'),
        props: {
          decorations(state: EditorState): DecorationSet | null {
            if (!docIsEmpty(state.doc)) return null;
            return DecorationSet.create(state.doc, [
              Decoration.widget(
                1,
                () => {
                  const span = document.createElement('span');
                  span.className = 'tensor-placeholder';
                  span.textContent = PLACEHOLDER_TEXT;
                  return span;
                },
                { side: 10 },
              ),
            ]);
          },
        },
      }),
    ];
  },
});
