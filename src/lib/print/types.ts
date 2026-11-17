import type { TextStyle } from '@tensor-editor/engine';

/**
 * M-PRINT (#43/#39) — the print document DATA MODEL. The renderer
 * (render.ts) walks the engine's LineBoxes ONCE into these positioned
 * elements (all coordinates PAGE-RELATIVE px — contentBox added at
 * walk time); the view (PrintDocumentView) renders them as absolutely
 * positioned DOM. THREE consumers share one walk: the preview modal,
 * the OS print path (window.print), and the PDF synthesizer (pdf-lib
 * draws the same facts). Element order in the array IS paint order
 * (the view renders in order, all one stacking context).
 *
 * GEOMETRY LAW: every element derives from the engine's placement
 * facts (LineBox rect/baseline/segments, placed[] rects) through the
 * SAME derivations the canvas uses (alignOffset, fieldShiftBefore,
 * fitDownImage) — never re-measured, never re-derived. Page breaks
 * match the on-screen view by construction (same engine, same
 * metrics).
 */

export interface PrintText {
  kind: 'text';
  /** Page-relative left. */
  x: number;
  /** Page-relative TOP of the ink box (baseline − ascent) — the DOM
   *  view's datum (absolute positioning). */
  top: number;
  /** Page-relative BASELINE — the PDF's datum (drawText y). Both ride
   *  because the two consumers differ (v1 of the walk carried only
   *  top and the PDF had to re-derive ascent per style — re-derivation
   *  is the asymmetry-bug class this model kills). */
  baseline: number;
  width: number;
  text: string;
  style: TextStyle;
  /** Text ink color ('#000' default — the paint law). */
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
   *  embeds from the MediaStore's BYTES (an object URL is a view-side
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
   *  doc chain resolved at BUILD time (the same chain the on-screen
   * view paints). Unset = white paper (the sheet/PDF default). */
  background?: string;
  /**
   * #WATERMARK — the page's overlay, RESOLVED at build time (the
   * resolveWatermark spec — self-contained: font, size, rotation,
   * opacity; the same section → doc chain as the background). Unset
   * = none. Painted FIRST — before the elements — by every consumer
   * (the preview sheet, window.print, the PDF synthesizer).
   */
  watermark?: PrintWatermark;
  elements: PrintElement[];
}

/** #WATERMARK — the resolved text overlay (the PDF's font book keys
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

/** #WATERMARK — the resolved image overlay: the dual handle of
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