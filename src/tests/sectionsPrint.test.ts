import { describe, it, expect, vi } from 'vitest';
import { PDFDocument, PDFPage, rgb } from 'pdf-lib';
import { renderPrintDocument } from '@/lib/print/render';
import { exportPdf } from '@/lib/print/pdfExport';
import type { TextMetricsPort } from '@/lib/print/metricsPort';
import type { PrintPage } from '@/lib/print/types';
import { createLayoutEngine, type LayoutOptions } from '@tensor-editor/engine';

/**
 * #58 SECTIONS — the PRINT/PDF sweep (Phase 4): a mixed-geometry
 * document (A4 section 0 + Letter section 1) walks through the SAME
 * engine (one geometry source) and the print renderer + PDF
 * synthesizer consume the PER-PAGE facts. The #34 field ink-shift
 * (the page-number string) resolves per page across the boundary.
 */

/** Deterministic metrics: advance = chars × 8, ascent 12, descent 4. */
const PORT: TextMetricsPort = {
  measure: (t) => t.length * 8,
  ascent: () => 12,
  descent: () => 4,
};

const BASE_STYLE = { fontFamily: 'system-ui', fontSize: 16 };
const A4 = { width: 794, height: 1123 };
const LETTER = { width: 816, height: 1056 };
const MARGINS = { top: 96, right: 96, bottom: 96, left: 96 };

const LAYOUT: LayoutOptions = {
  page: LETTER,
  margins: MARGINS,
  // The A4 section 0 (the −1 boundary) + the Letter final.
  sections: [
    { afterBlock: -1, geometry: { page: A4, margins: MARGINS } },
    { afterBlock: 0, geometry: { page: LETTER, margins: MARGINS } },
  ],
};

interface Run {
  kind?: string;
  text: string;
  style: typeof BASE_STYLE;
  fieldKind?: string;
}

/** The engine block (runs only) AND the renderer's adapter shape
 *  (text/from/to/align/runDecor — the inputBlock pattern). */
function para(id: string, lines: number, field?: 'page' | 'pages'): {
  id: string;
  kind: 'paragraph';
  runs: Run[];
  text: string;
  from: number;
  to: number;
  align: 'left';
  runDecor: Record<string, never>[];
} {
  const text = 'aaaa '.repeat(12 * lines).trim();
  const runs: Run[] = [
    { kind: 'text', text, style: { ...BASE_STYLE }, ...(field ? { fieldKind: field } : {}) },
  ];
  return {
    id,
    kind: 'paragraph',
    runs,
    text,
    from: 0,
    to: text.length,
    align: 'left',
    runDecor: [{}],
  };
}

describe('sections × print — the mixed-geometry walk', () => {
  it('each PrintPage carries ITS section’s dims; ink sits in each page’s own frame', () => {
    const engine = createLayoutEngine({ metrics: PORT });
    // Section 0 (A4): one block. Section 1 (Letter): one block.
    const blocks = [para('a', 1), para('b', 1)];
    const result = engine.layout(
      {
        baseStyle: BASE_STYLE,
        blocks: blocks.map((b) => ({
          ...b,
          runs: b.runs.map((r) => ({ kind: 'text', text: r.text, style: r.style })),
        })) as never,
      },
      LAYOUT,
    );
    // The boundary forced two pages (each block is one short line).
    expect(result.pages.length).toBe(2);
    const pages = renderPrintDocument({
      result,
      blocks: blocks as never,
      metrics: PORT,
      bitmapSrc: () => undefined,
      fieldTotal: 2,
    });
    // Page 0: A4. Page 1: Letter — the PDF takes mixed sizes natively.
    expect(pages[0]!.width).toBe(A4.width);
    expect(pages[0]!.height).toBe(A4.height);
    expect(pages[1]!.width).toBe(LETTER.width);
    expect(pages[1]!.height).toBe(LETTER.height);
    // Each page's ink sits in ITS OWN content frame (the cb.x/y of the
    // page's section — identical margins here, so the frames agree;
    // the widths differ).
    for (const p of pages) {
      const texts = p.elements.filter((e) => e.kind === 'text');
      expect(texts.length).toBeGreaterThan(0);
      for (const t of texts) {
        if (t.kind !== 'text') continue;
        expect(t.x).toBeGreaterThanOrEqual(0);
        expect(t.x).toBeLessThan(p.width);
      }
    }
  });

  it('the #34 page field resolves per page across the boundary (the band echo path)', () => {
    const engine = createLayoutEngine({ metrics: PORT });
    // The FIELD lives in the FOOTER band (the #34 spelling — band
    // lines echo on every page and the field resolves per pageIndex).
    // Section 0: the tall block spans TWO A4 pages; the boundary opens
    // section 1 for the body block. Total 3 pages.
    const bodyText = 'aaaa '.repeat(12 * 80).trim();
    const fieldRuns: Run[] = [
      { kind: 'text', text: 'Page ', style: { ...BASE_STYLE } },
      { kind: 'text', text: '1', style: { ...BASE_STYLE }, fieldKind: 'page' },
      { kind: 'text', text: ' of ', style: { ...BASE_STYLE } },
      { kind: 'text', text: '1', style: { ...BASE_STYLE }, fieldKind: 'pages' },
    ];
    const fieldText = fieldRuns.map((r) => r.text).join('');
    const footerBlock = {
      id: 'f1',
      kind: 'paragraph' as const,
      runs: fieldRuns,
    };
    const result = engine.layout(
      {
        baseStyle: BASE_STYLE,
        blocks: [
          { id: 'a', kind: 'paragraph', runs: [{ kind: 'text', text: bodyText, style: { ...BASE_STYLE } }] },
          { id: 'b', kind: 'paragraph', runs: [{ kind: 'text', text: 'section one body', style: { ...BASE_STYLE } }] },
        ],
        bands: { footer: [footerBlock as never] },
      } as never,
      {
        page: LETTER,
        margins: MARGINS,
        sections: [
          { afterBlock: -1, geometry: { page: A4, margins: MARGINS } },
          { afterBlock: 0, geometry: { page: LETTER, margins: MARGINS } },
        ],
      },
    );
    const total = result.pages.length;
    expect(total).toBe(3);
    const blocks = [
      { id: 'a', kind: 'paragraph', runs: [{ kind: 'text', text: bodyText, style: { ...BASE_STYLE } }], text: bodyText, from: 0, to: bodyText.length, align: 'left' as const, runDecor: [{}] },
      { id: 'b', kind: 'paragraph', runs: [{ kind: 'text', text: 'section one body', style: { ...BASE_STYLE } }], text: 'section one body', from: 0, to: 16, align: 'left' as const, runDecor: [{}] },
      { id: 'f1', kind: 'paragraph', runs: fieldRuns, text: fieldText, from: 0, to: fieldText.length, align: 'left' as const, runDecor: [{}, {}, {}, {}] },
    ];
    const pages = renderPrintDocument({
      result,
      blocks: blocks as never,
      metrics: PORT,
      bitmapSrc: () => undefined,
      fieldTotal: total,
    });
    // EVERY page's footer carries ITS resolved page number — the
    // section swap never disturbs the field machinery (the ink-shift
    // placeholder was measured at the band's wrap width per section).
    pages.forEach((p, i) => {
      const all = p.elements
        .filter((e) => e.kind === 'text')
        .map((e) => (e as { text: string }).text)
        .join('');
      expect(all).toContain(`Page ${i + 1} of ${total}`);
    });
  });
});

describe('sections × pdf — mixed page sizes synthesize natively', () => {
  it('each PDF page takes its PrintPage’s size (A4 + Letter in one file)', async () => {
    const mk = (w: number, h: number, label: string): PrintPage => ({
      index: 0,
      width: w,
      height: h,
      elements: [
        {
          kind: 'text',
          x: 96,
          top: 96,
          baseline: 110,
          width: 40,
          text: label,
          style: { fontFamily: 'system-ui', fontSize: 16 },
          color: '#000',
          decoration: '',
        },
      ],
    });
    const result = await exportPdf({
      pages: [
        { ...mk(A4.width, A4.height, 'a4'), index: 0 },
        { ...mk(LETTER.width, LETTER.height, 'letter'), index: 1 },
      ],
      info: {},
      mediaBytes: () => undefined,
      rasterizeEquation: async () => null,
    });
    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getPageCount()).toBe(2);
    // A4: 794×1123 px → 595.5×842.25 pt (the 0.75 factor).
    const s0 = doc.getPage(0).getSize();
    expect(Math.round(s0.width)).toBe(Math.round(A4.width * 0.75));
    expect(Math.round(s0.height)).toBe(Math.round(A4.height * 0.75));
    const s1 = doc.getPage(1).getSize();
    expect(Math.round(s1.width)).toBe(Math.round(LETTER.width * 0.75));
    expect(Math.round(s1.height)).toBe(Math.round(LETTER.height * 0.75));
  });
});

// ─── #48 — page backgrounds through the PDF ──────────────────────────────

describe('#48 — page backgrounds through print + PDF', () => {
  it('a PrintPage background becomes a full-page PDF fill UNDER the content (drawn first)', async () => {
    const spy = vi.spyOn(PDFPage.prototype, 'drawRectangle');
    const pages: PrintPage[] = [
      { index: 0, width: LETTER.width, height: LETTER.height, background: '#b91c1c', elements: [] },
      { index: 1, width: LETTER.width, height: LETTER.height, elements: [] },
    ];
    const result = await exportPdf({ pages, info: {}, mediaBytes: () => undefined });
    // ONE fill — on the backgrounded page only, full-page sized.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        x: 0,
        y: 0,
        width: LETTER.width * 0.75,
        height: LETTER.height * 0.75,
        color: rgb(185 / 255, 28 / 255, 28 / 255),
      }),
    );
    spy.mockRestore();
    expect(result.bytes.length).toBeGreaterThan(0);
  });

  it('an unparseable background skips (never a guess, never a failed export)', async () => {
    const spy = vi.spyOn(PDFPage.prototype, 'drawRectangle');
    const pages: PrintPage[] = [
      { index: 0, width: LETTER.width, height: LETTER.height, background: 'var(--paper)', elements: [] },
    ];
    await exportPdf({ pages, info: {}, mediaBytes: () => undefined });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
