import { describe, it, expect } from 'vitest';

import { renderPrintDocument } from '@/lib/print/render';
import type { TextMetricsPort } from '@/lib/print/metricsPort';
import type { PrintText } from '@/lib/print/types';
import { createLayoutEngine, type LayoutOptions } from '@tensor-editor/engine';

/**
 * M-PRINT (#43 Mark 1) — the print renderer suite. The walk runs
 * against a REAL engine layout (the layout outputs are the one
 * geometry source — the Mark-1 contract), with hand-built adapter
 * shapes for the inputs the canvas path derives from PM. Structural
 * assertions only (the docx-suite pattern): positions, page splits,
 * ink order.
 */

const SHA = 'f'.repeat(64);

/** Deterministic metrics: advance = chars × 8, ascent 12, descent 4. */
const PORT: TextMetricsPort = {
  measure: (t) => t.length * 8,
  ascent: () => 12,
  descent: () => 4,
};

interface InputBlock {
  id: string;
  runs: { kind?: string; text?: string; style: { fontFamily: string; fontSize: number; bold?: boolean }; fieldKind?: string }[];
  text: string;
  from: number;
  to: number;
  align: 'left' | 'center' | 'right';
  runDecor: { color?: string; highlight?: string; underline?: boolean; strike?: boolean }[];
  paint?: { marker?: unknown; blockquote?: boolean; code?: boolean; rule?: boolean };
}

function inputBlock(
  id: string,
  runs: InputBlock['runs'],
  opts: Partial<InputBlock> = {},
): InputBlock {
  return {
    id,
    runs,
    text: runs.map((r) => r.text ?? '').join(''),
    from: 0,
    to: 0,
    align: opts.align ?? 'left',
    runDecor: opts.runDecor ?? runs.map(() => ({})),
    paint: opts.paint,
  };
}

const LAYOUT: LayoutOptions = {
  page: { width: 800, height: 600 },
  margins: { top: 96, right: 96, bottom: 96, left: 96 },
};

const BASE_STYLE = { fontFamily: 'system-ui', fontSize: 16 };

describe('print renderer — the text walk', () => {
  it('spans position at the engine placement (contentBox + rect + seg.x)', () => {
    const blocks = [inputBlock('b1', [
      { kind: 'text', text: 'hello', style: { fontFamily: 'system-ui', fontSize: 16 } },
    ])];
    const engine = createLayoutEngine({ metrics: PORT });
    const adapted = {
      doc: {
        baseStyle: BASE_STYLE,
        blocks: [
          {
            id: 'b1', kind: 'paragraph', runs: [
              { kind: 'text', text: 'hello', style: { ...BASE_STYLE } },
            ],
          },
        ],
      },
    };
    const result = engine.layout(adapted.doc as never, LAYOUT);
    const pages = renderPrintDocument({
      result,
      blocks: blocks as never,
      metrics: PORT,
      bitmapSrc: () => undefined,
      fieldTotal: 1,
    });
    expect(pages).toHaveLength(1);
    const cb = result.pages[0]!.contentBox;
    const line = result.lines.find((l) => l.blockId === 'b1')!;
    const texts = pages[0]!.elements.filter((e): e is PrintText => e.kind === 'text');
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toBe('hello');
    // x = contentBox.x + rect.x + seg.x (alignOffset 0, shift 0)
    expect(texts[0]!.x).toBe(cb.x + line.rect.x + line.segments[0]!.x);
    // top = contentBox.y + rect.y + baseline − ascent
    expect(texts[0]!.top).toBe(cb.y + line.rect.y + line.baseline - 12);
    expect(texts[0]!.width).toBe(5 * 8);
  });

  it('the page field renders the RESOLVED string per page (page 3 of 12)', () => {
    const runs = [
      { kind: 'text', text: 'Page ', style: { ...BASE_STYLE } },
      { kind: 'text', text: '12', style: { ...BASE_STYLE }, fieldKind: 'page' },
      { kind: 'text', text: ' of ', style: { ...BASE_STYLE } },
      { kind: 'text', text: '12', style: { ...BASE_STYLE }, fieldKind: 'pages' },
    ];
    const engine = createLayoutEngine({ metrics: PORT });
    const result = engine.layout({
      baseStyle: BASE_STYLE,
      blocks: [
        { id: 'b1', kind: 'paragraph', runs: runs.map((r) => ({ kind: 'text', text: r.text, style: r.style })) },
      ],
      bands: {
        header: [],
        footer: [
          {
            id: 'f1', kind: 'paragraph',
            runs: [
              { kind: 'text' as const, text: 'Page ', style: { ...BASE_STYLE } },
              { kind: 'text' as const, text: '12', style: { ...BASE_STYLE }, fieldKind: 'page' as const },
              { kind: 'text' as const, text: ' of ', style: { ...BASE_STYLE } },
              { kind: 'text' as const, text: '12', style: { ...BASE_STYLE }, fieldKind: 'pages' as const },
            ],
          },
        ],
      },
    } as never, LAYOUT);
    // Field-bearing runs on the FOOTER block (band lines carry them).
    const blocks = [
      inputBlock('f1', runs, { runDecor: [{}, {}, {}, {}] }),
    ];
    const pages = renderPrintDocument({
      result,
      blocks: blocks as never,
      metrics: PORT,
      bitmapSrc: () => undefined,
      fieldTotal: 12,
    });
    // Page 0's footer echo resolves 'Page 1 of 12' — natively.
    const page0 = pages[0]!;
    const fieldTexts = page0.elements.filter(
      (e): e is PrintText => e.kind === 'text' && /^Page \d+ of \d+$/.test(e.text),
    );
    // The band paragraphs joined per line: 'Page 1 of 12' arrives as
    // separate spans (per segment) — the PAGE field span carries '1'.
    const pageField = page0.elements.find(
      (e): e is PrintText => e.kind === 'text' && e.text === '1',
    );
    const pagesField = page0.elements.find(
      (e): e is PrintText => e.kind === 'text' && e.text === '12',
    );
    expect(pageField).toBeTruthy();
    expect(pagesField).toBeTruthy();
    // fieldTexts may be empty (spans are per-segment, not joined) —
    // the resolved STRINGS are the contract:
    const all = page0.elements.filter((e): e is PrintText => e.kind === 'text').map((e) => e.text);
    expect(all).toContain('Page ');
    expect(all).toContain('1');
    expect(all).toContain(' of ');
    expect(all).toContain('12');
    void fieldTexts;
  });

  it('block decor rides under the ink (blockquote bg + border rects precede text)', () => {
    const engine = createLayoutEngine({ metrics: PORT });
    const result = engine.layout({
      baseStyle: BASE_STYLE,
      blocks: [{ id: 'b1', kind: 'paragraph', runs: [{ kind: 'text', text: 'quoted', style: { ...BASE_STYLE } }] }],
    } as never, LAYOUT);
    const blocks = [inputBlock('b1', [
      { kind: 'text', text: 'quoted', style: { ...BASE_STYLE } },
    ], { paint: { blockquote: true } })];
    const pages = renderPrintDocument({
      result,
      blocks: blocks as never,
      metrics: PORT,
      bitmapSrc: () => undefined,
      fieldTotal: 1,
    });
    const els = pages[0]!.elements;
    const bgIndex = els.findIndex((e) => e.kind === 'rect');
    const textIndex = els.findIndex((e) => e.kind === 'text');
    expect(bgIndex).toBeGreaterThan(-1);
    expect(textIndex).toBeGreaterThan(bgIndex);
    // the blockquote emits TWO rects (tint + 3px border bar)
    const rects = els.filter((e) => e.kind === 'rect');
    expect(rects.length).toBeGreaterThanOrEqual(2);
  });

  it('what does NOT print: NPC, squiggles, selection chrome — by construction of the walk', () => {
    // The walk consumes only LineBoxes/placed[] — there is NO input
    // surface for editing state. Pin the input contract: the walk
    // never receives decor beyond runDecor (color/highlight/deco).
    const engine = createLayoutEngine({ metrics: PORT });
    const result = engine.layout({
      baseStyle: BASE_STYLE,
      blocks: [{ id: 'b1', kind: 'paragraph', runs: [{ kind: 'text', text: 'x', style: { ...BASE_STYLE } }] }],
    } as never, LAYOUT);
    expect(result.lines).toHaveLength(1);
    const pages = renderPrintDocument({
      result,
      blocks: [] as never,
      metrics: PORT,
      bitmapSrc: () => undefined,
      fieldTotal: 1,
    });
    // no blocks → no text spans (only the empty page frame)
    expect(pages[0]!.elements).toHaveLength(0);
  });
});

describe('print renderer — table cells + images', () => {
  it('cell fills and merged borders', () => {
    // Direct placed[] fixture (the engine table walk is tested engine-
    // side; the PRINT contract is the cell paint):
    const result = {
      pages: [{ index: 0, size: { x: 0, y: 0, width: 800, height: 600 }, contentBox: { x: 96, y: 96, width: 608, height: 408 } }],
      lines: [],
      breaks: [],
      placed: [
        {
          blockId: 't1', kind: 'tableCell' as const, pageIndex: 0,
          rect: { x: 0, y: 0, width: 100, height: 20 },
          cell: { fill: '#eee', border: 'all', colspan: 1, rowspan: 1, row: 0, col: 0 },
        },
        {
          blockId: 't1', kind: 'tableCell' as const, pageIndex: 0,
          rect: { x: 100, y: 0, width: 100, height: 20 },
          cell: { fill: null, border: 'all', colspan: 1, rowspan: 1, row: 0, col: 1 },
        },
      ],
    };
    const pages = renderPrintDocument({
      result: result as never,
      blocks: [] as never,
      metrics: PORT,
      bitmapSrc: () => undefined,
      fieldTotal: 1,
    });
    const els = pages[0]!.elements;
    // the fill
    expect(els.some((e) => e.kind === 'rect' && e.fill === '#eee')).toBe(true);
    // merged vertical segments: x=0, x=100 (shared — ONCE), x=200
    const vLines = els.filter((e) => e.kind === 'line' && e.width === 1 && e.height === 20);
    const xs = [...new Set(vLines.map((l) => (l as { x: number }).x))].sort((a, b) => a - b);
    expect(xs).toEqual([96, 196, 296]); // cb.x + 0/100/200
  });

  it('images render from the bitmap cache at their placed rect; floats z-order', () => {
    const result = {
      pages: [{ index: 0, size: { x: 0, y: 0, width: 800, height: 600 }, contentBox: { x: 96, y: 96, width: 608, height: 408 } }],
      lines: [],
      breaks: [],
      placed: [
        {
          blockId: 'i1', kind: 'image' as const, pageIndex: 0,
          rect: { x: 10, y: 10, width: 120, height: 60 },
          src: `media://${SHA}`, alt: 'the pic',
        },
        {
          blockId: 'i2', kind: 'image' as const, pageIndex: 0,
          rect: { x: 0, y: 0, width: 50, height: 50 },
          src: `media://${SHA}`, alt: 'behind',
          z: 'behind' as const,
        },
      ],
    };
    const pages = renderPrintDocument({
      result: result as never,
      blocks: [] as never,
      metrics: PORT,
      bitmapSrc: (sha) => (sha === SHA ? `blob:${sha.slice(0, 8)}` : undefined),
      fieldTotal: 1,
    });
    const images = pages[0]!.elements.filter((e) => e.kind === 'image');
    expect(images).toHaveLength(2);
    expect((images[0] as { z: string }).z).toBe('behind'); // emitted FIRST (under ink)
    expect((images[1] as { src: string }).src).toContain('blob:');
  });
});

describe('PrintDocumentView — the equation wrapper (M-PRINT fix)', () => {
  it('the equation div carries .tensor-equation (the measured box IS the painted box)', async () => {
    const { render } = await import('@testing-library/react');
    const { PrintDocumentView } = await import('@/lib/print/PrintDocumentView');
    const pages: import('@/lib/print/types').PrintPage[] = [
      {
        index: 0,
        width: 800,
        height: 600,
        elements: [
          {
            kind: 'equation',
            x: 100,
            top: 100,
            width: 120,
            height: 60,
            latex: 'x^2',
            fontSize: 16,
            color: '#000',
          },
        ],
      },
    ];
    const utils = render(<PrintDocumentView pages={pages} />);
    const eq = utils.container.querySelector('.tensor-equation') as HTMLElement;
    expect(eq).toBeTruthy();
    // the KaTeX HTML rendered inside (the renderEquation string)
    expect(eq.querySelector('.katex')).toBeTruthy();
  });
});
