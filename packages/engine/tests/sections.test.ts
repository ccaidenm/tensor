import { describe, expect, it } from 'vitest'
import { createLayoutEngine } from '../src/index.js'
import { FakeMetrics } from './fake-metrics.js'
import type { Block, LayoutOptions, SectionBoundary, SemanticDoc, TextStyle } from '../src/index.js'

// #58 SECTIONS — the per-section geometry table. FakeMetrics at
// fontSize 100 → 110px lines; Letter contentBox 624×864 → cap = 7
// lines/page; 12 "aaaa " tokens (600px) per line.
const style100: TextStyle = { fontFamily: 'sans-serif', fontSize: 100 }
const baseStyle: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }
const LETTER = { width: 816, height: 1056 }
const MARGINS = { top: 96, right: 96, bottom: 96, left: 96 }
const A4 = { width: 794, height: 1123 }

const opts: LayoutOptions = { page: LETTER, margins: MARGINS }

const tokens = (lines: number) => 'aaaa '.repeat(12 * lines)

function para(id: string, lines: number): Block {
  return { id, kind: 'paragraph', runs: [{ text: tokens(lines), style: style100 }] }
}

/** Two sections: blocks 0..k-1 in section 0 (geometry A), blocks
 * k.. in section 1 (geometry B). Boundary at afterBlock k-1. */
function twoSections(
  a: { page: { width: number; height: number }; margins?: typeof MARGINS },
  b: { page: { width: number; height: number }; margins?: typeof MARGINS },
  k: number,
): SectionBoundary[] {
  return [
    { afterBlock: -1, geometry: { page: a.page, margins: a.margins ?? MARGINS } },
    { afterBlock: k - 1, geometry: { page: b.page, margins: b.margins ?? MARGINS } },
  ]
}

describe('sections: the per-section geometry table', () => {
  it('no sections option → uniform pages, every page section 0 (the additive law)', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const result = engine.layout(
      { baseStyle, blocks: [para('a', 8), para('b', 8)] },
      opts,
    )
    expect(result.pages.length).toBeGreaterThanOrEqual(3)
    for (const page of result.pages) {
      expect(page.sectionIndex).toBe(0)
      expect(page.size).toMatchObject({ width: 816, height: 1056 })
    }
  })

  it('a boundary forces a new page and swaps the geometry (mixed page sizes)', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    // Section 0: A4; section 1: Letter. 2 lines fit A4's section-0
    // page, then the boundary forces the break EVEN THOUGH the A4
    // page has room (1123 − 96×2 = 931 → 8 lines would fit).
    const result = engine.layout(
      { baseStyle, blocks: [para('a', 1), para('b', 1), para('c', 1)] },
      {
        ...opts,
        sections: twoSections({ page: A4 }, { page: LETTER }, 2),
      },
    )
    // Section 0's page(s): A4. Section 1's: Letter.
    expect(result.pages[0]!.size).toMatchObject({ width: 794, height: 1123 })
    expect(result.pages[0]!.sectionIndex).toBe(0)
    const letterPage = result.pages.find((p) => p.sectionIndex === 1)!
    expect(letterPage).toBeTruthy()
    expect(letterPage.size).toMatchObject({ width: 816, height: 1056 })
    // The boundary forced the break: 'c' (section 1) does not share
    // page 0 with 'a'/'b'.
    const cPage = result.lines.find((l) => l.blockId === 'c')!.pageIndex
    const bPage = result.lines.find((l) => l.blockId === 'b')!.pageIndex
    expect(cPage).toBeGreaterThan(bPage)
  })

  it('section 0’s geometry comes from the −1 boundary, NOT the opts defaults', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const result = engine.layout(
      { baseStyle, blocks: [para('a', 1)] },
      {
        ...opts, // defaults = Letter
        sections: twoSections({ page: A4 }, { page: A4 }, 0),
      },
    )
    // Wait — boundary 1 at afterBlock -1?? k=0 → afterBlock -1 for
    // BOTH boundaries: section 1 is empty (starts where section 0
    // starts). The engine applies both; section 0's geometry (A4)
    // governs the page.
    expect(result.pages[0]!.size).toMatchObject({ width: 794, height: 1123 })
  })

  it('the LAST section (after the final boundary) uses the opts defaults', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const result = engine.layout(
      { baseStyle, blocks: [para('a', 1), para('b', 1)] },
      {
        ...opts, // defaults Letter
        sections: [
          // Section 0 = A4 (both blocks)… boundary 1 at afterBlock 0
          // starts section 1 = the implicit defaults (Letter).
          { afterBlock: -1, geometry: { page: A4, margins: MARGINS } },
          { afterBlock: 0, geometry: { page: LETTER, margins: MARGINS } },
        ],
      },
    )
    // Section 0 = A4; section 1 = the appended defaults (Letter).
    expect(result.pages[0]!.size).toMatchObject({ width: 794, height: 1123 })
    const letter = result.pages.find((p) => p.sectionIndex === 1)
    expect(letter?.size).toMatchObject({ width: 816, height: 1056 })
  })

  it('per-section margins drive the contentBox (band-free)', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const wide = { page: LETTER, margins: { top: 96, right: 96, bottom: 96, left: 96 } }
    const narrow = { page: LETTER, margins: { top: 96, right: 250, bottom: 96, left: 250 } }
    const result = engine.layout(
      { baseStyle, blocks: [para('a', 1), para('b', 1)] },
      { ...opts, sections: twoSections(wide, narrow, 1) },
    )
    expect(result.pages[0]!.contentBox.width).toBe(624)
    const second = result.pages.find((p) => p.sectionIndex === 1)!
    expect(second.contentBox.width).toBe(816 - 250 - 250)
  })

  it('consecutive boundaries (an empty middle section) hold no pages', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const result = engine.layout(
      { baseStyle, blocks: [para('a', 1), para('b', 1)] },
      {
        ...opts,
        sections: [
          { afterBlock: -1, geometry: { page: LETTER, margins: MARGINS } },
          // An empty section between (starts at block 1, ends at
          // block 1 — the next boundary ALSO starts at block 1).
          { afterBlock: 0, geometry: { page: A4, margins: MARGINS } },
          { afterBlock: 0, geometry: { page: LETTER, margins: MARGINS } },
        ],
      },
    )
    // The A4 section owns no page: pages are Letter-only.
    for (const page of result.pages) {
      expect(page.size).toMatchObject({ width: 816, height: 1056 })
    }
  })

  it('bands emit in EACH section’s own margins (per-page anchor offsets)', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const headerBlock: Block = {
      id: 'band-h',
      kind: 'paragraph',
      runs: [{ text: tokens(1), style: style100 }],
    }
    // Letter with a TALL top margin in section 1 — the header band's
    // y offset differs per section.
    const result = engine.layout(
      {
        baseStyle,
        blocks: [para('a', 1), para('b', 1)],
        bands: { header: [headerBlock] },
      },
      {
        ...opts,
        sections: twoSections(
          { page: LETTER, margins: { top: 96, right: 96, bottom: 96, left: 96 } },
          { page: LETTER, margins: { top: 300, right: 96, bottom: 96, left: 96 } },
          1,
        ),
      },
    )
    const headerLines = result.lines.filter((l) => l.blockId === 'band-h')
    // One echo per page; page 0 (section 0, top margin 96): the
    // anchor clamps to 48… anchorPx 48 < 96 → anchor 48. contentBox.y
    // = max(96, 48 + 110) = 158. rect.y = 48 − 158 = −110.
    expect(headerLines[0]!.rect.y).toBeCloseTo(48 - 158)
    // Section 1's page (top margin 300): contentBox.y =
    // max(300, 48+110) = 300. rect.y = 48 − 300 = −252.
    const sec1Header = headerLines.find(
      (l) => result.pages[l.pageIndex]!.sectionIndex === 1,
    )!
    expect(sec1Header.rect.y).toBeCloseTo(48 - 300)
  })

  it('the cache: an identical re-layout reuses; a sections change invalidates and re-walks', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const doc: SemanticDoc = { baseStyle, blocks: [para('a', 2), para('b', 2)] }
    const sections = twoSections({ page: LETTER }, { page: A4 }, 1)
    const first = engine.layout(doc, { ...opts, sections })
    const second = engine.layout(doc, { ...opts, sections })
    expect(second.version).toBe(first.version)
    expect(engine.lastStats.blocksWalked).toBe(0)
    // Swap section 1's page size → context change → full re-walk,
    // and the NEW geometry governs.
    const sections2 = twoSections({ page: LETTER }, { page: { width: 595, height: 842 } }, 1)
    const third = engine.layout(doc, { ...opts, sections: sections2 })
    expect(engine.lastStats.blocksWalked).toBeGreaterThan(0)
    const a5Page = third.pages.find((p) => p.sectionIndex === 1)!
    expect(a5Page.size).toMatchObject({ width: 595, height: 842 })
  })
})
describe('sections: per-section band overrides (link-to-previous resolution)', () => {
  const docHeader: Block = {
    id: 'band-doc',
    kind: 'paragraph',
    runs: [{ text: 'DOC-HEADER ', style: style100 }],
  }
  const secHeader: Block = {
    id: 'band-sec1',
    kind: 'paragraph',
    runs: [{ text: 'SEC1-HEADER ', style: style100 }],
  }

  it('a section with an override paints ITS band; others inherit the doc default', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const result = engine.layout(
      {
        baseStyle,
        blocks: [para('a', 1), para('b', 1)],
        bands: {
          header: [docHeader],
          perSection: [{ section: 1, header: [secHeader] }],
        },
      },
      { ...opts, sections: twoSections({ page: LETTER }, { page: LETTER }, 1) },
    )
    // Page 0 (section 0): the doc default echo. Section 1's page: the
    // override echo.
    expect(result.lines.some((l) => l.blockId === 'band-doc' && l.pageIndex === 0)).toBe(true)
    const sec1Page = result.pages.find((p) => p.sectionIndex === 1)!.index
    expect(result.lines.some((l) => l.blockId === 'band-sec1' && l.pageIndex === sec1Page)).toBe(true)
    expect(result.lines.some((l) => l.blockId === 'band-doc' && l.pageIndex === sec1Page)).toBe(false)
  })

  it('a section WITHOUT an override inherits the doc default on every page', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const result = engine.layout(
      {
        baseStyle,
        blocks: [para('a', 1), para('b', 1)],
        bands: { header: [docHeader] },
      },
      { ...opts, sections: twoSections({ page: LETTER }, { page: LETTER }, 1) },
    )
    for (const page of result.pages) {
      expect(result.lines.some((l) => l.blockId === 'band-doc' && l.pageIndex === page.index)).toBe(true)
    }
    expect(result.lines.some((l) => l.blockId === 'band-sec1')).toBe(false)
  })

  it('the override feeds the BAND RESERVATION (a taller override grows its section’s box)', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const tall: Block = {
      id: 'band-tall',
      kind: 'paragraph',
      runs: [{ text: tokens(3), style: style100 }], // 3 × 110px
    }
    const result = engine.layout(
      {
        baseStyle,
        blocks: [para('a', 1), para('b', 1)],
        bands: {
          header: [docHeader], // 1 line
          perSection: [{ section: 1, header: [tall] }],
        },
      },
      { ...opts, sections: twoSections({ page: LETTER }, { page: LETTER }, 1) },
    )
    // Section 0's contentBox: bodyTop = max(96, 48 + 110) = 158.
    expect(result.pages[0]!.contentBox.y).toBe(158)
    // Section 1's: bodyTop = max(96, 48 + 330) = 378.
    const sec1 = result.pages.find((p) => p.sectionIndex === 1)!
    expect(sec1.contentBox.y).toBe(378)
  })

  it('differentFirstPage + sections: section 0 paints first-class on page 0, defaults elsewhere', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const firstHeader: Block = {
      id: 'band-first',
      kind: 'paragraph',
      runs: [{ text: 'FIRST ', style: style100 }],
    }
    const result = engine.layout(
      {
        baseStyle,
        blocks: [para('a', 1), para('b', 1), para('c', 1)],
        bands: { header: [docHeader], firstHeader: [firstHeader], differentFirstPage: true },
      },
      { ...opts, sections: twoSections({ page: LETTER }, { page: LETTER }, 2) },
    )
    // Page 0: the FIRST header echo only.
    expect(result.lines.some((l) => l.blockId === 'band-first' && l.pageIndex === 0)).toBe(true)
    expect(result.lines.some((l) => l.blockId === 'band-doc' && l.pageIndex === 0)).toBe(false)
    // Section 1's page (a section > 0): the DEFAULT class even on its
    // own first page (v1: differentFirstPage is doc page 0 only).
    const sec1Page = result.pages.find((p) => p.sectionIndex === 1)!.index
    expect(result.lines.some((l) => l.blockId === 'band-doc' && l.pageIndex === sec1Page)).toBe(true)
  })
})

describe('sections: continuous boundaries', () => {
  it('a continuous boundary with the SAME geometry flows on the same page', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const result = engine.layout(
      { baseStyle, blocks: [para('a', 1), para('b', 1), para('c', 1)] },
      {
        ...opts,
        sections: [
          { afterBlock: -1, geometry: { page: LETTER, margins: MARGINS }, type: 'nextPage' },
          { afterBlock: 0, geometry: { page: LETTER, margins: MARGINS }, type: 'continuous' },
        ],
      },
    )
    // All three one-line blocks share page 0 (no close at the boundary).
    const aPage = result.lines.find((l) => l.blockId === 'a')!.pageIndex
    const cPage = result.lines.find((l) => l.blockId === 'c')!.pageIndex
    expect(aPage).toBe(0)
    expect(cPage).toBe(0)
  })

  it('a continuous boundary with a DIFFERENT geometry upgrades to a page start (Word’s law)', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const result = engine.layout(
      { baseStyle, blocks: [para('a', 1), para('b', 1)] },
      {
        ...opts,
        sections: [
          { afterBlock: -1, geometry: { page: LETTER, margins: MARGINS }, type: 'nextPage' },
          { afterBlock: 0, geometry: { page: A4, margins: MARGINS }, type: 'continuous' },
        ],
      },
    )
    // The A4 section's page: a NEW page (the auto-upgrade), and the
    // shared page 0 keeps the OPENER's frame (Letter — first-write-wins).
    expect(result.pages.length).toBe(2)
    expect(result.pages[0]!.size).toMatchObject({ width: 816, height: 1056 })
    expect(result.pages[0]!.sectionIndex).toBe(0)
    expect(result.pages[1]!.size).toMatchObject({ width: 794, height: 1123 })
    expect(result.pages[1]!.sectionIndex).toBe(1)
  })

  it('the shared page’s bands wear the OPENER’s section (first-write-wins)', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const docHeader: Block = {
      id: 'band-doc',
      kind: 'paragraph',
      runs: [{ text: tokens(1), style: style100 }],
    }
    const secHeader: Block = {
      id: 'band-sec1',
      kind: 'paragraph',
      runs: [{ text: tokens(1), style: style100 }],
    }
    const result = engine.layout(
      {
        baseStyle,
        blocks: [para('a', 1), para('b', 1)],
        bands: {
          header: [docHeader],
          perSection: [{ section: 1, header: [secHeader] }],
        },
      },
      {
        ...opts,
        sections: [
          { afterBlock: -1, geometry: { page: LETTER, margins: MARGINS }, type: 'nextPage' },
          { afterBlock: 0, geometry: { page: LETTER, margins: MARGINS }, type: 'continuous' },
        ],
      },
    )
    // One page; its frame = section 0 → the DOC header echoes, the
    // section-1 override does not (it owns pages section 1 OPENS).
    expect(result.pages.length).toBe(1)
    expect(result.lines.some((l) => l.blockId === 'band-doc')).toBe(true)
    expect(result.lines.some((l) => l.blockId === 'band-sec1')).toBe(false)
  })

  it('a bond across a continuous same-geometry boundary SURVIVES (the sections share the page)', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    // heading (2 lines) + paragraph (1 line, keepPrevious) — a bonded
    // pair across the continuous boundary. Same geometry → the bond
    // holds: heading's last line + the paragraph share page 0.
    const headingBlock: Block = {
      id: 'h',
      kind: 'heading',
      level: 1,
      runs: [{ text: tokens(2), style: style100 }],
      flow: { keepNext: true },
    }
    const body: Block = {
      id: 'b',
      kind: 'paragraph',
      runs: [{ text: tokens(1), style: style100 }],
      flow: { keepPrevious: true },
    }
    const result = engine.layout(
      { baseStyle, blocks: [headingBlock, body] },
      {
        ...opts,
        sections: [
          { afterBlock: -1, geometry: { page: LETTER, margins: MARGINS }, type: 'nextPage' },
          { afterBlock: 0, geometry: { page: LETTER, margins: MARGINS }, type: 'continuous' },
        ],
      },
    )
    // The bond kept both on page 0 (no structural drop, no relocation).
    const hPage = result.lines.find((l) => l.blockId === 'h')!.pageIndex
    const bPage = result.lines.find((l) => l.blockId === 'b')!.pageIndex
    expect(hPage).toBe(0)
    expect(bPage).toBe(0)
  })
})
