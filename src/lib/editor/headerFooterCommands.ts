import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { useDocumentStore } from '@/lib/document/store';
import {
  cloneHeaderFooterSettings,
  defaultHeaderFooterSettings,
} from '@/lib/document/headerFooter';

/**
 * M-HEADER-FOOTER-2 — the header/footer COMMANDS. The old editing
 * store (region Editor instances, hidden hosts, measured band
 * heights, the settings echo loop) is DELETED: content rides the ONE
 * PM document via doc-level `headerBlock`/`footerBlock` nodes, the
 * ONE hidden input view owns focus, and the ONE engine pipeline
 * paints/hit-tests/caret-projects the bands. What remains here is
 * command sugar over the one editor plus the metadata settings
 * (differentFirstPage — a document-wide setting, not node content).
 */

export type BandWhich = 'header' | 'footer';
export type BandVariant = 'default' | 'first';

interface BandContainer {
  node: PMNode;
  pos: number;
}

/** The doc-level band container node for (which, variant), or null. */
export function findBandContainer(
  editor: Editor | null,
  which: BandWhich,
  variant: BandVariant,
): BandContainer | null {
  if (!editor) return null;
  const name = which === 'header' ? 'headerBlock' : 'footerBlock';
  let found: BandContainer | null = null;
  editor.state.doc.forEach((node: PMNode, offset: number) => {
    if (found) return;
    if (node.type.name !== name) return;
    if (variant === 'first' ? node.attrs.variant !== 'first' : node.attrs.variant === 'first')
      return;
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
 * True while the selection sits inside a band container — the
 * "active band" signal (muted ink, the contextual tab, the ruler's
 * active-region highlight). Selection-driven, like every projection.
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
 * Enable a region: INSERT the container (an empty paragraph child)
 * when absent, then focus its END. Word's Insert ▸ Header flow —
 * presence IS enablement (no separate flag to desync).
 *
 * M-HEADER-FOOTER-3: VARIANT-AWARE. The caller names the variant the
 * PAGE paints (the slot under differentFirstPage wants 'first' on
 * page 1, 'default' elsewhere) — the v2 always-default spelling made a
 * page-0 dblclick focus a variant page 0 never paints (the "double-
 * click does nothing" bug).
 */
export function enableRegion(
  editor: Editor | null,
  which: BandWhich,
  variant: BandVariant = 'default',
): void {
  if (!editor) return;
  const existing = findBandContainer(editor, which, variant);
  if (!existing) {
    const name = which === 'header' ? 'headerBlock' : 'footerBlock';
    // Insert at the doc start (header) / end (footer) — the band
    // containers' canonical positions.
    const pos = which === 'header' ? 0 : editor.state.doc.content.size;
    editor
      .chain()
      .focus()
      .insertContentAt(pos, { type: name, attrs: { variant }, content: [{ type: 'paragraph' }] })
      .run();
  }
  focusBand(editor, which, variant);
}

/**
 * Focus a band container's END (the last position inside it —
 * setTextSelection clamps). A plain selection + view.focus, NO
 * scrollIntoView (the hidden view's geometry is meaningless, L3 —
 * PaginatedView's own follow logic owns scroll).
 */
export function focusBand(
  editor: Editor | null,
  which: BandWhich,
  variant: BandVariant = 'default',
): void {
  if (!editor) return;
  const container = findBandContainer(editor, which, variant);
  if (!container) return;
  // INSIDE the last child's text end: the container's close token sits
  // at pos + nodeSize − 1 (a selection there = INSIDE the container's
  // content, AFTER the last child — insertContent would add a sibling).
  // One inward lands on the last child's own close = its text end.
  const end = container.pos + container.node.nodeSize - 2;
  editor.view.focus();
  editor.commands.setTextSelection(end);
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
 * The migration (v1 → v2): translate a legacy metadata shape's
 * per-region TipTap JSON docs into doc-level band container nodes.
 * Called by openDocument BEFORE the settings land in the store.
 * Regions with no content (null docs) are skipped — enabling without
 * content has no v2 spelling (presence IS enablement).
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