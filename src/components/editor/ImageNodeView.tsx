import { useState } from 'react';
import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { useMediaStore } from '@/lib/media/store';

/**
 * The image node view. ONE resolution point: the MediaStore objectURL —
 * no parallel path. Pageless: the visible rendering (natural size —
 * parity with paginated placed dims). Paginated: rendered invisibly in
 * the hidden PM view (opacity 0, NOT aria-hidden) so the real <img alt>
 * stays in the a11y tree.
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
  // The <img> is a SECOND decode path beside the bitmap cache (the
  // pageless surface and the a11y view ride it). Never a browser
  // broken-image glyph: onerror flips to the canvas surfaces' hatched
  // failed box. Trusts only its OWN onerror — it doesn't subscribe to
  // bitmap arrivals (a stale read otherwise).
  const [imgFailed, setImgFailed] = useState(false);
  const failed = imgFailed;

  if (!id || !entry) {
    return (
      <NodeViewWrapper data-image-node="true" data-resolved="false">
        {/* Unresolved ref (e.g. an external doc opened without its
            container): tinted placeholder, never a broken glyph.
            Decorative images stay hidden from the a11y tree (the alt=""
            <img> spelling carries it when resolved). */}
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
