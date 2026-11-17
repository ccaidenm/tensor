import { describe, expect, it } from 'vitest'
import { createLayoutEngine } from '../src/index.js'
import { FakeMetrics } from './fake-metrics.js'
import type { LayoutOptions, SemanticDoc, TextStyle } from '../src/index.js'

// #74 COLUMNS — the flow-slot core. Letter, 96 margins → contentBox
// 624×864. fontSize 100 → ascent 85 + descent 25 = 110px lines →
// slot cap = 7 (864/110 = 7.85). 'aaaa ' = 50px/token.
const style: TextStyle = { fontFamily: 'sans-serif', fontSize: 100 }
const baseStyle: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }
const opts: LayoutOptions = {
  page: { width: 816, height: 1056 },
  margins: { top: 96, right: 96, bottom: 96, left: 96 },
}

function para(id: string, tokens: number) {
  return { id, kind: 'paragraph' as const, runs: [{ text: 'aaaa '.repeat(tokens), style }] }
}

const layout = (doc: SemanticDoc, o: LayoutOptions) =>
  createLayoutEngine({ metrics: FakeMetrics }).layout(doc, o)

// Two columns, gap 24 → available 600 → width 300 → 6 tokens/line.
const twoCol = { ...opts, columns: { count: 2, gap: 24 } }

describe('columns: the flow-slot core', () => {
  it('1. ADDITIVE LAW: no columns ≡ today — no facts emitted, one full slot', () => {
    const doc: SemanticDoc = { baseStyle, blocks: [para('p1', 12)] }
    const result = layout(doc, opts)
    expect(result.pages).toHaveLength(1)
    expect('columns' in result.pages[0]!).toBe(false)
    expect(result.lines.every((l) => l.column === undefined)).toBe(true)
    expect(result.lines[0]!.rect.x).toBe(0)
  })

  it('2. ADDITIVE LAW: count 1 ≡ absent (one full-width slot, no facts)', () => {
    const doc: SemanticDoc = { baseStyle, blocks: [para('p1', 12)] }
    const result = layout(doc, { ...opts, columns: { count: 1, gap: 24 } })
    expect(result.pages).toHaveLength(1)
    expect('columns' in result.pages[0]!).toBe(false)
    expect(result.lines.every((l) => l.column === undefined)).toBe(true)
  })

  it('3. SLOT FACTS: PageGeometry carries the resolved grid; default gap is Word 0.5"', () => {
    const doc: SemanticDoc = { baseStyle, blocks: [para('p1', 6)] }
    const result = layout(doc, { ...opts, columns: { count: 2 } })
    // Default gap 48 → available 576 → equal 288-wide columns.
    expect(result.pages[0]!.columns).toEqual([
      { x: 0, width: 288 },
      { x: 336, width: 288 },
    ])
  })

  it('4. TWO-COLUMN FLOW: a 10-line block fills col 0 (7) then col 1 (3) on ONE page', () => {
    const doc: SemanticDoc = { baseStyle, blocks: [para('p1', 60)] }
    const result = layout(doc, twoCol)
    // 60 tokens / 6 per line = 10 lines of 300px; wrap width = 300
    // (gap 24 → available 600 → min slot 300).
    expect(result.pages).toHaveLength(1)
    expect(result.breaks).toEqual([{ blockId: 'p1', atLine: 7, pageIndex: 0 }])
    const col0 = result.lines.filter((l) => l.column === 0)
    const col1 = result.lines.filter((l) => l.column === 1)
    expect(col0.map((l) => l.lineIndex)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(col1.map((l) => l.lineIndex)).toEqual([7, 8, 9])
    // Column left edges fold into rect.x (content-box-relative).
    expect(col0.every((l) => l.rect.x === 0)).toBe(true)
    expect(col1.every((l) => l.rect.x === 300 + 24)).toBe(true)
    // y restarts at the top of the second column.
    expect(col1[0]!.rect.y).toBe(0)
    // The page carries the grid.
    expect(result.pages[0]!.columns).toEqual([
      { x: 0, width: 300 },
      { x: 324, width: 300 },
    ])
  })

  it('5. PAGE WRAP: a 20-line block tiles 7/7/6 across two pages × two columns', () => {
    const doc: SemanticDoc = { baseStyle, blocks: [para('p1', 120)] }
    const result = layout(doc, twoCol)
    expect(result.pages).toHaveLength(2)
    // Column continuations keep the page; only the page wrap bumps it:
    // slots run 7 (col 0) / 7 (col 1) / 6 (page 1 col 0).
    expect(result.breaks).toEqual([
      { blockId: 'p1', atLine: 7, pageIndex: 0 },
      { blockId: 'p1', atLine: 14, pageIndex: 1 },
    ])
    expect(result.lines.filter((l) => l.column === 0 && l.pageIndex === 0)).toHaveLength(7)
    expect(result.lines.filter((l) => l.column === 1 && l.pageIndex === 0)).toHaveLength(7)
    expect(result.lines.filter((l) => l.column === 0 && l.pageIndex === 1)).toHaveLength(6)
    expect(result.lines.filter((l) => l.column === 1 && l.pageIndex === 1)).toHaveLength(0)
  })

  it('6. R2 ORPHAN AT A COLUMN CLOSE: the block start moves to the next COLUMN, not page', () => {
    // Filler 36 tokens = 6 lines (y=660); p2 30 tokens = 5 lines;
    // fits = 1 → R2 fires at the column bottom (Word parity ruling).
    const doc: SemanticDoc = { baseStyle, blocks: [para('fill', 36), para('p2', 30)] }
    const result = layout(doc, twoCol)
    expect(result.pages).toHaveLength(1)
    expect(result.breaks).toEqual([]) // pushed wholly — no FragmentBreak
    const p2 = result.lines.filter((l) => l.blockId === 'p2')
    expect(p2).toHaveLength(5)
    expect(p2.every((l) => l.pageIndex === 0 && l.column === 1)).toBe(true)
    expect(p2.every((l) => l.rect.x === 324)).toBe(true)
    expect(p2[0]!.rect.y).toBe(0)
  })

  it('7. R3 WIDOW AT A COLUMN BOUNDARY: splits 4/2 across the columns, not 5/1', () => {
    // Filler 12 tokens = 2 lines (y=220); p2 36 tokens = 6 lines;
    // fits = 5 → n−fits = 1 → R3 backs the split to 4.
    const doc: SemanticDoc = { baseStyle, blocks: [para('fill', 12), para('p2', 36)] }
    const result = layout(doc, twoCol)
    expect(result.pages).toHaveLength(1)
    expect(result.breaks).toEqual([{ blockId: 'p2', atLine: 4, pageIndex: 0 }])
    const onCol0 = result.lines.filter((l) => l.blockId === 'p2' && l.column === 0)
    const onCol1 = result.lines.filter((l) => l.blockId === 'p2' && l.column === 1)
    expect(onCol0.map((l) => l.lineIndex)).toEqual([0, 1, 2, 3])
    expect(onCol1.map((l) => l.lineIndex)).toEqual([4, 5])
  })

  it('8. BOND HOLDS ACROSS A COLUMN CLOSE: keep-with-next guards pages, not columns', () => {
    // A = 42 tokens = 7 lines (fills col 0 exactly); B = 2 lines.
    // B's first line cannot fit col 0's remainder → R1 → col 1; the
    // bond's page co-membership survives, so NO enforcement fires.
    const doc: SemanticDoc = {
      baseStyle,
      blocks: [para('a', 42), para('b', 12)],
    }
    const aFlow = { keepNext: true }
    doc.blocks[0] = { ...doc.blocks[0]!, flow: aFlow }
    const result = layout(doc, twoCol)
    expect(result.pages).toHaveLength(1)
    expect(result.breaks).toEqual([])
    const bLines = result.lines.filter((l) => l.blockId === 'b')
    expect(bLines.every((l) => l.column === 1 && l.pageIndex === 0)).toBe(true)
  })

  it('9. CUSTOM WIDTHS: weights split the post-gap space; wrap = narrowest column', () => {
    // widths [2,1], gap 24 → available 600 → 400/200. Lines wrap at
    // the NARROWEST (200px = 4 tokens): a block spanning into col 1
    // fits every slot (the conservative v1 wrap ruling).
    const doc: SemanticDoc = { baseStyle, blocks: [para('p1', 80)] }
    const result = layout(doc, { ...opts, columns: { count: 2, gap: 24, widths: [2, 1] } })
    expect(result.pages[0]!.columns).toEqual([
      { x: 0, width: 400 },
      { x: 424, width: 200 },
    ])
    // 80 tokens / 4 per line = 20 lines → slots 7/7/6.
    expect(result.pages).toHaveLength(2)
    const col1 = result.lines.filter((l) => l.column === 1 && l.pageIndex === 0)
    expect(col1.map((l) => l.lineIndex)).toEqual([7, 8, 9, 10, 11, 12, 13])
    // 190 = the ink width (the breaker does not measure the line's
    // trailing space).
    expect(col1.every((l) => l.rect.x === 424 && l.rect.width === 190)).toBe(true)
  })

  it('10. PER-SECTION COLUMNS: the boundary swaps the grid with the geometry', () => {
    // Section 0 single-column; section 1 two-column (gap 24 → 300).
    const doc: SemanticDoc = {
      baseStyle,
      blocks: [para('a', 12), para('b', 60)],
    }
    const result = layout(doc, {
      ...opts,
      sections: [
        { afterBlock: -1, geometry: { page: opts.page, margins: opts.margins } },
        {
          afterBlock: 0,
          geometry: { page: opts.page, margins: opts.margins, columns: { count: 2, gap: 24 } },
        },
      ],
    })
    // The boundary closed the page: a on page 0 (single column — no
    // facts), b's 10 lines tile 7/3 into page 1's two columns.
    expect(result.pages).toHaveLength(2)
    expect('columns' in result.pages[0]!).toBe(false)
    expect(result.pages[1]!.columns).toEqual([
      { x: 0, width: 300 },
      { x: 324, width: 300 },
    ])
    expect(result.lines.filter((l) => l.blockId === 'b' && l.column === 1)).toHaveLength(3)
  })

  it('11. CONTINUOUS UPGRADE: a 1-col → 2-col continuous boundary closes the page', () => {
    const doc: SemanticDoc = { baseStyle, blocks: [para('a', 6), para('b', 6)] }
    const result = layout(doc, {
      ...opts,
      sections: [
        { afterBlock: -1, geometry: { page: opts.page, margins: opts.margins }, type: 'nextPage' },
        {
          afterBlock: 0,
          geometry: {
            page: opts.page,
            margins: opts.margins,
            columns: { count: 2, gap: 24 },
          },
          type: 'continuous',
        },
      ],
    })
    // Same page dims, different column grid → NOT continuous → the
    // page closes (one grid per page — the law).
    expect(result.pages).toHaveLength(2)
    expect(result.lines.filter((l) => l.blockId === 'b').every((l) => l.pageIndex === 1)).toBe(true)
  })

  it('12. FORCED PAGE BREAKS wrap the page in a columned doc (column 0)', () => {
    const doc: SemanticDoc = {
      baseStyle,
      blocks: [
        { ...para('a', 6), flow: { breakAfter: 'page' } },
        para('b', 6),
      ],
    }
    const result = layout(doc, twoCol)
    expect(result.pages).toHaveLength(2)
    const b = result.lines.filter((l) => l.blockId === 'b')
    expect(b.every((l) => l.pageIndex === 1 && l.column === 0 && l.rect.y === 0)).toBe(true)
  })

  it('13. LOUD SEAMS: invalid specs throw (adapter-contract backstop)', () => {
    const doc: SemanticDoc = { baseStyle, blocks: [para('p1', 6)] }
    const cases: unknown[] = [
      { count: 0 },
      { count: 1.5 },
      { count: 2, gap: -5 },
      { count: 2, widths: [1] },
      { count: 2, widths: [-1, 2] },
      { count: 13, gap: 48 }, // 12 × 48 = 576 < 624 — wait, this FITS
    ]
    // (the last case is adjusted below — 13 columns × 48 gap does not
    // fit; use a gap that consumes the box)
    cases[5] = { count: 14, gap: 48 }
    for (const columns of cases) {
      expect(() => layout(doc, { ...opts, columns: columns as never })).toThrow(/adapter must validate/)
    }
  })

  it('14. PARITY: warm output deep-equals cold output under column flow', () => {
    const doc: SemanticDoc = {
      baseStyle,
      blocks: [para('a', 60), para('b', 42), para('c', 120)],
    }
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    // (version is a staleness signal, not output — the parity fuzzer's
    // canonical rule: strip before comparing)
    const canon = (r: ReturnType<ReturnType<typeof createLayoutEngine>['layout']>) => {
      const { version: _version, ...rest } = r
      return rest
    }
    const cold = canon(createLayoutEngine({ metrics: FakeMetrics }).layout(doc, twoCol))
    const warm1 = canon(engine.layout(doc, twoCol))
    const edited: SemanticDoc = {
      baseStyle,
      blocks: [para('a', 66), para('b', 42), para('c', 120)],
    }
    const warm2 = canon(
      engine.layout(edited, twoCol),
    )
    const cold2 = canon(createLayoutEngine({ metrics: FakeMetrics }).layout(edited, twoCol))
    expect(warm1).toEqual(cold)
    expect(warm2).toEqual(cold2)
  })

  it('15. SPlicing: an edit deep in the doc re-splices the prefix unchanged', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const blocks = [para('a', 60), para('b', 60), para('c', 60)]
    engine.layout({ baseStyle, blocks }, twoCol)
    const edited = [para('a', 60), para('b', 66), para('c', 60)]
    engine.layout({ baseStyle, blocks: edited }, twoCol)
    // lastStats sanity: the walk resumed at block b (a spliced prefix).
    expect(engine.lastStats.blocksWalked).toBeGreaterThan(0)
    expect(engine.lastStats.blocksWalked).toBeLessThan(3)
  })
})