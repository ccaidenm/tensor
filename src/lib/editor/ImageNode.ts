import { Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { ImageNodeView } from '@/components/editor/ImageNodeView';

/**
 * M-IMAGES-1 — the image model.
 *
 * CUSTOM NODE, not @tiptap/extension-image (the divergence receipt):
 * the stock extension ships a paragraph-grouped node whose attrs are
 * just {src, alt, title} aimed at external/data URLs, renders via
 * plain renderHTML with no size control, and parses pasted HTML <img>
 * on sight. Tensor needs: (a) src as an INTERNAL 'media://<sha256>'
 * ref — never a URL the document reaches out to; (b) REQUIRED
 * width/height document data (the engine's ImageBlock contract:
 * "intrinsic px, REQUIRED document data, never fetched at layout
 * time"); (c) align + keepNext (the caption bond); (d) a NODE VIEW so
 * the hidden PM view renders a real <img alt> (the M5 Orca a11y
 * mirror) and the pageless mode renders through the ONE MediaStore
 * resolution point. parseHTML/renderHTML are SCOPED to our own
 * data-tensor-image marker (M-IMAGES-2.2 — the clipboard round-trip):
 * external <img> HTML never parses in; internal copy/paste is exact.
 *
 * The node NEVER holds bytes or data URLs — refs only. Dims are
 * required at INSERT time; dim-less legacy nodes are backfilled on
 * open (imageBackfill.ts).
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
    };
  },

  // M-IMAGES-2.2 — the CLIPBOARD-SCOPED round-trip. The ORIGINAL law
  // (no parseHTML at all) died on its own success: an INTERNAL copy
  // lost the image too — PM's clipboard rides text/html, the slice
  // parsed back WITHOUT a rule for our node, so copy→paste deleted
  // every image (and drag moved nothing). The law's actual intent was
  // narrower and stays intact: EXTERNAL content must never parse in.
  // So the round-trip is SCOPED to our own marker: renderHTML emits
  // div[data-tensor-image] + the internal attrs (a media:// ref is a
  // content address — meaningless outside the container, never a
  // secret); parseHTML matches ONLY that marker — a web page's <img>
  // (the original fear) still never parses in, and the M-IMAGES-1.5
  // paste refusal owns the URL case. Internal fidelity is now exact —
  // copy, cut, drag, and cross-document pastes round-trip the node
  // (dims REQUIRED at insert keep the adapter contract true on paste).
  // Node views still render the real <img>; toDOM is the clipboard
  // and serialization form.
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
      },
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageNodeView);
  },
});
