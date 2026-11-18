import { describe, expect, it } from 'vitest'
import { createLayoutEngine } from '../src/index.js'
import { FakeMetrics } from './fake-metrics.js'
import type { LayoutOptions, SemanticDoc } from '../src/index.js'

const opts: LayoutOptions = {
  page: { width: 816, height: 1056 },
  margins: { top: 96, right: 96, bottom: 96, left: 96 },
}

const round = (result: unknown) =>
  JSON.parse(
    JSON.stringify(result, (_k, v) =>
      typeof v === 'number' ? Math.round(v * 10) / 10 : v,
    ),
  )

describe('golden: single paragraph on a Letter page (FakeMetrics)', () => {
  it('produces one page and one measured line box', () => {
    const doc: SemanticDoc = {
      baseStyle: { fontFamily: 'sans-serif', fontSize: 16 },
      blocks: [
        {
          id: 'p1',
          kind: 'paragraph',
          runs: [
            {
              text: 'Hello, Tensor.',
              style: { fontFamily: 'sans-serif', fontSize: 16 },
            },
          ],
        },
      ],
    }

    const { layout } = createLayoutEngine({ metrics: FakeMetrics })
    const result = layout(doc, opts)
    expect(round(result)).toMatchSnapshot()
  })
})

describe('golden: 10-line fontSize-100 block across two pages (FakeMetrics)', () => {
  it('slices 7 + 3 with one FragmentBreak', () => {
    // "aaaa " × 120 tokens = 10 lines of 12 tokens (600px) each at
    // fontSize 100 → 110px line height → cap 7 on a Letter content box.
    const doc: SemanticDoc = {
      baseStyle: { fontFamily: 'sans-serif', fontSize: 16 },
      blocks: [
        {
          id: 'p1',
          kind: 'paragraph',
          runs: [
            {
              text: 'aaaa '.repeat(120),
              style: { fontFamily: 'sans-serif', fontSize: 100 },
            },
          ],
        },
      ],
    }

    const { layout } = createLayoutEngine({ metrics: FakeMetrics })
    const result = layout(doc, opts)
    expect(round(result)).toMatchSnapshot()
  })
})

describe('golden: bonded heading flagship (FakeMetrics)', () => {
  it('5/7/5: filler strands, keepNext heading moves fresh, paragraph splits', () => {
    // Flagship: filler (5 lines), heading (2 lines, keepNext bonded to
    // the paragraph), paragraph (10 lines) at fontSize 100 (110px
    // lines, cap 7). WITHOUT the bond the heading strands at page 0's
    // bottom; WITH it, the heading's start moves fresh to page 1, the
    // paragraph's first 5 lines follow it, and its last 5 open page 2.
    const doc: SemanticDoc = {
      baseStyle: { fontFamily: 'sans-serif', fontSize: 16 },
      blocks: [
        {
          id: 'filler',
          kind: 'paragraph',
          runs: [{ text: 'aaaa '.repeat(60), style: { fontFamily: 'sans-serif', fontSize: 100 } }],
        },
        {
          id: 'heading',
          kind: 'heading',
          level: 1,
          runs: [{ text: 'aaaa '.repeat(24), style: { fontFamily: 'sans-serif', fontSize: 100 } }],
          flow: { keepNext: true },
        },
        {
          id: 'para',
          kind: 'paragraph',
          runs: [{ text: 'aaaa '.repeat(120), style: { fontFamily: 'sans-serif', fontSize: 100 } }],
        },
      ],
    }

    const { layout } = createLayoutEngine({ metrics: FakeMetrics })
    const result = layout(doc, opts)
    expect(round(result)).toMatchSnapshot()
  })
})

describe('golden: natural-size image + walk flow (FakeMetrics)', () => {
  it('places the intrinsic rect and continues the walk below it', () => {
    // E-IMG-1 spec-of-record pin: the PlacedRect record shape at
    // natural size. 200×100 fits the 624×864 box → placed as-is.
    const doc: SemanticDoc = {
      baseStyle: { fontFamily: 'sans-serif', fontSize: 16 },
      blocks: [
        {
          id: 'img',
          kind: 'image',
          src: 'media://e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          width: 200,
          height: 100,
          alt: 'A small photograph',
        },
        {
          id: 'tail',
          kind: 'paragraph',
          runs: [{ text: 'After the image.', style: { fontFamily: 'sans-serif', fontSize: 16 } }],
        },
      ],
    }

    const { layout } = createLayoutEngine({ metrics: FakeMetrics })
    const result = layout(doc, opts)
    expect(round(result)).toMatchSnapshot()
  })
})

describe('golden: two-column newsletter flagship (FakeMetrics)', () => {
  it('2 columns, gap 24: wrap 300px, slot cap 7, balance on the last page', () => {
    // #74 flagship: filler (5 lines), heading (2 lines, keepNext
    // bonded to the paragraph), paragraph (10 lines) under TWO columns
    // (gap 24 → 300px slots → 6 tokens/line; slot cap 7 at 110px
    // lines). The flow fills col 0, wraps to col 1, wraps the page
    // only when BOTH columns are full; the section's last page (the
    // document's only page) balances to the min-max assignment.
    const doc: SemanticDoc = {
      baseStyle: { fontFamily: 'sans-serif', fontSize: 16 },
      blocks: [
        {
          id: 'filler',
          kind: 'paragraph',
          runs: [{ text: 'aaaa '.repeat(30), style: { fontFamily: 'sans-serif', fontSize: 100 } }],
        },
        {
          id: 'heading',
          kind: 'heading',
          level: 1,
          runs: [{ text: 'aaaa '.repeat(12), style: { fontFamily: 'sans-serif', fontSize: 100 } }],
          flow: { keepNext: true },
        },
        {
          id: 'para',
          kind: 'paragraph',
          runs: [{ text: 'aaaa '.repeat(60), style: { fontFamily: 'sans-serif', fontSize: 100 } }],
        },
      ],
    }

    const { layout } = createLayoutEngine({ metrics: FakeMetrics })
    const result = layout(doc, {
      ...opts,
      columns: { count: 2, gap: 24 },
    })
    expect(round(result)).toMatchSnapshot()
  })
})

describe('golden: fit-down landscape image (FakeMetrics)', () => {
  it('scales to contentWidth preserving aspect; the following block accounts for the scaled height', () => {
    // 1248×300 → scale 0.5 → 624×150: the two numbers every future
    // consumer relies on (placed width == contentWidth, height scaled).
    const doc: SemanticDoc = {
      baseStyle: { fontFamily: 'sans-serif', fontSize: 16 },
      blocks: [
        {
          id: 'img',
          kind: 'image',
          src: 'media://abc123',
          width: 1248,
          height: 300,
          alt: 'A wide landscape',
        },
        {
          id: 'tail',
          kind: 'paragraph',
          runs: [{ text: 'After the wide image.', style: { fontFamily: 'sans-serif', fontSize: 16 } }],
        },
      ],
    }

    const { layout } = createLayoutEngine({ metrics: FakeMetrics })
    const result = layout(doc, opts)
    expect(round(result)).toMatchSnapshot()
  })
})

describe('golden: image keepNext caption bond (FakeMetrics)', () => {
  it('7/1/1: filler fills page 0, the bonded image moves fresh, the caption follows', () => {
    // Filler: 7 lines × 110px = 770. The image (90×90) fits at
    // 770..860, but the caption's first line (17.6) does not → the
    // keepNext bond moves the image fresh to page 1 and the caption
    // follows. Pins the kind-agnostic bond-helper path: the image's
    // "line" is its placed rect.
    const doc: SemanticDoc = {
      baseStyle: { fontFamily: 'sans-serif', fontSize: 16 },
      blocks: [
        {
          id: 'filler',
          kind: 'paragraph',
          runs: [
            { text: 'aaaa '.repeat(84), style: { fontFamily: 'sans-serif', fontSize: 100 } },
          ],
        },
        {
          id: 'img',
          kind: 'image',
          src: 'media://bonded',
          width: 90,
          height: 90,
          alt: 'A bonded figure',
          flow: { keepNext: true },
        },
        {
          id: 'caption',
          kind: 'paragraph',
          runs: [
            { text: 'Figure 1.', style: { fontFamily: 'sans-serif', fontSize: 16 } },
          ],
        },
      ],
    }

    const { layout } = createLayoutEngine({ metrics: FakeMetrics })
    const result = layout(doc, opts)
    expect(round(result)).toMatchSnapshot()
  })
})

describe('golden: reference table — ToC entries with level indents (FakeMetrics)', () => {
  it('per-entry lines, numbers right-aligned at the shared text edge', () => {
    // M-REFS: three entries (level indents 0/32/64); each entry's runs
    // are complete line content — text + tab + page number — so the
    // breaker + the right tab stop right-align every number at the
    // shared text edge (624) whatever its level.
    const entryRun = (text: string, page: string) => [
      { text, style: { fontFamily: 'sans-serif', fontSize: 16 } },
      { text: '\t', style: { fontFamily: 'sans-serif', fontSize: 16 } },
      { text: page, style: { fontFamily: 'sans-serif', fontSize: 16 } },
    ]
    const doc: SemanticDoc = {
      baseStyle: { fontFamily: 'sans-serif', fontSize: 16 },
      blocks: [
        {
          id: 'toc',
          kind: 'referenceTable',
          entries: [
            { runs: entryRun('Introduction', '1') },
            { runs: entryRun('Background', '2'), indentLeft: 32 },
            { runs: entryRun('Method', '5'), indentLeft: 64 },
          ],
        },
      ],
    }

    const { layout } = createLayoutEngine({ metrics: FakeMetrics })
    const result = layout(doc, opts)
    expect(round(result)).toMatchSnapshot()
  })
})
