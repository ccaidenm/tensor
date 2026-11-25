import { Node, mergeAttributes } from '@tiptap/core';

/**
 * Doc-level header/footer containers — same PM document, so the one
 * hidden view owns input and the one engine pipeline paints the
 * bands; the adapter routes them out of body flow into `doc.bands`.
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
        // #58 — the section OVERRIDE tag: a container tagged with a
        // break's sectionId feeds THAT section; untagged = the doc
        // default. A stale tag resolves to the doc default.
        sectionId: {
          default: null,
          parseHTML: (el: HTMLElement) => el.getAttribute('data-section-id'),
          renderHTML: (attrs: Record<string, unknown>) =>
            attrs.sectionId ? { 'data-section-id': attrs.sectionId } : {},
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

/**
 * #58 — the FINAL section's band-override key: the breaks carry
 * sections 0..n-1's ids, and this reserved id (uncolliding with
 * generated `sec-…`) feeds the final section only.
 */
export const FINAL_SECTION_ID = 'sec-final';

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