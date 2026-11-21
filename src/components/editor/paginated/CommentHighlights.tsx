import type { PaintedRect } from '@/lib/paginated/positionMap';

/**
 * #COMMENTS — the PAGES-mode projection of the comment tracking
 * plugin's ranges (commentTrackingKey), mapped through positionMap —
 * the SearchHighlights pattern (one state, two projections; the
 * pageless side renders via the mark's own spans + the active-class
 * decoration). One tinted rect group per anchored thread; the ACTIVE
 * thread (the caret's) paints a second, deeper tier on top — the
 * search `current` pattern.
 *
 * Geometry = textRangeTextExtents' TEXT EXTENT (the search law): the
 * rects hug the glyphs, so adjacent lines never bleed. The overlay is
 * pointer-events-none + absolutely positioned — comments can never
 * change pagination or intercept clicks (the layout-invisibility law).
 */
const COMMENT_HIGHLIGHT_ALPHA = '0.55';

export interface CommentThreadPaint {
  id: string;
  rects: PaintedRect[];
}

export function CommentHighlights({
  threads,
  active,
}: {
  threads: CommentThreadPaint[];
  active: PaintedRect[];
}) {
  return (
    <>
      {threads.flatMap((thread) =>
        thread.rects.map((r, i) => (
          <div
            key={`${thread.id}-${i}`}
            data-testid="comment-rect"
            data-comment-thread={thread.id}
            aria-hidden="true"
            className="pointer-events-none absolute"
            style={{
              left: `${r.left}px`,
              top: `${r.top}px`,
              width: `${r.width}px`,
              height: `${r.height}px`,
              backgroundColor: 'var(--color-comment-highlight)',
              opacity: COMMENT_HIGHLIGHT_ALPHA,
            }}
          />
        )),
      )}
      {active.map((r, i) => (
        <div
          key={`active-${i}`}
          data-testid="comment-rect-active"
          aria-hidden="true"
          className="pointer-events-none absolute"
          style={{
            left: `${r.left}px`,
            top: `${r.top}px`,
            width: `${r.width}px`,
            height: `${r.height}px`,
            backgroundColor: 'var(--color-comment-highlight-active)',
            opacity: COMMENT_HIGHLIGHT_ALPHA,
          }}
        />
      ))}
    </>
  );
}
