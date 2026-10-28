import { describe, expect, it } from 'vitest'
import { createLayoutEngine, EquationTooTallError } from '../src/index.js'
import { FakeMetrics } from './fake-metrics.js'
import type {
  Block,
  BlockBase,
  EquationBlock,
  EquationMetrics,
  LayoutOptions,
  Run,
  SemanticDoc,
  TextRun,
  TextStyle,
} from '../src/index.js'

// M-EQ — equation blocks: the atomic-visual family's second member.
// The image contract with TWO deliberate inversions, both ruled in
// types.ts's EquationBlock doc and pinned here:
//   1. dims are DERIVED facts via the EquationMetrics PORT (never
//      document data — the adapter is pure and cannot measure);
//   2. NO fit-down — never rescaled; over-tall throws loud, over-wide
//      bleeds into the margins (Word's convention).
// Letter page, 96px margins → contentBox 624 × 864 (FakeMetrics: 10px
// per char, fontSize-16 line = 17.6px tall).

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

/** Deterministic fake: width = 10px per char (scaled by fontSize/16),
 *  height = 1.6× fontSize — same shape as the real KaTeX measurer's
 *  contract (sync, memoized upstream is the implementation's job). */
const fakeEquationMetrics: EquationMetrics = {
  measure: (latex, fontSize) => ({
    width: latex.length * 10 * (fontSize / 16),
    height: fontSize * 1.6,
  }),
}

const eq = (id: string, latex: string, over: Partial<EquationBlock> = {}): Block => ({
  id,
  kind: 'equation',
  latex,
  fontSize: 16,
  ...over,
})

const doc = (...blocks: Block[]): SemanticDoc => ({ baseStyle, blocks })

const layout = (d: SemanticDoc, equationMetrics: EquationMetrics | undefined = fakeEquationMetrics) =>
  createLayoutEngine({ metrics: FakeMetrics, equationMetrics }).layout(d, opts)

describe('equations (M-EQ)', () => {
  it('1. places as ONE PlacedRect, centered by default; never enters lines[]', () => {
    // 20-char latex at fontSize 16 → 200px wide, 25.6px tall.
    const result = layout(doc(para('p', [t('before')]), eq('e', 'a'.repeat(20))))
    expect(result.lines).toHaveLength(1) // the paragraph only
    expect(result.placed).toHaveLength(1)
    const placed = result.placed[0]!
    expect(placed.kind).toBe('equation')
    expect(placed.blockId).toBe('e')
    // Centered on the 624px content box: (624 − 200) / 2 = 212.
    expect(placed.rect.x).toBe(212)
    expect(placed.rect.width).toBe(200)
    expect(placed.rect.height).toBe(25.6)
    // The echo contract: the shell re-renders the math from these.
    expect(placed.latex).toBe('a'.repeat(20))
    expect(placed.fontSize).toBe(16)
    // The paragraph flows ABOVE the equation (in-flow atomic).
    expect(result.lines[0]!.rect.y).toBe(0)
    expect(placed.rect.y).toBe(17.6)
  })

  it('2. align left/right pin the rect to the content-box edges', () => {
    const result = layout(doc(eq('l', 'aaaa', { align: 'left' }), eq('r', 'aaaa', { align: 'right' })))
    expect(result.placed[0]!.rect.x).toBe(0)
    expect(result.placed[1]!.rect.x).toBe(624 - 40)
  })

  it('3. the flow cursor advances by the equation height (+ spacing family)', () => {
    const result = layout(
      doc(
        eq('a', 'aaaa', { spaceBefore: 10, spaceAfter: 12 }),
        para('p', [t('after')]),
      ),
    )
    // spaceBefore at entry, then the block, then spaceAfter joins the
    // EXIT cursor — the paragraph's line starts at 10 + 25.6 + 12.
    expect(result.placed[0]!.rect.y).toBe(10)
    expect(result.lines[0]!.rect.y).toBe(10 + 25.6 + 12)
  })

  it('4. a latex edit re-walks (hash covers latex); an unchanged equation SPLICES', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics, equationMetrics: fakeEquationMetrics })
    const d1 = doc(para('p', [t('x')]), eq('e', 'aaaa'), para('q', [t('y')]))
    engine.layout(d1, opts)
    // Same doc again: the whole walk is cache-served.
    engine.layout(d1, opts)
    expect(engine.lastStats.blocksWalked).toBe(0)
    // A latex edit re-walks the equation; the paragraph after it
    // SPLICES (its entry state is unchanged — the verified-splice
    // family: an edit with no flow impact re-walks only the edit).
    const d2 = doc(para('p', [t('x')]), eq('e', 'bbbbbbbb'), para('q', [t('y')]))
    engine.layout(d2, opts)
    const stats = engine.lastStats
    expect(stats.blocksWalked).toBe(1) // the equation
    expect(stats.blocksSpliced).toBe(1) // the paragraph after it
  })

  it('5. a fontSize edit re-walks (hash covers fontSize — the port\u2019s second key)', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics, equationMetrics: fakeEquationMetrics })
    const d1 = doc(eq('e', 'aaaa', { fontSize: 16 }))
    engine.layout(d1, opts)
    const d2 = doc(eq('e', 'aaaa', { fontSize: 20 }))
    engine.layout(d2, opts)
    expect(engine.lastStats.blocksWalked).toBe(1)
    // 40px wide × 32px tall at fontSize 20.
    expect(engine.layout(d2, opts).placed[0]!.rect.height).toBe(32)
  })

  it('6. over-tall throws LOUD as the SENTINEL class (never rescaled, never silently clipped)', () => {
    // 40 chars → 400px wide; fontSize 600 → 960px tall > 864 content box.
    expect(() => layout(doc(eq('e', 'a'.repeat(40), { fontSize: 600 })))).toThrow(
      EquationTooTallError,
    )
    // The message carries the guidance (shorten / reduce size).
    try {
      layout(doc(eq('e', 'a'.repeat(40), { fontSize: 600 })))
    } catch (err) {
      expect((err as Error).message).toMatch(/taller than the.*content box/i)
      expect((err as Error).name).toBe('EquationTooTallError')
    }
  })

  it('7. over-wide PLACES (Word\u2019s margin-bleed convention; centered x goes negative)', () => {
    // 80 chars → 800px wide > the 624px content box; height fine.
    const result = layout(doc(eq('e', 'a'.repeat(80))))
    const placed = result.placed[0]!
    expect(placed.rect.width).toBe(800)
    // (624 − 800) / 2 = −88 — the same negative-x frame floats emit.
    expect(placed.rect.x).toBe(-88)
  })

  it('8. an equation without the metrics port throws the LOUD contract seam', () => {
    // No port at construction — the default-parameter trap means the
    // port-less engine is built explicitly here.
    const portless = createLayoutEngine({ metrics: FakeMetrics })
    expect(() => portless.layout(doc(eq('e', 'aaaa')), opts)).toThrow(
      /no equationMetrics port/,
    )
  })

  it('9. keepNext bonds: the equation moves WHOLE to the next page (atomic degeneration)', () => {
    // Fill the first page almost completely, then a bonded
    // paragraph→equation pair: the FILLER moves (shape 1) so the pair
    // lands together on page 2 — never the equation alone at a page
    // bottom, never a lone first line.
    const filler = para('fill', [t('a'.repeat(48))], { flow: { keepNext: true } })
    const many = Array.from({ length: 48 }, (_, i) => para(`p${i}`, [t('x')]))
    const result = layout(doc(...many, filler, eq('e', 'aaaa')))
    const placed = result.placed[0]!
    expect(placed.pageIndex).toBe(1)
    // The filler's line and the equation share page 1.
    const lastLine = result.lines[result.lines.length - 1]!
    expect(lastLine.pageIndex).toBe(1)
  })

  it('10. engine/tensor version skew gate accepts the kind (KNOWN_KINDS)', () => {
    // A doc with ONLY equations validates kinds and lays out — no
    // unknown-kind throw (the skew gate mirrors the Block union).
    const result = layout(doc(eq('e', 'aaaa')))
    expect(result.placed).toHaveLength(1)
  })

  it('11. parity warm vs cold: a spliced equation reproduces identical placed[] output', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics, equationMetrics: fakeEquationMetrics })
    const d1 = doc(para('p', [t('before')]), eq('e', 'aaaa'), para('q', [t('after')]))
    const warm1 = engine.layout(d1, opts)
    // Edit ONLY the trailing paragraph (the equation's hash is
    // unchanged — its placed rect must splice through bit-identical).
    const d2 = doc(para('p', [t('before')]), eq('e', 'aaaa'), para('q', [t('after'.repeat(6))]))
    const warm2 = engine.layout(d2, opts)
    const cold2 = createLayoutEngine({ metrics: FakeMetrics, equationMetrics: fakeEquationMetrics }).layout(d2, opts)
    expect(warm2.placed[0]).toEqual(cold2.placed[0])
    expect(warm1.placed[0]).toEqual(cold2.placed[0])
  })
})