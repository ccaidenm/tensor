import { PDFDocument, degrees, rgb, type PDFImage } from 'pdf-lib';
import katex from 'katex';
import type { PdfInfo } from '@/lib/document/coreProperties';
import { createWarmableFontBook, type WarmableFontBook } from './pdfFonts';
import type { PrintPage } from './types';

/**
 * #39 — the PDF synthesis: the walk's positioned elements → pdf-lib
 * drawing, px → pt at 0.75, text selectable via embedded fonts;
 * equation rasters fall to LaTeX text on failure.
 */

const PT_PER_PX = 72 / 96;

export interface PdfExportInput {
  pages: readonly PrintPage[];
  /** Document metadata (toPdfInfo — the seam pre-built for this). */
  info: PdfInfo;
  /** sha → the MediaStore's bytes + ext (the export embeds from the
   *  bytes; an object URL is a view-side handle). */
  mediaBytes: (sha: string) => { bytes: Uint8Array; ext: string } | undefined;
  /** Test seam: the equation raster (jsdom can't rasterize). */
  rasterizeEquation?: (latex: string, fontSizePx: number) => Promise<Uint8Array | null>;
}

export interface PdfExportResult {
  bytes: Uint8Array;
  /** Families that fell to standard-14 faces (the loud report). */
  substitutedFonts: string[];
  /** Images that could not embed (unsupported formats). */
  skippedImages: number;
  /** Equations that fell to latex text (raster failure). */
  fallbackEquations: number;
}

/** Hex/rgba color → pdf-lib rgb. Returns null for unparseable. */
function parseColor(color: string): { r: number; g: number; b: number; alpha?: number } | null {
  const hex = /^#([0-9a-f]{3})$/i.exec(color) ?? /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    let digits = hex[1]!;
    if (digits.length === 3) digits = digits[0]! + digits[0] + digits[1]! + digits[1] + digits[2]! + digits[2];
    return {
      r: parseInt(digits.slice(0, 2), 16) / 255,
      g: parseInt(digits.slice(2, 4), 16) / 255,
      b: parseInt(digits.slice(4, 6), 16) / 255,
    };
  }
  const rgba = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/.exec(color);
  if (rgba) {
    return {
      r: Number(rgba[1]!) / 255,
      g: Number(rgba[2]!) / 255,
      b: Number(rgba[3]!) / 255,
      alpha: rgba[4] != null ? Number(rgba[4]!) : undefined,
    };
  }
  return null;
}

/** The MathML raster (the default equation path): KaTeX's MathML
 *  output in an SVG foreignObject → Image → canvas → PNG. Chromium
 *  renders MathML with built-in math layout — no external font deps. */
async function rasterizeEquationViaMathMl(
  latex: string,
  fontSizePx: number,
): Promise<Uint8Array | null> {
  try {
    const mathml = katex.renderToString(latex, {
      output: 'mathml',
      displayMode: true,
      throwOnError: false,
    });
    // A generous raster box (the placed rect is the crop target).
    const w = 1200;
    const h = 400;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<foreignObject width="100%" height="100%">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="font-size:${fontSizePx * 3}px;padding:16px;">${mathml}</div>` +
      `</foreignObject></svg>`;
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0);
    // The raster box dwarfs the math; embedding it whole would shrink
    // the content to a corner — crop to the ink bounds (non-white).
    const data = ctx.getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        // non-white = ink (any channel below ~250; anti-alias edges count).
        if (data[i]! < 250 || data[i + 1]! < 250 || data[i + 2]! < 250) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0 || maxY < 0) return null; // blank raster (a MathML miss)
    const pad = 4;
    const cx0 = Math.max(0, minX - pad);
    const cy0 = Math.max(0, minY - pad);
    const cw = Math.min(w, maxX + 1 + pad) - cx0;
    const ch = Math.min(h, maxY + 1 + pad) - cy0;
    const cropped = document.createElement('canvas');
    cropped.width = cw;
    cropped.height = ch;
    const cctx = cropped.getContext('2d');
    if (!cctx) return null;
    cctx.drawImage(canvas, cx0, cy0, cw, ch, 0, 0, cw, ch);
    const blob: Blob | null = await new Promise((resolve) => cropped.toBlob(resolve, 'image/png'));
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

export async function exportPdf(input: PdfExportInput): Promise<PdfExportResult> {
  const { pages, info, mediaBytes } = input;
  const rasterize = input.rasterizeEquation ?? rasterizeEquationViaMathMl;

  const doc = await PDFDocument.create();
  if (info.Title) doc.setTitle(info.Title);
  if (info.Author) doc.setAuthor(info.Author);
  if (info.Subject) doc.setSubject(info.Subject);
  if (info.Keywords) doc.setKeywords(
    info.Keywords.split(',').map((k) => k.trim()).filter(Boolean),
  );

  const book: WarmableFontBook = await createWarmableFontBook(doc);

  // Warm every (family × bold/italic) the walk uses — embedding is
  // async; the draw is sync off the book.
  const seen = new Set<string>();
  for (const page of pages) {
    for (const el of page.elements) {
      if (el.kind === 'text') {
        const key = `${el.style.fontFamily}|${el.style.bold ? 'b' : ''}${el.style.italic ? 'i' : ''}`;
        if (!seen.has(key)) {
          seen.add(key);
          await book.warm(el.style.fontFamily, el.style.bold === true, el.style.italic === true);
        }
      }
    }
  }

  // The text overlay's fonts ride the same warmup (the overlay is
  // bold; unwarmed families would substitute).
  for (const page of pages) {
    const wm = page.watermark;
    if (wm?.kind === 'text') {
      await book.warm(wm.fontFamily, true, false);
    }
  }

  // Image embedding: sha → PDFImage, deduped (content-addressed ids).
  const imageCache = new Map<string, PDFImage | null>();
  const embedImage = async (sha: string): Promise<PDFImage | null> => {
    const hit = imageCache.get(sha);
    if (hit !== undefined) return hit;
    try {
      const media = mediaBytes(sha);
      if (media) {
        if (media.ext === 'png') {
          const img = await doc.embedPng(media.bytes);
          imageCache.set(sha, img);
          return img;
        }
        if (media.ext === 'jpg' || media.ext === 'jpeg') {
          const img = await doc.embedJpg(media.bytes);
          imageCache.set(sha, img);
          return img;
        }
        // gif/bmp/webp: no PDF embed path (pdf-lib) — null (counted).
      }
    } catch {
      // a corrupt/odd image skips (counted) — never fails the export
    }
    imageCache.set(sha, null);
    return null;
  };

  let skippedImages = 0;
  let fallbackEquations = 0;

  for (const printPage of pages) {
    const W = printPage.width * PT_PER_PX;
    const H = printPage.height * PT_PER_PX;
    const page = doc.addPage([W, H]);

    // #48 — full-page fill under the content (drawn first = painted
    // first); unset = the PDF's own white paper.
    if (printPage.background) {
      const bg = parseColor(printPage.background);
      if (bg) {
        page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(bg.r, bg.g, bg.b) });
      }
    }

    // The watermark: drawn over the paper fill, under every element.
    // pdf-lib rotates about the anchor (baseline origin / image
    // lower-left), so place it so the rotated center lands at
    // page-center; degrees(−θ) converts y-down CSS rotation to y-up.
    const wm = printPage.watermark;
    if (wm?.kind === 'text') {
      const font = book.resolve(wm.fontFamily, true, false);
      if (font) {
        const sizePt = wm.fontSize * PT_PER_PX;
        const textWidthPt = font.widthOfTextAtSize(wm.text, sizePt);
        const textHeightPt = font.heightAtSize(sizePt);
        const theta = (-wm.rotation * Math.PI) / 180;
        const cx = (Math.cos(theta) * textWidthPt) / 2 - (Math.sin(theta) * textHeightPt) / 2;
        const cy = (Math.sin(theta) * textWidthPt) / 2 + (Math.cos(theta) * textHeightPt) / 2;
        const color = parseColor(wm.color) ?? { r: 0.75, g: 0.75, b: 0.75 };
        try {
          page.drawText(wm.text, {
            x: W / 2 - cx,
            y: H / 2 - cy,
            size: sizePt,
            font,
            color: rgb(color.r, color.g, color.b),
            rotate: degrees(-wm.rotation),
            opacity: wm.opacity,
          });
        } catch {
          // WinAnsi fallback fonts reject exotic glyphs — the watermark
          // skips (never fails the export).
        }
      }
    } else if (wm?.kind === 'image') {
      const img = await embedImage(wm.sha);
      if (img) {
        const wPt = wm.width * PT_PER_PX;
        const hPt = wm.height * PT_PER_PX;
        const theta = (-wm.rotation * Math.PI) / 180;
        const cx = (Math.cos(theta) * wPt) / 2 - (Math.sin(theta) * hPt) / 2;
        const cy = (Math.sin(theta) * wPt) / 2 + (Math.cos(theta) * hPt) / 2;
        page.drawImage(img, {
          x: W / 2 - cx,
          y: H / 2 - cy,
          width: wPt,
          height: hPt,
          rotate: degrees(-wm.rotation),
          opacity: wm.opacity,
        });
      }
    }

    for (const el of printPage.elements) {
      switch (el.kind) {
        case 'text': {
          const font = book.resolve(el.style.fontFamily, el.style.bold === true, el.style.italic === true);
          if (!font) continue;
          const color = parseColor(el.color) ?? { r: 0, g: 0, b: 0 };
          try {
            page.drawText(el.text, {
              x: el.x * PT_PER_PX,
              y: H - el.baseline * PT_PER_PX,
              size: el.style.fontSize * PT_PER_PX,
              font,
              color: rgb(color.r, color.g, color.b),
            });
          } catch {
            // WinAnsi fallback fonts reject non-Latin glyphs — such runs
            // skip (the report names the substitution).
          }
          // Decorations (the paint's underline/strike ink).
          if (el.decoration) {
            const decoColor = rgb(color.r, color.g, color.b);
            const sizePt = el.style.fontSize * PT_PER_PX;
            if (el.decoration.includes('underline')) {
              page.drawLine({
                start: { x: el.x * PT_PER_PX, y: H - (el.baseline + 0.08 * el.style.fontSize) * PT_PER_PX },
                end: { x: (el.x + el.width) * PT_PER_PX, y: H - (el.baseline + 0.08 * el.style.fontSize) * PT_PER_PX },
                thickness: Math.max(0.5, sizePt / 16),
                color: decoColor,
              });
            }
            if (el.decoration.includes('line-through')) {
              page.drawLine({
                start: { x: el.x * PT_PER_PX, y: H - (el.baseline - 0.3 * el.style.fontSize) * PT_PER_PX },
                end: { x: (el.x + el.width) * PT_PER_PX, y: H - (el.baseline - 0.3 * el.style.fontSize) * PT_PER_PX },
                thickness: Math.max(0.5, sizePt / 16),
                color: decoColor,
              });
            }
          }
          break;
        }
        case 'highlight':
        case 'rect': {
          const color = parseColor(el.kind === 'highlight' ? el.color : el.fill);
          if (!color) break;
          page.drawRectangle({
            x: el.x * PT_PER_PX,
            y: H - (el.top + el.height) * PT_PER_PX,
            width: el.width * PT_PER_PX,
            height: el.height * PT_PER_PX,
            color: rgb(color.r, color.g, color.b),
            opacity: color.alpha ?? 1,
          });
          break;
        }
        case 'line': {
          const color = parseColor(el.color) ?? { r: 0, g: 0, b: 0 };
          page.drawRectangle({
            x: el.x * PT_PER_PX,
            y: H - (el.top + el.height) * PT_PER_PX,
            width: el.width * PT_PER_PX,
            height: Math.max(0.5, el.height * PT_PER_PX),
            color: rgb(color.r, color.g, color.b),
          });
          break;
        }
        case 'image': {
          const img = el.sha ? await embedImage(el.sha) : null;
          if (!img) {
            skippedImages += 1;
            break;
          }
          page.drawImage(img, {
            x: el.x * PT_PER_PX,
            y: H - (el.top + el.height) * PT_PER_PX,
            width: el.width * PT_PER_PX,
            height: el.height * PT_PER_PX,
          });
          break;
        }
        case 'equation': {
          // MathML → PNG at the placed rect; a null raster falls to
          // the LaTeX source as selectable text.
          const png = el.latex.trim() ? await rasterize(el.latex, el.fontSize) : null;
          if (png) {
            const img = await doc.embedPng(png);
            // Contain-fit: the raster is MathML at 3× CSS px (the rect was
            // measured off KaTeX's HTML render), so natural size in pt =
            // (px/3) × PT_PER_PX — clamped into the placed rect,
            // centered: never squashed, never overflowing.
            const naturalW = (img.width / 3) * PT_PER_PX;
            const naturalH = (img.height / 3) * PT_PER_PX;
            const maxW = el.width * PT_PER_PX;
            const maxH = el.height * PT_PER_PX;
            const scale = Math.min(maxW / naturalW, maxH / naturalH, 1);
            const drawW = naturalW * scale;
            const drawH = naturalH * scale;
            page.drawImage(img, {
              x: el.x * PT_PER_PX + (maxW - drawW) / 2,
              y: H - (el.top + el.height) * PT_PER_PX + (maxH - drawH) / 2,
              width: drawW,
              height: drawH,
            });
          } else {
            // Fallback: the LaTeX source as selectable text (a raster
            // failure is environmental — jsdom).
            fallbackEquations += 1;
            await book.warm('monospace', false, false);
            const font = book.resolve('monospace', false, false);
            const sizePt = el.fontSize * PT_PER_PX;
            if (font) {
              try {
                page.drawText(el.latex, {
                  x: el.x * PT_PER_PX,
                  y: H - (el.top + sizePt) * PT_PER_PX,
                  size: sizePt,
                  font,
                  color: rgb(0.2, 0.2, 0.2),
                  maxWidth: el.width * PT_PER_PX,
                });
              } catch {
                // the exotic-glyph skip (same as the text path)
              }
            }
          }
          break;
        }
      }
    }
  }

  const bytes = await doc.save();
  return {
    bytes,
    substitutedFonts: [...book.substituted],
    skippedImages,
    fallbackEquations,
  };
}

