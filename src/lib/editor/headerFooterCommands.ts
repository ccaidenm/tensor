import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { useDocumentStore } from '@/lib/document/store';
import {
  cloneHeaderFooterSettings,
  defaultHeaderFooterSettings,
} from '@/lib/document/headerFooter';

/**
 * Header/footer command sugar: content rides the one PM document via
 * doc-level headerBlock/footerBlock nodes; only the metadata settings
 * (differentFirstPage) live outside it.
 */

export type BandWhich = 'header' | 'footer';
export type BandVariant = 'default' | 'first';

interface BandContainer {
  node: PMNode;
  pos: number;
}

/** The doc-level band container for (which, variant), or null.
 *  #58 — given a sectionId: that section's tagged override only;
 *  undefined: the UNTAGGED doc default all non-overriders inherit. */
export function findBandContainer(
  editor: Editor | null,
  which: BandWhich,
  variant: BandVariant,
  sectionId?: string | null,
): BandContainer | null {
  if (!editor) return null;
  const name = which === 'header' ? 'headerBlock' : 'footerBlock';
  let found: BandContainer | null = null;
  editor.state.doc.forEach((node: PMNode, offset: number) => {
    if (found) return;
    if (node.type.name !== name) return;
    if (variant === 'first' ? node.attrs.variant !== 'first' : node.attrs.variant === 'first')
      return;
    // A tagged search matches only its tag; untagged-only for the default.
    const tag = typeof node.attrs.sectionId === 'string' ? node.attrs.sectionId : null;
    if (sectionId ? tag !== sectionId : tag !== null) return;
    found = { node, pos: offset };
  });
  return found;
}

/** Any band container present? (The Insert buttons' active state.) */
export function hasBandContainer(editor: Editor | null, which: BandWhich): boolean {
  if (!editor) return false;
  const name = which === 'header' ? 'headerBlock' : 'footerBlock';
  let found = false;
  editor.state.doc.forEach((node: PMNode) => {
    if (node.type.name === name) found = true;
  });
  return found;
}

/**
 * True while the selection sits inside a band container — the "active
 * band" signal (muted ink, the contextual tab, ruler highlight).
 */
export function selectionInBand(editor: Editor | null): boolean {
  if (!editor) return false;
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (name === 'headerBlock' || name === 'footerBlock') return true;
  }
  return false;
}

/**
 * Enable a region: INSERT the container (empty paragraph) when absent,
 * then focus its end — presence IS enablement. The caller names the
 * variant the PAGE paints ('first' on page 1 under differentFirstPage).
 */
export function enableRegion(
  editor: Editor | null,
  which: BandWhich,
  variant: BandVariant = 'default',
  sectionId?: string | null,
): void {
  if (!editor) return;
  const existing = findBandContainer(editor, which, variant, sectionId);
  if (!existing) {
    const name = which === 'header' ? 'headerBlock' : 'footerBlock';
    // #58 — a section-tagged enable seeds the container with the doc
    // default's content COPY (Word's "same as previous"); no default
    // → an empty paragraph.
    const seed = sectionId
      ? (() => {
          const def = findBandContainer(editor, which, variant);
          if (!def) return [{ type: 'paragraph' }];
          const content: unknown[] = [];
          def.node.forEach((child: PMNode) => {
            content.push(child.toJSON());
          });
          return content.length > 0 ? content : [{ type: 'paragraph' }];
        })()
      : [{ type: 'paragraph' }];
    // Insert at the doc start (header) / end (footer) — the band
    // containers' canonical positions.
    const pos = which === 'header' ? 0 : editor.state.doc.content.size;
    editor
      .chain()
      .focus()
      // @ts-expect-error -- content JSON passthrough (TipTap validates)
      .insertContentAt(pos, {
        type: name,
        attrs: sectionId ? { variant, sectionId } : { variant },
        content: seed,
      })
      .run();
  }
  focusBand(editor, which, variant, sectionId);
}

/**
 * Focus a band container's END (last position inside it). NO
 * scrollIntoView — the hidden view's geometry is meaningless.
 */
export function focusBand(
  editor: Editor | null,
  which: BandWhich,
  variant: BandVariant = 'default',
  sectionId?: string | null,
): void {
  if (!editor) return;
  const container = findBandContainer(editor, which, variant, sectionId);
  if (!container) return;
  // INSIDE the last child's text end: the container's close token sits
  // at pos + nodeSize − 1 (a selection there = AFTER the last child);
  // one inward lands on the last child's own close = its text end.
  const end = container.pos + container.node.nodeSize - 2;
  editor.view.focus();
  editor.commands.setTextSelection(end);
}

/**
 * #58 — merge-on-delete: the following section's properties win and
 * the dead section's tagged bands drop, in one transaction. False
 * when no break is adjacent (deletion falls through).
 */
export function deleteSectionBreakNear(editor: Editor | null, dir: 'back' | 'fwd'): boolean {
  if (!editor) return false;
  const { state } = editor;
  const { selection } = state;
  const breakType = state.schema.nodes.sectionBreak;
  if (!breakType) return false;

  let breakPos: number | null = null;
  if (selection.empty) {
    const { $from } = selection;
    if (dir === 'back') {
      // Backspace: the caret's BLOCK start — the parent level sees the
      // previous sibling; the caret inside the open token cannot.
      const blockStart = $from.before($from.depth);
      const before = state.doc.resolve(blockStart);
      if (before.nodeBefore?.type === breakType) {
        breakPos = blockStart - before.nodeBefore.nodeSize;
      }
    } else {
      // Delete: the caret's BLOCK end — the position between the
      // caret's block and its next sibling.
      const blockEnd = $from.after($from.depth);
      const after = state.doc.resolve(blockEnd);
      if (after.nodeAfter?.type === breakType) breakPos = blockEnd;
    }
  } else if (selection instanceof NodeSelection) {
    // NodeSelection on the break itself.
    if (selection.node.type === breakType) breakPos = selection.from;
  }
  if (breakPos === null) return false;

  const brk = state.doc.nodeAt(breakPos);
  if (!brk) return false;
  const tag = typeof brk.attrs.sectionId === 'string' ? brk.attrs.sectionId : null;

  const tr = state.tr;
  // ALL doomed positions (the tagged band containers + the break) are
  // collected on the ORIGINAL doc and deleted DESCENDING — each
  // deletion only shifts positions after it, which are already gone.
  const doomed: number[] = [];
  if (tag) {
    state.doc.forEach((node: PMNode, offset: number) => {
      if (
        (node.type.name === 'headerBlock' || node.type.name === 'footerBlock') &&
        node.attrs.sectionId === tag
      ) {
        doomed.push(offset);
      }
    });
  }
  doomed.push(breakPos);
  doomed.sort((a, b) => b - a);
  for (const pos of doomed) {
    const node = state.doc.nodeAt(pos)!;
    tr.delete(pos, pos + node.nodeSize);
  }
  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}

/**
 * #58 — relink ("Link to Previous"): delete the section's band
 * override; it inherits the doc default again (custom content is
 * lost — Word's own behavior). One transaction = one undo step.
 */
export function relinkBand(
  editor: Editor | null,
  which: BandWhich,
  variant: BandVariant,
  sectionId: string,
): boolean {
  if (!editor) return false;
  const container = findBandContainer(editor, which, variant, sectionId);
  if (!container) return false;
  // ONE transaction: the delete + landing selection (a split would
  // make the first undo swallow a selection-only item).
  const tr = editor.state.tr;
  tr.delete(container.pos, container.pos + container.node.nodeSize);
  // The section inherits again — land the user in the doc default's
  // band (mapped through the delete inside THIS tr).
  const fallback = findBandContainerInDoc(tr.doc, which, variant);
  if (fallback) {
    tr.setSelection(TextSelection.create(tr.doc, fallback.pos + fallback.node.nodeSize - 2));
  }
  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}

/** findBandContainer over an ARBITRARY document (the in-transaction
 *  post-delete doc). */
function findBandContainerInDoc(
  doc: PMNode,
  which: BandWhich,
  variant: BandVariant,
): BandContainer | null {
  const name = which === 'header' ? 'headerBlock' : 'footerBlock';
  let found: BandContainer | null = null;
  doc.forEach((node: PMNode, offset: number) => {
    if (found) return;
    if (node.type.name !== name) return;
    if (variant === 'first' ? node.attrs.variant !== 'first' : node.attrs.variant === 'first') return;
    const tag = typeof node.attrs.sectionId === 'string' ? node.attrs.sectionId : null;
    if (tag !== null) return; // the doc DEFAULT only (untagged)
    found = { node, pos: offset };
  });
  return found;
}

/** Focus the first BODY block (leaving the bands). */
export function blurToBody(editor: Editor | null): void {
  if (!editor) return;
  // The first NON-band top-level node's text start — a headerBlock at
  // the doc start would swallow position 1 (its child opens there).
  let target = 1;
  editor.state.doc.forEach((node: PMNode, offset: number) => {
    if (target !== 1) return;
    const name = node.type.name;
    if (name === 'headerBlock' || name === 'footerBlock') return;
    target = offset + 1;
  });
  editor.view.focus();
  editor.commands.setTextSelection(target);
}

/** The different-first-page settings write (marks dirty, relayouts). */
export function setDifferentFirstPage(value: boolean): void {
  const store = useDocumentStore.getState();
  const current = store.headerFooter ?? defaultHeaderFooterSettings();
  const next = cloneHeaderFooterSettings(current);
  next.differentFirstPage = value;
  store.setHeaderFooter(next);
}

/**
 * The v1 → v2 migration: legacy per-region docs become doc-level band
 * containers; called by openDocument BEFORE settings land. Null docs
 * are skipped (presence IS enablement).
 */
export function migrateLegacyHeaderFooter(
  editor: Editor,
  legacy: {
    header?: { doc?: unknown } | null;
    footer?: { doc?: unknown } | null;
    firstHeader?: { doc?: unknown } | null;
    firstFooter?: { doc?: unknown } | null;
  },
): void {
  const insert = (which: BandWhich, variant: BandVariant, doc: unknown): void => {
    if (!doc || typeof doc !== 'object') return;
    // A full doc JSON's children splice in; a bare node/fragment too.
    const content =
      (doc as { type?: string; content?: unknown[] }).type === 'doc'
        ? (doc as { content?: unknown[] }).content
        : doc;
    if (!content) return;
    const name = which === 'header' ? 'headerBlock' : 'footerBlock';
    const pos = which === 'header' ? 0 : editor.state.doc.content.size;
    // @ts-expect-error -- content JSON passthrough (TipTap validates)
    editor.commands.insertContentAt(pos, { type: name, attrs: { variant }, content });
  };
  insert('header', 'default', legacy.header?.doc);
  insert('header', 'first', legacy.firstHeader?.doc);
  insert('footer', 'default', legacy.footer?.doc);
  insert('footer', 'first', legacy.firstFooter?.doc);
}