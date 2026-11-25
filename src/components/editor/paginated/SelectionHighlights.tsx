import type { PaintedRect } from '@/lib/paginated/positionMap';
import { withAlpha } from '@/lib/colorFormat';

/** PM selection projection: one div per line, partial x on the
 * first/last line. Rects are inside the zoom transform — no zoom
 * compensation. A configured `color` always paints at SELECTION_ALPHA. */
const SELECTION_ALPHA = 0.35;

export function SelectionHighlights({
  rects,
  color,
}: {
  rects: readonly PaintedRect[];
  color?: string;
}) {
  return (
    <>
      {rects.map((r, i) => (
        <div
          key={i}
          data-testid="selection-rect"
          aria-hidden="true"
          className={`pointer-events-none absolute ${color ? '' : 'bg-primary/25'}`}
          style={{
            left: `${r.left}px`,
            top: `${r.top}px`,
            width: `${r.width}px`,
            height: `${r.height}px`,
            ...(color ? { backgroundColor: withAlpha(color, SELECTION_ALPHA) } : {}),
          }}
        />
      ))}
    </>
  );
}
