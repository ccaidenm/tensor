import type { TextStyle } from '@tensor-editor/engine';

/**
 * #43/#39 — the print data model: one walk into page-relative elements
 * shared by the preview, window.print, and the PDF synthesizer. Element
 * order is paint order; geometry is never re-measured.
 */

export interface PrintText {
  kind: 'text';
  /** Page-relative left. */
  x: number;
  /** Page-relative TOP of the ink box (baseline − ascent) — the DOM
   *  view's datum (absolute positioning). */
  top: number;
  /** Page-relative baseline — the PDF's datum (drawText y). Both
   *  datums ride because the two consumers differ. */
  baseline: number;
  width: number;
  text: string;
  style: TextStyle;
  /** Text ink color ('#000' default). */
  color: string;
  /** Text decoration ('' | 'underline' | 'line-through' | both). */
  decoration: string;
}

export interface PrintHighlight {
  kind: 'highlight';
  x: number;
  top: number;
  width: number;
  /** Ink height (ascent + descent — the paint box). */
  height: number;
  color: string;
}

export interface PrintRect {
  kind: 'rect';
  x: number;
  top: number;
  width: number;
  height: number;
  fill: string;
}

export interface PrintLine {
  kind: 'line';
  x: number;
  top: number;
  width: number;
  /** Vertical (thick) lines are drawn as rotated rects in the view. */
  height: number;
  color: string;
}

export interface PrintImage {
  kind: 'image';
  x: number;
  top: number;
  width: number;
  height: number;
  /** A renderable URL (the bitmap's src — object URL or data URL). */
  src: string;
  /** The content address ('media://<sha>' minus the scheme) — the PDF
   *  embeds from the MediaStore's bytes (an object URL is a view-side
   * handle; the export is a standalone file). */
  sha: string;
  alt: string;
  /** Paint order vs text: floats 'behind' go under. */
  z: 'front' | 'behind';
}

export interface PrintEquation {
  kind: 'equation';
  x: number;
  top: number;
  width: number;
  height: number;
  latex: string;
  fontSize: number;
  color: string;
}

export type PrintElement =
  | PrintText
  | PrintHighlight
  | PrintRect
  | PrintLine
  | PrintImage
  | PrintEquation;

export interface PrintPage {
  index: number;
  width: number;
  height: number;
  /** #48 — the page's background fill: the per-page → per-section →
   *  doc chain resolved at build time. Unset = white paper. */
  background?: string;
  /**
   * The page's overlay, resolved at build time (the same section →
   * doc chain as the background). Painted before the elements by
   * every consumer.
   */
  watermark?: PrintWatermark;
  elements: PrintElement[];
}

/** The resolved text overlay (the PDF's font book keys
 * off fontFamily; the anchor math keys off fontSize). */
export interface PrintWatermarkText {
  kind: 'text';
  text: string;
  fontFamily: string;
  fontSize: number;
  color: string;
  rotation: number;
  opacity: number;
}

/** The resolved image overlay: the dual handle of
 * PrintImage (src = the view's URL; sha = the export's bytes key). */
export interface PrintWatermarkImage {
  kind: 'image';
  sha: string;
  src: string;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
}

export type PrintWatermark = PrintWatermarkText | PrintWatermarkImage;