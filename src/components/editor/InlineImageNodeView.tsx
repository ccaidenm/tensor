import { useState } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import type { ReactNodeViewProps } from '@tiptap/react';
import { useMediaStore } from '@/lib/media/store';

/**
 * The inline image node view (pageless rendering + the hidden-PM-view
 * a11y surface). Natural size inline — the CSS baseline seats it;
 * clamped by CSS max-width:100% (the engine's fitDownImage owns the
 * paginated clamp). Decode failure flips to the hatched failed box —
 * never a broken-image glyph, matching the canvas surfaces.
 */
type InlineImageNodeViewProps = ReactNodeViewProps;

export function InlineImageNodeView({ node }: InlineImageNodeViewProps) {
  const { src, alt, width, height, radius, decorative } = node.attrs as {
    src: string | null;
    alt: string;
    width: number | null;
    height: number | null;
    radius?: number;
    decorative?: boolean;
  };
  const id = src?.startsWith('media://') ? src.slice('media://'.length) : null;
  const entry = useMediaStore((s) => (id ? s.entries.get(id) : undefined));
  // The <img>'s own decode failure (see ImageNodeView).
  const [imgFailed, setImgFailed] = useState(false);

  if (!id || !entry) {
    return (
      <NodeViewWrapper as="span" data-inline-image-node="true" data-resolved="false">
        <span
          data-testid="inline-image-placeholder"
          role="img"
          aria-label={alt || 'image'}
          aria-hidden={decorative === true || undefined}
          style={{
            display: 'inline-block',
            width: width ? `${width}px` : '48px',
            height: height ? `${height}px` : '32px',
            background: 'rgba(0,0,0,0.08)',
            borderRadius: radius ? `${radius}px` : undefined,
          }}
        />
      </NodeViewWrapper>
    );
  }

  if (imgFailed) {
    return (
      <NodeViewWrapper as="span" data-inline-image-node="true" data-resolved="failed">
        <span
          data-testid="inline-image-failed"
          role="img"
          aria-label={alt || 'image'}
          aria-hidden={decorative === true || undefined}
          style={{
            display: 'inline-block',
            width: width ? `${width}px` : '48px',
            height: height ? `${height}px` : '32px',
            background:
              'repeating-linear-gradient(45deg, rgba(0,0,0,0.16) 0 8px, rgba(0,0,0,0.24) 8px 16px)',
            borderRadius: radius ? `${radius}px` : undefined,
          }}
        />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper as="span" data-inline-image-node="true" data-resolved="true">
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
          display: 'inline-block',
          verticalAlign: 'baseline',
          maxWidth: '100%',
          ...(width && height ? { width: `${width}px`, height: `${height}px` } : {}),
          ...(radius ? { borderRadius: `${radius}px` } : {}),
        }}
      />
    </NodeViewWrapper>
  );
}
