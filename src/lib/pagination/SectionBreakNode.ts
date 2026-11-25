import { Node, mergeAttributes } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { useDocumentStore } from '@/lib/document/store';
import type { PageSetup } from '@/lib/document/pageSetup';
import { deleteSectionBreakNear } from '@/lib/editor/headerFooterCommands';

/**
 * #58 — the sectionBreak atom (Word's sectPr spelling): the node carries
 * the preceding section's setup; the store's pageSetup governs the
 * final section (no breaks = today's document, no migration).
 */

/** A fresh section id (the band-override key — stable for the
 *  node's life; collisions practically impossible). */
function newSectionId(): string {
  return `sec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    sectionBreak: {
      /** `type`: how the section after this break starts (Word's
       * "Section start") — nextPage (default) or continuous. */
      insertSectionBreak: (setup?: PageSetup, type?: 'nextPage' | 'continuous') => ReturnType;
    };
  }
}

export const SectionBreakNode = Node.create({
  name: 'sectionBreak',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      setup: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const raw = el.getAttribute('data-section-setup');
          if (!raw) return null;
          try {
            return JSON.parse(raw) as PageSetup;
          } catch {
            return null;
          }
        },
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.setup ? { 'data-section-setup': JSON.stringify(attrs.setup) } : {},
      },
      sectionId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-section-id'),
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.sectionId ? { 'data-section-id': attrs.sectionId } : {},
      },
      // #58 — how the section after this break starts (Word's "Section
      // start"): 'nextPage' (default) closes the page; 'continuous'
      // flows on (the engine upgrades it when the geometry differs).
      type: {
        default: 'nextPage',
        parseHTML: (el: HTMLElement) =>
          el.getAttribute('data-section-type') === 'continuous' ? 'continuous' : 'nextPage',
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.type === 'continuous' ? { 'data-section-type': 'continuous' } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-section-break]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-section-break': 'true',
        class: 'section-break-marker',
        // The marker's label reads the type (the pageless surface's
        // NPC — the paginated view paints its own badges).
        'data-section-type': HTMLAttributes['data-section-type'] ?? 'nextPage',
        contenteditable: 'false',
      }),
    ];
  },

  addKeyboardShortcuts() {
    // #58 — merge-on-delete: the break's section merges into the
    // following one (following props win; band overrides drop) —
    // a plain delete would orphan the tagged band containers.
    return {
      Backspace: () =>
        this.editor.commands.command(({ state }) => {
          const { selection } = state;
          const isSelected =
            selection instanceof NodeSelection && selection.node.type.name === 'sectionBreak';
          if (!isSelected && !selection.empty) return false;
          return deleteSectionBreakNear(this.editor, 'back');
        }),
      Delete: () =>
        this.editor.commands.command(({ state }) => {
          const { selection } = state;
          const isSelected =
            selection instanceof NodeSelection && selection.node.type.name === 'sectionBreak';
          if (!isSelected && !selection.empty) return false;
          return deleteSectionBreakNear(this.editor, 'fwd');
        }),
    };
  },

  addCommands() {
    return {
      insertSectionBreak:
        (setup?: PageSetup, type?: 'nextPage' | 'continuous') =>
        ({ tr, dispatch, state }) => {
          const sectionBreakType = state.schema.nodes.sectionBreak;
          const paragraphType = state.schema.nodes.paragraph;
          const { $from } = state.selection;

          // The seed: the new break's setup = the effective geometry at
          // the insertion point (the store's pageSetup; an explicit
          // setup arg overrides).
          const effective: PageSetup = setup ?? useDocumentStore.getState().pageSetup;

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

          const sectionBreakNode = sectionBreakType.create({
            setup: effective,
            sectionId: newSectionId(),
            type: type ?? 'nextPage',
          });
          newTr = newTr.insert(insertPos, sectionBreakNode);
          const afterPos = insertPos + sectionBreakNode.nodeSize;

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