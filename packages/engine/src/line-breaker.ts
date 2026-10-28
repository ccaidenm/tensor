import type { LineResult, LineSegment, Run, TabStop, TextMetrics, TextStyle } from './types.js'

// ONE SCALE PRIMITIVE (extracted in E-IMG-2, from E-IMG-1's block
// fit-down): the aspect-preserving image fit-down shared by the BLOCK
// placement (layout.ts's imagePlacedSize — both axes against the
// content box) and the INLINE clamp (below — width only, maxHeight
// Infinity) — one formula, no forked math. The engine owns this math
// (two-sided law): the SHELL must never scale — it IMPORTS this
// function for paint (the alignOffset precedent, M5.13), never
// re-derives. Down-only: natural size when both axes fit, else scale
// by the binding axis. Degenerate guards, both commented at their
// sites: a zero-dim intrinsic degrades to 1×1, and the 1px floor is
// unreachable except in a degenerate box.
export function fitDownImage(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  // ZERO-DIM GUARD (loud-seam family — NO throw): ANY non-positive or
  // non-finite axis (per-axis trigger, not just both-zero — a 100×0
  // image is as degenerate as a 0×0 one) degrades the WHOLE intrinsic
  // to 1×1; the valid axis is not preserved, because half an image is
  // not an image. ADAPTER CONTRACT: the shell should prevent zero-dim
  // images before sending; this is the engine's deterministic
  // backstop, never a license to send them.
  const degenerate =
    !(Number.isFinite(width) && width > 0) || !(Number.isFinite(height) && height > 0)
  const w = degenerate ? 1 : width
  const h = degenerate ? 1 : height
  const scale = Math.min(maxWidth / w, maxHeight / h, 1)
  let placedW = w * scale
  let placedH = h * scale
  // 1px FLOOR (R6 floor family): only reachable when the box itself is
  // degenerate (maxWidth/maxHeight <= 0 makes the scale 0) — a line or
  // content box too small for any image still PLACES it, never loops.
  // The aspect breaks only here, in geometry that cannot hold any
  // image at all.
  if (!(placedW > 0)) placedW = 1
  if (!(placedH > 0)) placedH = 1
  return { width: placedW, height: placedH }
}

// The inline-object token (E-IMG-2): OBJECT REPLACEMENT CHARACTER —
// exactly ONE position per object in the block's concatenated text.
// Chosen so it can never collide with content semantics: not a space
// (so never a break point), length 1 (so never split mid-object), and
// the Unicode standard's own placeholder for an inline object.
const OBJECT_CHAR = '\uFFFC'

// ─── TAB STOPS (M-RULER Phase 4) ─────────────────────────────────────
// The default tab grid when a block has no custom stops (or the pen is
// already past the last one): every 48px — 0.5" at 96dpi, the
// Word/GDocs default tab interval — anchored at the CONTENT box's left
// edge (margin-anchored, like Word's ruler defaults), so an indented
// block's first default tab lands on the same grid as an unindented
// one's.
const DEFAULT_TAB_STEP = 48

// TAB SECTION ATOMICITY: the text between a \t and the next \t (or the
// text end) is placed as ONE unit for center/right stops — its
// measured width positions it (center: ON the stop; right: ENDS at
// it), so it cannot wrap internally. If it cannot fit (it would cross
// the wrap width, or a center/right placement would reach back to or
// past the pen), the line ends BEFORE the tab and the tab travels to
// the next line — where the same resolution runs against a fresh pen.
// A section that cannot fit even on a fresh line falls to the char
// floor (in the walk below): the tab places and the section's FIRST
// character emits with it, so layout terminates exactly like the
// existing "even a single char overflows: emit it anyway" ruling.

// Greedy line breaker — deliberately simple: greedy fill; break at
// spaces only; trim the space at the break; no hyphenation; hard-split
// tokens longer than the line.
// TODO: proper UAX #14 line breaking, whitespace collapsing,
// hyphenation, overflow policy.
//
// The CODE breaker (breakCodeLines, below) is deliberately different:
// source-line semantics for codeBlock blocks (tabs measure as glyphs
// there — code preserves whitespace exactly; column alignment is the
// content's own business).

// BOTTOM-ONLY LEADING (M6 RULING — spec of record): with content
// height c = a + d and lineHeight multiplier lh, the line box is
// c × lh tall and the baseline sits at `ascent` from the box top —
// ALL the leading (c × lh − c) lives BELOW the glyphs.
// Rationale: the top-left of a line box is always text; inter-line
// space lives below; above-line space is owned by the block tier
// (spaceBefore/spaceAfter), never to the line. Word-family
// convention, deliberately replacing the CSS half-leading model.
// lineHeight absent or 1.0 returns (c, a) bit-identically to the
// lineHeight-free model.
function lineBoxVertical(ascent: number, descent: number, style: TextStyle): {
  height: number
  baseline: number
} {
  const content = ascent + descent
  const height = content * (style.lineHeight ?? 1.0)
  return { height, baseline: ascent }
}

// Shared per-breaker machinery: run ranges over the concatenated
// text plus the measure/segment/vertical helpers. Both breakers
// (prose + code) consume the same LineResult shape.
//
// E-IMG-2: runs are a discriminated union. A TEXT run contributes its
// text; an INLINE IMAGE run contributes exactly ONE position (the
// OBJECT_CHAR token) and its placed dims — width from dims, never a
// metrics call (dims are data, the M5.6+ ruling; the metrics port is
// not consulted for objects).
interface PreparedText {
  run: Run
  start: number
  end: number
  text: string
  style: TextStyle
}
interface PreparedObject {
  run: Run
  start: number
  end: number
  dims: { width: number; height: number }
}

// P1 helper for the Run union: a PRESENT run's style wins over
// baseStyle — but an inlineImage run carries no style. len === 0
// implies every present run is a zero-length TEXT run (an inline
// object always occupies one position), so the pick is unchanged for
// every existing corpus; the scan exists for the union's type safety.
function firstTextStyle(runs: readonly Run[]): TextStyle | undefined {
  for (const run of runs) {
    if (run.kind !== 'inlineImage') return run.style
  }
  return undefined
}

function prepare(runs: readonly Run[], metrics: TextMetrics, objectMaxWidth: number) {
  const parts: string[] = []
  const runRanges: (PreparedText | PreparedObject)[] = []
  let offset = 0
  for (const run of runs) {
    if (run.kind === 'inlineImage') {
      // INLINE CLAMP (E-IMG-2): an object wider than the BASE wrap
      // width clamps to it, aspect preserved, height scaling with it
      // — the SAME fit-down primitive as block images (one scale, no
      // forked math). The clamp uses the BASE width, never the
      // narrower first-line width: dims must not depend on which line
      // the object lands on. NO height clamp for inline objects — a
      // tall object GROWS its line; the slicer's R6 floor handles an
      // over-tall one like any single line.
      runRanges.push({
        run,
        start: offset,
        end: offset + 1,
        dims: fitDownImage(run.width, run.height, objectMaxWidth, Infinity),
      })
      parts.push(OBJECT_CHAR)
      offset += 1
    } else {
      runRanges.push({ run, start: offset, end: offset + run.text.length, text: run.text, style: run.style })
      parts.push(run.text)
      offset += run.text.length
    }
  }
  const concatenated = parts.join('')
  const len = concatenated.length

  // Measured width of [start,end): sum of per-run intersections, each
  // measured under that run's style. Never assumes per-char additivity
  // (real fonts kern). An inline object contributes its PLACED WIDTH
  // — data, never measured.
  function lineWidth(start: number, end: number): number {
    let width = 0
    for (const pr of runRanges) {
      const a = Math.max(start, pr.start)
      const b = Math.min(end, pr.end)
      if (a < b) {
        if ('dims' in pr) width += pr.dims.width
        else width += metrics.measure(pr.text.slice(a - pr.start, b - pr.start), pr.style)
      }
    }
    return width
  }

  // PEN-WALK PLACEMENT (M-RULER Phase 4): emits segments with their
  // placed x (LINE-relative, 0 = the line box's left edge) — the
  // tab-aware replacement for prefix-sum segment data. Segments split
  // at run boundaries AND at tabs (a \t is its own segment: no glyphs;
  // its advance is the jump to the next segment's x). The chunk widths
  // sum in the same order as lineWidth's run-intersection sum, so for
  // tab-free ranges the pen is BIT-IDENTICAL to lineWidth(start, end).
  function placeSection(
    placed: LineSegment[],
    segX: number,
    s: number,
    e: number,
  ): number {
    let pen = segX
    runRanges.forEach((pr, runIndex) => {
      const a = Math.max(s, pr.start)
      const b = Math.min(e, pr.end)
      if (a >= b) return
      placed.push({
        runIndex,
        start: a,
        end: b,
        x: pen,
      })
      pen += 'dims' in pr
        ? pr.dims.width
        : metrics.measure(pr.text.slice(a - pr.start, b - pr.start), pr.style)
    })
    return pen
  }

  // resolveStop: the first custom stop STRICTLY after the pen (content
  // frame — a pen already sitting on a stop advances to the NEXT one,
  // the Word behavior), else the next default-grid stop.
  function resolveStop(
    penContent: number,
    stops: readonly TabStop[] | undefined,
  ): { position: number; alignment: 'left' | 'center' | 'right' } {
    for (const s of stops ?? []) {
      if (s.position > penContent + 0.01) return s
    }
    const next =
      (Math.floor(penContent / DEFAULT_TAB_STEP + 1e-9) + 1) * DEFAULT_TAB_STEP
    return { position: next, alignment: 'left' }
  }

  function runIndexAt(pos: number): number {
    for (let i = 0; i < runRanges.length; i++) {
      const pr = runRanges[i]!
      if (pos >= pr.start && pos < pr.end) return i
    }
    return 0
  }

  function verticalFor(start: number, end: number): { height: number; baseline: number } {
    let boxAscent = 0
    let boxDescent = 0
    for (const pr of runRanges) {
      if (Math.max(start, pr.start) < Math.min(end, pr.end)) {
        if ('dims' in pr) {
          // SEATING RULE (E-IMG-2 — CSS default): an inline image
          // sits ON the baseline — its BOTTOM at the baseline. It
          // extends imageHeight ABOVE the baseline and nothing below:
          // ascent contribution = placed height, descent contribution
          // = 0. No lineHeight multiplier — dims are data (M5.6+), not
          // font metrics: the object's box is exactly its height. Line
          // height = max over runs as today.
          boxAscent = Math.max(boxAscent, pr.dims.height)
        } else {
          const a = metrics.ascent(pr.style)
          const d = metrics.descent(pr.style)
          const leading = (a + d) * (pr.style.lineHeight ?? 1.0) - (a + d)
          boxAscent = Math.max(boxAscent, a)
          boxDescent = Math.max(boxDescent, d + leading)
        }
      }
    }
    return { height: boxAscent + boxDescent, baseline: boxAscent }
  }

  // makeLine: the PLAIN (tab-free) builder — pen from 0 across
  // [start, end), width = that pen (bit-identical to the historical
  // lineWidth(start, end): same slices, same order). Code lines and
  // the prose walk's tab-free outcomes go through here.
  function makeLine(start: number, end: number): LineResult {
    const placed: LineSegment[] = []
    const width = placeSection(placed, 0, start, end)
    const { height, baseline } = verticalFor(start, end)
    return { start, end, segments: placed, width, height, baseline }
  }

  // ── THE TAB-AWARE LINE WALK (prose only) ──
  // Places [start, len) as far as it fits at wrap width `w`, emitting
  // placed segments with x. Tab stops resolve in the CONTENT frame
  // (penContent = pen + tabLeft — the line's left edge sits tabLeft
  // into the content box: indentLeft (+ firstLineIndent on line 0)),
  // so a stop at px 96 from the margin is where the text lands
  // regardless of the block's indent.
  interface TabPlacement {
    placed: LineSegment[]
    /** The text index the placement consumed — the next line starts here. */
    consumed: number
    /** The placed pen — the line's ink width. */
    pen: number
    fits: boolean
    /** Where the fit failed: inside the LEADING glyphs (space-break
     *  eligible, the legacy semantics), at a tab+section (wrap before
     *  the tab — atomic tab sections never split at spaces), or the
     *  CHAR FLOOR (which the legacy flow bypassed the space-break on:
     *  its `continue` predates the space logic — pinned by the
     *  line-0-forced-floor test). */
    overflow: 'leading' | 'tab' | 'floor' | null
  }

  function layoutLine(
    start: number,
    w: number,
    tabLeft: number,
    stops: readonly TabStop[] | undefined,
  ): TabPlacement {
    const placed: LineSegment[] = []
    let pen = 0
    let consumed = start
    while (consumed < len) {
      const tab = concatenated.indexOf('\t', consumed)
      const leadEnd = tab === -1 ? len : tab
      if (leadEnd > consumed) {
        // LEADING GLYPHS — char-greedy fit. Pen-relative prefix sums:
        // for the first section of a tab-free line pen is exactly 0, so
        // this IS the legacy scan bit-for-bit.
        let f = consumed
        while (f < leadEnd && pen + lineWidth(consumed, f + 1) <= w) f++
        if (f === consumed) {
          // THE CHAR FLOOR: even one char overflows — emit it so
          // layout terminates (the existing ruling, verbatim). The
          // FLOOR flag matters: the legacy flow's `continue` fired
          // BEFORE the space-break, so a space right after the floored
          // char must NOT trim (pinned by the line-0 floor test).
          const width = placeSection(placed, pen, consumed, consumed + 1)
          return {
            placed,
            consumed: consumed + 1,
            pen: pen + lineWidth(consumed, consumed + 1),
            fits: false,
            overflow: 'floor',
          }
        }
        pen = placeSection(placed, pen, consumed, f)
        consumed = f
        if (f < leadEnd) {
          return { placed, consumed: f, pen, fits: false, overflow: 'leading' }
        }
      }
      if (tab === -1) {
        return { placed, consumed: len, pen, fits: true, overflow: null }
      }
      // THE TAB at `tab`: resolve the stop, emit the tab's own segment
      // (it paints nothing; its advance is the jump), then the section
      // after it ATOMICALLY under the stop's kind.
      const stop = resolveStop(pen + tabLeft, stops)
      let target = stop.position - tabLeft // LINE frame
      if (target > w) target = w // a stop beyond the wrap clamps to the margin
      const secEnd = concatenated.indexOf('\t', tab + 1)
      const secStop = secEnd === -1 ? len : secEnd
      const W = lineWidth(tab + 1, secStop)
      let segX: number
      let endPen: number
      if (stop.alignment === 'center') {
        segX = target - W / 2
        endPen = target + W / 2
      } else if (stop.alignment === 'right') {
        segX = target - W
        endPen = target
      } else {
        segX = target
        endPen = target + W
      }
      const fitsHere =
        endPen <= w + 1e-9 && segX >= pen - 1e-9 && segX >= -1e-9
      if (!fitsHere) {
        if (tab === start) {
          // THE FLOOR: even on a fresh line the atomic section cannot
          // fit — place the tab and the section's FIRST character so
          // layout terminates (the char-floor ruling family; the
          // next line resumes with the section's remainder as plain
          // text, which terminates).
          placed.push({
            runIndex: runIndexAt(tab),
            start: tab,
            end: tab + 1,
            x: pen,
          })
          const after = placeSection(placed, Math.min(target, w), tab + 1, tab + 2)
          return {
            placed,
            consumed: tab + 2,
            pen: after,
            fits: false,
            overflow: 'tab',
          }
        }
        // Wrap BEFORE the tab: the tab travels to the next line.
        return { placed, consumed: tab, pen, fits: false, overflow: 'tab' }
      }
      placed.push({
        runIndex: runIndexAt(tab),
        start: tab,
        end: tab + 1,
        x: pen,
      })
      pen = placeSection(placed, segX, tab + 1, secStop)
      consumed = secStop
    }
    return { placed, consumed: len, pen, fits: true, overflow: null }
  }

  function lineFromPlacement(
    placed: LineSegment[],
    start: number,
    end: number,
    width: number,
  ): LineResult {
    const { height, baseline } = verticalFor(start, end)
    return { start, end, segments: placed, width, height, baseline }
  }

  // Truncate a placement at text index `s` (the space-break cut inside
  // the leading glyphs): keep segments starting before s, clipping the
  // straddler.
  function truncatePlacement(placed: LineSegment[], s: number): LineSegment[] {
    const out: LineSegment[] = []
    for (const seg of placed) {
      if (seg.start >= s) break
      out.push({ ...seg, end: Math.min(seg.end, s) })
    }
    return out
  }

  return {
    concatenated,
    len,
    lineWidth,
    makeLine,
    layoutLine,
    lineFromPlacement,
    truncatePlacement,
    verticalFor,
  }
}

// FIRST-LINE WIDTH (the firstLineIndent seam): both breakers take an
// optional fifth width. When given, the block's line 0 — the FIRST
// LineResult produced — wraps at firstMaxWidth instead of maxWidth;
// every later line uses maxWidth. Bit-identical to the 4-arg call
// when omitted (or when the two widths are equal).
//
// TAB LEFT OFFSETS (M-RULER Phase 4, the sixth argument): the line's
// left edge offset from the CONTENT box — line 0 sits at
// indentLeft + firstLineIndent (the hanging seam), later lines at
// indentLeft. Tab stops resolve in the CONTENT frame, so the walk
// needs the per-line offset; `stops` are the block's normalized stops.
// Omitted = zeros + no stops (unindented, and every pre-Phase-4
// caller) — the walk then reduces to the legacy behavior bit-for-bit.
export function breakLines(
  runs: readonly Run[],
  metrics: TextMetrics,
  maxWidth: number,
  baseStyle: TextStyle,
  firstMaxWidth?: number,
  tabLeft?: { first: number; rest: number; stops?: readonly TabStop[] },
): LineResult[] {
  const { concatenated, len, lineWidth, layoutLine, lineFromPlacement, truncatePlacement } =
    prepare(runs, metrics, maxWidth)
  const tabLeftFirst = tabLeft?.first ?? 0
  const tabLeftRest = tabLeft?.rest ?? 0
  const stops = tabLeft?.stops

  if (len === 0) {
    // EMPTY-LINE METRICS (P1 ruling): a PRESENT run's style wins over
    // baseStyle — a zero-length run still carries its style, and the
    // adapter's empty-textblock projection (one zero-length run with
    // the paragraph's effective style) depends on it: an empty
    // paragraph in a 2.0-spaced doc must measure 2.0. baseStyle
    // remains the fallback only when there are NO runs at all (the
    // true empty-document case; REQUIRED, supplied by the adapter —
    // defaults live at the edges, never in the engine). Width stays 0.
    // Run union: firstTextStyle keeps the pick identical (an inline
    // object always occupies one position, so a len-0 block's present
    // runs are all zero-length TEXT runs).
    const style = firstTextStyle(runs) ?? baseStyle
    const ascent = metrics.ascent(style)
    const descent = metrics.descent(style)
    const { height, baseline } = lineBoxVertical(ascent, descent, style)
    return [{
      start: 0,
      end: 0,
      segments: [],
      width: 0,
      height,
      baseline,
    }]
  }

  // Last space index in (from, to] — a space at `from` never counts
  // (it would make an empty line and loop forever).
  function lastSpaceIn(from: number, to: number): number {
    for (let i = to; i > from; i--) {
      if (concatenated[i] === ' ') return i
    }
    return -1
  }

  const lines: LineResult[] = []
  let start = 0
  // Only the block's line 0 wraps at firstMaxWidth — consumed by the
  // first line pushed, whatever branch produces it.
  let first = true
  while (start < len) {
    const w = first && firstMaxWidth !== undefined ? firstMaxWidth : maxWidth
    const layout = layoutLine(start, w, first ? tabLeftFirst : tabLeftRest, stops)
    if (layout.fits) {
      lines.push(lineFromPlacement(layout.placed, start, len, layout.pen))
      break
    }
    if (layout.overflow === 'leading') {
      // The legacy space-break semantics, verbatim for tab-free
      // content: break at the last fitting space, trimming it.
      const fit = layout.consumed
      const s = lastSpaceIn(start, fit)
      if (s !== -1) {
        lines.push(
          lineFromPlacement(truncatePlacement(layout.placed, s), start, s, 0),
        )
        // The truncated line's width is the pen up to s — recompute
        // honestly (the placement's pen includes text past s).
        lines[lines.length - 1]!.width = lineWidth(start, s)
        start = s + 1
      } else {
        lines.push(lineFromPlacement(layout.placed, start, fit, layout.pen))
        start = fit
      }
    } else if (layout.overflow === 'floor') {
      // The legacy floor's `continue`: the one-char line emits, the
      // space-break never runs.
      lines.push(lineFromPlacement(layout.placed, start, layout.consumed, layout.pen))
      start = layout.consumed
    } else {
      // Wrap before the tab (or the floor): no space search — tab
      // sections are atomic (a space inside a placed center/right
      // section must not break the line: re-placement would move the
      // section).
      lines.push(lineFromPlacement(layout.placed, start, layout.consumed, layout.pen))
      start = layout.consumed
    }
    first = false
  }

  return lines
}

// CODE BREAKING (codeBlock) — SOURCE-LINE SEMANTICS, the v1 rulings:
//
// 1. EXPLICIT NEWLINES ARE HONORED: the concatenated text splits at
//    every '\n'; each source line yields ≥1 LineBox. An EMPTY source
//    line (including the one a trailing '\n' opens) yields an EMPTY
//    LineBox — width 0, full height — like a code editor's blank
//    line. What a <pre> would show is what this emits.
// 2. SOFT WRAP IS GREEDY CHARACTER WRAP (v1 ruling): a source line
//    longer than the wrap width breaks at the last fitting CHARACTER
//    — anywhere, not at spaces. Code must not reflow words; column
//    alignment is the content's own business.
//    TODO: hanging indent / wrap markers for soft-wrapped code lines.
// 3. WHITESPACE IS PRESERVED EXACTLY: leading whitespace is never
//    trimmed and internal spaces never collapse — both would corrupt
//    code's column semantics. Every char of a source line appears in
//    exactly one LineBox. (Tabs included: they measure as glyphs —
//    the M-RULER tab-advance rule is a PROSE ruling; code's columns
//    are the content's own business.)
// 4. The '\n' itself belongs to NO LineBox range — it is a separator
//    (same ruling as the prose breaker's trimmed break space): line
//    k ends right before it, line k+1 starts right after it.
// 5. An EMPTY source line has no chars of its own to measure under,
//    so it measures under the FIRST run's style — the code font — so
//    a blank line is exactly as tall as its siblings (baseStyle
//    would misalign a block whose code font is a different size). A
//    block with no text at all follows the same P1 rule: a present
//    (even zero-length) run's style wins; baseStyle only when there
//    are no runs, see breakLines.
export function breakCodeLines(
  runs: readonly Run[],
  metrics: TextMetrics,
  maxWidth: number,
  baseStyle: TextStyle,
  firstMaxWidth?: number,
): LineResult[] {
  const { concatenated, len, lineWidth, makeLine } = prepare(runs, metrics, maxWidth)

  if (len === 0) {
    // Same P1 ruling as prose: a PRESENT (even zero-length) run's
    // style wins over baseStyle; baseStyle is the no-runs-at-all
    // fallback only. Run union: firstTextStyle (see breakLines).
    const style = firstTextStyle(runs) ?? baseStyle
    const ascent = metrics.ascent(style)
    const descent = metrics.descent(style)
    const { height, baseline } = lineBoxVertical(ascent, descent, style)
    return [{ start: 0, end: 0, segments: [], width: 0, height, baseline }]
  }

  const emptyLine = (at: number): LineResult => {
    const style = firstTextStyle(runs) ?? baseStyle
    const ascent = metrics.ascent(style)
    const descent = metrics.descent(style)
    const { height, baseline } = lineBoxVertical(ascent, descent, style)
    return { start: at, end: at, segments: [], width: 0, height, baseline }
  }

  const lines: LineResult[] = []
  let segStart = 0
  // FIRST-LINE WIDTH ruling for code: the special width belongs to
  // the block's very FIRST LineBox (lineIndex 0) — even when that is
  // an empty first source line — and is consumed by it. A soft-wrapped
  // overflow of the first source line continues at the BASE width:
  // only lineIndex 0 carries the first-line indent, by the family's
  // uniform rule.
  let first = true
  while (segStart <= len) {
    // Source line = [segStart, nl), nl = the next '\n' or text end.
    const nl = concatenated.indexOf('\n', segStart)
    const segEnd = nl === -1 ? len : nl
    if (segStart === segEnd) {
      lines.push(emptyLine(segStart)) // honored blank line
      first = false
    } else {
      // Greedy CHARACTER wrap within the source line.
      let start = segStart
      while (start < segEnd) {
        const w = first && firstMaxWidth !== undefined ? firstMaxWidth : maxWidth
        if (lineWidth(start, segEnd) <= w) {
          lines.push(makeLine(start, segEnd))
          break
        }
        let fit = start
        while (fit < segEnd && lineWidth(start, fit + 1) <= w) fit++
        if (fit === start) {
          // Even a single char overflows: emit it anyway so layout
          // terminates (same ruling as prose). TODO: overflow policy.
          fit = start + 1
        }
        lines.push(makeLine(start, fit))
        start = fit
        first = false
      }
    }
    if (nl === -1) break
    segStart = nl + 1
  }

  return lines
}
