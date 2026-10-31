import { Node, mergeAttributes } from '@tiptap/core';

/**
 * M-PAGEFIELD (#34) — the page-number FIELD: an inline atom in band
 * content that resolves to the CURRENT page number ('page') or the
 * document's total page count ('pages') — the "Page X of Y" footer
 * composed as literal text around two fields, Word's own spelling.
 *
 * THE RESOLUTION LAW (the M-REFS family): numbers are LAYOUT facts —
 * the PM node is a marker, never carrying a resolved value (never
 * saved, never stale). The ADAPTER emits the field as a text run
 * measured at the warm total's max-width digits (the widest page
 * number string — layout-stable across pages); the PAINT resolves
 * per page (each page's echoed band lines draw their own number);
 * the SHELL's two-pass fixpoint re-lays-out when the total's digit
 * width changes. The ENGINE never reads the field — the run is plain
 * text to it (the fieldKind marker is deliberately unhashed).
 *
 * PAGELESS: page numbers are meaningless without pages — the
 * pageless view renders the chip (this node's DOM), a known and
 * honest divergence.
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
   * THE PLAIN-TEXT SPELLING (clipboard text/plain + the spell/search
   * token): a stable braced label. Copy/paste round-trips through
   * PM's HTML path (renderHTML/parseHTML above); the plain-text
   * flavor carries the label so external targets and the menu's
   * text-only paste replay show WHAT was there instead of nothing.
   */
  renderText({ node }: { node: { attrs: { kind?: string } } }) {
    return node.attrs.kind === 'pages' ? '{NUMPAGES}' : '{PAGE}';
  },

  renderHTML({ node }: { node: { attrs: Record<string, unknown>; type: { name: string } } }) {
    const pages = node.attrs.kind === 'pages';
    // The chip: the editor's own surface (the paginated canvas paints
    // the resolved number; this DOM is the pageless view + the
    // clipboard's spelling). Inline styles — self-contained, no CSS
    // sheet dependency.
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
