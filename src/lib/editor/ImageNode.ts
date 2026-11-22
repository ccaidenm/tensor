import { Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { ImageNodeView } from '@/components/editor/ImageNodeView';

/**
 * Custom node (not @tiptap/extension-image): internal 'media://<sha256>'
 * refs, REQUIRED width/height, parseHTML scoped to our own marker
 * (external <img> never parses in); no bytes on the node.
 */

export interface ImageAttrs {
  src: string;
  width: number | null;
  height: number | null;
  alt: string;
  align: 'left' | 'center' | 'right';
  keepNext: boolean;
  /** Corner radius (px, default 0) — PAINT-ONLY (the clip/CSS border
   *  radius); never a layout fact, so attr writes splice without
   * relayout geometry changes. Clamped to half the min placed dim. */
  radius: number;
  /**
   * Presentational, content-free ink — exempt from the alt-text rule;
   * render surfaces carry alt=""/aria-hidden ('' alt = "not yet
   * written"; decorative = "no description needed").
   */
  decorative: boolean;
}

export const ImageNode = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      width: { default: null },
      height: { default: null },
      alt: { default: '' },
      align: { default: 'left' },
      keepNext: { default: false },
      radius: { default: 0 },
      float: { default: null },
      decorative: { default: false },
    };
  },

  // PM's clipboard rides text/html, so without a parse rule for our
  // node an internal copy would lose the image. The round-trip is
  // scoped to our own marker — external <img> HTML never parses in.
  parseHTML() {
    return [
      {
        tag: 'div[data-tensor-image="true"]',
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
      'div',
      {
        'data-tensor-image': 'true',
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
    return ReactNodeViewRenderer(ImageNodeView);
  },
});
