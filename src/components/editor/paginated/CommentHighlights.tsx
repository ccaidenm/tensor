import type { PaintedRect } from '@/lib/paginated/positionMap';

/**
 * Pages-mode projection of the comment plugin's ranges via positionMap;
 * the active thread paints a deeper tier on top. Rects use the text
 * extent (textRangeTextExtents) — no line bleed; pointer-events-none —
 * comments never change pagination or intercept clicks.
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
