import { Mark } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    indexMark: {
      /** Mark the selection as an index entry (the issue's "invisible
       * index-marked span"). Non-empty text selections only. */
      setIndexEntry: () => ReturnType;
      /** Remove the mark from the selection (caret: the touched span). */
      unsetIndexEntry: () => ReturnType;
    };
  }
}

/**
 * M-REFS — the INDEX ENTRY mark: an INVISIBLE, presence-only span. The
 * marked text IS the term (no attrs; sub-entries/see-also are M3 —
 * attrs are the extension point). The scanner (references/scan.ts)
 * groups marked spans by exact trimmed text and lists each occurrence
 * as its own location.
 *
 * VISIBILITY: none in reading mode — the Index itself is the
 * feedback. With non-printing characters ON, the NPC affordance
 * (index.css: `.show-non-printing [data-tensor-index]`) shows a
 * dotted underline so authors can audit their marks — the pilcrow
 * law, applied to a mark.
 *
 * CLIPBOARD (the equation/clipboard law): parseHTML matches ONLY
 * Tensor's own marker — an external HTML <span> never carries it, so
 * nothing foreign parses in; internal copy/paste round-trips the mark
 * through the marker, exactly like the equation node.
 */
export const IndexMark = Mark.create({
  name: 'indexEntry',
  // A mark spanning a typed-over boundary keeps marking (the term
  // grows) — matches Link's behavior; unset is the explicit removal.
  keepOnSplit: true,

  parseHTML() {
    return [{ tag: 'span[data-tensor-index]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', { ...HTMLAttributes, 'data-tensor-index': 'true' }, 0];
  },

  addCommands() {
    return {
      setIndexEntry:
        () =>
        ({ state, tr, dispatch }) => {
          const { selection } = state;
          if (selection.empty) return false;
          if (dispatch) {
            tr.addMark(selection.from, selection.to, state.schema.marks.indexEntry.create());
          }
          return true;
        },

      unsetIndexEntry:
        () =>
        ({ state, tr, dispatch }) => {
          const { from, to, empty } = state.selection;
          const markType = state.schema.marks.indexEntry;
          if (dispatch) {
            if (empty) {
              // Caret case: clear the touched BLOCK's marks (Word's
              // remove-mark-at-caret shape — an explicit selection
              // narrows it).
              const $from = state.doc.resolve(from);
              tr.removeMark($from.before(), $from.after(), markType);
            } else {
              tr.removeMark(from, to, markType);
            }
          }
          return true;
        },
    };
  },
});

/** Enablement helper (context menu + palette): is an index mark active
 * at the current selection? Mirrors the link-active helper shape. */
export function indexEntryActive(state: EditorState): boolean {
  const markType = state.schema.marks.indexEntry;
  const { from, to, empty } = state.selection;
  if (empty) {
    const resolved = state.doc.resolve(from);
    return (
      resolved.marks().some((m) => m.type === markType) ||
      resolved.marks().some((m) => m.type.name === 'indexEntry')
    );
  }
  return state.doc.rangeHasMark(from, to, markType);
}
