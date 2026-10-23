import { Node, mergeAttributes } from '@tiptap/core';

/**
 * M-HEADER-FOOTER-2 — the doc-level header/footer container nodes.
 *
 * DESIGN (the unified-pipeline ruling): header/footer content lives in
 * the SAME TipTap document as the body — `doc: [headerBlock?, ...body…,
 * footerBlock?]` — so the ONE hidden input view (L3) owns all keyboard
 * input, IME, and the selection model, and the ONE engine pipeline
 * paints, hit-tests, and caret-projects it identically to body text.
 * The old separate small Editors (headerFooterStore's region editors)
 * are deleted with this milestone.
 *
 * CONTENT: 'block+' (multi-paragraph). The ADAPTER routes these nodes
 * OUT of the body flow into `doc.bands` (never in flow order) while
 * their paragraphs' AdapterBlocks join `blocks` (real PM positions —
 * the paint/caret/hit-test sidecar) AND `bandBlocks` (the band-membership
 * sidecar). The ENGINE re-emits them per page in the margin strips
 * (band-tagged LineBoxes).
 *
 * ATTRS: `variant` — 'default' (the every-page region) or 'first' (the
 * page-1 region under differentFirstPage). Enables/differentFirstPage
 * persist in .wpdoc metadata (document-wide settings, not node content).
 *
 * PAGELESS: renders natively (the content children, no special chrome)
 * — the fallback path's own contract.
 */

export interface HeaderFooterNodeOptions {
  name: 'headerBlock' | 'footerBlock';
  tag: string;
  legacyTag: string;
}

function createHeaderFooterNode({ name, tag, legacyTag }: HeaderFooterNodeOptions) {
  return Node.create({
    name,
    content: 'block+',
    group: 'block',
    defining: true,
    isolating: true,

    addAttributes() {
      return {
        variant: {
          default: 'default' as const,
          parseHTML: (el: HTMLElement) =>
            el.getAttribute('data-variant') === 'first' ? 'first' : 'default',
          renderHTML: (attrs: Record<string, unknown>) => ({
            'data-variant': attrs.variant === 'first' ? 'first' : 'default',
          }),
        },
      };
    },

    parseHTML() {
      return [{ tag }, { tag: legacyTag, attrs: {} }];
    },

    renderHTML({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) {
      return [tag, mergeAttributes(HTMLAttributes), 0];
    },
  });
}

export const HeaderBlock = createHeaderFooterNode({
  name: 'headerBlock',
  tag: 'header-block',
  legacyTag: 'headerBlock',
});

export const FooterBlock = createHeaderFooterNode({
  name: 'footerBlock',
  tag: 'footer-block',
  legacyTag: 'footerBlock',
});

export type HeaderFooterVariant = 'default' | 'first';

/** Which region a header/footer node feeds; null for non-band nodes. */
export function regionOf(
  name: string,
  variant: HeaderFooterVariant,
): 'header' | 'footer' | 'firstHeader' | 'firstFooter' | null {
  if (name === 'headerBlock') return variant === 'first' ? 'firstHeader' : 'header';
  if (name === 'footerBlock') return variant === 'first' ? 'firstFooter' : 'footer';
  return null;
}