import { StandardFonts, type PDFFont, type PDFDocument } from 'pdf-lib';
import { decompress } from 'wawoff2';

/**
 * M-PRINT (#39) — THE PDF FONT BOOK. The synthesizer resolves every
 * drawn run's (fontFamily, bold, italic) through this book:
 *
 *  1. BUNDLED families (the @fontsource catalog): the latin woff2
 *     files decode to TTF (wawoff2 — WASM brotli, the same decoder
 *     the format deserves) and EMBED (selectable, searchable text —
 *     #39's core AC). Decode is lazy per family+face and cached per
 *     book; a failed fetch/decode quietly falls to the standard map
 *     (a PDF with substituted glyphs beats no PDF — and tests, whose
 *     jsdom fetch of a ?url path fails, exercise exactly this path).
 *  2. EVERYTHING ELSE (system fonts, 'system-ui', 'monospace',
 *     unknown) → the PDF standard 14: serif→Times, sans→Helvetica,
 *     mono→Courier — universally renderable, no embedding rights
 *     questions (a system font's file is not ours to ship).
 */

/** The bundled latin font files (family → faces). ?url: Vite emits the
 *  asset; the loader fetches it at first use. */
import geistRegular from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url';
import geistItalic from '@fontsource-variable/geist/files/geist-latin-wght-italic.woff2?url';
import openSansRegular from '@fontsource/open-sans/files/open-sans-latin-400-normal.woff2?url';
import openSansBold from '@fontsource/open-sans/files/open-sans-latin-700-normal.woff2?url';
import openSansItalic from '@fontsource/open-sans/files/open-sans-latin-400-italic.woff2?url';
import openSansBoldItalic from '@fontsource/open-sans/files/open-sans-latin-700-italic.woff2?url';
import loraRegular from '@fontsource/lora/files/lora-latin-400-normal.woff2?url';
import loraBold from '@fontsource/lora/files/lora-latin-700-normal.woff2?url';
import loraItalic from '@fontsource/lora/files/lora-latin-400-italic.woff2?url';
import loraBoldItalic from '@fontsource/lora/files/lora-latin-700-italic.woff2?url';
import playfairRegular from '@fontsource/playfair-display/files/playfair-display-latin-400-normal.woff2?url';
import playfairBold from '@fontsource/playfair-display/files/playfair-display-latin-700-normal.woff2?url';
import playfairItalic from '@fontsource/playfair-display/files/playfair-display-latin-400-italic.woff2?url';
import playfairBoldItalic from '@fontsource/playfair-display/files/playfair-display-latin-700-italic.woff2?url';
import jetbrainsRegular from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url';
import jetbrainsBold from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2?url';
import jetbrainsItalic from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-italic.woff2?url';
import jetbrainsBoldItalic from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-italic.woff2?url';
import sourceSerifRegular from '@fontsource/source-serif-4/files/source-serif-4-latin-400-normal.woff2?url';
import sourceSerifBold from '@fontsource/source-serif-4/files/source-serif-4-latin-700-normal.woff2?url';
import sourceSerifItalic from '@fontsource/source-serif-4/files/source-serif-4-latin-400-italic.woff2?url';
import sourceSerifBoldItalic from '@fontsource/source-serif-4/files/source-serif-4-latin-700-italic.woff2?url';
import merriweatherRegular from '@fontsource/merriweather/files/merriweather-latin-400-normal.woff2?url';
import merriweatherBold from '@fontsource/merriweather/files/merriweather-latin-700-normal.woff2?url';
import merriweatherItalic from '@fontsource/merriweather/files/merriweather-latin-400-italic.woff2?url';
import merriweatherBoldItalic from '@fontsource/merriweather/files/merriweather-latin-700-italic.woff2?url';
import firaCodeRegular from '@fontsource/fira-code/files/fira-code-latin-400-normal.woff2?url';
import firaCodeBold from '@fontsource/fira-code/files/fira-code-latin-700-normal.woff2?url';
import nunitoRegular from '@fontsource/nunito/files/nunito-latin-400-normal.woff2?url';
import nunitoBold from '@fontsource/nunito/files/nunito-latin-700-normal.woff2?url';
import nunitoItalic from '@fontsource/nunito/files/nunito-latin-400-italic.woff2?url';
import nunitoBoldItalic from '@fontsource/nunito/files/nunito-latin-700-italic.woff2?url';
import crimsonRegular from '@fontsource/crimson-pro/files/crimson-pro-latin-400-normal.woff2?url';
import crimsonBold from '@fontsource/crimson-pro/files/crimson-pro-latin-700-normal.woff2?url';
import crimsonItalic from '@fontsource/crimson-pro/files/crimson-pro-latin-400-italic.woff2?url';
import crimsonBoldItalic from '@fontsource/crimson-pro/files/crimson-pro-latin-700-italic.woff2?url';
import plexRegular from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2?url';
import plexBold from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-700-normal.woff2?url';
import plexItalic from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-italic.woff2?url';
import plexBoldItalic from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-700-italic.woff2?url';
import manropeRegular from '@fontsource/manrope/files/manrope-latin-400-normal.woff2?url';
import manropeBold from '@fontsource/manrope/files/manrope-latin-700-normal.woff2?url';
import soraRegular from '@fontsource/sora/files/sora-latin-400-normal.woff2?url';
import soraBold from '@fontsource/sora/files/sora-latin-700-normal.woff2?url';

interface FaceUrls {
  regular: string;
  bold?: string;
  italic?: string;
  boldItalic?: string;
}

/** The bundled catalog — keys are the DOCUMENT's fontFamily names
 *  (BUNDLED_FONTS' family spellings; unknown spellings fall through
 *  to the standard map). */
const BUNDLED: Record<string, FaceUrls> = {
  'Geist Variable': { regular: geistRegular, bold: geistRegular, italic: geistItalic, boldItalic: geistItalic },
  'Open Sans': { regular: openSansRegular, bold: openSansBold, italic: openSansItalic, boldItalic: openSansBoldItalic },
  Lora: { regular: loraRegular, bold: loraBold, italic: loraItalic, boldItalic: loraBoldItalic },
  'Playfair Display': { regular: playfairRegular, bold: playfairBold, italic: playfairItalic, boldItalic: playfairBoldItalic },
  'JetBrains Mono': { regular: jetbrainsRegular, bold: jetbrainsBold, italic: jetbrainsItalic, boldItalic: jetbrainsBoldItalic },
  'Source Serif 4': { regular: sourceSerifRegular, bold: sourceSerifBold, italic: sourceSerifItalic, boldItalic: sourceSerifBoldItalic },
  Merriweather: { regular: merriweatherRegular, bold: merriweatherBold, italic: merriweatherItalic, boldItalic: merriweatherBoldItalic },
  'Fira Code': { regular: firaCodeRegular, bold: firaCodeBold },
  Nunito: { regular: nunitoRegular, bold: nunitoBold, italic: nunitoItalic, boldItalic: nunitoBoldItalic },
  'Crimson Pro': { regular: crimsonRegular, bold: crimsonBold, italic: crimsonItalic, boldItalic: crimsonBoldItalic },
  'IBM Plex Sans': { regular: plexRegular, bold: plexBold, italic: plexItalic, boldItalic: plexBoldItalic },
  Manrope: { regular: manropeRegular, bold: manropeBold },
  Sora: { regular: soraRegular, bold: soraBold },
};

export interface PdfFontBook {
  /** Resolve a run's (family, bold, italic) → a PDF font (embedded
   *  bundled or standard-fallback). Synchronous after warmup: the
   *  caller warms every family the document uses first. */
  resolve: (family: string, bold: boolean, italic: boolean) => PDFFont;
}

/** The standard-14 fallback map (serif/sans/mono × bold/italic). */
async function standardFace(
  doc: PDFDocument,
  family: string,
  bold: boolean,
  italic: boolean,
): Promise<PDFFont> {
  const serif = /serif|roman|book|times|georgia|crimson|merriweather|lora|playfair|source/i.test(family);
  const mono = /mono|code|consol|courier/i.test(family);
  const pick = async (r: StandardFonts, b: StandardFonts, i: StandardFonts, bi: StandardFonts) =>
    doc.embedStandardFont(bold && italic ? bi : bold ? b : italic ? i : r);
  if (mono) return pick(StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique);
  if (serif) return pick(StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic);
  return pick(StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique);
}

/** The warmable book the exporter drives: warm(family, bold, italic)
 * for every (family × face) the document's text styles use, then
 * resolve synchronously during the draw. */
export interface WarmableFontBook {
  resolve: (family: string, bold: boolean, italic: boolean) => PDFFont;
  warm: (family: string, bold: boolean, italic: boolean) => Promise<void>;
  /** Every family seen (the report's substitution list). */
  substituted: Set<string>;
}

export async function createWarmableFontBook(doc: PDFDocument): Promise<WarmableFontBook> {
  const embedded = new Map<string, PDFFont>();
  const substituted = new Set<string>();

  const loadFace = async (family: string, bold: boolean, italic: boolean): Promise<PDFFont> => {
    const key = `${family}|${bold ? 'b' : ''}${italic ? 'i' : ''}`;
    const hit = embedded.get(key);
    if (hit) return hit;
    const faces = BUNDLED[family];
    const url = faces
      ? (bold && italic ? faces.boldItalic ?? faces.regular
        : bold ? faces.bold ?? faces.regular
        : italic ? faces.italic ?? faces.regular
        : faces.regular)
      : null;
    let font: PDFFont | null = null;
    if (url) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          const woff2 = new Uint8Array(await res.arrayBuffer());
          const ttf = new Uint8Array(await decompress(woff2));
          font = await doc.embedFont(ttf, { subset: true });
        }
      } catch {
        // fall through to the standard face
      }
    }
    if (!font) substituted.add(family);
    const resolved = font ?? (await standardFace(doc, family, bold, italic));
    embedded.set(key, resolved);
    return resolved;
  };

  return {
    resolve: (family, bold, italic) =>
      embedded.get(`${family}|${bold ? 'b' : ''}${italic ? 'i' : ''}`)!,
    warm: async (family, bold, italic) => {
      await loadFace(family, bold, italic);
    },
    substituted,
  };
}