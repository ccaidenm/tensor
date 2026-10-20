import { Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { InlineImageNodeView } from '@/components/editor/InlineImageNodeView';

/**
 * M-IMAGES-2 — the INLINE image node (E-IMG-2).
 *
 * WHY A SEPARATE NODE (the mechanics receipt): block and inline are
 * DIFFERENT PM SHAPES — different `group` (top-level block content vs
 * `inline`, allowed only INSIDE a textblock), different content
 * models (atom-in-flow vs atom-in-text), different schema slots. A
 * node-kind SWITCH (replace block image ↔ inline image inside a
 * paragraph) is the only honest conversion; there is no "position
 * transform" that turns one shape into the other.
 *
 * The node mirrors the block image's attrs (src media:// ref, REQUIRED
 * width/height, alt) plus the inert carry-overs (align, keepNext,
 * radius, float) so the block ↔ inline round-trip returns geometry
 * EXACTLY (the conversion copies all attrs both ways; the adapter
 * ignores the inert ones inline). The token is ONE PM position per
 * object — the engine's U+FFFC contract.
 *
 * Baseline seating is the ENGINE's law (bottom-at-baseline, the CSS
 * default); the node view renders at the natural/clamped size and the
 * text baseline sits it — no shell math.
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
      // The float CARRIER (wrap.ts's carryAttrs): a floated image
      // wrapped inline and floated again keeps its exact offset —
      // mode switches never move the image (E-IMG-3). NEVER read
      // inline: the adapter's InlineImageRun ignores it, and in-flow
      // objects have no float placement of their own.
      float: { default: null },
    };
  },

  // M-IMAGES-2.2 — the CLIPBOARD-SCOPED round-trip (the twin of
  // ImageNode's): renderHTML emits span[data-tensor-inline-image] +
  // attrs; parseHTML matches ONLY that marker (external <img> HTML
  // never parses in — the original M-IMAGES-1 law stands). Internal
  // copy/cut/drag/paste of text CONTAINING objects now round-trips.
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
      },
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(InlineImageNodeView);
  },
});
