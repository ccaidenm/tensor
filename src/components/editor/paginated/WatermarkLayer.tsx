import { useMediaStore } from '@/lib/media/store';
import type { WatermarkSettings } from '@/lib/document/pageSetup';
import type { PageGeometry, TextMetrics } from '@tensor-editor/engine';
import { resolveWatermark, type ResolvedImageWatermark } from '@/lib/paginated/watermark';

/**
 * #WATERMARK — the on-screen page overlay: semi-transparent rotated
 * text ("DRAFT") or an image, centered on the sheet, BEHIND all
 * content. Mount order is the whole story: the layer is the FIRST
 * child inside the sheet (above the sheet's own background, below the
 * behind-floats ImageLayer and the text canvases) — behind everything
 * by construction, the paint-order law, no z-index anywhere.
 *
 * THE LAYER CONTRACT (every per-page layer's): pointer-events-none
 * absolute + aria-hidden — it paints only; hit-testing and selection
 * never see it (the selection/hit machinery walks the text canvases,
 * which sit above).
 *
 * DOM, NOT CANVAS (the EquationLayer ruling): rotation is a CSS
 * transform — there is no ctx.rotate anywhere in the codebase, and
 * DOM keeps the watermark crisp at every zoom/DPR for free (it lives
 * inside the scaled stack; no zoom compensation, the zoom law).
 * Pages mode only — a watermark is page-level ink; pageless has no
 * sheets and shows nothing (documented ruling, Word's web-layout
 * divergence noted).
 */

function WatermarkImage({ spec }: { spec: ResolvedImageWatermark }) {
  const sha = spec.src.slice('media://'.length);
  const entry = useMediaStore((s) => s.entries.get(sha));
  return (
    <img
      src={entry?.url}
      alt=""
      draggable={false}
      style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        width: `${spec.width}px`,
        height: `${spec.height}px`,
        transform: `translate(-50%, -50%) rotate(${spec.rotation}deg)`,
        opacity: spec.opacity,
      }}
    />
  );
}

export function WatermarkLayer({
  geometry,
  watermark,
  metrics,
  baseFontFamily,
}: {
  geometry: PageGeometry;
  watermark: WatermarkSettings | null | undefined;
  metrics: TextMetrics;
  baseFontFamily: string;
}) {
  const spec = watermark
    ? resolveWatermark(watermark, { width: geometry.size.width, height: geometry.size.height }, metrics.measure, baseFontFamily)
    : null;
  if (!spec) return null;
  return (
    <div
      data-testid="watermark-layer"
      aria-hidden="true"
      className="pointer-events-none absolute left-0 top-0"
      style={{ width: `${geometry.size.width}px`, height: `${geometry.size.height}px` }}
    >
      {spec.kind === 'text' ? (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            fontFamily: baseFontFamily,
            fontSize: `${spec.fontSize}px`,
            fontWeight: 'bold',
            color: spec.color,
            opacity: spec.opacity,
            whiteSpace: 'nowrap',
            transform: `translate(-50%, -50%) rotate(${spec.rotation}deg)`,
          }}
        >
          {spec.text}
        </div>
      ) : (
        <WatermarkImage spec={spec} />
      )}
    </div>
  );
}
