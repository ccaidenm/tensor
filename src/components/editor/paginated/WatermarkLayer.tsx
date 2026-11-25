import { useMediaStore } from '@/lib/media/store';
import type { WatermarkSettings } from '@/lib/document/pageSetup';
import type { PageGeometry, TextMetrics } from '@tensor-editor/engine';
import { resolveWatermark, type ResolvedImageWatermark } from '@/lib/paginated/watermark';

/**
 * Semi-transparent rotated text/image centered on the sheet, BEHIND all
 * content by mount order (the sheet's FIRST child, no z-index).
 * pointer-events-none + aria-hidden: paints only, never hit-tested.
 * CSS-transform rotation on DOM stays crisp at every zoom/DPR inside
 * the scaled stack. Pages mode only.
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
