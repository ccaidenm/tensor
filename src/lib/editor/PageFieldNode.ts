import { Node, mergeAttributes } from '@tiptap/core';

/**
 * #34 — the page-number FIELD: an inline atom resolving to the current
 * page ('page') or total count ('pages'). The node is a marker, never
 * a saved value; paint resolves per page (the engine never reads it).
 */
export const PageFieldNode = Node.create({
  name: 'pageField',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      kind: {
        default: 'page' as 'page' | 'pages',
        parseHTML: (element: HTMLElement) =>
          element.getAttribute('data-page-field') === 'pages' ? 'pages' : 'page',
        renderHTML: (attributes: Record<string, unknown>) => ({
          'data-page-field': attributes.kind === 'pages' ? 'pages' : 'page',
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-page-field]' }];
  },

  /**
   * The plain-text spelling (clipboard text/plain, spell/search):
   * a stable braced label so external targets see WHAT was there.
   */
  renderText({ node }: { node: { attrs: { kind?: string } } }) {
    return node.attrs.kind === 'pages' ? '{NUMPAGES}' : '{PAGE}';
  },

  renderHTML({ node }: { node: { attrs: Record<string, unknown>; type: { name: string } } }) {
    const pages = node.attrs.kind === 'pages';
    // The chip: the pageless view + clipboard spelling (the paginated
    // canvas paints the resolved number). Inline styles — no CSS sheet
    // dependency.
    return [
      'span',
      mergeAttributes(
        { 'data-page-field': pages ? 'pages' : 'page' },
        {
          style:
            'display:inline-block;padding:0 4px;border:1px solid rgba(128,128,128,.5);' +
            'border-radius:3px;font-size:0.85em;color:gray;user-select:none;white-space:nowrap;',
        },
      ),
      pages ? 'PAGE COUNT' : 'PAGE NUMBER',
    ];
  },
});

/** Insert a page field at the caret (the header/footer ribbon's
 *  command body — enablement is the caller's: the selection must sit
 *  in a band). */
export function insertPageField(
  editor: import('@tiptap/core').Editor,
  kind: 'page' | 'pages',
): boolean {
  return editor.chain().focus().insertContent({ type: 'pageField', attrs: { kind } }).run();
}
