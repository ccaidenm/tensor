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

  it('4. TWO-COLUMN FLOW: a 10-line block balances 5/5 on ONE page (the last page equalizes)', () => {
    const doc: SemanticDoc = { baseStyle, blocks: [para('p1', 60)] }
    const result = layout(doc, twoCol)
    // 60 tokens / 6 per line = 10 lines of 300px; wrap width = 300
    // (gap 24 → available 600 → min slot 300). #74 balance: the single
    // page IS the section's last page → 5/5 (T = 550).
    expect(result.pages).toHaveLength(1)
    expect(result.breaks).toEqual([{ blockId: 'p1', atLine: 5, pageIndex: 0 }])
    const col0 = result.lines.filter((l) => l.column === 0)
    const col1 = result.lines.filter((l) => l.column === 1)
    expect(col0.map((l) => l.lineIndex)).toEqual([0, 1, 2, 3, 4])
    expect(col1.map((l) => l.lineIndex)).toEqual([5, 6, 7, 8, 9])
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
    // slots run 7 (col 0) / 7 (col 1) / page 1 balances 3/3.
    expect(result.breaks).toEqual([
      { blockId: 'p1', atLine: 7, pageIndex: 0 },
      { blockId: 'p1', atLine: 14, pageIndex: 1 },
      { blockId: 'p1', atLine: 17, pageIndex: 1 },
    ])
    expect(result.lines.filter((l) => l.column === 0 && l.pageIndex === 0)).toHaveLength(7)
    expect(result.lines.filter((l) => l.column === 1 && l.pageIndex === 0)).toHaveLength(7)
    expect(result.lines.filter((l) => l.column === 0 && l.pageIndex === 1)).toHaveLength(3)
    expect(result.lines.filter((l) => l.column === 1 && l.pageIndex === 1)).toHaveLength(3)
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

  it('7. R3 WIDOW AT A COLUMN BOUNDARY: the boundary minimums fire, then the last page balances 4/4', () => {
    // Filler 12 tokens = 2 lines (y=220); p2 36 tokens = 6 lines;
    // fits = 5 → n−fits = 1 → R3 backs the split to 4. The page is the
    // section's last → the 8 units balance 4/4 (T = 440).
    const doc: SemanticDoc = { baseStyle, blocks: [para('fill', 12), para('p2', 36)] }
    const result = layout(doc, twoCol)
    expect(result.pages).toHaveLength(1)
    expect(result.breaks).toEqual([{ blockId: 'p2', atLine: 2, pageIndex: 0 }])
    const onCol0 = result.lines.filter((l) => l.column === 0)
    const onCol1 = result.lines.filter((l) => l.column === 1)
    // col 0: the filler's 2 lines + p2's first 2; col 1: p2's last 4.
    expect(onCol0.map((l) => l.blockId)).toEqual(['fill', 'fill', 'p2', 'p2'])
    expect(onCol1.filter((l) => l.blockId === 'p2').map((l) => l.lineIndex)).toEqual([2, 3, 4, 5])
  })

  it('8. BOND HOLDS ACROSS A COLUMN CLOSE: keep-with-next guards pages, not columns', () => {
    // A = 42 tokens = 7 lines (fills col 0 exactly); B = 2 lines.
    // B's first line cannot fit col 0's remainder → R1 → col 1; the
    // bond's page co-membership survives, so NO enforcement fires.
    // The last page then balances: A 5/2, B rides col 1 with A's tail.
    const doc: SemanticDoc = {
      baseStyle,
      blocks: [para('a', 42), para('b', 12)],
    }
    const aFlow = { keepNext: true }
    doc.blocks[0] = { ...doc.blocks[0]!, flow: aFlow }
    const result = layout(doc, twoCol)
    expect(result.pages).toHaveLength(1)
    expect(result.breaks).toEqual([{ blockId: 'a', atLine: 5, pageIndex: 0 }])
    const bLines = result.lines.filter((l) => l.blockId === 'b')
    expect(bLines.every((l) => l.column === 1 && l.pageIndex === 0)).toBe(true)
    const aCol0 = result.lines.filter((l) => l.blockId === 'a' && l.column === 0)
    expect(aCol0.map((l) => l.lineIndex)).toEqual([0, 1, 2, 3, 4])
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
    // facts), b's 10 lines balance 5/5 into page 1's two columns.
    expect(result.pages).toHaveLength(2)
    expect('columns' in result.pages[0]!).toBe(false)
    expect(result.pages[1]!.columns).toEqual([
      { x: 0, width: 300 },
      { x: 324, width: 300 },
    ])
    expect(result.lines.filter((l) => l.blockId === 'b' && l.column === 1)).toHaveLength(5)
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

describe('columns: manual column breaks (the structural tier)', () => {
  const colBreak = { breakBefore: 'column' as const }
  // version is a staleness signal, not output — strip before comparing.
  const stripVersion = (r: { version: number }) => {
    const { version: _v, ...rest } = r
    return rest
  }

  it('1. breakBefore column: the block starts the next column top (same page)', () => {
    const doc: SemanticDoc = {
      baseStyle,
      blocks: [para('fill', 12), { ...para('b', 6), flow: colBreak }],
    }
    const result = layout(doc, twoCol)
    expect(result.pages).toHaveLength(1)
    const b = result.lines.filter((l) => l.blockId === 'b')
    expect(b.map((l) => [l.pageIndex, l.column, l.rect.y, l.rect.x])).toEqual([[0, 1, 0, 324]])
  })

  it('2. breakBefore column in the LAST column wraps to the next page (column 0)', () => {
    const doc: SemanticDoc = {
      baseStyle,
      blocks: [para('fill', 72), { ...para('b', 6), flow: colBreak }],
    }
    const result = layout(doc, twoCol)
    expect(result.pages).toHaveLength(2)
    const b = result.lines.filter((l) => l.blockId === 'b')
    expect(b.map((l) => [l.pageIndex, l.column, l.rect.y, l.rect.x])).toEqual([[1, 0, 0, 0]])
  })

  it('3. breakBefore column at a fresh slot is a no-op (both spellings compose)', () => {
    // A ends col 0 with breakAfter 'column' → the close puts B at col 1
    // fresh; B's own breakBefore 'column' is then vacuous.
    const doc: SemanticDoc = {
      baseStyle,
      blocks: [
        { ...para('a', 12), flow: { breakAfter: 'column' } },
        { ...para('b', 12), flow: colBreak },
      ],
    }
    const result = layout(doc, twoCol)
    expect(result.pages).toHaveLength(1)
    const b = result.lines.filter((l) => l.blockId === 'b')
    expect(b.map((l) => [l.column, l.rect.y, l.rect.x])).toEqual([
      [1, 0, 324],
      [1, 110, 324],
    ])
  })

  it('4. breakAfter column: the FOLLOWING block opens the next column', () => {
    const doc: SemanticDoc = {
      baseStyle,
      blocks: [{ ...para('a', 12), flow: { breakAfter: 'column' } }, para('b', 12)],
    }
    const result = layout(doc, twoCol)
    expect(result.pages).toHaveLength(1)
    const b = result.lines.filter((l) => l.blockId === 'b')
    expect(b.map((l) => [l.column, l.rect.y, l.rect.x])).toEqual([
      [1, 0, 324],
      [1, 110, 324],
    ])
  })

  it('5. STRUCTURAL DROP: a bond at a breakBefore-column boundary never moves A', () => {
    // A fills both columns (14 lines) with keepNext; B breakBefore
    // 'column' wraps from the last column to page 1. Enforcement would
    // pull A to page 1 (shape 1); the manual break outranks the bond —
    // A stays, B alone opens page 1 (its 2 lines then balance 1/1 —
    // the section's last page equalizes).
    const doc: SemanticDoc = {
      baseStyle,
      blocks: [
        { ...para('a', 84), flow: { keepNext: true } },
        { ...para('b', 12), flow: colBreak },
      ],
    }
    const result = layout(doc, twoCol)
    expect(result.pages).toHaveLength(2)
    const a = result.lines.filter((l) => l.blockId === 'a')
    expect(a.every((l) => l.pageIndex === 0)).toBe(true)
    expect(a.filter((l) => l.column === 0)).toHaveLength(7)
    expect(a.filter((l) => l.column === 1)).toHaveLength(7)
    const b = result.lines.filter((l) => l.blockId === 'b')
    expect(b.map((l) => [l.pageIndex, l.column, l.rect.y])).toEqual([
      [1, 0, 0],
      [1, 1, 0],
    ])
  })

  it('6. STRUCTURAL DROP (same page): B takes the next column, A unmoved', () => {
    const doc: SemanticDoc = {
      baseStyle,
      blocks: [
        { ...para('a', 12), flow: { keepNext: true } },
        { ...para('b', 12), flow: colBreak },
      ],
    }
    const result = layout(doc, twoCol)
    expect(result.pages).toHaveLength(1)
    const a = result.lines.filter((l) => l.blockId === 'a')
    const b = result.lines.filter((l) => l.blockId === 'b')
    expect(a.every((l) => l.column === 0)).toBe(true)
    expect(b.map((l) => [l.column, l.rect.y])).toEqual([
      [1, 0],
      [1, 110],
    ])
  })

  it('7. STRUCTURAL FIRST: the break preempts R2 (no orphan double-move, no loop)', () => {
    // Filler 6 lines (y=660) would orphan B (fits 1) — but B's column
    // break closes col 0 first; B places whole at col 1 fresh.
    const doc: SemanticDoc = {
      baseStyle,
      blocks: [para('fill', 36), { ...para('b', 30), flow: colBreak }],
    }
    const result = layout(doc, twoCol)
    expect(result.pages).toHaveLength(1)
    const b = result.lines.filter((l) => l.blockId === 'b')
    expect(b.map((l) => [l.column, l.rect.y])).toEqual([
      [1, 0],
      [1, 110],
      [1, 220],
      [1, 330],
      [1, 440],
    ])
  })

  it('8. WARM PARITY: the breakAfter-column close re-applies on resume (splice gate)', () => {    // Editing block b (resume = 1) reconstructs the cursor through
    // cursorAfter's 'column' transform — it must reproduce the exact
    // original entry state or b's placement shifts (a parity break).
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const doc1: SemanticDoc = {
      baseStyle,
      blocks: [
        { ...para('a', 12), flow: { breakAfter: 'column' } },
        para('b', 12),
        para('c', 12),
      ],
    }
    const doc2: SemanticDoc = {
      baseStyle,
      blocks: [
        { ...para('a', 12), flow: { breakAfter: 'column' } },
        para('b', 24),
        para('c', 12),
      ],
    }
    engine.layout(doc1, twoCol)
    const warm = engine.layout(doc2, twoCol)
    const cold = createLayoutEngine({ metrics: FakeMetrics }).layout(doc2, twoCol)
    expect(stripVersion(warm)).toEqual(stripVersion(cold))
    // And the result is the honest layout: b (4 lines) fills col 1,
    // c continues under it.
    const warmB = warm.lines.filter((l) => l.blockId === 'b')
    expect(warmB.map((l) => [l.column, l.rect.y])).toEqual([
      [1, 0],
      [1, 110],
      [1, 220],
      [1, 330],
    ])
    const warmC = warm.lines.filter((l) => l.blockId === 'c')
    expect(warmC.map((l) => [l.column, l.rect.y])).toEqual([
      [1, 440],
      [1, 550],
    ])
  })
})

describe('columns: balanced columns (the section-end balance)', () => {
  // version is a staleness signal, not output — strip before comparing.
  const stripVersion = (r: { version: number }) => {
    const { version: _v, ...rest } = r
    return rest
  }
  const tops = (
    result: { lines: { blockId: string; column?: number; rect: { y: number } }[] },
    id: string,
    col: number,
  ) =>
    result.lines
      .filter((l) => l.blockId === id && l.column === col)
      .map((l) => l.rect.y)

  it('1. a short block splits evenly: 4 lines → 2/2 (the unbalanced fill would be 4/0)', () => {
    const doc: SemanticDoc = { baseStyle, blocks: [para('p1', 24)] }
    const result = layout(doc, twoCol)
    expect(result.pages).toHaveLength(1)
    expect(result.breaks).toEqual([{ blockId: 'p1', atLine: 2, pageIndex: 0 }])
    expect(tops(result, 'p1', 0)).toEqual([0, 110])
    expect(tops(result, 'p1', 1)).toEqual([0, 110])
  })

  it('2. balance touches ONLY the last page: earlier pages stay full 7/7', () => {
    const doc: SemanticDoc = { baseStyle, blocks: [para('p1', 120)] }
    const result = layout(doc, twoCol)
    expect(result.pages).toHaveLength(2)
    // Page 0 is full — the min-max pack cannot improve it; the records
    // keep the unbalanced (full) assignment.
    const p0c0 = result.lines.filter((l) => l.column === 0 && l.pageIndex === 0)
    expect(p0c0.map((l) => l.rect.y)).toEqual([0, 110, 220, 330, 440, 550, 660])
    const p0c1 = result.lines.filter((l) => l.column === 1 && l.pageIndex === 0)
    expect(p0c1.map((l) => l.rect.y)).toEqual([0, 110, 220, 330, 440, 550, 660])
    // Page 1's 6 remaining lines balance 3/3.
    const p1c0 = result.lines.filter((l) => l.column === 0 && l.pageIndex === 1)
    const p1c1 = result.lines.filter((l) => l.column === 1 && l.pageIndex === 1)
    expect(p1c0.map((l) => l.lineIndex)).toEqual([14, 15, 16])
    expect(p1c1.map((l) => l.lineIndex)).toEqual([17, 18, 19])
  })

  it('3. balanced: false keeps the naive fill (7/3, no equalization)', () => {
    const doc: SemanticDoc = { baseStyle, blocks: [para('p1', 60)] }
    const result = layout(doc, { ...twoCol, columns: { count: 2, gap: 24, balanced: false } })
    expect(result.pages).toHaveLength(1)
    expect(result.lines.filter((l) => l.column === 0)).toHaveLength(7)
    expect(result.lines.filter((l) => l.column === 1)).toHaveLength(3)
  })

  it('4. THREE columns: 12 lines → 4/4/4', () => {
    const doc: SemanticDoc = { baseStyle, blocks: [para('p1', 48)] }
    // gap 24 → available 576 → 192-wide columns at x 0/216/432;
    // 192px holds 4 tokens/line (the breaker's ink width excludes the
    // trailing space) → 48 tokens = 12 lines. The min-max balance:
    // T = 440 → 4/4/4.
    const result = layout(doc, { ...opts, columns: { count: 3, gap: 24 } })
    expect(result.pages).toHaveLength(1)
    expect(result.pages[0]!.columns).toEqual([
      { x: 0, width: 192 },
      { x: 216, width: 192 },
      { x: 432, width: 192 },
    ])
    expect(result.lines.filter((l) => l.column === 0)).toHaveLength(4)
    expect(result.lines.filter((l) => l.column === 1)).toHaveLength(4)
    expect(result.lines.filter((l) => l.column === 2)).toHaveLength(4)
    expect(result.lines.filter((l) => l.column === 2).map((l) => l.rect.x)).toEqual([432, 432, 432, 432])
    expect(result.breaks).toEqual([
      { blockId: 'p1', atLine: 4, pageIndex: 0 },
      { blockId: 'p1', atLine: 8, pageIndex: 0 },
    ])
  })

  it('5. a single unit on the last page is a no-op (the pack reproduces the fill)', () => {
    const doc: SemanticDoc = { baseStyle, blocks: [para('p1', 6)] }
    const result = layout(doc, twoCol)
    expect(result.pages).toHaveLength(1)
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0]!.column).toBe(0)
    expect(result.lines[0]!.rect.y).toBe(0)
    expect(result.breaks).toEqual([])
  })

  it('6. spaceBefore rides the balanced lead: the entry gap applies at the column top', () => {
    // A = 2 lines with spaceBefore 50; B = 6 lines. The 8 units
    // balance with A's lead preserved: col 0 opens at y=50.
    const doc: SemanticDoc = {
      baseStyle,
      blocks: [{ ...para('a', 12), spaceBefore: 50 }, para('b', 36)],
    }
    const result = layout(doc, twoCol)
    expect(result.pages).toHaveLength(1)
    expect(tops(result, 'a', 0)).toEqual([50, 160])
    expect(tops(result, 'b', 0)).toEqual([270, 380])
    expect(tops(result, 'b', 1)).toEqual([0, 110, 220, 330])
  })

  it('7. a forced column break pins its column start inside the balance', () => {
    // A (breakAfter 'column') must own a column; B+C pack the other.
    // Min-max with the forced constraint: col 0 = A (220), col 1 = B+C
    // (440) — T = 440.
    const doc: SemanticDoc = {
      baseStyle,
      blocks: [
        { ...para('a', 12), flow: { breakAfter: 'column' } },
        para('b', 12),
        para('c', 12),
      ],
    }
    const result = layout(doc, twoCol)
    expect(result.pages).toHaveLength(1)
    expect(tops(result, 'a', 0)).toEqual([0, 110])
    expect(tops(result, 'b', 1)).toEqual([0, 110])
    expect(tops(result, 'c', 1)).toEqual([220, 330])
  })

  it('8. table bands balance as units (a band never splits across columns)', () => {
    // Three rows (one line of content each + the 8px cell pads → band
    // heights 118/236/118). Unbalanced: all 472 in col 0. Balanced:
    // 354/118 — band 2 moves to col 1.
    const tableRow = (minHeight: number) => ({
      isHeader: false,
      minHeight,
      cells: [
        {
          colspan: 1,
          rowspan: 1,
          content: [{ id: `c${minHeight}`, kind: 'paragraph' as const, runs: [{ text: 'aaaa ', style }] }],
        },
      ],
    })
    const doc: SemanticDoc = {
      baseStyle,
      blocks: [
        {
          id: 't',
          kind: 'table',
          rows: [tableRow(118), tableRow(236), tableRow(118)],
        },
      ],
    }
    const result = layout(doc, twoCol)
    expect(result.pages).toHaveLength(1)
    const cellRects = result.placed.filter((r) => r.kind === 'tableCell')
    const col0 = cellRects.filter((r) => r.column === 0)
    const col1 = cellRects.filter((r) => r.column === 1)
    expect(col0.map((r) => r.rect.y)).toEqual([0, 118])
    expect(col1.map((r) => r.rect.y)).toEqual([0])
    expect(col1[0]!.rect.x).toBe(324)
    // The band's lane lines moved with it (the lane rides the cell's
    // 4px top pad inside the band).
    const col1Lanes = result.lines.filter((l) => l.column === 1)
    expect(col1Lanes.map((l) => l.rect.y)).toEqual([4])
  })

  it('9. WARM PARITY: an edit inside the tail re-balances identically', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const doc1: SemanticDoc = { baseStyle, blocks: [para('a', 60), para('b', 60)] }
    const doc2: SemanticDoc = { baseStyle, blocks: [para('a', 66), para('b', 60)] }
    engine.layout(doc1, twoCol)
    const warm = engine.layout(doc2, twoCol)
    const cold = createLayoutEngine({ metrics: FakeMetrics }).layout(doc2, twoCol)
    expect(stripVersion(warm)).toEqual(stripVersion(cold))
  })

  it('10. the balance runs at a section boundary: section 0 balances before the close', () => {
    // Section 0 (columned): 10 lines balance 5/5 on page 0; section 1
    // (single-column, nextPage) opens page 1 with no column facts.
    const doc: SemanticDoc = {
      baseStyle,
      blocks: [para('a', 60), para('b', 12)],
    }
    const result = layout(doc, {
      ...opts,
      sections: [
        {
          afterBlock: -1,
          geometry: { page: opts.page, margins: opts.margins, columns: { count: 2, gap: 24 } },
        },
        { afterBlock: 0, geometry: { page: opts.page, margins: opts.margins } },
      ],
    })
    expect(result.pages).toHaveLength(2)
    expect(result.lines.filter((l) => l.blockId === 'a' && l.column === 0)).toHaveLength(5)
    expect(result.lines.filter((l) => l.blockId === 'a' && l.column === 1)).toHaveLength(5)
    expect('columns' in result.pages[1]!).toBe(false)
    expect(result.lines.filter((l) => l.blockId === 'b').every((l) => l.column === undefined)).toBe(true)
  })

  it('11. CONTINUOUS shares the page: no mid-flow balance — the doc end balances the whole page', () => {
    // Section 0: 10 lines; section 1 (continuous, same geometry): 4
    // lines. The tier does NOT balance (the flow continues — a balance
    // here would spill section 1 onto a second page); the doc end
    // balances the shared page's 14 units → 7/7, one page total.
    const doc: SemanticDoc = {
      baseStyle,
      blocks: [para('a', 60), para('b', 24)],
    }
    const result = layout(doc, {
      ...opts,
      sections: [
        {
          afterBlock: -1,
          geometry: { page: opts.page, margins: opts.margins, columns: { count: 2, gap: 24 } },
        },
        {
          afterBlock: 0,
          geometry: { page: opts.page, margins: opts.margins, columns: { count: 2, gap: 24 } },
          type: 'continuous',
        },
      ],
    })
    expect(result.pages).toHaveLength(1)
    const col0 = result.lines.filter((l) => l.column === 0)
    const col1 = result.lines.filter((l) => l.column === 1)
    expect(col0.map((l) => l.blockId)).toEqual(['a', 'a', 'a', 'a', 'a', 'a', 'a'])
    expect(col1.map((l) => l.blockId)).toEqual([
      'a', 'a', 'a', 'b', 'b', 'b', 'b',
    ])
    expect(result.breaks).toEqual([{ blockId: 'a', atLine: 7, pageIndex: 0 }])
  })
})