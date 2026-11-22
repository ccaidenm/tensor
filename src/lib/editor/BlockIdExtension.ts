import { Extension, type Editor } from '@tiptap/core';
import { Plugin, type Transaction } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { nanoid } from 'nanoid';

/**
 * Stable block ids on ID_BEARING_KINDS: the engine's caches are
 * id-keyed and throw on duplicates — mint missing ids (legacy docs,
 * initial content) and re-mint duplicates on the LATER node.
 */

// Each kind here maps to exactly one engine Block per node (table
// rows/cells are positional inside it), so each node needs its own id.
const ID_BEARING_KINDS = ['paragraph', 'heading', 'codeBlock', 'horizontalRule', 'image', 'equation', 'table', 'headerBlock', 'footerBlock', 'referenceTable'];

/**
 * Mint ids for missing/duplicate ID-bearing blocks INTO `tr` (positions
 * are doc-relative — tr must belong to the same doc). Full-tree walk:
 * nested list-item/blockquote paragraphs get engine Blocks too.
 */
function mintIds(doc: PMNode, tr: Transaction): boolean {
  const seen = new Set<string>();
  let modified = false;

  doc.descendants((node, pos) => {
    if (!ID_BEARING_KINDS.includes(node.type.name)) return;
    const id = node.attrs.blockId;
    if (typeof id === 'string' && id && !seen.has(id)) {
      seen.add(id);
      return;
    }
    // A duplicate re-mints on the LATER node; the earlier keeps its id.
    const minted = nanoid();
    seen.add(minted);
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockId: minted });
    modified = true;
  });

  return modified;
}

/** Run the mint pass against the live doc and dispatch if needed. Used
 * for the initial-content path (no transaction ever fires there). */
export function ensureBlockIds(editor: Editor): void {
  const { state, view } = editor;
  const tr = state.tr;
  if (mintIds(state.doc, tr)) view.dispatch(tr);
}

export const BlockIdExtension = Extension.create({
  name: 'blockId',

  addGlobalAttributes() {
    return [
      {
        types: ID_BEARING_KINDS,
        attributes: {
          blockId: {
            default: null,
            // Splitting must mint fresh: cloning would duplicate the id.
            keepOnSplit: false,
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((t) => t.docChanged)) return null;
          const tr = newState.tr;
          return mintIds(newState.doc, tr) ? tr : null;
        },
      }),
    ];
  },
});