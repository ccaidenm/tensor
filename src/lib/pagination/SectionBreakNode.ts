import { Node, mergeAttributes } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { useDocumentStore } from '@/lib/document/store';
import type { PageSetup } from '@/lib/document/pageSetup';
import { deleteSectionBreakNear } from '@/lib/editor/headerFooterCommands';

/**
 * #58 SECTIONS — the sectionBreak ATOM: divides the document into
 * sections. Word's sectPr spelling: the node carries THE PRECEDING
 * section's page setup ("everything above me, since the previous
 * break, is a section with this setup"); the document's store-level
 * pageSetup/headerFooter = THE FINAL section's (content after the
 * last break). Consequence (the additive law): a document with no
 * sectionBreak nodes is exactly today's document — the store's
 * pageSetup governs everything, no migration.
 *
 * THE ADAPTER TRANSLATES (the pageBreak law — the node is NOT part of
 * the IR): breaks become the engine's section-boundary facts, each
 * carrying the FOLLOWING section's geometry (the next break's attrs,
 * else the doc defaults). v1 breaks are nextPage type — a boundary
 * always closes the page (the engine's boundary law, same as
 * breakBefore).
 *
 * ATTRS:
 *  - `setup`: PageSetup-shaped (pageSize/orientation/margins pt/
 *    custom dims) — the PRECEDING section's props. pageGap is NOT
 *    section data (view spacing, store-level).
 *  - `sectionId`: a stable generated id — the band-override key
 *    (headerBlock/footerBlock nodes reference it; Phase 2).
 *
 * INSERT LAW (the split-dance, PageBreakNode's): block-start inserts
 * before, block-end after, mid-block splits first. The new break's
 * setup seeds from the EFFECTIVE geometry at the insertion point —
 * inserting a break changes nothing visually until the user edits
 * the new section's props (the honest default).
 */

/** A fresh section id (the band-override key — stable for the
 *  node's life; collisions practically impossible). */
function newSectionId(): string {
  return `sec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    sectionBreak: {
      /** `type`: how the section AFTER this break starts (Word's
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
      // #58 — how the section AFTER this break starts (Word's "Section
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
    // #58 — MERGE-ON-DELETE: deleting the break merges its section into
    // the FOLLOWING one (the following section's props win; the dead
    // section's band overrides drop) — ONE undo step. A plain native
    // delete would orphan the tagged band containers, so Backspace/
    // Delete on a selected (or caret-adjacent) break route through the
    // merge command; no break adjacent → false, the default deletion.
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

          // THE SEED: the new break ends the section the insertion
          // point sits in — its props = that section's EFFECTIVE
          // geometry. v1: the store's pageSetup (the final section's;
          // an explicit setup arg overrides — the ribbon's law).
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