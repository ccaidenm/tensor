import type { TextStyle } from '@tensor-editor/engine';

/**
 * The metrics port for the print walk: the seam lets tests use
 * deterministic doubles and keeps the renderer off canvas state.
 */

export interface TextMetricsPort {
  measure(text: string, style: TextStyle): number;
  ascent(style: TextStyle): number;
  descent(style: TextStyle): number;
}