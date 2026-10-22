import type { PageGeometry, PlacedRect } from '@tensor-editor/engine';
import { parseEquation, renderEquation } from '@/lib/equations/render';

/**
 * M-EQ — the paginated equation paint: consumes placed[] (the engine's
 * placement facts — the shell never computes equation geometry) and
 * renders each equation at its placed rect as a positioned DOM overlay
 * INSIDE the sheet (page-relative coords — the sheet owns the stack
 * offset), the ImageLayer's sibling with one deliberate difference:
 *
 * DOM, NOT CANVAS — KaTeX output is HTML+CSS with webfonts; there is
 * no drawImage for it (an HTML-to-bitmap raster would blur at zoom/DPR
 * and fight the font pipeline). The overlay is crisp at any zoom and
 * the fonts are the same files the node view and the measurer use.
 *
 * pointer-events: NONE — like every layer, it paints only; the click
 * that selects an equation resolves through PaginatedView's placed-rect
 * hit-test against the canvas surface (the image rule).
 *
 * The rect's width/height are the ENGINE's placed dims — measured by
 * the EquationMetrics port from the SAME render surface class, so the
 * painted box is the measured box by construction. The fontSize echo
 * drives the math size (the .tensor-equation .katex override inherits
 * it — the one CSS derivation).
 */

interface EquationLayerProps {
  geometry: PageGeometry;
  /** This page's placed equations (document order). */
  placed: readonly PlacedRect[];
  /** M-EQ-2: the paint-only color per blockId from the PM doc
   *  (null = INHERIT). The imageRadii precedent: paint facts stay out
   *  of the engine — a color edit repaints without any relayout. */
  colors: ReadonlyMap<string, string | null>;
  /** The document's DEFAULT text color (the resolveRun 'normal'
   *  derivation the canvas text paints with) — the inherit case must
   *  paint THIS explicitly: the overlay is DOM and would otherwise
   *  inherit chrome's --foreground (the off-white mismatch). */
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
        // THE BROKEN-GLYPH LAW (the node view's, mirrored): the painted
        // surface never shows KaTeX's red error text (throwOnError:
        // false would paint the source in #cc0000) nor a silent blank.
        // Empty → the dashed placeholder; invalid → the styled invalid
        // face with the source visible (the edit path is one click
        // away); valid → the KaTeX projection.
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