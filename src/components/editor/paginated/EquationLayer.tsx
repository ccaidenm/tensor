import type { PageGeometry, PlacedRect } from '@tensor-editor/engine';
import { parseEquation, renderEquation } from '@/lib/equations/render';

/**
 * Paginated equation paint: each placed[] entry (engine placement facts
 * — the shell never computes geometry) renders as positioned DOM at its
 * page-relative rect. DOM, not canvas: KaTeX is HTML+CSS with webfonts,
 * crisp at any zoom/DPR. pointer-events: none — selection resolves via
 * PaginatedView's placed-rect hit-test. Painted box = measured box
 * (EquationMetrics uses the same render surface class).
 */

interface EquationLayerProps {
  geometry: PageGeometry;
  /** This page's placed equations (document order). */
  placed: readonly PlacedRect[];
  /** Paint-only color per blockId from the PM doc (null = INHERIT).
   *  Paint facts stay out of the engine — a color edit repaints
   *  without any relayout. */
  colors: ReadonlyMap<string, string | null>;
  /** The document's DEFAULT text color (what the canvas text paints
   *  with) — painted explicitly because the DOM overlay would
   *  otherwise inherit chrome's --foreground (the off-white mismatch). */
  defaultColor: string;
}

export function EquationLayer({ geometry, placed, colors, defaultColor }: EquationLayerProps) {
  if (placed.length === 0) return null;
  return (
    <div
      data-testid="equation-layer"
      data-page-index={geometry.index}
      className="pointer-events-none absolute left-0"
      style={{ top: 0, width: `${geometry.size.width}px`, height: `${geometry.size.height}px` }}
    >
      {placed.map((p) => {
        const latex = p.latex ?? '';
        const empty = latex.trim() === '';
        // Never KaTeX's red error text (throwOnError: false paints the
        // source in #cc0000) nor a silent blank: empty → the dashed
        // placeholder; invalid → the invalid face with the source visible.
        const invalid = !empty && parseEquation(latex) !== null;
        return (
          <div
            key={p.blockId}
            data-testid="equation-painted"
            data-block-id={p.blockId}
            data-resolved={empty ? 'empty' : invalid ? 'invalid' : 'ok'}
            className="tensor-equation absolute"
            style={{
              left: `${geometry.contentBox.x + p.rect.x}px`,
              top: `${geometry.contentBox.y + p.rect.y}px`,
              width: `${p.rect.width}px`,
              height: `${p.rect.height}px`,
              // The port's second key, echoed back — the math renders at
              // exactly the size the engine laid out.
              fontSize: `${p.fontSize ?? 16}px`,
              // The paint color: the node's attr, else the DOCUMENT's
              // default text color — explicitly, never chrome's.
              color: colors.get(p.blockId) ?? defaultColor,
              justifyContent: 'center',
            }}
          >
            {empty ? (
              <div className="tensor-equation-placeholder" />
            ) : invalid ? (
              <div className="tensor-equation-invalid">
                <code>{latex}</code>
              </div>
            ) : (
              // The ONE render surface — the same HTML the node view shows.
              <div
                className="tensor-equation-math"
                dangerouslySetInnerHTML={{ __html: renderEquation(latex) }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}