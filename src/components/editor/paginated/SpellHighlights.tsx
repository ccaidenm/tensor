import { useConfigStore } from '@/lib/config/store';
import type { PaintedRect } from '@/lib/paginated/positionMap';
import type { SpellError } from '@/lib/editor/spell/types';

/**
 * SPELL & GRAMMAR projection (Pages mode): flat flagged-span lines,
 * the SearchHighlights receipt adapted to bar geometry —
 *
 *  - `pointer-events: none` — right/left-clicks must fall through to
 *    the painted surface (hitTest owns the routing);
 *  - stack-local pre-zoom px inside the transform (the zoom law: the
 *    scale() parents scale these for free, nothing compensates);
 *  - aria-hidden + role none — the flag is ink, not content (a11y
 *    consumers read the hidden input view's text, as ever).
 *
 * KIND = COLOR (the distinction ruling): spelling red, grammar the
 * advisory blue (Word/GDocs convention). The optional DOUBLE line
 * for grammar (Accessibility → Visual Cues) adds a second bar below
 * the first — a non-color cue for color-blind users; the pageless
 * surface does the same via CSS text-decoration-style: double.
 *
 * The rects arrive from positionMap.textRangeUnderlineRects — the
 * same span walk the search/selection projections ride, so a flagged
 * span's bar hugs the glyphs through wraps, table lanes, and
 * alignment exactly like its selection would. The bar carries a touch
 * of transparency (the user's tuning — it reads as signal ink, not a
 * hard rule).
 */
export type SpellBar = PaintedRect & { kind: SpellError['kind'] };

/** The vertical gap between the two bars of a double line. */
const DOUBLE_LINE_GAP_PX = 2;

export function SpellHighlights({ bars }: { bars: readonly SpellBar[] }) {
  const doubleLine = useConfigStore((s) => s.config.accessibility.grammarDoubleLine);

  return (
    <>
      {bars.map((r, i) => {
        const color =
          r.kind === 'grammar' ? 'var(--color-grammar-error)' : 'var(--color-spell-error)';
        return (
          <div key={i} data-testid="spell-underline-group">
            <div
              data-testid="spell-underline"
              aria-hidden="true"
              className="pointer-events-none absolute"
              style={{
                left: `${r.left}px`,
                top: `${r.top}px`,
                width: `${r.width}px`,
                height: `${r.height}px`,
                backgroundColor: color,
                opacity: 0.85,
              }}
            />
            {r.kind === 'grammar' && doubleLine && (
              <div
                data-testid="spell-underline-double"
                aria-hidden="true"
                className="pointer-events-none absolute"
                style={{
                  left: `${r.left}px`,
                  top: `${r.top + r.height + DOUBLE_LINE_GAP_PX}px`,
                  width: `${r.width}px`,
                  height: `${r.height}px`,
                  backgroundColor: color,
                  opacity: 0.85,
                }}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
