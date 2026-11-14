import type { TextStyle } from '@tensor-editor/engine';

/**
 * M-PRINT — the metrics PORT for the print walk. The real
 * implementation is the on-screen singleton (lib/paginated/metrics.ts
 * — getRealMetrics); the seam exists so tests drive the walk with
 * deterministic doubles (the FakeMetrics precedent) and the
 * renderer never imports canvas-adjacent module state.
 */

export interface TextMetricsPort {
  measure(text: string, style: TextStyle): number;
  ascent(style: TextStyle): number;
  descent(style: TextStyle): number;
}