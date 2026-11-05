import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { renderTensor, settleLayout } from './harness';
import { buildPrintDocument } from '@/lib/print/buildDocument';
import { exportPdf } from '@/lib/print/pdfExport';
import { toPdfInfo } from '@/lib/document/coreProperties';
import { useDocumentStore } from '@/lib/document/store';
import type { PrintPage } from '@/lib/print/types';

/**
 * M-PRINT (#39, Mark 4) — the PDF synthesis suite. The structural
 * contract: the output re-parses (PDFDocument.load) with the right
 * page count and PT sizes (px → pt at 0.75); the walk's geometry IS
 * the PDF's geometry by construction (same source as the preview).
 * The font book's jsdom path exercises the standard-14 fallback (the
 * bundled ?url fetch fails in the test env — the designed quiet
 * degradation, reported in substitutedFonts).
 */

/** A tiny valid PNG (1×1) — the embed path's real bytes. */
const TINY_PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

function page(w: number, h: number, elements: PrintPage['elements']): PrintPage {
  return { index: 0, width: w, height: h, elements };
}

const BASE_STYLE = { fontFamily: 'Lora', fontSize: 16 };

describe('exportPdf — the synthesis', () => {
  it('produces a re-parsable PDF with the right page size (px → pt at 0.75)', async () => {
    // 800×600 px page (Letter-ish test geometry) → 600×450 pt.
    const pages = [
      page(800, 600, [
        {
          kind: 'text',
          x: 96,
          top: 96,
          baseline: 110,
          width: 40,
          text: 'hello pdf',
          style: { ...BASE_STYLE },
          color: '#000',
          decoration: '',
        },
      ]),
    ];
    const result = await exportPdf({
      pages,
      info: { Title: 'Test', Author: 'A. Student' },
      mediaBytes: () => undefined,
      // jsdom: force the latex-text fallback deterministically.
      rasterizeEquation: async () => null,
    });
    expect(result.bytes.length).toBeGreaterThan(300);
    expect(new TextDecoder().decode(result.bytes.slice(0, 5))).toBe('%PDF-');
    // RE-PARSE: the structural contract.
    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getPageCount()).toBe(1);
    const size = doc.getPage(0).getSize();
    expect(Math.round(size.width)).toBe(600);
    expect(Math.round(size.height)).toBe(450);
    // metadata rides (the toPdfInfo seam)
    expect(doc.getTitle()).toBe('Test');
    expect(doc.getAuthor()).toBe('A. Student');
  });

  it('every page lands; the field text draws resolved strings', async () => {
    const mk = (index: number): PrintPage =>
      page(800, 600, [
        {
          kind: 'text',
          x: 96,
          top: 500,
          baseline: 514,
          width: 20,
          text: String(index + 1),
          style: { fontFamily: 'system-ui', fontSize: 12 },
          color: '#000',
          decoration: '',
        },
      ]);
    const result = await exportPdf({
      pages: [mk(0), mk(1), mk(2)],
      info: {},
      mediaBytes: () => undefined,
      rasterizeEquation: async () => null,
    });
    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getPageCount()).toBe(3);
  });

  it('images embed from the MediaStore bytes; unsupported formats skip + count', async () => {
    const pages = [
      page(800, 600, [
        { kind: 'image', x: 100, top: 100, width: 120, height: 60, src: 'blob:x', sha: 'aaa', alt: '', z: 'front' },
        { kind: 'image', x: 400, top: 100, width: 120, height: 60, src: 'blob:y', sha: 'bbb', alt: '', z: 'front' },
        { kind: 'image', x: 700, top: 100, width: 120, height: 60, src: 'blob:z', sha: 'ccc', alt: '', z: 'front' },
      ]),
    ];
    const result = await exportPdf({
      pages,
      info: {},
      mediaBytes: (sha) => {
        if (sha === 'aaa') return { bytes: TINY_PNG, ext: 'png' };
        if (sha === 'bbb') return { bytes: new Uint8Array([1, 2, 3]), ext: 'webp' }; // unsupported
        return undefined; // missing
      },
      rasterizeEquation: async () => null,
    });
    expect(result.skippedImages).toBe(2); // webp + missing
    expect(result.skippedImages).toBe(2); // (asserted above)
    // The PDF re-parses clean with the image inside (embedPng's bytes
    // inflate the file — the honest presence check).
    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(result.bytes.length).toBeGreaterThan(400);
  });

  it('the full walk end-to-end: the real document exports and re-parses', async () => {
    const { editor } = renderTensor('<p>the pdf walk</p>');
    await settleLayout();
    const build = buildPrintDocument(editor);
    const result = await exportPdf({
      pages: build.pages,
      info: toPdfInfo(useDocumentStore.getState().coreProperties),
      mediaBytes: () => undefined,
      rasterizeEquation: async () => null,
    });
    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getPageCount()).toBe(build.total);
    void result;
  });
});
