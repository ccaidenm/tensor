import { describe, expect, it } from 'vitest'
import { CELL_PAD_H, CELL_PAD_V, createLayoutEngine } from '../src/index.js'
import { FakeMetrics } from './fake-metrics.js'
import type { Block, LayoutOptions, SemanticDoc, TableBlock, TextStyle } from '../src/index.js'

// M-TABLES — the table block: band model, tracks, row heights,
// rowspan distribution, header repetition, fragmentation.
//
// Letter page, 96px margins → contentBox 624 × 864 (FakeMetrics: 10px
// per char, fontSize-16 line = 17.6px tall).

const style: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }
const baseStyle: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }
const opts: LayoutOptions = {
  page: { width: 816, height: 1056 },
  margins: { top: 96, right: 96, bottom: 96, left: 96 },
}
const CONTENT_W = 624
const LINE_H = (0.85 + 0.25) * 16 // 17.6

const para = (id: string, text = 'hi'): Block => ({ id, kind: 'paragraph', runs: [{ text, style }] })

const cellPara = (text = ''): TableBlock['rows'][0]['cells'][0]['content'][0] => ({
  id: 'cell-para',
  kind: 'paragraph',
  runs: [{ text, style }],
})

const table = (over: Partial<TableBlock> = {}): TableBlock => ({
  id: 't',
  kind: 'table',
  rows: [
    { isHeader: true, cells: [{ colspan: 1, rowspan: 1, content: [cellPara('h0')] }] },
    { isHeader: false, cells: [{ colspan: 1, rowspan: 1, content: [cellPara('b0')] }] },
  ],
  ...over,
})

const doc = (...blocks: Block[]): SemanticDoc => ({ baseStyle, blocks })
const engine = () => createLayoutEngine({ metrics: FakeMetrics })

/** The band-wise contiguity check (paint.ts's generalized contract):
 *  table cell LINES are lane content inside their bands (skipped);
 *  the tableCell rects ARE the bands' flow representatives and tile
 *  the content box exactly alongside every other flow item. */
function expectBandContiguity(result: ReturnType<ReturnType<typeof engine>['layout']>): void {
  for (let p = 0; p < result.pages.length; p++) {
    const items: { y: number; h: number }[] = []
    for (const line of result.lines) {
      if (line.pageIndex === p && !line.tableCell) items.push({ y: line.rect.y, h: line.rect.height })
    }
    for (const pr of result.placed) {
      if (pr.pageIndex === p && pr.z == null) {
        items.push({ y: pr.rect.y, h: pr.rect.height })
      }
    }
    const ys = [...new Set(items.map((i) => i.y))].sort((a, b) => a - b)
    let expected = 0
    for (const y of ys) {
      const band = items.filter((i) => i.y === y)
      const bandTop = Math.min(...band.map((i) => i.y))
      const bandBottom = Math.max(...band.map((i) => i.y + i.h))
      expect(bandTop).toBe(expected)
      expected = bandBottom
    }
  }
}

describe('M-TABLES: tracks', () => {
  it('1. no colwidths → equal tracks of the content box; the table fills the box', () => {
    const t = table({
      rows: [
        { isHeader: false, cells: [c('a'), c('b')] },
      ],
    })
    function c(text: string) {
      return { colspan: 1, rowspan: 1, content: [cellPara(text)] }
    }
    const result = engine().layout(doc(t), opts)
    const band = result.lines.filter((l) => l.blockId === 't')
    expect(band).toHaveLength(2)
    // Track width 312 each; lines sit at lane x + CELL_PAD_H.
    expect(band[0].rect.x).toBe(CELL_PAD_H)
    expect(band[1].rect.x).toBe(CONTENT_W / 2 + CELL_PAD_H)
    // Both lanes share the band's y (parallel).
    expect(band[0].rect.y).toBe(band[1].rect.y)
  })

  it('2. colwidths → tracks from the cells; the table is as wide as their sum', () => {
    const t = table({
      rows: [
        {
          isHeader: false,
          cells: [
            { colspan: 1, rowspan: 1, colwidth: [200], content: [cellPara('a')] },
            { colspan: 1, rowspan: 1, colwidth: [100], content: [cellPara('b')] },
          ],
        },
      ],
    })
    const result = engine().layout(doc(t), opts)
    const band = result.lines.filter((l) => l.blockId === 't')
    expect(band[0].rect.x).toBe(CELL_PAD_H)
    expect(band[1].rect.x).toBe(200 + CELL_PAD_H)
    // Fully fixed: the table is 300 wide, not 624 — cell 1's right edge.
    expect(result.placed[1].rect.x + result.placed[1].rect.width).toBe(300)
  })

  it('3. partially fixed → the fixed keep their widths, the flexible share the remainder', () => {
    const t = table({
      rows: [
        {
          isHeader: false,
          cells: [
            { colspan: 1, rowspan: 1, colwidth: [120], content: [cellPara('a')] },
            { colspan: 1, rowspan: 1, content: [cellPara('b')] },
            { colspan: 1, rowspan: 1, content: [cellPara('c')] },
          ],
        },
      ],
    })
    const result = engine().layout(doc(t), opts)
    const band = result.lines.filter((l) => l.blockId === 't')
    const flex = (CONTENT_W - 120) / 2
    expect(band[0].rect.x).toBe(CELL_PAD_H)
    expect(band[1].rect.x).toBe(120 + CELL_PAD_H)
    expect(band[2].rect.x).toBe(120 + flex + CELL_PAD_H)
  })

  it('4. colspan cell: its content breaks at the union width, its lane spans the tracks', () => {
    const t = table({
      rows: [
        { isHeader: false, cells: [{ colspan: 2, rowspan: 1, content: [cellPara('x'.repeat(50))] }] },
        {
          isHeader: false,
          cells: [c('l'), c('r')],
        },
      ],
    })
    function c(text: string) {
      return { colspan: 1, rowspan: 1, content: [cellPara(text)] }
    }
    const result = engine().layout(doc(t), opts)
    const lines = result.lines.filter((l) => l.blockId === 't')
    // The 50-char spanner at 624−16 content width: 608/10 = 60 chars per
    // line → ONE line. The two single cells follow in band 2.
    expect(lines).toHaveLength(3)
    expect(lines[0].tableCell?.col).toBe(0)
    expect(lines[0].tableCell?.width).toBe(CONTENT_W - 2 * CELL_PAD_H)
    // Band 0's spanner line; band 1's two cells share its top. Band 1
    // starts at row 0's height (17.6 + 2 pads).
    expect(lines[1].rect.y).toBe(lines[2].rect.y)
    expect(lines[1].rect.y).toBe(LINE_H + 2 * CELL_PAD_V + CELL_PAD_V)
  })
})

describe('M-TABLES: rows, bands, page-breaking', () => {
  it('5. row height = max cell content + padding; the flow cursor advances band-wise', () => {
    const t = table({
      rows: [
        {
          isHeader: false,
          cells: [
            { colspan: 1, rowspan: 1, content: [cellPara('a'), cellPara('b')] },
            { colspan: 1, rowspan: 1, content: [cellPara('c')] },
          ],
        },
      ],
    })
    const result = engine().layout(doc(t), opts)
    const lines = result.lines.filter((l) => l.blockId === 't')
    expect(lines).toHaveLength(3)
    // M-FLOW: lines[] is BAND-major for a split-allowed row — band 0
    // holds every cell's line 0 in canonical order, band 1 the rest
    // (the monster-row emission order, now reachable for ordinary
    // rows). Match lanes by cell identity, not array position.
    const cell0 = lines.filter((l) => l.tableCell?.col === 0)
    const cell1 = lines.filter((l) => l.tableCell?.col === 1)
    expect(cell0).toHaveLength(2)
    expect(cell1).toHaveLength(1)
    // Cell 0's two lines stack: line 0 in band 0 (at the cell's top
    // pad), line 1 at band 1's top — pixel-identical to the one-band
    // stack (the band-alignment ruling's uniform-line guarantee).
    expect(cell0[1].rect.y).toBe(cell0[0].rect.y + LINE_H)
    // Cell 1's single line shares band 0's top (parallel lanes).
    expect(cell1[0].rect.y).toBe(cell0[0].rect.y)
    // The next block enters BELOW the row (band heights = 2 lines + pads).
    const after = engine().layout(doc(t, para('after')), opts)
    const afterLine = after.lines.find((l) => l.blockId === 'after')
    expect(afterLine!.rect.y).toBe(2 * LINE_H + 2 * CELL_PAD_V)
  })

  it("6. rows split at the line grid by default (Word's allow-row-to-break): the straddling row breaks mid-row", () => {
    // A filler tall enough to leave less than the tall row needs, then
    // the table: row 0 (25.6) + a tall row (5 lines = 96). The tall row
    // cannot fit page 0's remainder → it SPLITS at the line grid — the
    // M-FLOW DEFAULT (cantSplit unset ≡ Word/GDocs' "Allow row to break
    // across pages" checked). Bands that fit stay; R5 breaks the rest
    // over to the next page. (The pre-M-FLOW whole-row move is pinned
    // by 6b, behind cantSplit.)
    const filler = { id: 'f', kind: 'paragraph' as const, runs: [{ text: 'x'.repeat(2800), style }] }
    const tallRow = {
      isHeader: false,
      cells: [{ colspan: 1, rowspan: 1, content: Array.from({ length: 5 }, (_, i) => cellPara(`s${i}`)) }],
    }
    const t = table({
      rows: [
        { isHeader: false, cells: [{ colspan: 1, rowspan: 1, content: [cellPara('r0')] }] },
        tallRow,
      ],
    })
    const result = engine().layout(doc(filler, t), opts)
    const tableLines = result.lines.filter((l) => l.blockId === 't')
    expect(tableLines).toHaveLength(6)
    const pageOf = (lineIndex: number) => tableLines.find((l) => l.lineIndex === lineIndex)!.pageIndex
    // 46 filler lines = 809.6; row 0's band (25.6) + the tall row's
    // FIRST band (17.6) fill page 0 to 852.8 — the rest doesn't fit.
    expect(pageOf(0)).toBe(0)
    expect(pageOf(1)).toBe(0)
    // The tall row's remaining four lines open page 1 — a mid-row split.
    expect([2, 3, 4, 5].map(pageOf)).toEqual([1, 1, 1, 1])
    // The FragmentBreak names the tall row's first CONTINUATION line
    // (canonical index 2) on page 1.
    const breaks = result.breaks.filter((b) => b.blockId === 't')
    expect(breaks).toHaveLength(1)
    expect(breaks[0].pageIndex).toBe(1)
    expect(breaks[0].atLine).toBe(2)
    expectBandContiguity(result)
  })

  it("6b. cantSplit: the row moves WHOLLY (one atomic band — Word's checkbox off)", () => {
    // The SAME fixture with cantSplit on the tall row: the pre-M-FLOW
    // behavior, preserved behind the flag — the row lands on page 1 in
    // one piece, its 5 lines contiguous on a single page.
    const filler = { id: 'f', kind: 'paragraph' as const, runs: [{ text: 'x'.repeat(2800), style }] }
    const tallRow = {
      isHeader: false,
      cantSplit: true,
      cells: [{ colspan: 1, rowspan: 1, content: Array.from({ length: 5 }, (_, i) => cellPara(`s${i}`)) }],
    }
    const t = table({
      rows: [
        { isHeader: false, cells: [{ colspan: 1, rowspan: 1, content: [cellPara('r0')] }] },
        tallRow,
      ],
    })
    const result = engine().layout(doc(filler, t), opts)
    const tableLines = result.lines.filter((l) => l.blockId === 't')
    const tallRowLines = tableLines.filter((l) => l.lineIndex >= 1)
    // The tall row is atomic: all 5 lines on ONE page.
    expect(new Set(tallRowLines.map((l) => l.pageIndex))).toHaveLength(1)
    expect(tallRowLines.every((l) => l.pageIndex === 1)).toBe(true)
    // The FragmentBreak names the tall row's first line (index 1) on page 1.
    const breaks = result.breaks.filter((b) => b.blockId === 't')
    expect(breaks).toHaveLength(1)
    expect(breaks[0].pageIndex).toBe(1)
    expect(breaks[0].atLine).toBe(1)
    expectBandContiguity(result)
  })

  it('6c. a fitting row is pixel-identical either way (nothing straddles → no observable split)', () => {
    // A 5-line row that fits its page whole: split-allowed banding and
    // the cantSplit one-band tile to the same line positions (band 0
    // carries the top pad, the last band the bottom — the uniform-line
    // guarantee). Only the placed[] SLICE count differs (5 slices vs
    // 1); the slices sum to the same row height.
    const cells = [{ colspan: 1, rowspan: 1, content: Array.from({ length: 5 }, (_, i) => cellPara(`s${i}`)) }]
    const rSplit = engine().layout(doc(table({ rows: [{ isHeader: false, cells }] })), opts)
    const rAtomic = engine().layout(doc(table({ rows: [{ isHeader: false, cantSplit: true, cells }] })), opts)
    expect(rSplit.lines).toEqual(rAtomic.lines)
    const cellHeight = (r: typeof rSplit) =>
      r.placed.filter((p) => p.kind === 'tableCell').reduce((s, p) => s + p.rect.height, 0)
    expect(rSplit.placed.filter((p) => p.kind === 'tableCell')).toHaveLength(5)
    expect(cellHeight(rSplit)).toBeCloseTo(5 * LINE_H + 2 * CELL_PAD_V, 6)
    expect(cellHeight(rAtomic)).toBeCloseTo(5 * LINE_H + 2 * CELL_PAD_V, 6)
  })

  it('7. header rows repeat on every continuation page: same lineIndex/ranges, re-emitted lines + rects', () => {
    // Rows tall enough that the table fragments: each body row is a
    // full-page-tall cell (44 lines of 17.6 ≈ 774px + padding… make it
    // unambiguous: 30 lines ≈ 528 + 8 pad).
    const bodyRow = (text: string) => ({
      isHeader: false,
      cells: [{ colspan: 1, rowspan: 1, content: Array.from({ length: 30 }, () => cellPara(text)) }],
    })
    const t = table({
      rows: [
        { isHeader: true, cells: [{ colspan: 1, rowspan: 1, content: [cellPara('head')] }] },
        bodyRow('a'),
        bodyRow('b'),
      ],
    })
    const result = engine().layout(doc(t), opts)
    const tableLines = result.lines.filter((l) => l.blockId === 't')
    // The header's line appears on EVERY page the table touches.
    const headLines = tableLines.filter((l) => l.lineIndex === 0)
    const tPages = new Set(tableLines.map((l) => l.pageIndex))
    expect(headLines.length).toBe(tPages.size)
    // The repeats carry the header's text range (the same logical line).
    const ranges = new Set(headLines.map((l) => `${l.rangeStart}:${l.rangeEnd}`))
    expect(ranges.size).toBe(1)
    // Each continuation page's header line sits at the band top + the
    // cell's top padding (the rect slice itself starts at 0).
    for (const l of headLines) expect(l.rect.y).toBe(CELL_PAD_V)
    // The cell rects echo on every page too (the fill + grid).
    const headRects = result.placed.filter(
      (pr) => pr.blockId === 't' && pr.kind === 'tableCell' && pr.cell?.row === 0,
    )
    expect(headRects.length).toBe(tPages.size)
    // FragmentBreaks: atLine points at the first CONTINUATION line's
    // canonical index. M-FLOW: the body rows are split-allowed, so the
    // break lands MID-ROW — body row b's 16th band (canonical line 47:
    // the header is 0, body a is 1..30, body b is 31..60) — never at
    // the repeated header's echoed 0. Page 1 therefore OPENS with a
    // mid-row continuation band, and the header repeat still fires
    // above it: the lazy repeat keys on the first CONTENT band of the
    // fresh page, mid-row or not (Word's behavior — a repeated header
    // rides every continuation, however the row broke).
    for (const brk of result.breaks.filter((b) => b.blockId === 't')) {
      expect(brk.atLine).toBe(47)
    }
    expectBandContiguity(result)
  })

  it('8. monster row (taller than the content box) fragments at band boundaries', () => {
    // One cell with 60 lines ≈ 1056px > 864 content height.
    const t = table({
      rows: [
        {
          isHeader: false,
          cells: [{ colspan: 1, rowspan: 1, content: Array.from({ length: 60 }, () => cellPara('m')) }],
        },
      ],
    })
    const result = engine().layout(doc(t), opts)
    const tableLines = result.lines.filter((l) => l.blockId === 't')
    expect(tableLines.length).toBe(60)
    const pages = new Set(tableLines.map((l) => l.pageIndex))
    expect(pages.size).toBeGreaterThanOrEqual(2)
    // The breaks land mid-row (between bands of the same row).
    const breaks = result.breaks.filter((b) => b.blockId === 't')
    expect(breaks.length).toBeGreaterThanOrEqual(1)
    expectBandContiguity(result)
  })

  it("8b. cantSplit on a monster row still fragments (can't keep together what can't fit together)", () => {
    // The same 60-line monster with cantSplit: over-page rows fragment
    // regardless — the flag's atomicity is conditional on the row
    // fitting a page at all (the keepLines/R-ATOMIC ruling family).
    const t = table({
      rows: [
        {
          isHeader: false,
          cantSplit: true,
          cells: [{ colspan: 1, rowspan: 1, content: Array.from({ length: 60 }, () => cellPara('m')) }],
        },
      ],
    })
    const result = engine().layout(doc(t), opts)
    const tableLines = result.lines.filter((l) => l.blockId === 't')
    expect(tableLines.length).toBe(60)
    const pages = new Set(tableLines.map((l) => l.pageIndex))
    expect(pages.size).toBeGreaterThanOrEqual(2)
    const breaks = result.breaks.filter((b) => b.blockId === 't')
    expect(breaks.length).toBeGreaterThanOrEqual(1)
    expectBandContiguity(result)
  })

  it('8c. split-allowed rows with mixed cell line heights tile band-aligned (the negotiated stack is a floor)', () => {
    // Cell A: two 16pt lines (17.6 each). Cell B: one 32pt line (35.2).
    // The negotiated row height is 43.2, but band 0 must hold B's tall
    // lane (pad 4 + 35.2 = 39.2) and band 1 holds A's second line
    // (17.6) → the split-allowed row tiles 56.8. THE BAND-ALIGNMENT
    // PRICE (the M-FLOW ruling, spec of record): fragmentability is
    // band-aligned, so a row whose cells mix line heights can sit
    // taller than its atomic height — the price every fragmentable row
    // family already pays (monster rows, rowspan fills). cantSplit
    // restores the one-band 43.2.
    const para32 = (text: string) => ({
      id: 'cell-para',
      kind: 'paragraph' as const,
      runs: [{ text, style: { ...style, fontSize: 32 } }],
    })
    const cells = [
      { colspan: 1, rowspan: 1, content: [cellPara('a'), cellPara('b')] },
      { colspan: 1, rowspan: 1, content: [para32('B')] },
    ]
    const rSplit = engine().layout(doc(table({ rows: [{ isHeader: false, cells }] }), para('after')), opts)
    const rAtomic = engine().layout(
      doc(table({ rows: [{ isHeader: false, cantSplit: true, cells }] }), para('after')),
      opts,
    )
    const afterSplit = rSplit.lines.find((l) => l.blockId === 'after')!
    const afterAtomic = rAtomic.lines.find((l) => l.blockId === 'after')!
    expect(afterSplit.rect.y).toBeCloseTo(39.2 + 17.6, 6)
    expect(afterAtomic.rect.y).toBeCloseTo(2 * LINE_H + 2 * CELL_PAD_V, 6)
    expectBandContiguity(rSplit)
    expectBandContiguity(rAtomic)
  })

  it('9. keepLines on a table moves it wholly to the next page (R-ATOMIC band-wise)', () => {
    const t = table({
      flow: { keepLines: true },
      rows: [
        { isHeader: false, cells: [{ colspan: 1, rowspan: 1, content: [cellPara('r0')] }] },
        { isHeader: false, cells: [{ colspan: 1, rowspan: 1, content: [cellPara('r1')] }] },
      ],
    })
    // A filler tall enough to leave less than the 51.2px table needs.
    const filler = { id: 'f', kind: 'paragraph' as const, runs: [{ text: 'x'.repeat(3000), style }] }
    const result = engine().layout(doc(filler, t), opts)
    const tableLines = result.lines.filter((l) => l.blockId === 't')
    expect(new Set(tableLines.map((l) => l.pageIndex))).toEqual(new Set([1]))
  })
})

describe('M-TABLES: rowspan', () => {
  it('10. rowspan distributes its requirement over the spanned rows; its lines stay band-aligned inside the union', () => {
    // Row 0: [spanner rowspan 2, right cell]; row 1: [left cell].
    // The spanner has 6 lines (105.6 + 8 pad); the right cell 1 line.
    const t = table({
      rows: [
        {
          isHeader: false,
          cells: [
            { colspan: 1, rowspan: 2, content: Array.from({ length: 6 }, (_, i) => cellPara(`s${i}`)) },
            { colspan: 1, rowspan: 1, content: [cellPara('r0c1')] },
          ],
        },
        {
          isHeader: false,
          cells: [{ colspan: 1, rowspan: 1, content: [cellPara('r1c0')] }],
        },
      ],
    })
    const result = engine().layout(doc(t), opts)
    const lines = result.lines.filter((l) => l.blockId === 't')
    // The spanner's lines: 6, all on page 0 (105.6 + pads < 864).
    expect(lines).toHaveLength(8)
    const spanner = lines.filter((l) => l.tableCell?.row === 0 && l.tableCell?.col === 0)
    expect(spanner).toHaveLength(6)
    // Row heights: 113.6 required, distributed — row 0 = max(right cell
    // 25.6, 113.6/2) = 56.8; row 1 = 56.8. The spanner's lines stack
    // from row 0's top + pad, crossing the row boundary.
    const y0 = spanner[0].rect.y
    expect(y0).toBe(CELL_PAD_V)
    // Row 1's own cell's line sits at row 1's top + pad — row 1's top =
    // row 0's height (56.8).
    const r1c0 = lines.find((l) => l.tableCell?.row === 1)!
    expect(r1c0.rect.y).toBeCloseTo(56.8 + CELL_PAD_V, 6)
    // The spanner's lines fill its union: the 6 lines stack (pad only on
    // the first), ending inside row 1.
    const lastSpanner = spanner[spanner.length - 1]!
    expect(lastSpanner.rect.y).toBeGreaterThan(56.8)
    // The spanner's rect slices: one per row band it covers.
    const spannerRects = result.placed.filter(
      (pr) => pr.blockId === 't' && pr.kind === 'tableCell' && pr.cell?.row === 0 && pr.cell?.col === 0,
    )
    expect(spannerRects).toHaveLength(2)
    expect(spannerRects[0].rect.height).toBeCloseTo(56.8, 6)
    expectBandContiguity(result)
  })

  it('11. a rowspan cell taller than its span grows the span’s last band (content never vanishes)', () => {
    // Row 0: [spanner rowspan 2 with 12 lines (~211px), small cell];
    // row 1: [small]. Requirement 219.2 — distributed 109.6/109.6.
    const t = table({
      rows: [
        {
          isHeader: false,
          cells: [
            { colspan: 1, rowspan: 2, content: Array.from({ length: 12 }, () => cellPara('L')) },
            { colspan: 1, rowspan: 1, content: [cellPara('x')] },
          ],
        },
        {
          isHeader: false,
          cells: [{ colspan: 1, rowspan: 1, content: [cellPara('y')] }],
        },
      ],
    })
    const result = engine().layout(doc(t), opts)
    const lines = result.lines.filter((l) => l.blockId === 't')
    // ALL 14 lines present (12 spanner + 2 others).
    expect(lines).toHaveLength(14)
    // The spanner's last line's y + height ≤ the union bottom.
    const spanner = lines.filter((l) => l.tableCell?.row === 0 && l.tableCell?.col === 0)
    const last = spanner[spanner.length - 1]!
    const row0Rect = result.placed.find(
      (pr) => pr.blockId === 't' && pr.kind === 'tableCell' && pr.cell?.row === 0 && pr.cell?.col === 1,
    )!
    // The right cell's slice height = row 0's (grown) height; the
    // spanner's stack fits within rows 0+1's union.
    expect(last.rect.y + last.rect.height).toBeLessThanOrEqual(row0Rect.rect.y + row0Rect.rect.height + 200)
    expectBandContiguity(result)
  })
})

describe('M-TABLES: contract + cache', () => {
  it('12. minHeight grows a row beyond its content', () => {
    const t = table({
      rows: [
        { isHeader: false, minHeight: 200, cells: [{ colspan: 1, rowspan: 1, content: [cellPara('a')] }] },
      ],
    })
    const result = engine().layout(doc(t, para('after')), opts)
    const afterLine = result.lines.find((l) => l.blockId === 'after')
    expect(afterLine!.rect.y).toBe(200)
  })

  it('13. warm == cold parity: two calls, same engine — deep-equal output', () => {
    const t = table({
      rows: [
        { isHeader: true, cells: [{ colspan: 2, rowspan: 1, content: [cellPara('head')] }] },
        {
          isHeader: false,
          cells: [
            { colspan: 1, rowspan: 1, content: [cellPara('a'), cellPara('b')] },
            { colspan: 1, rowspan: 1, content: [cellPara('c')] },
          ],
        },
        {
          isHeader: false,
          cells: [
            { colspan: 1, rowspan: 2, content: Array.from({ length: 9 }, () => cellPara('s')) },
            { colspan: 1, rowspan: 1, content: [cellPara('z')] },
          ],
        },
        { isHeader: false, cells: [{ colspan: 1, rowspan: 1, content: [cellPara('q')] }] },
      ],
    })
    const e = engine()
    const cold = e.layout(doc(t, para('p')), opts)
    const warm = e.layout(doc(t, para('p')), opts)
    expect(warm.lines).toEqual(cold.lines)
    expect(warm.placed).toEqual(cold.placed)
    expect(warm.breaks).toEqual(cold.breaks)
    expect(warm.pages).toEqual(cold.pages)
    // The warm call was fully cache-served (prefix reuse — no re-walk;
    // a fully-resumed walk runs no splice gate, so blocksSpliced is 0).
    expect(e.lastStats.blocksWalked).toBe(0)
  })

  it('13b. warm ≡ cold on a SPLITTING table (the parity law, straddling split-allowed row)', () => {
    // The M-FLOW reachability claim: ordinary rows now fragment, so a
    // warm second call must reproduce a cold fresh engine's output
    // byte-for-byte across the split (band construction rides the
    // lineCache; nothing placement-dependent leaks between calls).
    const filler = { id: 'f', kind: 'paragraph' as const, runs: [{ text: 'x'.repeat(2800), style }] }
    const t = table({
      rows: [
        { isHeader: true, cells: [{ colspan: 1, rowspan: 1, content: [cellPara('h')] }] },
        {
          isHeader: false,
          cells: [{ colspan: 1, rowspan: 1, content: Array.from({ length: 5 }, (_, i) => cellPara(`s${i}`)) }],
        },
      ],
    })
    const d = doc(filler, t, para('p'))
    const warmEngine = engine()
    warmEngine.layout(d, opts) // prime every cache
    const warm = warmEngine.layout(d, opts)
    const cold = engine().layout(d, opts)
    expect(warm.lines).toEqual(cold.lines)
    expect(warm.placed).toEqual(cold.placed)
    expect(warm.breaks).toEqual(cold.breaks)
    expect(warm.pages).toEqual(cold.pages)
    expect(warmEngine.lastStats.blocksWalked).toBe(0)
  })

  it('14. a cell edit invalidates only the table (contentHash change) — parity after the edit', () => {
    const t1 = table({
      rows: [{ isHeader: false, cells: [{ colspan: 1, rowspan: 1, content: [cellPara('a')] }] }],
    })
    const t2 = table({
      rows: [{ isHeader: false, cells: [{ colspan: 1, rowspan: 1, content: [cellPara('a!')] }] }],
    })
    const e = engine()
    const first = e.layout(doc(t1, para('p')), opts)
    const second = e.layout(doc(t2, para('p')), opts)
    expect(second.lines.filter((l) => l.blockId === 't')).not.toEqual(
      first.lines.filter((l) => l.blockId === 't'),
    )
    expect(e.lastStats.blocksWalked).toBe(1)
  })

  it('14b. a cantSplit toggle re-walks the table (contentHash covers the row flag)', () => {
    // Identical cells; only the straddling row's cantSplit differs. The
    // hash changes (cache-relevant ≡ layout-relevant: the flag changes
    // the BAND SLOTS), so the warm engine re-walks exactly the table —
    // and the placements genuinely differ at the page bottom (the
    // split vs the whole-row move of cases 6/6b).
    const filler = { id: 'f', kind: 'paragraph' as const, runs: [{ text: 'x'.repeat(2800), style }] }
    const row0 = () => ({ isHeader: false, cells: [{ colspan: 1, rowspan: 1, content: [cellPara('r0')] }] })
    const tallRow = (cantSplit: boolean) => ({
      isHeader: false,
      ...(cantSplit ? { cantSplit: true as const } : {}),
      cells: [{ colspan: 1, rowspan: 1, content: Array.from({ length: 5 }, (_, i) => cellPara(`s${i}`)) }],
    })
    const t1 = table({ rows: [row0(), tallRow(false)] })
    const t2 = table({ rows: [row0(), tallRow(true)] })
    const e = engine()
    const first = e.layout(doc(filler, t1), opts)
    const second = e.layout(doc(filler, t2), opts)
    expect(e.lastStats.blocksWalked).toBe(1)
    expect(second.lines.filter((l) => l.blockId === 't')).not.toEqual(
      first.lines.filter((l) => l.blockId === 't'),
    )
  })

  it('15. cell padding narrows the lane and grows the row; per-side inheritance cell ← table ← constants', () => {
    // 60 chars at the default lane 624−16=608 → 60 fit → 1 line; with
    // table cellPadding {left:20, right:20} → 584 → 58 fit → 2 lines,
    // and the row grows by top+bottom pads.
    const withPad = table({
      rows: [
        { isHeader: false, cells: [{ colspan: 1, rowspan: 1, content: [cellPara('x'.repeat(60))] }] },
      ],
      cellPadding: { top: 10, right: 20, bottom: 10, left: 20 },
    })
    const plain = table({
      rows: [
        { isHeader: false, cells: [{ colspan: 1, rowspan: 1, content: [cellPara('x'.repeat(60))] }] },
      ],
    })
    const rPad = engine().layout(doc(withPad), opts)
    const rPlain = engine().layout(doc(plain), opts)
    const padLines = rPad.lines.filter((l) => l.blockId === 't')
    const plainLines = rPlain.lines.filter((l) => l.blockId === 't')
    expect(plainLines).toHaveLength(1)
    expect(padLines).toHaveLength(2)
    // Line x includes the left pad; the lane width field shrinks by both sides.
    expect(padLines[0].rect.x).toBe(20) // laneX(0)=0 + pad.left
    expect(padLines[0].tableCell!.width).toBe(CONTENT_W - 40)
    // Row height: 2 lines + top/bottom pads (vs 1 line + 2*CELL_PAD_V).
    // M-FLOW: the split-allowed row emits its cell as TWO band slices —
    // band 0 carries the 10px top pad (10 + 17.6), the last band
    // absorbs the bottom pad (17.6 + 10); their sum is the row's
    // height, and they tile contiguously. The one-line plain row keeps
    // its single slice.
    const padRects = rPad.placed.filter((p) => p.kind === 'tableCell')
    const plainRect = rPlain.placed.find((p) => p.kind === 'tableCell')!
    expect(padRects).toHaveLength(2)
    expect(padRects[0].rect.y).toBe(0)
    expect(padRects[0].rect.height).toBeCloseTo(10 + LINE_H, 6)
    expect(padRects[1].rect.y).toBeCloseTo(10 + LINE_H, 6)
    expect(padRects[1].rect.height).toBeCloseTo(LINE_H + 10, 6)
    expect(padRects.reduce((s, p) => s + p.rect.height, 0)).toBeCloseTo(2 * LINE_H + 20, 6)
    expect(plainRect.rect.height).toBeCloseTo(LINE_H + 2 * CELL_PAD_V, 6)
    // Per-CELL override beats the table default per-side: this cell's
    // left pad is 40 (override) but its top stays the table's 10.
    const cellOverride = table({
      cellPadding: { top: 10, right: 20, bottom: 10, left: 20 },
      rows: [
        {
          isHeader: false,
          cells: [
            {
              colspan: 1,
              rowspan: 1,
              padding: { top: null, right: null, bottom: null, left: 40 },
              content: [cellPara('y')],
            },
          ],
        },
      ],
    })
    const rOverride = engine().layout(doc(cellOverride), opts)
    const line = rOverride.lines.find((l) => l.blockId === 't')!
    expect(line.rect.x).toBe(40)
    expect(line.tableCell!.width).toBe(CONTENT_W - 20 - 40)
  });

  it('16. table margins narrow the box and shift x; margins that consume the box THROW', () => {
    const margined = table({
      margin: { left: 50, right: 50 },
      rows: [
        { isHeader: false, cells: [{ colspan: 1, rowspan: 1, content: [cellPara('m')] }] },
      ],
    });
    const result = engine().layout(doc(margined), opts)
    const rect = result.placed.find((p) => p.kind === 'tableCell')!
    // Box 624−100=524: the flexible track fills it; x shifts by 50.
    expect(rect.rect.x).toBe(50)
    expect(rect.rect.width).toBe(524)
    // No margins: bit-identical defaults (x 0, width 624).
    const plain = engine().layout(
      doc(table({ rows: [{ isHeader: false, cells: [{ colspan: 1, rowspan: 1, content: [cellPara('m')] }] }] })),
      opts,
    )
    const plainRect = plain.placed.find((p) => p.kind === 'tableCell')!
    expect(plainRect.rect.x).toBe(0)
    expect(plainRect.rect.width).toBe(CONTENT_W);
    // Consuming the box: THROW (the loud seam).
    const tooWide = table({
      margin: { left: 400, right: 400 },
      rows: [{ isHeader: false, cells: [{ colspan: 1, rowspan: 1, content: [cellPara('z')] }] }],
    })
    expect(() => engine().layout(doc(tooWide), opts)).toThrow(/leave no room/)
  });

  it('15. contract: non-rectangular grids and colwidth conflicts THROW', () => {
    const ragged = table({
      rows: [
        { isHeader: false, cells: [{ colspan: 2, rowspan: 1, content: [cellPara('a')] }] },
        { isHeader: false, cells: [c('b'), c('c')] },
      ],
    })
    function c(text: string) {
      return { colspan: 1, rowspan: 1, content: [cellPara(text)] }
    }
    // Ragged: row 1's cells (2×1) follow a colspan-2 cell → occupancy 3
    // of 2 → throw.
    const cols2 = table({
      rows: [
        { isHeader: false, cells: [c('a'), c('b')] },
        { isHeader: false, cells: [{ colspan: 3, rowspan: 1, content: [cellPara('c')] }] },
      ],
    })
    void ragged
    expect(() => engine().layout(doc(cols2), opts)).toThrow(/overruns the 2-column grid/)
    const conflict = table({
      rows: [
        {
          isHeader: false,
          cells: [
            { colspan: 1, rowspan: 1, colwidth: [100], content: [cellPara('a')] },
            { colspan: 1, rowspan: 1, colwidth: [140], content: [cellPara('b')] },
          ],
        },
        {
          isHeader: false,
          cells: [
            { colspan: 2, rowspan: 1, colwidth: [100, 180], content: [cellPara('c')] },
          ],
        },
      ],
    })
    expect(() => engine().layout(doc(conflict), opts)).toThrow(/conflicting colwidths/)
  })
})
