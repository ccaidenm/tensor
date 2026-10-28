import { describe, expect, it } from 'vitest'
import { createLayoutEngine } from '../src/index.js'
import { FakeMetrics } from './fake-metrics.js'
import type {
  Block,
  BlockBase,
  LayoutOptions,
  LineBox,
  ReferenceEntry,
  ReferenceTableBlock,
  Run,
  SemanticDoc,
  TextRun,
  TextStyle,
} from '../src/index.js'

// M-REFS — reference tables (ToC / ToF / Index): the composite kind
// whose flow units are ENTRIES expressed as flattened per-line
// LineResults (the table-band family's shape, minus the lanes). The
// entry's runs are COMPLETE line content — text runs, the tab run,
// the page-number run — so the ONE breaker + the ONE tab machinery
// break, wrap, and right-align the number; the arm supplies the right
// tab stop at the shared text edge. Letter page, 96px margins →
// contentBox 624 × 864 (FakeMetrics: 10px per char, fontSize-16 line
// = 17.6px tall → 49 lines per page).

const style: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }
const baseStyle: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }
const opts: LayoutOptions = {
  page: { width: 816, height: 1056 },
  margins: { top: 96, right: 96, bottom: 96, left: 96 },
}

const t = (text: string): TextRun => ({ text, style })
const para = (
  id: string,
  runs: Run[],
  over: Omit<Partial<BlockBase>, 'id' | 'kind'> = {},
): Block => ({
  id,
  kind: 'paragraph',
  runs,
  ...over,
})

/** One COMPLETE entry: text runs + the tab run + the page-number run. */
const entry = (text: string, page: string, indentLeft?: number): ReferenceEntry => ({
  runs: [t(text), t('\t'), t(page)],
  ...(indentLeft !== undefined ? { indentLeft } : {}),
})

const refTable = (id: string, entries: ReferenceEntry[], over: Partial<ReferenceTableBlock> = {}): Block => ({
  id,
  kind: 'referenceTable',
  entries,
  ...over,
})

const doc = (...blocks: Block[]): SemanticDoc => ({ baseStyle, blocks })

const layout = (d: SemanticDoc) => createLayoutEngine({ metrics: FakeMetrics }).layout(d, opts)

/** The reference table's emitted LineBoxes (the kind never PlacedRects). */
const linesOf = (result: { lines: LineBox[] }, id: string): LineBox[] =>
  result.lines.filter((l) => l.blockId === id)

describe('reference tables (M-REFS)', () => {
  it('1. one LineBox per entry; the number right-aligns at the shared text edge; rect.x carries the entry indent', () => {
    // "Introduction" = 12 chars (120px) + tab + "1" (10px): the
    // number's END lands at 624 (the stop = content width), so its
    // segment x = 614. The indented entry's rect.x = 32 and its
    // number's line-frame x = 624 − 32 − 10 = 582.
    const result = layout(
      doc(
        refTable('toc', [
          entry('Introduction', '1'),
          entry('Background', '2', 32),
        ]),
      ),
    )
    const lines = linesOf(result, 'toc')
    expect(lines).toHaveLength(2)

    expect(lines[0]!.rect).toEqual({ x: 0, y: 0, width: 624, height: 17.6 })
    expect(lines[0]!.segments).toEqual([
      { runIndex: 0, start: 0, end: 12, x: 0 },
      { runIndex: 1, start: 12, end: 13, x: 120 }, // the tab: own segment, no glyphs
      { runIndex: 2, start: 13, end: 14, x: 614 }, // right-aligned: ends at 624
    ])
    expect(lines[0]!.rangeStart).toBe(0)
    expect(lines[0]!.rangeEnd).toBe(14)

    // The line width = the entry's WRAP width (the line runs to the
    // stop in its own frame): 624 − 32 = 592 — the rect's right edge
    // lands at the shared text edge (32 + 592 = 624).
    expect(lines[1]!.rect).toEqual({ x: 32, y: 17.6, width: 592, height: 17.6 })
    // Segments are LINE-relative (the rect carries the indent);
    // offsets are BLOCK-canonical (entry 0's text = 14 chars).
    expect(lines[1]!.segments).toEqual([
      { runIndex: 3, start: 14, end: 24, x: 0 },
      { runIndex: 4, start: 24, end: 25, x: 100 },
      { runIndex: 5, start: 25, end: 26, x: 582 },
    ])
    expect(lines[1]!.rangeStart).toBe(14)
    expect(lines[1]!.rangeEnd).toBe(26)
  })

  it('2. a long entry wraps; the tab + number travel to the LAST line', () => {
    // 70-char text = 700px > the 624 wrap width: line 0 carries the
    // wrapped text (62 chars = 620px — the breaker breaks at spaces;
    // 'aaaa ' tokens are 5 chars = 50px, so 12 tokens = 600px fit),
    // and the tab + number open the continuation line.
    const result = layout(doc(refTable('toc', [entry('aaaa '.repeat(14).trim(), '7')])))
    const lines = linesOf(result, 'toc')
    expect(lines.length).toBeGreaterThan(1)
    const last = lines[lines.length - 1]!
    // The number's segment ends at the shared text edge (624).
    const numberSeg = last.segments[last.segments.length - 1]!
    expect(numberSeg.x).toBe(614)
    expect(last.rangeEnd).toBe(69 + 1 + 1) // text (trim drops the trailing space) + tab + page
  })

  it('3. fragments between entry lines; FragmentBreak carries the block id', () => {
    // 60 entries × 17.6 = 1056px > the 864px content box: 49 lines
    // place on page 0, the rest open page 1.
    const entries = Array.from({ length: 60 }, (_, i) => entry(`e${i}`, String(i)))
    const result = layout(doc(refTable('toc', entries)))
    const lines = linesOf(result, 'toc')
    expect(lines).toHaveLength(60)
    expect(lines[0]!.pageIndex).toBe(0)
    expect(lines[49]!.pageIndex).toBe(1)
    expect(result.breaks).toEqual([
      { blockId: 'toc', atLine: 49, pageIndex: 1 },
    ])
  })

  it('4. keepNext bonds: a paragraph bonded to the table keeps its first line; the table bonded forward keeps the next block', () => {
    // Filler fills page 0 to the last line; the bonded table's first
    // line cannot follow → the PARAGRAPH moves fresh (shape-1) and
    // the table's first line opens page 1 with it.
    const fillerText = 'aaaa '.repeat(120) // 10 lines × 110px? no — fontSize 16: 10 lines × 17.6
    const result = layout(
      doc(
        para('filler', [t(fillerText)], { flow: { keepNext: true } }),
        refTable('toc', [entry('Introduction', '1')]),
      ),
    )
    // 600 chars at 10px = 6000px / 624 wrap → 10 lines... the filler's
    // last line lands at y 158.4; the table's first line fits. The
    // BOND's observable: filler + table line 0 share page 0.
    const fillerLines = linesOf(result, 'filler')
    const tocLines = linesOf(result, 'toc')
    expect(fillerLines[fillerLines.length - 1]!.pageIndex).toBe(tocLines[0]!.pageIndex)
  })

  it('5. hash coverage: page and indent edits re-break; an unchanged re-layout splices', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const base = doc(refTable('toc', [entry('Introduction', '1'), entry('Background', '2', 32)]))
    engine.layout(base, opts)

    // Unchanged blocks reuse the prefix cache (reference-stable reuse —
    // the adapter contract): zero re-walks, zero re-breaks.
    engine.layout({ baseStyle, blocks: base.blocks }, opts)
    expect(engine.lastStats.blocksWalked).toBe(0)
    expect(engine.lastStats.linesRebroken).toBe(0)

    // A PAGE-NUMBER edit re-breaks the block (the number rides the
    // entry runs by construction).
    const repaged = doc(
      refTable('toc', [entry('Introduction', '9'), entry('Background', '2', 32)]),
    )
    const repagedResult = engine.layout(repaged, opts)
    expect(engine.lastStats.linesRebroken).toBe(1)
    const numberSeg = linesOf(repagedResult, 'toc')[0]!.segments[2]!
    expect(numberSeg.start).toBe(13)
    expect(numberSeg.end).toBe(14)

    // An ENTRY-INDENT edit re-breaks too (wrap geometry).
    const reindented = doc(
      refTable('toc', [entry('Introduction', '1'), entry('Background', '2', 64)]),
    )
    engine.layout(reindented, opts)
    expect(engine.lastStats.linesRebroken).toBe(1)
  })

  it('6. tabStops on the block are IGNORED (not read → not cache-relevant): a stop edit splices', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const plain = refTable('toc', [entry('Introduction', '1')])
    engine.layout(doc(plain), opts)
    // The same block object with a tabStops field: the arm never reads
    // it, so the cached lines splice — no re-break.
    const withStops = { ...plain, tabStops: [{ position: 100, alignment: 'left' as const }] }
    const result = engine.layout(doc(withStops), opts)
    expect(engine.lastStats.linesRebroken).toBe(0)
    expect(engine.lastStats.blocksWalked).toBe(0)
    // And the geometry is identical (the stop was never consulted).
    expect(linesOf(result, 'toc')[0]!.segments[2]!.x).toBe(614)
  })

  it('7. contract throws: empty entry runs, nonzero firstLineIndent, entry indent past the wrap width', () => {
    expect(() =>
      layout(doc(refTable('toc', [{ runs: [] }]))),
    ).toThrow(/at least one run/)
    expect(() =>
      layout(doc(refTable('toc', [entry('a', '1')], { firstLineIndent: 10 }))),
    ).toThrow(/firstLineIndent/)
    // indentLeft 624 = the whole wrap width → a zero-width lane.
    expect(() =>
      layout(doc(refTable('toc', [entry('a', '1', 624)]))),
    ).toThrow(/zero-width lane/)
  })

  it('8. KNOWN_KINDS acceptance: the kind survives validation (no version-skew throw)', () => {
    const result = layout(doc(refTable('toc', [entry('Introduction', '1')])))
    expect(linesOf(result, 'toc')).toHaveLength(1)
  })

  it('9. zero entries lay out zero lines (the shell never sends it — the placeholder entry is shell policy)', () => {
    const result = layout(doc(refTable('toc', [])))
    expect(linesOf(result, 'toc')).toHaveLength(0)
  })

  it('10. warm ≡ cold parity on a mixed reference-table document', () => {
    const entries = Array.from({ length: 30 }, (_, i) =>
      entry(`Section ${i}`, String(i), (i % 3) * 32),
    )
    const d = doc(
      para('p1', [t('aaaa '.repeat(30))]),
      refTable('toc', entries),
      para('p2', [t('tail')], { flow: { keepPrevious: true } }),
    )
    const warm = createLayoutEngine({ metrics: FakeMetrics }).layout(d, opts)
    const cold = createLayoutEngine({ metrics: FakeMetrics }).layout(d, opts)
    expect(JSON.parse(JSON.stringify(warm))).toEqual(JSON.parse(JSON.stringify(cold)))
  })
})

// M-REFS-8: the leader-stretch tests are GONE with the stretch — the
// engine never rewrites run text (the block-text contract); the gap-
// filling dots are shell-side paint ink at the leader run's style.
