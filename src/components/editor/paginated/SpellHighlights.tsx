import { useConfigStore } from '@/lib/config/store';
import type { PaintedRect } from '@/lib/paginated/positionMap';
import type { SpellError } from '@/lib/editor/spell/types';

/**
 * Spell/grammar bars: pointer-events-none (hitTest owns the routing),
 * stack-local pre-zoom px inside the zoom transform, aria-hidden — ink,
 * not content. Spelling red, grammar blue; the optional double bar adds
 * a non-color cue for color-blind users. Rects come from
 * positionMap.textRangeUnderlineRects — bars hug the glyphs through wraps.
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
