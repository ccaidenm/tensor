import type { PaintedRect } from '@/lib/paginated/positionMap';

/** Search-match projection: rects are the matched TEXT EXTENT
 * (positionMap.textRangeTextExtents), not the leading box — no bleed
 * onto adjacent lines. Semi-transparent fill keeps text readable. */
const FIND_HIGHLIGHT_ALPHA = '0.3';

export function SearchHighlights({
  matches,
  current,
}: {
  matches: readonly PaintedRect[];
  current: readonly PaintedRect[];
}) {
  return (
    <>
      {matches.map((r, i) => (
        <div
          key={`m${i}`}
          data-testid="search-rect"
          aria-hidden="true"
          className="tensor-search-match pointer-events-none absolute"
          style={{
            left: `${r.left}px`,
            top: `${r.top}px`,
            width: `${r.width}px`,
            height: `${r.height}px`,
            backgroundColor: 'var(--color-search-highlight)',
            opacity: FIND_HIGHLIGHT_ALPHA,
          }}
        />
      ))}
      {current.map((r, i) => (
        <div
          key={`c${i}`}
          data-testid="search-current-rect"
          aria-hidden="true"
          className="tensor-search-match-current pointer-events-none absolute"
          style={{
            left: `${r.left}px`,
            top: `${r.top}px`,
            width: `${r.width}px`,
            height: `${r.height}px`,
            backgroundColor: 'var(--color-search-current)',
            opacity: FIND_HIGHLIGHT_ALPHA,
          }}
        />
      ))}
    </>
  );
}
