import { Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { InlineImageNodeView } from '@/components/editor/InlineImageNodeView';

/**
 * The INLINE image node — separate from the block node because block
 * and inline are different PM shapes. Mirrors the block image's attrs
 * so block ↔ inline round-trips geometry exactly; ONE PM position.
 */
export const InlineImageNode = Node.create({
  name: 'inlineImage',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      src: { default: null },
      width: { default: null },
      height: { default: null },
      alt: { default: '' },
      // Inert inline (round-trip carriers; the adapter's InlineImageRun
      // carries none of these):
      align: { default: 'left' },
      keepNext: { default: false },
      radius: { default: 0 },
      // The float CARRIER: a floated image wrapped inline and floated
      // again keeps its exact offset — never read inline (in-flow
      // objects have no float placement of their own).
      float: { default: null },
      // DECORATIVE (the block image's twin): exempt from the alt-text rule.
      decorative: { default: false },
    };
  },

  // The clipboard-scoped round-trip (ImageNode's twin): renderHTML
  // emits span[data-tensor-inline-image]; parseHTML matches ONLY that
  // marker — external <img> HTML never parses in.
  parseHTML() {
    return [
      {
        tag: 'span[data-tensor-inline-image="true"]',
        getAttrs: (el) => {
          const attrs = (el as HTMLElement).dataset as unknown as Record<string, string>;
          // data-float is JSON — malformed markup never breaks the
          // parse (the attr degrades to null, the no-float default).
          let float: unknown = null;
          if (attrs.float) {
            try { float = JSON.parse(attrs.float); } catch { float = null; }
          }
          return {
            src: attrs.src ?? null,
            width: attrs.width ? Number(attrs.width) : null,
            height: attrs.height ? Number(attrs.height) : null,
            alt: attrs.alt ?? '',
            align: attrs.align && ['left', 'center', 'right'].includes(attrs.align)
              ? attrs.align
              : 'left',
            keepNext: attrs.keepNext === 'true',
            radius: attrs.radius ? Number(attrs.radius) : 0,
            float,
            decorative: attrs.decorative === 'true',
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const a = node.attrs as Record<string, unknown>;
    return [
      'span',
      {
        'data-tensor-inline-image': 'true',
        ...(a.src != null ? { 'data-src': String(a.src) } : {}),
        ...(a.width != null ? { 'data-width': String(a.width) } : {}),
        ...(a.height != null ? { 'data-height': String(a.height) } : {}),
        ...(a.alt ? { 'data-alt': String(a.alt) } : {}),
        ...(a.align !== 'left' ? { 'data-align': String(a.align) } : {}),
        ...(a.keepNext === true ? { 'data-keep-next': 'true' } : {}),
        ...(a.radius ? { 'data-radius': String(a.radius) } : {}),
        ...(a.float != null ? { 'data-float': JSON.stringify(a.float) } : {}),
        ...(a.decorative === true ? { 'data-decorative': 'true' } : {}),
      },
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(InlineImageNodeView);
  },
});
