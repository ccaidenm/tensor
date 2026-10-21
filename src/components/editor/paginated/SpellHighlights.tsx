import type { PaintedRect } from '@/lib/paginated/positionMap';

/**
 * SPELL-CHECK projection (Pages mode): flat flagged-word lines, the
 * SearchHighlights receipt adapted to bar geometry —
 *
 *  - `pointer-events: none` — right/left-clicks must fall through to
 *    the painted surface (hitTest owns the routing);
 *  - stack-local pre-zoom px inside the transform (the zoom law: the
 *    scale() parents scale these for free, nothing compensates);
 *  - aria-hidden + role none — the flag is ink, not content (a11y
 *    consumers read the hidden input view's text, as ever).
 *
 * The rects arrive from positionMap.textRangeUnderlineRects — the
 * same span walk the search/selection projections ride, so a flagged
 * word's bar hugs the glyphs through wraps, table lanes, and
 * alignment exactly like its selection would. The bar carries a touch
 * of transparency (the user's tuning — it reads as signal ink, not a
 * hard rule).
 */
export function SpellHighlights({ bars }: { bars: readonly PaintedRect[] }) {
  return (
    <>
      {bars.map((r, i) => (
        <div
          key={i}
          data-testid="spell-underline"
          aria-hidden="true"
          className="pointer-events-none absolute"
          style={{
            left: `${r.left}px`,
            top: `${r.top}px`,
            width: `${r.width}px`,
            height: `${r.height}px`,
            backgroundColor: 'var(--color-spell-error)',
            opacity: 0.85,
          }}
        />
      ))}
    </>
  );
}
