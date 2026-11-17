import type { TextMetrics, TextStyle } from '@tensor-editor/engine';
import type { WatermarkSettings } from '@/lib/document/pageSetup';

/**
 * #WATERMARK — the ONE resolver: settings + page size → the concrete
 * paint spec. Every consumer (the on-screen WatermarkLayer, the print
 * walk, the PDF synthesizer, the tests) resolves through here — never
 * a second derivation of defaults, sizes, or the auto-scale math.
 *
 * DEFAULTS (absent = Word's own look): text = silver #c0c0c0, −45°
 * diagonal, 50% opacity, AUTO size (spans ~70% of the page diagonal,
 * measured through the ONE-ruler metrics); image = HORIZONTAL
 * (Word's picture-watermark posture — the diagonal is the TEXT
 * default), half the page wide, 50% opacity.
 *
 * DECLINES, never guesses (the checker's law): blank text, an image
 * without the media:// scheme, or missing/invalid dims → null —
 * nothing paints.
 */

export const WATERMARK_DEFAULT_COLOR = '#c0c0c0';
export const WATERMARK_DEFAULT_TEXT_ROTATION = -45;
export const WATERMARK_DEFAULT_IMAGE_ROTATION = 0;
export const WATERMARK_DEFAULT_OPACITY = 0.5;
export const WATERMARK_DEFAULT_SCALE = 0.5;

/** AUTO size: the text spans this fraction of the page diagonal. */
const AUTO_SPAN = 0.7;

export interface ResolvedTextWatermark {
  kind: 'text';
  text: string;
  /** The family the text renders in (the doc default) — carried so
   *  the print/PDF consumers never re-derive it (the self-contained
   *  spec law). */
  fontFamily: string;
  fontSize: number;
  color: string;
  rotation: number;
  opacity: number;
}

export interface ResolvedImageWatermark {
  kind: 'image';
  /** The opaque ref ('media://<sha>') — the view resolves the URL
   * through the MediaStore; the export through the bytes. */
  src: string;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
}

export type ResolvedWatermark = ResolvedTextWatermark | ResolvedImageWatermark;

export function resolveWatermark(
  wm: WatermarkSettings,
  page: { width: number; height: number },
  measure: TextMetrics['measure'],
  baseFontFamily: string,
): ResolvedWatermark | null {
  if (wm.kind === 'text') {
    const text = (wm.text ?? '').trim();
    if (!text) return null;
    let fontSize = wm.fontSize;
    if (typeof fontSize !== 'number' || !Number.isFinite(fontSize) || fontSize <= 0) {
      // AUTO: measure a 16px probe through the one ruler, scale so the
      // text spans AUTO_SPAN of the page's diagonal.
      const diagonal = Math.hypot(page.width, page.height);
      const probeStyle: TextStyle = { fontFamily: baseFontFamily, fontSize: 16 };
      const probe = measure(text, probeStyle);
      fontSize =
        probe > 0
          ? Math.max(8, (diagonal * AUTO_SPAN * 16) / probe)
          : (diagonal * AUTO_SPAN) / Math.max(6, text.length);
    }
    return {
      kind: 'text',
      text,
      fontFamily: baseFontFamily,
      fontSize,
      color: wm.color || WATERMARK_DEFAULT_COLOR,
      rotation: wm.rotation ?? WATERMARK_DEFAULT_TEXT_ROTATION,
      opacity: wm.opacity ?? WATERMARK_DEFAULT_OPACITY,
    };
  }
  const src = wm.src ?? '';
  const naturalWidth = wm.width;
  const naturalHeight = wm.height;
  if (
    !src.startsWith('media://') ||
    typeof naturalWidth !== 'number' ||
    typeof naturalHeight !== 'number' ||
    naturalWidth <= 0 ||
    naturalHeight <= 0 ||
    !Number.isFinite(naturalWidth) ||
    !Number.isFinite(naturalHeight)
  ) {
    return null;
  }
  const scale = typeof wm.scale === 'number' && wm.scale > 0 ? wm.scale : WATERMARK_DEFAULT_SCALE;
  const width = page.width * scale;
  return {
    kind: 'image',
    src,
    width,
    height: width * (naturalHeight / naturalWidth),
    rotation: wm.rotation ?? WATERMARK_DEFAULT_IMAGE_ROTATION,
    opacity: wm.opacity ?? WATERMARK_DEFAULT_OPACITY,
  };
}
