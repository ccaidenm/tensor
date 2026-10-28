import { describe, expect, it } from 'vitest'
import { breakLines } from '../src/line-breaker.js'
import { FakeMetrics } from './fake-metrics.js'
import type { Run, TabStop, TextStyle } from '../src/types.js'

// M-RULER Phase 4 — the \t advance rule: a tab's advance is
// pen-dependent (the jump to the next stop), so the breaker's placement
// is pen-based, not prefix-summed. FakeMetrics: 10px/char, so every
// number below is hand-derivable.
const maxWidth = 100
const style: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }
const baseStyle: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }
const run = (text: string): Run => ({ text, style })
const stop = (position: number, alignment: TabStop['alignment'] = 'left'): TabStop => ({
  position,
  alignment,
})
const tabLeft = { first: 0, rest: 0 }

describe('breakLines tab advance (M-RULER Phase 4)', () => {
  it('the default grid: a tab jumps to the next 48px multiple (margin-anchored)', () => {
    // pen after 'ab' = 20 → the next 48-multiple is 48 → 'cd' at x 48.
    const lines = breakLines([run('ab\tcd')], FakeMetrics, maxWidth, baseStyle, undefined, tabLeft)
    expect(lines).toHaveLength(1)
    expect(lines[0].width).toBe(68)
    expect(lines[0].segments).toEqual([
      { runIndex: 0, start: 0, end: 2, x: 0 },
      { runIndex: 0, start: 2, end: 3, x: 20 }, // the tab: own segment, no glyphs
      { runIndex: 0, start: 3, end: 5, x: 48 },
    ])
  })

  it('custom stops win over the grid; left kind starts the text AT the stop', () => {
    const lines = breakLines([run('ab\tcd')], FakeMetrics, maxWidth, baseStyle, undefined, {
      ...tabLeft,
      stops: [stop(80)],
    })
    expect(lines[0].segments[2]).toEqual({ runIndex: 0, start: 3, end: 5, x: 80 })
    expect(lines[0].width).toBe(100)
  })

  it('center kind centers the section ON the stop; right kind ENDS it there', () => {
    // 'cd' measures 20: center at 80 → [70, 90]; right at 80 → [60, 80].
    const center = breakLines([run('ab\tcd')], FakeMetrics, maxWidth, baseStyle, undefined, {
      ...tabLeft,
      stops: [stop(80, 'center')],
    })
    expect(center[0].segments[2]).toEqual({ runIndex: 0, start: 3, end: 5, x: 70 })
    expect(center[0].width).toBe(90)
    const right = breakLines([run('ab\tcd')], FakeMetrics, maxWidth, baseStyle, undefined, {
      ...tabLeft,
      stops: [stop(80, 'right')],
    })
    expect(right[0].segments[2]).toEqual({ runIndex: 0, start: 3, end: 5, x: 60 })
    expect(right[0].width).toBe(80)
  })

  it('a pen already ON a stop advances to the NEXT one (strictly greater)', () => {
    // tab 1: pen 20 → stop 60. tab 2: pen 60 — ON the stop → 80.
    const lines = breakLines([run('ab\t\tcd')], FakeMetrics, maxWidth, baseStyle, undefined, {
      ...tabLeft,
      stops: [stop(60), stop(80)],
    })
    expect(lines[0].segments).toEqual([
      { runIndex: 0, start: 0, end: 2, x: 0 },
      { runIndex: 0, start: 2, end: 3, x: 20 },
      { runIndex: 0, start: 3, end: 4, x: 60 },
      { runIndex: 0, start: 4, end: 6, x: 80 },
    ])
  })

  it('the content frame: a block indented 30 resolves stops from the margin', () => {
    // penContent = pen(line) + 30. pen(line) 20 → penContent 50: the
    // custom stop at 50 is NOT strictly after it → the grid: 96 →
    // line x 66.
    const lines = breakLines([run('ab\tcd')], FakeMetrics, maxWidth, baseStyle, undefined, {
      first: 30,
      rest: 30,
      stops: [stop(50)],
    })
    expect(lines[0].segments[2]).toEqual({ runIndex: 0, start: 3, end: 5, x: 66 })
  })

  it('wrap before the tab: the tab travels to the next line; the floor terminates', () => {
    // 'abcdefgh' = 80 fits; the tab → 96; the section (80 wide) would
    // end at 176 > 100 → the line ends BEFORE the tab. The next line
    // starts AT the tab: stop 48, section 80 wide → still overflows →
    // the floor: the tab + the section's FIRST char emit together, and
    // the remainder continues as plain text.
    const lines = breakLines(
      [run('abcdefgh\tijklmnop')],
      FakeMetrics,
      maxWidth,
      baseStyle,
      undefined,
      tabLeft,
    )
    expect(lines).toHaveLength(3)
    expect(lines[0].start).toBe(0)
    expect(lines[0].end).toBe(8) // 'abcdefgh' — no tab, no space-break
    expect(lines[1].start).toBe(8)
    expect(lines[1].end).toBe(10) // '\ti' — the floor
    expect(lines[2].start).toBe(10)
    expect(lines[2].end).toBe(17) // 'jklmnop' (7 chars = 70 ≤ 100)
  })

  it('a stop set without any tab in the text changes nothing (bit-identity)', () => {
    const without = breakLines([run('hello world of prose')], FakeMetrics, maxWidth, baseStyle)
    const withStops = breakLines(
      [run('hello world of prose')],
      FakeMetrics,
      maxWidth,
      baseStyle,
      undefined,
      { ...tabLeft, stops: [stop(48), stop(96, 'center')] },
    )
    expect(withStops).toEqual(without)
  })
})