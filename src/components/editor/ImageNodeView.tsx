import { useState } from 'react';
import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { useMediaStore } from '@/lib/media/store';

/**
 * M-IMAGES-1 — the image node view. ONE resolution point: the
 * MediaStore (objectURL) — no parallel path, ever. Rendered in BOTH
 * worlds:
 *  - PAGELESS: this is the visible rendering (natural size — the
 *    parity bar with the paginated placed dims).
 *  - PAGINATED: the hidden PM view (pm-input-only) still renders it
 *    invisibly — and that is the a11y receipt: a real <img alt> in
 *    the accessibility tree, exactly the M5 Orca mirror ("NOT
 *    aria-hidden: opacity 0 keeps it in the accessibility tree" —
 *    PaginatedView's HiddenInputView law).
 */

type ImageNodeViewProps = ReactNodeViewProps;

export function ImageNodeView({ node }: ImageNodeViewProps) {
  const { src, width, height, alt, radius, decorative } = node.attrs as {
    src: string | null;
    width: number | null;
    height: number | null;
    alt: string;
    radius?: number;
    decorative?: boolean;
  };
  const id = src?.startsWith('media://') ? src.slice('media://'.length) : null;
  const entry = useMediaStore((s) => (id ? s.entries.get(id) : undefined));
  // M-IMAGES-2.2 — the <img>'s own decode failure (an <img> fired by
  // the node view is a SECOND decode path beside the bitmap cache's —
  // the pageless surface and the a11y view ride it): a browser
  // broken-image glyph is FORBIDDEN here (the M-IMAGES-1 design law:
  // tinted placeholder, never a broken glyph), so an onerror flips
  // this view to the same hatched failed box the canvas surfaces use.
  // OWNERSHIP: this view trusts only ITS OWN onerror (it doesn't
  // subscribe to bitmap arrivals, so the canvas cache's failed state
  // would be a stale read here — each surface owns its decode path).
  const [imgFailed, setImgFailed] = useState(false);
  const failed = imgFailed;

  if (!id || !entry) {
    return (
      <NodeViewWrapper data-image-node="true" data-resolved="false">
        {/* Unresolved ref (media not in the store — e.g. an external
            doc opened without its container): the tinted placeholder,
            never a broken-image glyph. Decode-failure state lives in
            the failed branch below (shared with the <img> path).
            M-A11Y: DECORATIVE images are hidden from the tree (the
            alt="" <img> spelling carries it on the resolved path). */}
        <div
          data-testid="image-placeholder"
          aria-label={alt || 'image'}
          role="img"
          aria-hidden={decorative === true || undefined}
          style={{
            width: width ? `${width}px` : '96px',
            height: height ? `${height}px` : '64px',
            background: 'rgba(0,0,0,0.08)',
            borderRadius: '4px',
          }}
        />
      </NodeViewWrapper>
    );
  }

  if (failed) {
    return (
      <NodeViewWrapper data-image-node="true" data-resolved="failed">
        <div
          data-testid="image-failed"
          aria-label={alt || 'image'}
          role="img"
          aria-hidden={decorative === true || undefined}
          style={{
            width: width ? `${width}px` : '96px',
            height: height ? `${height}px` : '64px',
            background:
              'repeating-linear-gradient(45deg, rgba(0,0,0,0.16) 0 8px, rgba(0,0,0,0.24) 8px 16px)',
            borderRadius: '4px',
          }}
        />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper data-image-node="true" data-resolved="true">
      <img
        src={entry.url}
        alt={alt}
        draggable={false}
        onError={() => {
          if (import.meta.env.DEV) {
            console.error(`[media] <img> decode failed (media://${id}, ${(entry.bytes.length).toString()} bytes)`);
          }
          setImgFailed(true);
        }}
        style={{
          ...(width && height ? { width: `${width}px`, height: `${height}px` } : {}),
          borderRadius: radius ? `${Math.min(radius, Math.floor(Math.min(width ?? radius, height ?? radius) / 2))}px` : undefined,
        }}
      />
    </NodeViewWrapper>
  );
}
