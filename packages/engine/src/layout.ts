import type {
  Block,
  ColumnSlot,
  ColumnsSpec,
  EquationBlock,
  Run,
  EquationMetrics,
  FragmentBreak,
  ImageBlock,
  LayoutEngine,
  LastStats,
  LineBox,
  LineResult,
  PageGeometry,
  PlacedRect,
  Rect,
  SectionGeometry,
  SemanticDoc,
  TableBandData,
  TableBandLine,
  TableBandRect,
  TableBlock,
  TableCellData,
  TextStyle,
  TextMetrics,
} from './types.js'
import { BAND_ANCHOR_PX, DEFAULT_COLUMN_GAP } from './types.js'
import { breakCodeLines, breakLines, fitDownImage } from './line-breaker.js'

/**
 * M-EQ — the SENTINEL for an equation the engine refuses (taller than
 * the content box: can never fit any page, and equations are never
 * rescaled). NOT an adapter/engine bug — it is USER INPUT — so it
 * joins the UnsupportedDocError sentinel family in PaginatedView's
 * catch: the pageless fallback renders the node view natively (no
 * height limit there), never a crash, never a silent clip. The
 * missing-port throw above is a WIRING bug and stays loud (no
 * sentinel).
 */
export class EquationTooTallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EquationTooTallError'
  }
}

// SLICER VOCABULARY:
// - A block FRAGMENTS when a page break lands inside it (between its
//   lines).
// - "Orphan" = a block's first line alone at the bottom of a page.
// - "Widow"  = a block's last line alone at the top of the next page.
//
// BLOCK-TIER SPACING (spaceBefore/spaceAfter): spaceBefore is
// applied ONCE at block entry — fit counts evaluate against the line
// tops, and the y > 0 loop-freedom guards test line-top presence
// (spaceBefore is not content). spaceAfter joins the block's EXIT
// cursor, so the next block's fits account for it. Fragment
// continuations never re-apply spaceBefore: it was consumed at entry,
// and closePage resets the cursor to a bare page top.
//
// Placement rules, evaluated per attempt on page p (cursor y, H =
// remaining height) for a block of L lines with k already placed
// (n = L - k remaining). `fits` is ALWAYS computed by walking the
// block's ACTUAL line heights — mixed font sizes mean mixed line
// heights; never assume uniform. The precomputed `cap` (how many of
// THIS block's lines a fresh page holds) is used ONLY for the R4
// exemption test and R-ATOMIC's n <= cap check — "fill fresh pages to
// cap" is a characterization, not the mechanism.
//
//   R0. Whole remainder fits H → place, done.
//   R1. fits == 0 → close page, re-enter fresh. Fires only when the
//       page holds line tops (hasContent): closing a fresh page is a
//       vacuous move (R6 territory instead). spaceBefore pads the
//       cursor but is NOT content — a page holding only spaceBefore
//       is still fresh.
//   R2. ORPHAN: fits == 1 && n > 1 && widowControl (and hasContent) → the
//       block's START moves to the next page (R1-style). Applies to
//       tall blocks too: only the START moves; after re-entry it
//       fragments naturally under R4. Never leaves a lone first line
//       at a page bottom. The y > 0 guard is loop-freedom: moving off
//       a fresh page re-creates the same situation forever.
//   R-ATOMIC. k == 0 && flow.keepLines && n <= cap && hasContent →
//       move the whole block to the next page (R1-style). Tall blocks
//       fall through to R4 — can't keep together what can't fit
//       together.
//   R3. WIDOW: n - fits == 1 && fits > 1 && widowControl → break at
//       fits - 1; re-check R2 (inheriting its y > 0 guard). Applies to
//       tall blocks at their end edge. Under uniform line heights this
//       can only arise on a fresh page with n == cap + 1 exactly;
//       mixed heights can produce it mid-page too (a small preceding
//       line can leave fits == cap) — handled identically.
//   R4. EXEMPTION (L > cap): no keep-together attempts, no adjustment
//       of intermediate breaks — natural splits at the actual-height
//       fits. Boundary minimums (R2/R3) still apply at the block's
//       edges; they were already evaluated above.
//   R5. NATURAL SPLIT: place `fits` lines, emit FragmentBreak{blockId,
//       atLine: k + fits, pageIndex: p + 1}, continue on the next page.
//   R6. SAFETY: a fresh page always places at least one line even if
//       it overflows — never loop forever.
//
// Degenerate corner, pinned by tests/slicer.test.ts #12: at cap == 2
// both boundary minimums are unsatisfiable — the widow is fixed and
// the orphan deliberately sacrificed, because loop-freedom and
// determinism outrank a minimum that cannot be honored; the y > 0
// guard makes moving vacuous.
//
// INCREMENTAL WALK — PARITY LAW: the engine instance may memoize;
// warm output must deep-equal cold output — verified by
// tests/parity.fuzz.test.ts, forever. Same answers, provably; less
// work, measurably (engine.lastStats).
//
//  - MARKOV PROPERTY (the core proof): placement of blocks k..end is
//    fully determined by (state at k, blocks k..end, opts) — nothing
//    else persists across block boundaries. This is why splicing is
//    EXACT here, where the old DOM-based system could only fingerprint.
//  - Lemma 1: unchanged blocks + identical entry states ⇒ identical
//    outputs. Prefix blocks are reused directly; after each walked
//    block, splice consumes cached entries while (entry state AND id
//    AND contentHash) verify — trust is verified, never assumed. A
//    mid-splice mismatch aborts the splice and keeps walking (and
//    re-attempting) — that is how reconvergence splices happen.
//  - The caches live INSIDE the engine instance, NOT in LayoutResult.
//    CONSEQUENCE FOR CONSUMERS: the shell must hold ONE stable
//    engine instance; new metrics requires a new engine.
//  - Stats hygiene: lastStats is rebuilt from scratch on every call —
//    never accumulated (a stale counter would make the scripted
//    counts lie). cacheEpoch persists across calls but resets to 0 in
//    a fresh engine.
//  - IMMOVABILITY (enforced): emitted LineBox/FragmentBreak/PageGeometry
//    records are Object.freeze'd at creation — zero-copy sharing with
//    copying's safety at none of the cost.
//
// FLOW POLICY: Word-exact boundary
// bonds, forced page breaks, real heading layout (headings route
// through breakLines exactly like paragraphs; TODO(adapter): level-based
// default styles arrive from the ADAPTER — level is not a layout
// input here).
//
//  - BOND(A→B) ⇔ A's last line and B's first line share a page. One
//    mechanism, two spellings: flow.keepNext on A or flow.keepPrevious
//    on B; null counts as UNSET at every use site (PM attribute JSON
//    round-trips use null for absent attrs). Detection happens at A's
//    placement via a LOOKAHEAD of B's first-line height (firstLineLands
//    below — the exact same rules the walk applies), fetched from
//    lineCache/breakLines on demand (the cache absorbs it).
//  - ENFORCEMENT SHAPES (bounded: ONE attempt per bond per call; the
//    R6 floor stands):
//      violated + A fits a fresh page + A entered mid-page (y > 0) →
//        move A's start (R1 shape).
//      A tall → back A's FINAL split point up one line, floor 1 line
//        (R3 shape) — A's last line joins B's page.
//      Vacuous move (A already starts a fresh page), floor hit, or
//        still violated after the attempt → the bond DROPS. A stays at
//        the moved page per the (f) ruling — no revert; the move was
//        unproductive but deterministic.
//  - SHAPE-1 MOVES CASCADE BACKWARD: moving B for bond(B→C)
//    retro-violates bond(A→B) → A enforces in turn, re-flowing the
//    chain. Cascade floor: the head already starts a fresh page →
//    drop the EARLIEST bond — honor the maximal SUFFIX (drop earliest
//    first). "Tensor's pinned choice — Word's exact tie-break here is
//    undocumented; this is our spec of record."
//  - PRECEDENCE (pinned): structural forced breaks > orphan move (R2)
//    > bond > widow adjust (R3), applied as a bounded re-check loop
//    (each adjustment re-runs the checks; terminates via R6).
//    R-ATOMIC sits with orphan in tier 2 (a successor start-move); the
//    bond then cascades the predecessor, bounded. Bond preempts R3:
//    when the bond already relocates A's last line onto B's page, the
//    widow concern is void — a STRUCTURALLY DROPPED bond does NOT
//    preempt (control returns to R3; pinned by flow.test.ts).
//  - STRUCTURAL DROP: a bond at a boundary carrying a forced break —
//    breakBefore(B) OR breakAfter(A), symmetric, every spelling
//    ('page' and #74's 'column') — drops at detection, loudly: a
//    page/column that must start with B cannot also start with A's
//    last fragment (manual breaks outrank bonds — Word parity).
//  - FORCED BREAKS: breakBefore closes a non-fresh page (or, #74,
//    slot) before the block (fresh start = no-op); breakAfter closes
//    after the block. 'page' targets the next page; 'column' targets
//    the next SLOT — the next column, else the next page (the manual
//    column break). A closed page always holds content — never an
//    empty page; a trailing close never materializes (pages derive
//    from the max line pageIndex). Forced breaks emit NO FragmentBreak
//    (not mid-block splits).
//  - CACHE: the resume point extends BACKWARD through bonded chains —
//    a bonded predecessor's placement consumed its successor's
//    first-line height, so an edit inside the successor can invalidate
//    the predecessor's cached placement; blocksWalked counts the
//    re-walked bonded predecessors. Splices never cross a
//    breakBefore(B) boundary (the gate's state equality fails; the
//    walk re-applies the close) — conservative, safe.

// Walk state: (pageIndex, column, yCursor) at block entry. The unit of the
// Markov property — nothing else persists across block boundaries.
// #74 COLUMNS: `column` is the 0-based flow-slot index within the page's
// column grid (0 on single-column docs — the additive law). A SLOT is a
// column of the current page; flow fills a slot top-down, then advances:
// next column, else next page. CLOSE TAXONOMY: placeBlock's internal
// close and the structural 'column' spellings close to the next SLOT
// (the machine fills the grid before wrapping); 'page' spellings,
// section boundaries, and bond moves are PAGE closes — column 0 of the
// next page (Word: a page break in a columned section wraps the page).
interface WalkState {
  pageIndex: number
  column: number
  y: number
}

// Per-block walk cache, in doc order. exit[i] is the MACHINE exit;
// entry[i+1] = exit[i] plus the walk's cursor transforms (a breakAfter
// close on i, and/or a breakBefore close on i+1). Every path that
// resumes the cursor from a cached exit re-applies those closes via
// cursorAfter. Splice gates compare transformed cursors, so a
// breakBefore(B) boundary fails the gate safely (the walk re-applies
// the close) while breakAfter boundaries splice through.
interface WalkCacheEntry {
  blockId: string
  contentHash: string
  entryState: WalkState
  lineBoxes: LineBox[]
  breaks: FragmentBreak[]
  /**
   * Atomic visual outputs (images) — the sibling of lineBoxes for
   * blocks that never enter lines[]. Splice/prefix reuse shares these
   * frozen records zero-copy, exactly like lineBoxes.
   */
  placedRects: PlacedRect[]
  exitState: WalkState
  /**
   * UPSTREAM-DEPENDENCE RECORD: whether this placement consumed its
   * successor's first-line height (an ACTIVE bond lookahead at cache
   * time). Both directions matter: a successor edit invalidates a
   * consuming placement even when the current doc no longer carries
   * the bond (keepPrevious REMOVED), and a newly-added bond requires
   * consumption the cached placement never performed. Backward-resume
   * and the splice pull-back test BOTH the current flags and this
   * cached record.
   */
  bonded: boolean
  /**
   * NON-MARKOV RECORD: this placement was committed while its own
   * bond enforcement was dropped on a SPENT attempt — the
   * backward-cascade unwind re-walked this block within the same
   * call and the one-attempt budget was already gone. That outcome
   * depends on CALL HISTORY, not on (entry state, block, opts) alone
   * — a fresh call from the same entry state would enforce with a
   * fresh attempt (shape-1 move) instead of dropping. Such an entry
   * may NEVER be prefix-reused or spliced: the resume comparison and
   * the splice gate both refuse it, forcing a re-walk that
   * reproduces the placement under a fresh attempt. Caught by the
   * parity fuzzer (seed 1023 — an image successor's tall first
   * "line" made the violation reachable; the mechanism is
   * kind-agnostic and predates images).
   */
  danced: boolean
  /**
   * #58 — the ACTIVE section index at this block's ENTRY. Pages the
   * block touches (entry..exit) belong to it (a block never spans a
   * boundary — the boundary closes before the block); the page→section
   * map derives from these spans (prefix reuse replays them from the
   * cached records).
   */
  section: number
}

// Line-level cache: a block's LineResults depend only on (runs, the
// TWO wrap widths — base and line-0 — and baseStyle) — keyed by the
// block id, re-validated by hash. The indent family feeds both
// widths; both are part of the key. M-TABLES: a TABLE's band results
// ALSO depend on the content-box HEIGHT (the monster-row fragmentation
// threshold and the rowspan distribution) — contentHeight is stored
// and checked for tables only (undefined for text blocks).
interface CachedLines {
  contentHash: string
  maxWidth: number
  firstMaxWidth: number
  contentHeight?: number
  lines: LineResult[]
}

/**
 * Creates a layout engine bound to the given metrics port. The cache
 * lives inside the returned instance — the shell must hold ONE stable
 * engine instance (new metrics requires a new engine).
 */
export function createLayoutEngine({
  metrics,
  equationMetrics,
}: {
  metrics: TextMetrics
  /** M-EQ: the equation dims port — optional at construction so
   * existing callers (tests, older shells) keep working; an equation
   * block arriving WITHOUT the port throws loud at layout time (the
   * adapter/engine contract seam, the validate family's spirit). */
  equationMetrics?: EquationMetrics
}): LayoutEngine {
  const lineCache = new Map<string, CachedLines>()
  // M-HEADER-FOOTER: band-block line cache — same shape as lineCache
  // (hash + wrap width keyed), separate namespace (band blocks never
  // enter the walk). Lives with the engine instance (L2).
  const bandLineCache = new Map<string, CachedLines>()
  let walkCache: WalkCacheEntry[] = []
  let storedOptsHash: string | null = null
  let storedBaseStyleHash: string | null = null
  let cacheEpoch = 0
  let version = 1
  let hadCall = false
  let currentStats: LastStats = {
    blocksWalked: 0,
    linesRebroken: 0,
    blocksSpliced: 0,
    cacheEpoch: 0,
    invalidated: false,
  }

  return {
    layout(doc, opts) {
      // Loud adapter contracts, upfront — before any cache work.
      validateKinds(doc)
      validateDuplicateIds(doc)
      validateIndentGeometry(doc)
      validateInlineInCode(doc)
      validateFloatFlow(doc)
      validateReferenceEntries(doc)

      // Stats hygiene: rebuilt from scratch every call, never
      // accumulated — a stale counter would make the scripted counts lie.
      const stats: LastStats = {
        blocksWalked: 0,
        linesRebroken: 0,
        blocksSpliced: 0,
        cacheEpoch: 0,
        invalidated: false,
      }

      // ── #58 SECTIONS: the per-section geometry table ──
      // ONE section of the opts geometry when no boundaries ride
      // (today's shape exactly — the additive law). Each boundary is
      // a SECTION START: the walk crossing it closes a non-fresh page
      // (the breakBefore law) and swaps the ACTIVE geometry (page
      // dims, margins, band wrap width, contentBox). The ADAPTER
      // resolved the COMPLETE table — break nodes carry the PRECEDING
      // section's props (Word's sectPr spelling), so boundary 0 is the
      // doc start (−1) and each following boundary the next section,
      // INCLUDING the final one (the doc defaults — the adapter reads
      // the store's pageSetup; the engine never parses node attrs nor
      // holds doc-level defaults beyond opts).
      const boundaries = (opts.sections ?? [])
        .slice()
        .sort((a, b) => a.afterBlock - b.afterBlock)
      // The table IS the boundary list when one rides (the adapter's
      // complete resolution — the final section included); with NO
      // boundaries the single opts-geometry section stands (the
      // additive law — never an empty table).
      const sectionGeoms: SectionGeometry[] =
        boundaries.length > 0
          ? boundaries.map((b) => b.geometry)
          : [
              {
                page: { width: opts.page.width, height: opts.page.height },
                margins: {
                  top: opts.margins.top,
                  right: opts.margins.right,
                  bottom: opts.margins.bottom,
                  left: opts.margins.left,
                },
                // #74 — the document-level default folds into the
                // single-section fallback (the additive law: absent ≡
                // one column ≡ today's shape).
                columns: opts.columns,
              },
            ]
      // The block index where each section begins: section 0 at block
      // 0 (the adapter's −1 contract), section k ≥ 1 at boundary k's
      // afterBlock + 1 — one entry per section, aligned with the
      // table. Consecutive boundaries (equal afterBlock) make an EMPTY
      // middle section: pages derive from placed lines, so it holds no
      // pages — its geometry simply never renders.
      const sectionStartBlock = [
        0,
        ...boundaries.slice(1).map((b) => b.afterBlock + 1),
      ]

      const bands = doc.bands ?? undefined
      const anchorPx = bands?.anchorPx ?? BAND_ANCHOR_PX
      const topClass = bands?.differentFirstPage ? 'first' : 'default'

      interface BandEntry {
        block: Block
        results: LineResult[]
      }

      interface ActiveSection {
        index: number
        size: Rect
        anchorTop: number
        anchorBottom: number
        contentBox: Rect
        /** #74 — the section's RAW column spec (the continuous-upgrade comparison reads it). */
        columnSpec: ColumnsSpec | undefined
        /** #74 — the RESOLVED column grid (one slot per column, content-box-relative). */
        columnSlots: readonly ColumnSlot[]
        topBlocks: BandEntry[]
        bottomBlocks: BandEntry[]
        restTopBlocks: BandEntry[]
        restBottomBlocks: BandEntry[]
      }

      const sumHeight = (entries: { results: LineResult[] }[]): number =>
        entries.reduce((sum, e) => sum + e.results.reduce((s, r) => s + r.height, 0), 0)

      // M-HEADER-FOOTER: the BAND geometry — engine-issued facts, same
      // as the contentBox. Computed BEFORE the body contentBox so the
      // body shrinks by the band needs (Word: the body starts below
      // the header band, ends above the footer band). Band blocks are
      // paragraph/heading only (validated below), broken at the BAND
      // wrap width (the SECTION's page width − side margins), never
      // walked — they re-emit on every page as echoes (the table
      // header-repeat precedent). Band line cache keyed id|width: two
      // sections of different widths must not thrash one entry.
      const breakBand = (blocks: Block[] | undefined, sideW: number): BandEntry[] => {
        if (!blocks || blocks.length === 0) return []
        return blocks.map((block) => {
          if (block.kind !== 'paragraph' && block.kind !== 'heading') {
            throw new Error(
              `band block "${block.id}" kind "${block.kind}": band blocks are paragraph/heading only`,
            )
          }
          const hash = hashBlock(block)
          const cacheKey = `${block.id}|${sideW}`
          const cached = bandLineCache.get(cacheKey)
          if (cached && cached.contentHash === hash && cached.maxWidth === sideW) {
            return { block, results: cached.lines }
          }
          const results = breakLines(
            block.runs,
            metrics,
            sideW,
            doc.baseStyle,
            sideW,
            { first: 0, rest: 0, stops: block.tabStops },
          )
          bandLineCache.set(cacheKey, {
            contentHash: hash,
            maxWidth: sideW,
            firstMaxWidth: sideW,
            lines: results,
          })
          return { block, results }
        })
      }

      // M-HEADER-FOOTER-3: the anchor CLAMPS to the user's margin — a
      // margin dragged below the band distance (Word's "Header from
      // Top" knob, which we don't expose) pulls the band up with it,
      // so the band always lives INSIDE the margin area it scales
      // with. Margins larger than the anchor leave it at the default
      // distance (Word's behavior unchanged).
      // #58 — the per-section BAND resolution (Word's "link to
      // previous"): section s paints its override (BandSet.perSection),
      // else the doc default. Section 0 alone can paint the first-page
      // class (the doc's page 0 lives there); sections > 0 always the
      // default class — their firstClass is set = restClass (a
      // conservative reservation, never rendered).
      const perSectionBands = bands?.perSection
      const overrideOf = (
        s: number,
        region: 'header' | 'footer' | 'firstHeader' | 'firstFooter',
      ): Block[] | undefined => perSectionBands?.find((p) => p.section === s)?.[region]
      const sectionTable: ActiveSection[] = sectionGeoms.map((geom, index) => {
        const anchorTop = Math.min(anchorPx, geom.margins.top)
        const anchorBottom = Math.min(anchorPx, geom.margins.bottom)
        const sideW = geom.page.width - geom.margins.left - geom.margins.right
        const firstTop = overrideOf(index, 'firstHeader') ?? bands?.firstHeader
        const firstBottom = overrideOf(index, 'firstFooter') ?? bands?.firstFooter
        const defaultTop = overrideOf(index, 'header') ?? bands?.header
        const defaultBottom = overrideOf(index, 'footer') ?? bands?.footer
        const topBlocks =
          topClass === 'first'
            ? breakBand(firstTop, sideW)
            : breakBand(defaultTop, sideW)
        const bottomBlocks =
          topClass === 'first'
            ? breakBand(firstBottom, sideW)
            : breakBand(defaultBottom, sideW)
        // The REST pages' blocks: under differentFirstPage the default
        // regions; otherwise the same as page 0 (shared objects).
        const restTopBlocks =
          topClass === 'first' ? breakBand(defaultTop, sideW) : topBlocks
        const restBottomBlocks =
          topClass === 'first' ? breakBand(defaultBottom, sideW) : bottomBlocks
        const topNeed = Math.max(sumHeight(topBlocks), sumHeight(restTopBlocks))
        const bottomNeed = Math.max(sumHeight(bottomBlocks), sumHeight(restBottomBlocks))
        // No band content → NO reservation (a margins-0 doc with no
        // header must meet the sheet edge exactly — the anchor is not a
        // floor, it is where band CONTENT anchors).
        const bodyTop =
          topNeed > 0 ? Math.max(geom.margins.top, anchorTop + topNeed) : geom.margins.top
        const bodyBottom =
          bottomNeed > 0 ? Math.max(geom.margins.bottom, anchorBottom + bottomNeed) : geom.margins.bottom
        return {
          index,
          size: Object.freeze({
            x: 0,
            y: 0,
            width: geom.page.width,
            height: geom.page.height,
          }),
          anchorTop,
          anchorBottom,
          contentBox: Object.freeze({
            x: geom.margins.left,
            y: bodyTop,
            width: geom.page.width - geom.margins.left - geom.margins.right,
            height: geom.page.height - bodyTop - bodyBottom,
          }),
          columnSpec: geom.columns,
          // #74 — the resolved grid: one slot per column against this
          // section's content box (loud on invalid specs — the adapter
          // normalizes, this is the backstop).
          columnSlots: resolveColumnSlots(geom.columns, geom.page.width - geom.margins.left - geom.margins.right),
          topBlocks,
          bottomBlocks,
          restTopBlocks,
          restBottomBlocks,
        }
      })
      // The ACTIVE section the walk reads (mutated at boundaries; the
      // helpers below close over this binding — every geometry read in
      // the walk is the active section's).
      let active: ActiveSection = sectionTable[0]!

      // #74 — the column count of a cached entry's section (cursorAfter's
      // breakAfter-'column' transform needs the grid the block lived in).
      const columnCountOf = (s: number): number => sectionTable[s]?.columnSlots.length ?? 1

      const hashes = doc.blocks.map(hashBlock)
      const optsHash = stableStringify(opts)
      const baseStyleHash = stableStringify(doc.baseStyle)

      // Context change (opts or baseStyle) drops both caches
      // wholesale. baseStyle feeds empty-line LineResults, so a stale
      // baseStyle would violate parity. The FIRST call is not
      // invalidation (no prior cache exists).
      const hadCache = storedOptsHash !== null
      const contextChanged =
        hadCache && (storedOptsHash !== optsHash || storedBaseStyleHash !== baseStyleHash)
      if (contextChanged) {
        lineCache.clear()
        walkCache = []
        cacheEpoch += 1
        stats.invalidated = true
      }
      storedOptsHash = optsHash
      storedBaseStyleHash = baseStyleHash
      stats.cacheEpoch = cacheEpoch

      const oldCache = walkCache

      // Resume = first index where [id, contentHash] differs — or the
      // first NON-MARKOV entry (a spent-attempt bond drop is
      // call-history-dependent and must be re-walked, never reused).
      // Length mismatch counts as a difference at the shorter length's end.
      let resume = Math.min(doc.blocks.length, oldCache.length)
      for (let i = 0; i < resume; i++) {
        if (
          doc.blocks[i].id !== oldCache[i].blockId ||
          hashes[i] !== oldCache[i].contentHash ||
          oldCache[i].danced
        ) {
          resume = i
          break
        }
      }

      // BACKWARD-RESUME through bonded chains: a bonded
      // predecessor's placement consumed its successor's first-line
      // height (the bond lookahead), so an edit inside the successor
      // can invalidate the predecessor's cached placement — extend the
      // resume point BACKWARD while the pair is bonded. BOTH signals
      // are tested: the CURRENT doc's bond flags (a newly-added bond
      // requires consumption the cached placement never performed) AND
      // the cached bonded record (a consuming placement is stale even
      // when the edit REMOVED the bond — e.g. keepPrevious deleted from
      // the successor; a fuzzer-caught hole). Conservative: a spurious
      // extension only re-walks, never mis-splices. blocksWalked counts
      // the re-walked bonded predecessors.
      while (resume > 0 && (bondExistsBetween(doc, resume - 1) || oldCache[resume - 1].bonded)) {
        resume -= 1
      }

      const lines: LineBox[] = []
      const breaks: FragmentBreak[] = []
      // ATOMIC VISUAL OUTPUT: images (and, additively, floats later).
      // Document order, the sibling of lines[] — images never appear
      // in lines[]; consumers merge the arrays by (pageIndex, rect.y).
      const placedOut: PlacedRect[] = []
      const newCache: WalkCacheEntry[] = []
      // #58 — the page→section map: pageSections[p] = the section whose
      // FRAME the page wears (size/contentBox/bands). FIRST-WRITE-WINS:
      // the section active when the page's first content lands owns the
      // page. A nextPage boundary's fresh page is written by its first
      // block (the new section); an overflow page by the continuing
      // block (the same section); a CONTINUOUS boundary's shared page
      // keeps the OPENER's frame (the new section's blocks flow within
      // it — later spans never overwrite). Holes (a boundary-closed
      // page no block spans) cannot occur below maxPage — every
      // materialized page holds a line from some block.
      const pageSections: number[] = []

      // Lemma 1: unchanged blocks + identical entry states ⇒ identical
      // outputs — the prefix is reused directly. (optsHash covers the
      // sections table, so the prefix's geometry sequence is identical
      // by construction.)
      for (let i = 0; i < resume; i++) {
        lines.push(...oldCache[i]!.lineBoxes)
        breaks.push(...oldCache[i]!.breaks)
        placedOut.push(...oldCache[i]!.placedRects)
        newCache.push(oldCache[i]!)
        for (
          let p = oldCache[i]!.entryState.pageIndex;
          p <= oldCache[i]!.exitState.pageIndex;
          p++
        ) {
          if (pageSections[p] === undefined) pageSections[p] = oldCache[i]!.section
        }
      }

      // The walk state entering block `resume`, reconstructed from the
      // prefix: the predecessor's machine exit plus its breakAfter
      // close (a cursor transform).
      const startState: WalkState = (() => {
        if (resume === 0) return { pageIndex: 0, column: 0, y: 0 }
        // #74 — the column count of the predecessor's section (its grid
        // governs the breakAfter-'column' transform).
        return cursorAfter(
          doc.blocks[resume - 1],
          oldCache[resume - 1].exitState,
          columnCountOf(oldCache[resume - 1].section),
        )
      })()

      const walked = new Set<number>()
      // Bounded enforcement: one attempt per bond (keyed by the
      // predecessor's index) per call.
      const bondAttempts = new Set<number>()

      // #58 — the ACTIVE section entering block `resume`: the last
      // section whose start block index <= resume (section 0 starts at
      // block 0; a boundary exactly at resume applies when the loop
      // enters it).
      let sectionCursor = 0
      for (let k = 1; k < sectionTable.length; k++) {
        if ((sectionStartBlock[k] ?? Number.MAX_SAFE_INTEGER) <= resume) sectionCursor = k
      }

      // #74 — the WRAP WIDTH is the grid's NARROWEST column (equal-width
      // grids — the default — wrap at each column's width exactly; a
      // custom-widths grid wraps conservatively so every slot holds the
      // lines — per-column re-wrapping is future work, documented). The
      // ENTRY column still anchors the tab-stop frames and the
      // reference right-edge below.
      const getLines = (index: number, column: number): LineResult[] => {
        const block = doc.blocks[index]
        const columnWidth = Math.min(...active.columnSlots.map((s) => s.width))
        // ATOMIC IMAGES (E-IMG-1): the image's single synthetic "line"
        // — INTERNAL, never emitted into lines[]. Feeding it through
        // the SAME machinery (countFitting, firstLineLands, fitsFresh)
        // means one derivation of the fit/bond rules, not a parallel
        // image copy of them. Not cached and never counted in
        // linesRebroken: an image never breaks lines, and its dims are
        // per-call arithmetic over (intrinsic × contentBox).
        if (block.kind === 'image') {
          const dims = imagePlacedSize(
            block.width,
            block.height,
            columnWidth,
            active.contentBox.height,
          )
          return [
            { start: 0, end: 0, segments: [], width: dims.width, height: dims.height, baseline: dims.height },
          ]
        }
        // M-EQ — the equation's single synthetic "line": the SAME
        // machinery as the image (one placement decision, bonds
        // degenerate safely, never emitted into lines[]), with two
        // deliberate inversions ruled in types.ts's EquationBlock doc:
        // dims come from the EquationMetrics PORT (derived facts, not
        // document data — the adapter is pure and cannot measure), and
        // there is NO fit-down (an equation is never rescaled — a
        // font-shrunk formula misrepresents the math). Over-tall throws
        // loud: taller than the content box can never fit ANY page
        // (the codeBlock taller-than-page ruling family's atomic
        // analog). Over-wide places as-is (Word's margin-bleed
        // convention — the rect centers and may go negative-x, the
        // frame floats already emit; the vertical band is wholly the
        // equation's, so no text ever overlaps it).
        if (block.kind === 'equation') {
          if (!equationMetrics) {
            throw new Error(
              `block "${block.id}": equation block but no equationMetrics port — ` +
                'the shell must pass createLayoutEngine({ metrics, equationMetrics })',
            )
          }
          const dims = equationMetrics.measure(block.latex, block.fontSize)
          if (dims.height > active.contentBox.height) {
            throw new EquationTooTallError(
              `block "${block.id}": equation renders ${dims.width}×${dims.height}px, taller than the ` +
                `${active.contentBox.height}px content box — it can never fit any page. Equations are never ` +
                'rescaled (the no-fit-down ruling); shorten the formula or reduce its font size',
            )
          }
          return [
            { start: 0, end: 0, segments: [], width: dims.width, height: dims.height, baseline: dims.height },
          ]
        }
        // M-TABLES — the table's BAND results: one synthetic LineResult
        // per row-band (height = the band's flow height, tableBand =
        // the ready-to-emit data). The whole table computation
        // (tracks, cell line stacks, row heights, rowspan
        // distribution, band splitting) runs under the SAME lineCache
        // entry as prose lines — keyed by (contentHash, the wrap
        // width, AND the content-box height: the monster-row
        // fragmentation threshold and the rowspan distribution are
        // height-dependent, a text block's lines are not).
        if (block.kind === 'table') {
          const cached = lineCache.get(block.id)
          const hash = hashes[index]
          if (
            cached &&
            cached.contentHash === hash &&
            cached.maxWidth === columnWidth &&
            cached.contentHeight === active.contentBox.height
          ) {
            return cached.lines
          }
          const layout = computeTableLayout(
            block,
            columnWidth,
            active.contentBox.height,
            metrics,
            doc.baseStyle,
          )
          lineCache.set(block.id, {
            contentHash: hash,
            maxWidth: columnWidth,
            firstMaxWidth: columnWidth,
            contentHeight: active.contentBox.height,
            lines: layout.results,
          })
          stats.linesRebroken += 1
          return layout.results
        }
        // M-REFS — the reference table's ENTRIES: one breaker call per
        // entry (the entry's own wrap width = the block wrap width −
        // the entry's indentLeft), flattened into per-LINE results
        // carrying `referenceLine` (the emit branch's rect-x source +
        // the shell's sidecar join). The entry's runs are COMPLETE
        // line content — text runs, the tab run, the page-number run —
        // so the ONE breaker + the ONE tab machinery break, wrap, and
        // right-align the number; the arm supplies the RIGHT tab stop
        // at the shared text edge (content-frame: active.contentBox.width −
        // indentRight), which every entry's number aligns to whatever
        // its level. LOUD SEAM: an entry indent at/past its wrap width
        // is refused — a zero-width lane cannot break (the adapter
        // clamps, the warned-clamp family). Cache: the text kinds'
        // key (hash + maxWidth) — entry indents ride the hash,
        // firstLineIndent is refused by validation, so firstMaxWidth ≡
        // maxWidth for this kind.
        if (block.kind === 'referenceTable') {
          // #74 — entries wrap at the ENTRY column's width; the right
          // tab stop anchors the page numbers at the COLUMN's right edge
          // (tabLeft carries the column offset — stops resolve in the
          // content frame, the breaker's pen + tabLeft law).
          const colLeft = active.columnSlots[column]!.x
          const maxWidth = columnWidth - (block.indentLeft ?? 0) - (block.indentRight ?? 0)
          const cached = lineCache.get(block.id)
          const hash = hashes[index]
          if (cached && cached.contentHash === hash && cached.maxWidth === maxWidth) {
            return cached.lines
          }
          const results: LineResult[] = []
          let runStart = 0
          let textStart = 0
          for (let e = 0; e < block.entries.length; e++) {
            const entry = block.entries[e]
            const entryIndent = (block.indentLeft ?? 0) + (entry.indentLeft ?? 0)
            const entryWidth = maxWidth - (entry.indentLeft ?? 0)
            if (entryWidth <= 0) {
              throw new Error(
                `block "${block.id}" entry ${e}: indentLeft ${entry.indentLeft ?? 0} leaves a ` +
                  `${entryWidth}px wrap width — a zero-width lane cannot break; the adapter must ` +
                  'validate before sending',
              )
            }
            const lines = breakLines(entry.runs, metrics, entryWidth, doc.baseStyle, entryWidth, {
              // The entry's EVERY line sits at its own indent (first ≡
              // rest — the block-tier firstLineIndent is refused);
              // stops resolve in the CONTENT frame (pen + tabLeft), so
              // the right stop lands the number's END at the column's
              // right edge − indentRight regardless of the entry's level.
              first: colLeft + entryIndent,
              rest: colLeft + entryIndent,
              stops: [
                { position: colLeft + columnWidth - (block.indentRight ?? 0), alignment: 'right' },
              ],
            })
            for (const line of lines) {
              results.push({
                start: textStart + line.start,
                end: textStart + line.end,
                width: line.width,
                height: line.height,
                baseline: line.baseline,
                segments: line.segments.map((seg) => ({
                  runIndex: runStart + seg.runIndex,
                  start: textStart + seg.start,
                  end: textStart + seg.end,
                  x: seg.x,
                })),
                referenceLine: { entryIndex: e, x: entryIndent },
              })
            }
            // Canonical order advance: entries in array order, runs in
            // array order — the SAME concatenation AdapterBlock.text
            // mirrors (an inline object token is one position, the
            // E-IMG-2 receipt).
            for (const run of entry.runs) {
              runStart += 1
              textStart += run.kind === 'inlineImage' ? 1 : run.text.length
            }
          }
          lineCache.set(block.id, {
            contentHash: hash,
            maxWidth,
            firstMaxWidth: maxWidth,
            lines: results,
          })
          stats.linesRebroken += 1
          return results
        }
        // INDENT FAMILY, effect 1 (line breaking): base lines wrap at
        // the ENTRY COLUMN's width − indentLeft − indentRight; ONLY line 0
        // wraps at that − firstLineIndent — a NEGATIVE firstLineIndent
        // under a larger indentLeft is the hanging style, so line 0 can
        // wrap WIDER. The cache key stores BOTH widths: a re-layout under
        // different indents (same content) must re-break even before the
        // hash misses.
        const maxWidth = columnWidth - (block.indentLeft ?? 0) - (block.indentRight ?? 0)
        const firstMaxWidth = maxWidth - (block.firstLineIndent ?? 0)
        const cached = lineCache.get(block.id)
        const hash = hashes[index]
        if (
          cached &&
          cached.contentHash === hash &&
          cached.maxWidth === maxWidth &&
          cached.firstMaxWidth === firstMaxWidth
        ) {
          return cached.lines
        }
        // Kind routes the breaker: codeBlock breaks under source-line
        // semantics (explicit newlines honored, greedy character soft
        // wrap, whitespace preserved); paragraph/heading break at
        // spaces. Both produce LineResults consumed by the same
        // placement machine — code fragments BETWEEN lines exactly
        // like a paragraph (orphan/widow rules apply; the indent
        // family is block geometry for every kind).
        const results =
          block.kind === 'codeBlock'
            ? breakCodeLines(block.runs, metrics, maxWidth, doc.baseStyle, firstMaxWidth)
            : breakLines(block.runs, metrics, maxWidth, doc.baseStyle, firstMaxWidth, {
                // M-RULER Phase 4: tab stops resolve in the COLUMN
                // frame (#74 — each column re-anchors the grid; column
                // left ≡ content-box left single-column, so existing
                // docs parse identically) — line 0's left edge sits
                // indentLeft + firstLineIndent into it (the hanging
                // seam), later lines at indentLeft. The stops ride
                // the block (normalized by the adapter).
                first:
                  active.columnSlots[column]!.x +
                  (block.indentLeft ?? 0) +
                  (block.firstLineIndent ?? 0),
                rest: active.columnSlots[column]!.x + (block.indentLeft ?? 0),
                stops: block.tabStops,
              })
        lineCache.set(block.id, {
          contentHash: hash,
          maxWidth,
          firstMaxWidth,
          lines: results,
        })
        stats.linesRebroken += 1
        return results
      }

      const controlOf = (block: Block): boolean =>
        block.flow?.widowControl ?? opts.preventWidowsAndOrphans ?? true

      // Truncate the walk to index i (popping re-placed blocks' outputs)
      // and commit the entry — cascade unwinds go through here.
      const commit = (index: number, entry: WalkCacheEntry): void => {
        while (newCache.length > index) {
          const popped = newCache.pop()!
          lines.length -= popped.lineBoxes.length
          breaks.length -= popped.breaks.length
          placedOut.length -= popped.placedRects.length
        }
        newCache.push(entry)
        lines.push(...entry.lineBoxes)
        breaks.push(...entry.breaks)
        placedOut.push(...entry.placedRects)
      }

      let state: WalkState = startState
      let i = resume
      while (i < doc.blocks.length) {
        const block = doc.blocks[i]

        // ── #58 SECTION TIER (precedence 0 — BEFORE breakBefore) ──
        // The boundary closes a non-fresh page (the SAME law as a
        // forced break) and swaps the active geometry. Consecutive
        // boundaries (an empty middle section) apply in order — the
        // closes are idempotent, the geometry swaps through.
        // CONTINUOUS: a 'continuous' boundary does NOT close — the
        // sections share the page — UNLESS the new section's geometry
        // differs, which upgrades to a page start (Word's documented
        // behavior; a page cannot hold two geometries — the
        // one-geometry-per-page law; same-page sections simply share
        // the frame, so only an IDENTICAL geometry flows on).
        while (
          sectionCursor + 1 < sectionTable.length &&
          (sectionStartBlock[sectionCursor + 1] ?? Number.MAX_SAFE_INTEGER) <= i
        ) {
          const next = sectionTable[sectionCursor + 1]!
          // The crossed boundary's type: boundaries[k] = section k's
          // START (boundaries[0] = the doc start — never crossed here,
          // the loop applies k ≥ 1).
          const continuous =
            (boundaries[sectionCursor + 1]?.type ?? 'nextPage') === 'continuous' &&
            next.size.width === active.size.width &&
            next.size.height === active.size.height &&
            next.contentBox.x === active.contentBox.x &&
            next.contentBox.y === active.contentBox.y &&
            next.contentBox.width === active.contentBox.width &&
            next.contentBox.height === active.contentBox.height &&
            // #74 — the COLUMN GRID is geometry too: a continuous
            // 1-col → 2-col boundary upgrades to a page start (a page
            // cannot hold two grids — the one-geometry-per-page law).
            stableStringify(next.columnSpec) === stableStringify(active.columnSpec)
          if (!continuous && state.y > 0) state = { pageIndex: state.pageIndex + 1, column: 0, y: 0 }
          sectionCursor += 1
        }
        // The OUTER binding — getLines/placeFloat close over it; an
        // inner const would shadow and starve them of the swap.
        active = sectionTable[sectionCursor]!

        // STRUCTURAL TIER (precedence 1): breakBefore closes a
        // non-fresh page/slot; a fresh start is a no-op. Emits no
        // FragmentBreak (not a mid-block split). 'page' → column 0 of
        // the next page; 'column' (#74) → the next SLOT (next column,
        // else next page — the manual column break, Word's
        // newsletter-flow early wrap).
        if (block.flow?.breakBefore === 'page' && state.y > 0) {
          state = { pageIndex: state.pageIndex + 1, column: 0, y: 0 }
        } else if (block.flow?.breakBefore === 'column' && state.y > 0) {
          state = nextSlotState(state, active.columnSlots.length)
        }

        // Headings route through breakLines exactly like paragraphs —
        // heading entries in the walk cache are load-bearing.
        // TODO(adapter): level-based default styles arrive from the
        // ADAPTER; level is not a layout input here.
        const entryState = state
        // ANCHORED FLOAT (E-IMG-3, v1 wrap NONE): a floated image
        // enters the SAME walk machine but never placeBlock — zero
        // flow presence (the full model comment lives at placeFloat).
        // getLines is skipped entirely: no synthetic line, nothing to
        // fit, nothing to bond (validateFloatFlow refused flow).
        const floated = block.kind === 'image' && block.float != null
        const results: readonly LineResult[] = floated ? [] : getLines(i, entryState.column)
        // M-TABLES: the R2/R3 boundary minimums (orphan/widow) never
        // apply BETWEEN a table's bands — rows break naturally (Word
        // has no widow control on table rows; "keep rows together" is
        // keepLines, which R-ATOMIC already honors band-wise). The
        // bond lookahead's control for a table successor must match
        // (the prediction mirrors the machine).
        const control = block.kind === 'table' ? false : controlOf(block)
        const next = doc.blocks[i + 1]
        const bondExists =
          !floated &&
          next !== undefined &&
          (block.flow?.keepNext === true || next.flow?.keepPrevious === true)
        // #58: a CLOSING section boundary between the bonded pair drops
        // it at detection (the same law as a forced break — B's section
        // starts a fresh page; A's last fragment cannot share it). A
        // CONTINUOUS boundary with an identical geometry keeps the bond
        // (the sections share the page).
        const nextIsClosingBoundary =
          sectionCursor + 1 < sectionTable.length &&
          (sectionStartBlock[sectionCursor + 1] ?? Number.MAX_SAFE_INTEGER) === i + 1 &&
          !(() => {
            if ((boundaries[sectionCursor + 1]?.type ?? 'nextPage') !== 'continuous') return false
            const next = sectionTable[sectionCursor + 1]!
            return (
              next.size.width === active.size.width &&
              next.size.height === active.size.height &&
              next.contentBox.x === active.contentBox.x &&
              next.contentBox.y === active.contentBox.y &&
              next.contentBox.width === active.contentBox.width &&
              next.contentBox.height === active.contentBox.height &&
              // #74 — the column grid joins the geometry comparison
              // (the continuous-upgrade law above).
              stableStringify(next.columnSpec) === stableStringify(active.columnSpec)
            )
          })()
        // #74 — ANY forced-break spelling at the boundary is structural
        // ('page' and 'column'; null/undefined count as unset — the PM
        // round-trip convention). Manual breaks outrank bonds: the drop
        // keeps the bounded-attempt machinery from fighting the break.
        const structural =
          bondExists &&
          (block.flow?.breakAfter != null ||
            next.flow?.breakBefore != null ||
            nextIsClosingBoundary)
        const bonded = bondExists && !structural

        let currentEntry = entryState
        let placed =
          block.kind === 'image' && block.float != null
            ? placeFloat(block, block.float, currentEntry, active.size, active.contentBox)
            : placeBlock(
                block, results, currentEntry, active.columnSlots, active.contentBox.height,
                control, bonded, false,
              )
        let movedViaShape1 = false

        // BOND-DROP HISTORY FLAG: a placement committed while its own
        // bond enforcement was dropped on a SPENT attempt is a
        // call-history-dependent outcome (see WalkCacheEntry.danced)
        // — the one non-Markov flavor the walk produces. Everything
        // else (shape-1/shape-2 moves, vacuous drops, still-violated
        // stays) is a pure function of (entry state, block, opts) and
        // replays identically in a fresh call.
        let danced = false

        if (structural) {
          // STRUCTURAL DROP (loud): breakBefore(B) or breakAfter(A) —
          // both spellings, symmetric — puts a forced break at the A→B
          // boundary. A page that must start with B cannot also start
          // with A's last fragment; the bond drops at detection, no
          // enforcement attempt. The drop does NOT preempt R3 (bonded
          // is false above): control returns to the widow rule —
          // pinned by the composed flow test (6/2, never 7/1).
        } else if (bonded) {
          // BOND LOOKAHEAD — A's placement consumes B's first-line
          // height via firstLineLands, the exact same rules the walk
          // applies (see its comment for the full arm list). #74: the
          // lookahead breaks B at the width of the column B ENTERS
          // (A's exit slot).
          const nextLines = getLines(i + 1, placed.exitState.column)
          const lands = firstLineLands(
            next, nextLines, placed.exitState, active.contentBox.height,
            next.kind === 'table' ? false : controlOf(next),
            active.columnSlots.length,
          )
          if (!lands) {
            if (!bondAttempts.has(i)) {
              bondAttempts.add(i)
              const fitsFresh =
                countFitting(results, 0, active.contentBox.height) === results.length
              if (fitsFresh && entryState.y > 0) {
                // SHAPE 1 (R1 shape): move A's start to the fresh page.
                // #74: a PAGE move — column 0 of the next page.
                currentEntry = { pageIndex: entryState.pageIndex + 1, column: 0, y: 0 }
                placed = placeBlock(
                  block, results, currentEntry, active.columnSlots, active.contentBox.height,
                  control, bonded, false,
                )
                movedViaShape1 = true
                // Still violated → bounded drop. A stays at the moved
                // page per the (f) ruling — no revert; the move was
                // unproductive but deterministic.
              } else if (!fitsFresh) {
                // SHAPE 2 (R3 shape): A tall → back the FINAL split
                // point up one line; A's last line joins B's page.
                // Floor: a single-line final fragment cannot back up
                // (placeBlock places it naturally) → bounded drop.
                // For an ATOMIC image A this shape is vacuous by
                // construction (n == 1, never splits) → bounded drop.
                placed = placeBlock(
                  block, results, currentEntry, active.columnSlots, active.contentBox.height,
                  control, bonded, true,
                )
              }
              // else: fitsFresh && entryState.y === 0 → VACUOUS
              // (impossible-after-move family): A already starts a
              // fresh page; moving re-creates the same situation
              // forever → the bond drops.
            } else {
              // SPENT-ATTEMPT DROP — the only history-dependent
              // outcome: the backward-cascade unwind re-walked this
              // block within the same call and the one-attempt
              // budget was gone. Flag the entry (never prefix-reused,
              // never spliced — a fresh call from the same entry
              // state would enforce with a fresh attempt instead).
              danced = true
            }
            // else: the attempt was already used this call → the
            // spent-attempt drop above (pinned by the composed
            // R2-re-fire flow test).
          }
        }

        commit(i, {
          blockId: block.id,
          contentHash: hashes[i],
          entryState: currentEntry,
          lineBoxes: placed.lineBoxes,
          breaks: placed.breaks,
          placedRects: placed.placedRects,
          exitState: placed.exitState,
          bonded,
          danced,
          section: sectionCursor,
        })
        // #58 — the block's page span belongs to its entry section;
        // FIRST-WRITE-WINS (the page-frame law above — a continuous
        // section's blocks flow inside the opener's frame).
        for (let p = currentEntry.pageIndex; p <= placed.exitState.pageIndex; p++) {
          if (pageSections[p] === undefined) pageSections[p] = sectionCursor
        }
        if (!walked.has(i)) {
          walked.add(i)
          stats.blocksWalked += 1
        }
        state = placed.exitState

        // STRUCTURAL: breakAfter closes the page after the block — the
        // closed page always holds this block's lines, never an empty
        // page; a trailing close never materializes a phantom page
        // (pages derive from the max line pageIndex). Emits no
        // FragmentBreak. 'page' → column 0 of the next page; 'column'
        // (#74) → the next SLOT (the block's own slot always holds its
        // lines — never vacuous, unlike breakBefore).
        if (block.flow?.breakAfter === 'page') {
          state = { pageIndex: state.pageIndex + 1, column: 0, y: 0 }
        } else if (block.flow?.breakAfter === 'column') {
          state = nextSlotState(state, active.columnSlots.length)
        }

        // BACKWARD CASCADE (shape-1 moves only — shape 2 moves no
        // start): moving B for bond(B→C) retro-violates bond(A→B); the
        // predecessor enforces in turn. Bounded: one attempt per bond;
        // the chain re-flows from the unwind point.
        if (movedViaShape1 && i > resume) {
          const prev = doc.blocks[i - 1]
          const prevEntry = newCache[i - 1]
          const prevBondActive =
            (prev.flow?.keepNext === true || block.flow?.keepPrevious === true) &&
            // Any forced-break spelling is structural (#74: 'page' and
            // 'column'; null/undefined count as unset).
            prev.flow?.breakAfter == null &&
            block.flow?.breakBefore == null
          if (
            prevBondActive &&
            firstPageOfOutputs(placed) !== lastPageOfEntry(prevEntry)
          ) {
            // bond (i-1 → i) violated → predecessor enforcement (one
            // attempt, keyed i-1).
            if (!bondAttempts.has(i - 1)) {
              const prevResults = getLines(i - 1, prevEntry.entryState.column)
              const prevFitsFresh =
                countFitting(prevResults, 0, active.contentBox.height) === prevResults.length
              const prevEntryState = prevEntry.entryState
              if (prevFitsFresh && prevEntryState.y > 0) {
                bondAttempts.add(i - 1)
                // Unwind: close the predecessor's entry page, re-place
                // it fresh. #74: a PAGE move (column 0).
                i -= 1
                state = { pageIndex: prevEntryState.pageIndex + 1, column: 0, y: 0 }
                continue
              }
              if (!prevFitsFresh) {
                // Predecessor tall → SHAPE 2 in place: its final split
                // backs up one line to join block i's fresh page. No
                // start moved → no further cascade.
                bondAttempts.add(i - 1)
                const prevPlaced = placeBlock(
                  prev,
                  prevResults,
                  prevEntryState,
                  active.columnSlots,
                  active.contentBox.height,
                  // M-TABLES: same table-aware control the walk used —
                  // the re-placement must mirror the machine exactly.
                  prev.kind === 'table' ? false : controlOf(prev),
                  true,
                  true,
                )
                commit(i - 1, {
                  blockId: prev.id,
                  contentHash: hashes[i - 1],
                  entryState: prevEntryState,
                  lineBoxes: prevPlaced.lineBoxes,
                  breaks: prevPlaced.breaks,
                  placedRects: prevPlaced.placedRects,
                  exitState: prevPlaced.exitState,
                  bonded: true, // this re-placement consumed block i's height
                  // Not danced: this shape-2 re-placement is part of a
                  // deterministic, fully replayable dance (the fresh
                  // call re-executes the same sequence with the same
                  // fresh attempts); only the spent-attempt drop is
                  // history-dependent.
                  danced: false,
                  // The cascade re-placement lives in block i's
                  // section (a boundary between them would have been
                  // structural — no shape-1 move to cascade).
                  section: sectionCursor,
                })
                state = prevPlaced.exitState
                continue // the loop re-places block i from the new state
              }
              // else: the predecessor already starts a fresh page —
              // vacuous. Drop the EARLIEST bond (maximal-suffix
              // give-up); block i stays at its moved position.
            }
            // else: bounded drop (attempt used).
          }
        }

        // SPLICE GATE. Consume cached entries while (entry state AND
        // id AND contentHash AND not-danced) verify. PROOF-PINNING:
        // exact === on the state floats is sound ONLY because warm
        // and cold walks execute the identical operation sequence
        // (same y-cursor additions, same order, same values); IEEE
        // guarantees bitwise-identical results. A refactor that
        // reorders accumulation breaks this proof silently — the
        // parity fuzzer is the tripwire. A gate FAILING on reordered
        // accumulation is merely a missed splice (safe); a gate
        // passing on unequal states is impossible under ===. The
        // `danced` refusal is the same discipline for the one
        // history-dependent placement flavor (see WalkCacheEntry).
        const preSpliceState = state
        let j = i + 1
        while (
          j < doc.blocks.length &&
          j < oldCache.length &&
          sameState(state, oldCache[j].entryState) &&
          doc.blocks[j].id === oldCache[j].blockId &&
          hashes[j] === oldCache[j].contentHash &&
          !oldCache[j].danced
        ) {
          lines.push(...oldCache[j].lineBoxes)
          breaks.push(...oldCache[j].breaks)
          placedOut.push(...oldCache[j].placedRects)
          newCache.push(oldCache[j])
          // #58 — the splice replays the page→section spans too (the
          // sections table is hash-identical — same geometry sequence).
          for (let p = oldCache[j].entryState.pageIndex; p <= oldCache[j].exitState.pageIndex; p++) {
            if (pageSections[p] === undefined) pageSections[p] = oldCache[j].section
          }
          // CURSOR RECONSTRUCTION: the cached exitState is the MACHINE
          // exit — a breakAfter close is a cursor transform applied by
          // the walk AFTER placement, not part of the record. Every
          // path that resumes the cursor from a cached exit must
          // re-apply the close, or the next block enters a stale
          // mid-page state. #74 — the transform needs the entry's
          // section grid (the 'column' close).
          state = cursorAfter(doc.blocks[j], oldCache[j].exitState, columnCountOf(oldCache[j].section))
          stats.blocksSpliced += 1
          j += 1
        }
        // The splice may not END on a bonded predecessor: its cached
        // placement consumed its successor's first-line height (the
        // bond lookahead), and the successor was NOT spliced — it
        // changed (or ended the run), so that context is stale. BOTH
        // signals tested: the cached bonded record (stale consumption
        // even if the edit removed the bond) AND the current bond
        // flags (a newly-added bond requires enforcement the cached
        // placement never performed). Un-consume trailing bonded
        // entries; the walk re-places them with a fresh lookahead.
        // Symmetric with the backward-resume rule at the prefix
        // boundary.
        while (
          j - 1 > i &&
          (bondExistsBetween(doc, j - 1) || oldCache[j - 1].bonded)
        ) {
          const popped = newCache.pop()!
          lines.length -= popped.lineBoxes.length
          breaks.length -= popped.breaks.length
          placedOut.length -= popped.placedRects.length
          stats.blocksSpliced -= 1
          j -= 1
        }
        if (j > i + 1) {
          // Remaining consumed entries chain exactly to the current
          // cursor (breakAfter closes re-applied).
          state = cursorAfter(doc.blocks[j - 1], newCache[newCache.length - 1].exitState, columnCountOf(newCache[newCache.length - 1].section))
        } else {
          // Nothing consumed (or all un-consumed): restore the
          // pre-splice cursor (includes a possible breakAfter close —
          // not recoverable from newCache's machine exits).
          state = preSpliceState
        }
        i = j
      }

      walkCache = newCache

      // Pages derived: every opened page holds >= 1 line OR >= 1
      // placed rect (slicer invariant; an image-only page must
      // materialize — a trailing image would otherwise vanish).
      // Empty doc → 1 page.
      let maxPage = 0
      for (const line of lines) if (line.pageIndex > maxPage) maxPage = line.pageIndex
      for (const brk of breaks) if (brk.pageIndex > maxPage) maxPage = brk.pageIndex
      for (const rect of placedOut) if (rect.pageIndex > maxPage) maxPage = rect.pageIndex
      const pages: PageGeometry[] = []
      for (let p = 0; p <= maxPage; p++) {
        // #58 — per-page geometry: the page's OWN section's size and
        // contentBox (uniform documents: every page is section 0).
        // pageSections has no holes below maxPage (every materialized
        // page holds a line from some block's span); the ?? guards a
        // defensive gap anyway.
        const sectionIndexOf = pageSections[p] ?? 0
        const sec = sectionTable[sectionIndexOf] ?? sectionTable[0]!
        pages.push(
          Object.freeze({
            index: p,
            size: sec.size,
            contentBox: sec.contentBox,
            sectionIndex: sectionIndexOf,
            // #74 — the page's column grid, engine-issued (the
            // contentBox law applied to columns): consumers read the
            // facts, never re-derive. Omitted on single-column pages
            // (the additive law — existing snapshots pinned on it).
            ...(sec.columnSlots.length > 1
              ? { columns: sec.columnSlots as ColumnSlot[] }
              : {}),
          }),
        )
      }

      // M-HEADER-FOOTER: the BAND EMISSION — per page, the active
      // class's blocks re-emit as echoes on every page (same logical
      // lines, `band`-tagged, never flow units). Page-relative band
      // tops: header anchors at the SECTION's anchorPx from the page
      // top; footer BOTTOM-anchors at anchorPx from the page bottom
      // (its top derives). rect stays CONTENT-BOX-RELATIVE (the
      // LineBox contract): header rect.y = anchor − contentBox.y
      // (negative — the float precedent made out-of-box coords
      // legal), footer rect.y = (page.height − anchor − footerHeight)
      // − contentBox.y. Consumers add contentBox.y themselves,
      // uniformly. #58: EVERY offset reads the PAGE's section (its
      // page height, anchor clamps, contentBox.y) — a mixed-geometry
      // document's bands sit in each section's own margins.
      if (
        bands &&
        sectionTable.some(
          (s) =>
            s.topBlocks.length > 0 ||
            s.bottomBlocks.length > 0 ||
            s.restTopBlocks.length > 0 ||
            s.restBottomBlocks.length > 0,
        )
      ) {
        const emitBands = (
          which: 'header' | 'footer',
          entries: { block: Block; results: LineResult[] }[],
          pageIndex: number,
          sec: ActiveSection,
        ): void => {
          if (entries.length === 0) return
          const height = sumHeight(entries)
          let y =
            which === 'header'
              ? sec.anchorTop - sec.contentBox.y
              : sec.size.height - sec.anchorBottom - height - sec.contentBox.y
          for (const { block, results } of entries) {
            for (let li = 0; li < results.length; li++) {
              const result = results[li]
              lines.push(
                freezeLineBox({
                  blockId: block.id,
                  lineIndex: li,
                  pageIndex,
                  rect: { x: 0, y, width: result.width, height: result.height },
                  baseline: result.baseline,
                  rangeStart: result.start,
                  rangeEnd: result.end,
                  segments: result.segments,
                  band: which,
                }),
              )
              y += result.height
            }
          }
        }
        for (let p = 0; p <= maxPage; p++) {
          const sec = sectionTable[pageSections[p] ?? 0] ?? sectionTable[0]!
          const isFirst = p === 0
          emitBands('header', isFirst ? sec.topBlocks : sec.restTopBlocks, p, sec)
          emitBands('footer', isFirst ? sec.bottomBlocks : sec.restBottomBlocks, p, sec)
        }
      }

      const didWork =
        stats.blocksWalked > 0 || stats.linesRebroken > 0 || stats.invalidated
      if (didWork && hadCall) {
        version += 1
      }
      hadCall = true

      currentStats = Object.freeze(stats)
      return { pages, lines, breaks, placed: placedOut, version }
    },

    get lastStats(): LastStats {
      return currentStats
    },
  }
}

/**
 * THE ONE horizontal-align derivation (M5.13): the x-offset of an
 * aligned rect of `placedWidth` within a content box of
 * `contentWidth`. Engine-owned and exported — the SHELL's paint and
 * caret MUST import this function, never re-derive: placed[].rect.x,
 * painted rects, and caret x agree by construction, not by
 * convention. `center` of the PLACED rect, not the intrinsic; left by
 * default. Un-clamped: a negative result is reachable only in
 * degenerate geometry (a placed rect wider than the box), placed
 * anyway per the R6 floor family.
 */
export function alignOffset(
  align: 'left' | 'center' | 'right',
  placedWidth: number,
  contentWidth: number,
): number {
  if (align === 'center') return (contentWidth - placedWidth) / 2
  if (align === 'right') return contentWidth - placedWidth
  return 0
}

/**
 * #74 COLUMNS — the ONE column-grid derivation (the engine owns this
 * math; the shell imports PageGeometry.columns, never re-derives).
 * Resolves a ColumnsSpec against the section's content width into one
 * slot per column, CONTENT-BOX-relative. Absent spec ≡ ONE full-width
 * slot (the additive law). LOUD on invalid specs (the adapter-contract
 * backstop family): non-integer or < 1 count, negative gap, a
 * widths array whose length ≠ count or carrying negative weights, or
 * a gap that consumes the content box (no space left to divide).
 * Equal weights absent `widths`; else the weights are normalized
 * fractions of the post-gap space (relative, NOT px — the widths
 * reflow with the content box).
 */
function resolveColumnSlots(
  spec: ColumnsSpec | undefined,
  contentWidth: number,
): ColumnSlot[] {
  if (spec === undefined) return [Object.freeze({ x: 0, width: contentWidth }) as ColumnSlot]
  const { count, gap = DEFAULT_COLUMN_GAP, widths } = spec
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(
      `columns.count ${count} — not an integer >= 1; the adapter must validate before sending`,
    )
  }
  if (!(gap >= 0) || !Number.isFinite(gap)) {
    throw new Error(`columns.gap ${gap} — negative/invalid column gap; the adapter must validate before sending`)
  }
  if (widths !== undefined) {
    if (widths.length !== count) {
      throw new Error(
        `columns.widths.length ${widths.length} ≠ columns.count ${count}; the adapter must validate before sending`,
      )
    }
    if (widths.some((w) => !(w >= 0) || !Number.isFinite(w)) || widths.reduce((s, w) => s + w, 0) <= 0) {
      throw new Error(`columns.widths carry a negative/zero-sum weight; the adapter must validate before sending`)
    }
  }
  if (count === 1) return [Object.freeze({ x: 0, width: contentWidth }) as ColumnSlot]
  const available = contentWidth - gap * (count - 1)
  if (available <= 0) {
    throw new Error(
      `columns: gap ${gap} × ${count - 1} consumes the ${contentWidth}px content box — no space to divide; ` +
        'the adapter must validate before sending',
    )
  }
  const totalWeight = widths?.reduce((s, w) => s + w, 0)
  let x = 0
  const slots: ColumnSlot[] = []
  for (let c = 0; c < count; c++) {
    const width = widths === undefined ? available / count : (available * widths[c]!) / totalWeight!
    slots.push(Object.freeze({ x, width }) as ColumnSlot)
    x += width + gap
  }
  return slots
}

/**
 * Image fit-down (E-IMG-1): the block placement's box — the ENGINE owns
 * this math (two-sided law: the shell must never scale; it imports the
 * primitive). Delegates to fitDownImage (line-breaker.ts) — the ONE
 * scale primitive, extracted in E-IMG-2 so the INLINE clamp shares the
 * formula with the block fit-down: one scale, no forked math. The
 * E-IMG-1 rulings (zero-dim degrade, 1px floor) live at the primitive.
 */
function imagePlacedSize(
  width: number,
  height: number,
  contentWidth: number,
  contentHeight: number,
): { width: number; height: number } {
  return fitDownImage(width, height, contentWidth, contentHeight)
}

// BOND LOOKAHEAD — predicts whether a block's FIRST line lands on the
// entry PAGE, mirroring the placement machine's start decisions
// EXACTLY. The prediction must mirror "the same rules the walk
// applies" completely, or it isn't exact; every arm is listed:
//   - structural breakBefore: y > 0 → 'page' closes to the next page;
//     'column' (#74) closes to the next slot (the same page when a
//     column remains — the bond guards PAGE co-membership).
//   - spaceBefore is consumed at entry, shrinking the fit budget;
//     the y > 0 guards below test line-top presence (entry.y), not
//     the padded cursor — spaceBefore is not content.
//   - R0: the whole block fits → stays.
//   - fits == 0: content on the page → R1 closes → NEXT SLOT; fresh
//     slot → R6 places the first line by fiat → STAYS (degenerate: a
//     single line taller than the slot still lands on the entry slot —
//     the bond HOLDS).
//   - R2 orphan: fits == 1 && n > 1 && control && hasContent → next slot.
//   - R-ATOMIC: keepLines && n <= cap while the block doesn't fit →
//     next slot (cannot fire on a fresh slot: n <= cap means the
//     unpadded fresh slot fits the whole block, so R0 already fired —
//     with spaceBefore the hasContent guard pins it).
//   - otherwise: R3-adjusted/R5 splits place fits >= 1 FIRST lines on
//     the entry slot → stays (R3 never moves the start).
// #74 COLUMNS (the ruling, pinned by columns.test.ts): every slot move
// above lands on the NEXT SLOT — column+1 of the same page when one
// remains, else the next page. The BOND guards PAGE co-membership
// (Word: keep-with-next prevents PAGE breaks; a column close keeps
// both lines on the page), so each "moves" arm returns TRUE (lands)
// when another column remains on the entry page, FALSE otherwise.
function firstLineLands(
  block: Block,
  lines: readonly LineResult[],
  entry: WalkState,
  contentHeight: number,
  control: boolean,
  columnCount: number,
): boolean {
  if (block.flow?.breakBefore === 'page' && entry.y > 0) return false
  const hasContent = entry.y > 0
  // The slot move's page answer: another column on this page, or wrap.
  const nextSlotSamePage = entry.column + 1 < columnCount
  // #74 — UNREACHABLE via the driver (a bond at a breakBefore boundary
  // is structural — dropped at detection) but kept for the mirror law:
  // the prediction must reproduce the machine for any block handed to
  // it. A 'column' break lands B in the next slot — the SAME page when
  // a column remains (the bond guards page co-membership).
  if (block.flow?.breakBefore === 'column' && entry.y > 0) return nextSlotSamePage
  const n = lines.length
  const fits = countFitting(lines, 0, contentHeight - entry.y - (block.spaceBefore ?? 0))
  if (fits >= n) return true
  if (fits === 0) return !hasContent || nextSlotSamePage
  if (fits === 1 && n > 1 && control && hasContent) return nextSlotSamePage
  const cap = countFitting(lines, 0, contentHeight)
  if (block.flow?.keepLines === true && n <= cap && hasContent) return nextSlotSamePage
  return true
}

// Kind-agnostic output-page reads for the bond cascade: an ATOMIC
// image block's outputs live in placedRects, not lineBoxes (images
// never enter lines[]). Every block emits at least one output — a
// text block always has lines, an image always has its one placed
// rect — so the fallback chain is total. The image's single "line"
// IS its rect for bond purposes (the ToF #31 dependency).
function firstPageOfOutputs(out: {
  lineBoxes: LineBox[]
  placedRects: PlacedRect[]
}): number {
  return out.lineBoxes.length > 0
    ? out.lineBoxes[0].pageIndex
    : out.placedRects[0].pageIndex
}

function lastPageOfEntry(entry: WalkCacheEntry): number {
  return entry.lineBoxes.length > 0
    ? entry.lineBoxes[entry.lineBoxes.length - 1].pageIndex
    : entry.placedRects[entry.placedRects.length - 1].pageIndex
}

// Cursor reconstruction: the walk applies a block's breakAfter close
// AFTER placement as a cursor transform — the cached exitState is the
// MACHINE exit. Every path that resumes the cursor from a cached exit
// must re-apply the close, or the next block enters a stale mid-page
// state (a parity bug the fuzzer caught). #74: the 'column' transform
// needs the grid the block lived in — call sites pass
// columnCountOf(entry.section) (the cached entry records its section).
function cursorAfter(block: Block, exit: WalkState, columnCount: number): WalkState {
  if (block.flow?.breakAfter === 'page') {
    return { pageIndex: exit.pageIndex + 1, column: 0, y: 0 }
  }
  if (block.flow?.breakAfter === 'column') {
    return nextSlotState(exit, columnCount)
  }
  return exit
}

// #74 COLUMNS — the ONE slot-close derivation: the next flow slot, the
// next column first, else the next page (column 0). placeBlock's
// closeSlot, the driver's structural 'column' closes, and cursorAfter's
// breakAfter-'column' transform all route through it — one arithmetic,
// the single-derivation posture (parity requires bit-identical closes).
function nextSlotState(state: WalkState, columnCount: number): WalkState {
  if (state.column + 1 < columnCount) {
    return { pageIndex: state.pageIndex, column: state.column + 1, y: 0 }
  }
  return { pageIndex: state.pageIndex + 1, column: 0, y: 0 }
}

// Bond flags between blocks[i] and blocks[i+1] (either spelling).
function bondExistsBetween(doc: SemanticDoc, i: number): boolean {
  const a = doc.blocks[i]
  const b = doc.blocks[i + 1]
  if (a === undefined || b === undefined) return false
  return a.flow?.keepNext === true || b.flow?.keepPrevious === true
}

// The placement machine. PURE: a function of (block, LineResults,
// entry state, the section's column grid, the slot height, widow
// control, bond context, split backup) — the Markov property made
// physically true of the code.
// `bonded` (an ACTIVE bond to the successor) preempts R3: when the
// bond already relocates A's last line onto B's page, the widow
// concern is void. `backupFinalSplit` is the one-shot shape-2 hook:
// the FINAL fragment places one line fewer, so A's last line opens
// the successor's page.
// ATOMIC IMAGES (E-IMG-1): an image arrives as ONE synthetic
// LineResult carrying its FINAL placed dims (fit-down already
// applied — the engine owns that math), so the whole rule family
// degenerates safely: R0 places it, R1/R6 close-or-floor, and R2/R3/
// R-ATOMIC can never fire (n == 1). Exactly one placement decision,
// never fragmented. The EMIT branch swaps the record kind: an image
// produces a frozen PlacedRect (never a LineBox — images don't enter
// lines[]), with rect.x from the shared alignOffset — the same
// function the shell's paint/caret consume (M5.13). The indent family
// is wrap geometry and is IGNORED for images; keepLines on an image
// is vacuous by construction.
function placeBlock(
  block: Block,
  results: readonly LineResult[],
  entryState: WalkState,
  /** #74 — the section's resolved column grid (one slot per column). */
  columnSlots: readonly ColumnSlot[],
  contentHeight: number,
  control: boolean,
  bonded: boolean,
  backupFinalSplit: boolean,
): { lineBoxes: LineBox[]; breaks: FragmentBreak[]; placedRects: PlacedRect[]; exitState: WalkState } {
  const L = results.length
  // M-TABLES: the table's header machinery — the LEADING header bands
  // re-emit at the top of every continuation page (Word's "Repeat
  // Header Rows"). pendingHeader is set by closePage and fired lazily
  // by the first CONTENT band's placement on the fresh page: a close
  // whose continuation never places (a trailing close) emits nothing,
  // and the R6 floor (below) drops the repeat for a monster band that
  // cannot share a page with the header.
  const isTable = block.kind === 'table'
  const headerCount = isTable
    ? (() => {
        let n = 0
        for (const r of results) {
          if (!r.tableBand?.isHeader) break
          n += 1
        }
        return n
      })()
    : 0
  const headerHeight = isTable
    ? results.slice(0, headerCount).reduce((sum, r) => sum + r.height, 0)
    : 0
  let pendingHeader = false
  // How many of THIS block's lines a fresh page holds — only the R4
  // exemption test and R-ATOMIC's n <= cap check consume it. For a
  // table, a continuation page's fresh budget shrinks by the repeated
  // headers (conservative on the first page, where the headers are
  // part of the sequence itself).
  const cap = countFitting(results, 0, isTable ? contentHeight - headerHeight : contentHeight)
  const lineBoxes: LineBox[] = []
  const breaks: FragmentBreak[] = []
  const placedRects: PlacedRect[] = []
  let { pageIndex, column, y } = entryState
  // #74 COLUMNS — the machine is SLOT-aware: `column` is the current
  // flow slot (lines break ONCE at the ENTRY slot's width — the
  // getLines law; a fragment landing in another width of a custom
  // widths[] grid places at the broken width, documented). The
  // current slot's left edge folds into every emitted rect.x (the
  // engine emits COLUMN-offset rects — the shell stays column-blind
  // for everything rect-driven); the `column` field rides LineBoxes
  // iff the grid carries more than one column (the additive law).
  const multiColumn = columnSlots.length > 1
  const colLeft = (): number => columnSlots[column]!.x

  // SPACE-BEFORE (block entry, applied ONCE): the first line's top
  // is pushed down by spaceBefore, so every fit count below evaluates
  // against the line tops. The y > 0 loop-freedom guards test
  // `hasContent` — whether the page already holds LINE tops — NOT the
  // spaceBefore-padded cursor: spaceBefore is not content, and a page
  // holding only spaceBefore is still fresh (closing it would violate
  // the never-empty-page invariant). A page close mid-machine (R1/R2/
  // R-ATOMIC/fragment) never re-applies spaceBefore: it was consumed
  // here, and closePage resets the cursor to a bare page top.
  let hasContent = entryState.y > 0
  y += block.spaceBefore ?? 0

  // INDENT FAMILY, effect 2 (placement): a line's rect.x is its
  // effective left edge and its width is the line's measured width —
  // produced by that line's wrap width, so rect.x and the wrap shift
  // together. indentLeft/indentRight are per-line horizontal
  // geometry: every fragment keeps them. firstLineIndent is the
  // one-shot member — the CONTINUATION RULE mirrors spaceBefore's:
  // lineIndex 0 (the block's true start, wherever the start rules
  // put it) sits at indentLeft + firstLineIndent and WRAPPED at that
  // width; every later line — including every line of a continuation
  // fragment on a later page — resumes at the BASE edge indentLeft.
  // validateIndentGeometry guarantees the line-0 edge is ≥ 0.
  const baseLeft = block.indentLeft ?? 0
  const firstLeft = baseLeft + (block.firstLineIndent ?? 0)
  // #74 — the ENTRY slot's width positions aligned atomic blocks and
  // the table box (the getLines wrap-width law's placement twin).
  const entryWidth = columnSlots[entryState.column]!.width
  // IMAGE / EQUATION EMIT GEOMETRY: align positions the PLACED rect
  // within the ENTRY COLUMN via the shared alignOffset (center of
  // the placed rect, not the intrinsic). Computed once — an atomic
  // visual block is one line. Equations default 'center' (Word's
  // display-equation convention; images default 'left').
  const imageLeft =
    block.kind === 'image'
      ? alignOffset(block.align ?? 'left', results[0].width, entryWidth)
      : block.kind === 'equation'
        ? alignOffset(block.align ?? 'center', results[0].width, entryWidth)
        : 0
  // TABLE EMIT GEOMETRY: the table sits inside its MARGINED box — the
  // left margin first, then the shared alignOffset over the tracks'
  // total within the box (entryWidth − mL − mR). The band data is
  // TABLE-relative; the emit adds the table's x and the band top.
  const tableMarginL = block.kind === 'table' ? Math.max(0, block.margin?.left ?? 0) : 0
  const tableMarginR = block.kind === 'table' ? Math.max(0, block.margin?.right ?? 0) : 0
  const tableX =
    block.kind === 'table'
      ? tableMarginL +
        alignOffset(
          block.align ?? 'left',
          results[0]?.width ?? entryWidth,
          entryWidth - tableMarginL - tableMarginR,
        )
      : 0
  // The BAND emit (M-TABLES): the band's cell lines are PARALLEL
  // LineBoxes (same band y, one lane per column — the contiguity
  // contract is band-wise, paint.ts) and the cell rect slices ride
  // placed[] (kind 'tableCell' — paint geometry, not flow).
  const placeBands = (from: number, count: number): void => {
    for (let i = from; i < from + count; i++) {
      const result = results[i]
      const band = result?.tableBand
      if (!band) continue
      // #74 — band lanes/fills carry the CURRENT slot's left edge (a
      // table fragmenting across columns tiles band-wise into the
      // grid; the table x stays the entry-column approximation).
      const x0 = colLeft() + tableX
      for (const l of band.lines) {
        lineBoxes.push(
          freezeLineBox({
            blockId: block.id,
            lineIndex: l.lineIndex,
            pageIndex,
            ...(multiColumn ? { column } : {}),
            rect: {
              x: x0 + l.x,
              y: y + l.y,
              width: l.width,
              height: l.height,
            },
            baseline: l.baseline,
            rangeStart: l.rangeStart,
            rangeEnd: l.rangeEnd,
            segments: l.segments,
            tableCell: { row: l.row, col: l.col, width: l.laneWidth },
          }),
        )
      }
      for (const r of band.rects) {
        placedRects.push(
          freezePlacedRect({
            blockId: block.id,
            kind: 'tableCell',
            pageIndex,
            rect: { x: x0 + r.x, y: y + r.y, width: r.width, height: r.height },
            cell: {
              fill: r.fill,
              border: r.border,
              colspan: r.colspan,
              rowspan: r.rowspan,
              row: r.row,
              col: r.col,
            },
          }),
        )
      }
      y += result.height
      hasContent = true
    }
  }
  const place = (from: number, count: number): void => {
    // HEADER REPEAT (lazy): the first content band's placement on a
    // page that was just closed fires the pending header bands first.
    // The repeats are the same logical lines (same lineIndex/ranges)
    // re-emitted — echoes, not new flow units. from === 0 = the
    // sequence's OWN header bands (the table's first page after an
    // R1 close) — they cover the repeat, clear the flag.
    if (isTable && pendingHeader) {
      pendingHeader = false
      if (from !== 0) placeBands(0, headerCount)
    }
    if (isTable) {
      placeBands(from, count)
      return
    }
    for (let i = from; i < from + count; i++) {
      const result = results[i]
      if (block.kind === 'image') {
        // The ATOMIC emit: a PlacedRect, never a LineBox. src/alt are
        // opaque echoes — the engine never interprets them. #74: the
        // rect carries the CURRENT slot's left edge (a fit-failure
        // close moves the image to the next slot before R6 places).
        placedRects.push(
          freezePlacedRect({
            blockId: block.id,
            kind: 'image',
            src: block.src,
            alt: block.alt,
            pageIndex,
            rect: { x: imageLeft + colLeft(), y, width: result.width, height: result.height },
          }),
        )
      } else if (block.kind === 'equation') {
        // M-EQ — the equation's ATOMIC emit: the same shape as the
        // image's, with latex/fontSize echoing instead of src/alt (the
        // shell's EquationLayer re-renders the math from them — paint
        // data is the shell's to resolve). No z/float: equations are
        // in-flow by construction.
        placedRects.push(
          freezePlacedRect({
            blockId: block.id,
            kind: 'equation',
            latex: block.latex,
            fontSize: block.fontSize,
            pageIndex,
            rect: { x: imageLeft + colLeft(), y, width: result.width, height: result.height },
          }),
        )
      } else if (block.kind === 'referenceTable') {
        // M-REFS — the entry line's rect.x is its ENTRY's left edge
        // (the per-line referenceLine.x — the block tier's
        // baseLeft/firstLeft don't apply: the indent lives per entry,
        // the same ruling that gave tables their band emitter). #74:
        // + the current slot's left edge.
        const ref = result.referenceLine
        if (!ref) {
          throw new Error(
            `block "${block.id}" line ${i}: referenceTable line carries no referenceLine ` +
              'payload — the getLines arm must tag every entry line',
          )
        }
        lineBoxes.push(
          freezeLineBox({
            blockId: block.id,
            lineIndex: i,
            pageIndex,
            ...(multiColumn ? { column } : {}),
            rect: {
              x: colLeft() + ref.x,
              y,
              width: result.width,
              height: result.height,
            },
            baseline: result.baseline,
            rangeStart: result.start,
            rangeEnd: result.end,
            segments: result.segments,
          }),
        )
      } else {
        lineBoxes.push(
          freezeLineBox({
            blockId: block.id,
            lineIndex: i,
            pageIndex,
            ...(multiColumn ? { column } : {}),
            rect: { x: colLeft() + (i === 0 ? firstLeft : baseLeft), y, width: result.width, height: result.height },
            baseline: result.baseline,
            rangeStart: result.start,
            rangeEnd: result.end,
            segments: result.segments,
          }),
        )
      }
      y += result.height
      hasContent = true
    }
  }

  // #74 — the SLOT close: the next flow slot, next column first, else
  // the next page (column 0) — via the ONE nextSlotState arithmetic.
  // Driver 'page' closes, section boundaries, and bond moves are PAGE
  // closes by law; the driver's structural 'column' closes route
  // through the same helper.
  const closeSlot = (): void => {
    const next = nextSlotState({ pageIndex, column, y: 0 }, columnSlots.length)
    pageIndex = next.pageIndex
    column = next.column
    y = 0
    hasContent = false
    if (isTable) pendingHeader = true
  }
  // The page the continuation begins on after the next close (a
  // column continuation keeps the page).
  const continuationPage = (): number =>
    column + 1 < columnSlots.length ? pageIndex : pageIndex + 1

  let k = 0
  while (k < L) {
    const n = L - k
    // M-TABLES: the fit budget reserves the pending header repeat's
    // height — the repeat fires BEFORE the content band on the fresh
    // page, so the fit must leave room for it.
    const headerBudget = isTable && pendingHeader ? headerHeight : 0
    let fits = countFitting(results, k, contentHeight - y - headerBudget)

    if (fits >= n) {
      if (backupFinalSplit && n > 1) {
        // SHAPE 2 (R3 shape): back the FINAL split point up one line —
        // A's last line opens the successor's slot.
        place(k, n - 1)
        k += n - 1
        // M-TABLES: atLine is the CONTINUATION's first content
        // lineIndex (the band's smallest canonical index) — the
        // repeated header lines are echoes of earlier pages, not the
        // continuation.
        breaks.push(
          Object.freeze({
            blockId: block.id,
            atLine: results[k]?.tableBand?.firstLineIndex ?? k,
            pageIndex: continuationPage(),
          }),
        )
        closeSlot()
        continue
      }
      place(k, n) // R0
      k = L
      continue
    }

    if (fits === 0) {
      if (hasContent) {
        closeSlot() // R1
        continue
      }
      // Fresh page. A pending header repeat shrank the budget above —
      // drop the repeat and refit before the R6 floor: a monster band
      // that cannot share a page with the repeated header gets the
      // page to itself (Word drops the repeat in the same situation).
      if (headerBudget > 0) {
        pendingHeader = false
        fits = countFitting(results, k, contentHeight - y)
      }
      if (fits === 0) fits = 1 // R6: a fresh slot always places one band/line
    }

    if (control && hasContent && fits === 1 && n > 1) {
      closeSlot() // R2 orphan: the block's start moves (#74: at COLUMN closes too — Word parity)
      continue
    }

    if (k === 0 && hasContent && block.flow?.keepLines === true && n <= cap) {
      closeSlot() // R-ATOMIC: keepLines moves the whole block
      continue
    }

    if (control && !bonded && n - fits === 1 && fits > 1) {
      fits -= 1 // R3 widow (bond preempts when ACTIVE)
      if (fits === 1 && hasContent && n > 1) {
        closeSlot() // re-check R2 (inherits its content guard)
        continue
      }
    }

    // R4 exemption / R5 natural split — `fits` already came from the
    // actual-height walk above.
    place(k, fits)
    k += fits
    if (k < L) {
      breaks.push(
        Object.freeze({
          blockId: block.id,
          atLine: results[k]?.tableBand?.firstLineIndex ?? k,
          pageIndex: continuationPage(),
        }),
      )
      closeSlot()
    }
  }

  // SPACE-AFTER: belongs to this block's exit cursor, so the NEXT
  // block's fits account for it (participates in fits). Never closes
  // a slot itself — only a line placement ever closes slots.
  y += block.spaceAfter ?? 0

  return { lineBoxes, breaks, placedRects, exitState: { pageIndex, column, y } }
}

// ANCHORED FLOAT (E-IMG-3, v1 wrap NONE) — the model, in one breath:
// moves-with-text comes free — the anchor is the block's flow
// position, so reflowing text repositions the float. Wrap modes
// (square/tight) are a FUTURE issue; v1 floats do not affect line
// breaking. z is PAINT ORDER, not layout.
//
// ZERO FLOW PRESENCE: the block contributes nothing to the flow — no
// height, no spaceBefore/After on the cursor, no fits, no bonds
// (loud seam: validateFloatFlow), no fragmentation. Its walk-cache
// entry is pure placement data: exitState === entryState,
// lineBoxes/breaks empty, the one PlacedRect the entire output. The
// rect is a PURE function of (entry state, block, opts) — the Markov
// property holds; nothing history-dependent (the 'danced' family is
// untouched).
//
// ANCHOR + ANCHOR-FRAGMENT RULING (spec item 8, ruled in the
// pre-coding presentation): the anchor is the flow position where the
// block would have started — the walk cursor at its doc position,
// plus spaceBefore (the y a non-floated image's rect would have
// begun at; the cursor itself never moves). A v1 float sits BETWEEN
// blocks, so that cursor is always at a LINE boundary: when the
// preceding (anchor) paragraph fragments across a page boundary, the
// cursor is by construction on the page of the fragment that ENDS
// the block — the float belongs to the fragment where that flow
// position lands, even when a negative dy visually drags the rect
// over text living on an EARLIER fragment's page. pageIndex resolves
// from the ANCHOR, never from the shifted rect.
//
// RECT DERIVATION: anchor + (dx, dy), clamped to the FULL PAGE BOX
// (margins included — the page is the canvas; a float may sit IN the
// margin), emitted CONTENT-BOX-RELATIVE like every PlacedRect — a
// float in the margin carries negative x/y (or x beyond the content
// width); one frame for the whole placed[] array. The clamp bounds
// are the page box expressed in the content frame (see below). Dims:
// the unchanged E-IMG-1 fit-down (content box — a float never
// outgrows what a block image could); anchor x via the shared
// alignOffset (align stays meaningful for floats; the indent family
// stays ignored, the image family rule), then dx.
//
// Degenerate guard: a page box narrower/shorter than the placed rect
// (negative margins) clamps to the page's left/top edge — the
// Math.max(hi, lo) family, deterministic, never a loop.
function placeFloat(
  block: ImageBlock,
  float: { dx: number; dy: number; z: 'front' | 'behind' },
  entry: WalkState,
  size: Rect,
  contentBox: Rect,
): { lineBoxes: LineBox[]; breaks: FragmentBreak[]; placedRects: PlacedRect[]; exitState: WalkState } {
  const dims = imagePlacedSize(block.width, block.height, contentBox.width, contentBox.height)
  const anchorX = alignOffset(block.align ?? 'left', dims.width, contentBox.width)
  const anchorY = entry.y + (block.spaceBefore ?? 0)
  // PAGE-BOX CLAMP, expressed in the CONTENT frame (the emitted frame):
  // the page box [0, size.width] × [0, size.height] maps to
  // [−contentBox.x, size.width − w − contentBox.x] etc., so a float may
  // sit anywhere in the page INCLUDING the margins (negative
  // content-relative coordinates). Computing and clamping in the
  // emitted frame directly avoids a page-frame round trip whose IEEE
  // rounding would perturb a dy=0/dx=0 rect off its anchor — the rect
  // must be BIT-IDENTICAL to the anchor + offset when no clamp fires.
  // Degenerate guard: a page box narrower/shorter than the placed rect
  // (negative margins) clamps to the page's left/top edge — the
  // Math.max(hi, lo) family, deterministic, never a loop.
  const clamp = (value: number, lo: number, hi: number): number =>
    Math.min(Math.max(value, lo), Math.max(hi, lo))
  const x = clamp(
    anchorX + float.dx,
    -contentBox.x,
    size.width - dims.width - contentBox.x,
  )
  const y = clamp(
    anchorY + float.dy,
    -contentBox.y,
    size.height - dims.height - contentBox.y,
  )
  const rect: Rect = { x, y, width: dims.width, height: dims.height }
  return {
    lineBoxes: [],
    breaks: [],
    placedRects: [
      freezePlacedRect({
        blockId: block.id,
        kind: 'image',
        src: block.src,
        alt: block.alt,
        pageIndex: entry.pageIndex,
        rect,
        float: { dx: float.dx, dy: float.dy },
        z: float.z,
      }),
    ],
    exitState: entry,
  }
}

// Enforced immutability at creation: freeze the record and its rect
// (leaf records — idempotent, one-time cost). Same posture as
// freezeLineBox: emitted PlacedRects are shared zero-copy across
// results and the walk cache. E-IMG-3: a floated rect's float echo is
// frozen with it.
function freezePlacedRect(placed: PlacedRect): PlacedRect {
  Object.freeze(placed.rect)
  if (placed.float !== undefined) Object.freeze(placed.float)
  return Object.freeze(placed)
}

// Enforced immutability at creation: freeze the record, its rect, and
// its segments (leaf records — idempotent, one-time cost).
function freezeLineBox(box: LineBox): LineBox {
  Object.freeze(box.rect)
  for (const segment of box.segments) Object.freeze(segment)
  Object.freeze(box.segments)
  return Object.freeze(box)
}

function sameState(a: WalkState, b: WalkState): boolean {
  return a.pageIndex === b.pageIndex && a.column === b.column && a.y === b.y
}

// ─── M-TABLES — TABLE LAYOUT ─────────────────────────────────────────
//
// THE MODEL (spec of record, mirrored in types.ts's TableBlock doc):
// the table's flow units are BANDS — a band is one row's line-grid
// slice. A cantSplit row (fits a page) is exactly ONE band (atomic);
// a split-allowed row (cantSplit unset — Word/GDocs' "allow row to
// break across pages" DEFAULT) and a monster row (taller than the
// content box) fragment into per-line-grid bands, the codeBlock
// taller-than-page ruling family. Bands tile the
// flow track exactly like lines (the contiguity contract holds
// band-wise); the cell LINES within a band are PARALLEL lanes that
// ride lines[] as ordinary LineBoxes carrying `tableCell` identity.
//
// TRACKS: the engine owns the derivation (two-sided law). Per column:
// any covering cell's colwidth entry; >1 distinct values = adapter
// contract violation (THROW — prosemirror-tables keeps column cells in
// sync, so a conflict is a bug, never clipped). No widths at all →
// equal tracks of the content box (the pageless width:100% +
// table-layout:fixed look). Fixed columns that would crowd the
// flexible ones below the track floor scale down proportionally
// (down-only; a table never overflows its content box in v1).
//
// ROWSPAN: a merged cell lays its line stack out at the union width;
// its requirement is distributed equally over the spanned rows' heights
// (pass 1), then its lines are placed BAND-ALIGNED by greedy fill — a
// line never straddles a band boundary; the band remainder is slack
// the cell fill covers. A fill that overflows its span grows the
// span's last band and the whole distribution re-runs (heights only
// grow — bounded at TABLE_FILL_PASSES, after which the R6 floor family
// owns the outcome).
//
// PADDING: CELL_PAD_H/CELL_PAD_V are the ENGINE's constants — the
// shell's painter imports them (one pad derivation, never two).

export const CELL_PAD_H = 8
export const CELL_PAD_V = 4
/** Track floor — prosemirror-tables' cellMinWidth default. */
export const CELL_MIN_TRACK = 25

/** Bounded re-fill passes for the rowspan line distribution. */
const TABLE_FILL_PASSES = 8

/** M-T4 — the engine's built-in cell padding (the inheritance floor). */
const DEFAULT_CELL_PAD = { top: CELL_PAD_V, right: CELL_PAD_H, bottom: CELL_PAD_V, left: CELL_PAD_H }

/**
 * M-T4 — per-side padding resolution: cell override ← table default ←
 * the engine constants. Negative sides clamp to 0 (the adapter clamps
 * too; this is the deterministic backstop).
 */
function resolveCellPad(cell: TableCellData, table: TableBlock): {
  top: number
  right: number
  bottom: number
  left: number
} {
  const t = table.cellPadding
  const c = cell.padding
  const pick = (v: number | null | undefined, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : d
  return {
    top: pick(c?.top, pick(t?.top, DEFAULT_CELL_PAD.top)),
    right: pick(c?.right, pick(t?.right, DEFAULT_CELL_PAD.right)),
    bottom: pick(c?.bottom, pick(t?.bottom, DEFAULT_CELL_PAD.bottom)),
    left: pick(c?.left, pick(t?.left, DEFAULT_CELL_PAD.left)),
  }
}

/** One anchored cell's prepared layout data. */
interface TableCellStack {
  /** Anchor row/col (grid identity). */
  row: number
  col: number
  colspan: number
  rowspan: number
  /** Union track width (sum of spanned tracks). */
  laneWidth: number
  /** The lane's left edge, TABLE-relative. */
  laneX: number
  /** M-T4 — the cell's RESOLVED padding (per-side, constants floored). */
  pad: { top: number; right: number; bottom: number; left: number }
  fill: string | null
  border: 'all' | 'none' | 'outer'
  /** Broken line stack — all paragraphs' lines, in order. */
  lines: LineResult[]
  /** Which paragraph owns each line (parallel to `lines`). */
  linePara: number[]
  /** Per-paragraph canonical bases (table-space text offsets / run indexes). */
  paraBases: { textStart: number; runStart: number }[]
  /** Canonical lineIndex base of this cell's lines. */
  lineIndexBase: number
  /** Sum of the stack's line heights (no padding). */
  contentHeight: number
}

interface TableBand {
  row: number
  height: number
  /**
   * The band's line lanes — parallel lanes (whole stacks for ordinary
   * rows; one line each for monster bands; distributed chunks for
   * rowspan cells). Canonical order at assembly.
   */
  lanes: { stack: TableCellStack; paraIndex: number; lineIndex: number; line: LineResult; y: number }[]
  /** First band of its row — the cell-top padding applies here. */
  isFirstOfRow: boolean
  isHeader: boolean
  /** The band's READY-TO-EMIT data (frozen). */
  data: TableBandData
  /** The band's covered text range (informational; the synthetic result's start/end). */
  start: number
  end: number
}

interface TableLayout {
  tableWidth: number
  tableX: number
  tracks: number[]
  bands: TableBand[]
  headerBandCount: number
  /** The synthetic LineResults — one per band — for the placement machine. */
  results: LineResult[]
}

/** Grid width: the first row's colspan sum. */
function tableColumnCount(block: TableBlock): number {
  const first = block.rows[0]
  if (!first) throw new Error(`table "${block.id}": no rows`)
  if (first.cells.length === 0) throw new Error(`table "${block.id}": row 0 has no cells`)
  return first.cells.reduce((sum, cell) => sum + cell.colspan, 0)
}

interface AnchoredCell {
  rowIndex: number
  cellIndex: number
  cell: TableCellData
  col: number
}

/**
 * Row-major anchored-cell placement over the occupancy grid: each cell
 * visited once at its anchor, left-to-right by column, first free
 * track. Validates the rectangular grid (every row's total occupancy
 * === cols) and that no span overruns — the adapter (fixTables)
 * guarantees both; this is the loud backstop.
 */
function tableAnchoredCells(block: TableBlock): AnchoredCell[] {
  const cols = tableColumnCount(block)
  const occupied = new Set<string>()
  const anchored: AnchoredCell[] = []
  block.rows.forEach((rowData, rowIndex) => {
    let col = 0
    rowData.cells.forEach((cell, cellIndex) => {
      if (!Number.isInteger(cell.colspan) || cell.colspan < 1) {
        throw new Error(`table "${block.id}": row ${rowIndex} cell ${cellIndex} has colspan ${cell.colspan}`)
      }
      if (!Number.isInteger(cell.rowspan) || cell.rowspan < 1) {
        throw new Error(`table "${block.id}": row ${rowIndex} cell ${cellIndex} has rowspan ${cell.rowspan}`)
      }
      while (occupied.has(`${rowIndex}:${col}`)) col += 1
      if (col + cell.colspan > cols) {
        throw new Error(
          `table "${block.id}": cell at row ${rowIndex} col ${col} (colspan ${cell.colspan}) overruns the ${cols}-column grid`,
        )
      }
      if (rowIndex + cell.rowspan > block.rows.length) {
        throw new Error(
          `table "${block.id}": cell at row ${rowIndex} col ${col} spans ${cell.rowspan} rows past the table end`,
        )
      }
      for (let dr = 0; dr < cell.rowspan; dr++) {
        for (let dc = 0; dc < cell.colspan; dc++) {
          occupied.add(`${rowIndex + dr}:${col + dc}`)
        }
      }
      anchored.push({ rowIndex, cellIndex, cell, col })
      col += cell.colspan
    })
    let count = 0
    for (let c = 0; c < cols; c++) if (occupied.has(`${rowIndex}:${c}`)) count += 1
    if (count !== cols) {
      throw new Error(
        `table "${block.id}": row ${rowIndex} occupies ${count} of ${cols} columns — the grid is not rectangular; the adapter (fixTables) must normalize before sending`,
      )
    }
  })
  return anchored
}

function computeTableLayout(
  block: TableBlock,
  contentWidth: number,
  contentHeight: number,
  metrics: TextMetrics,
  baseStyle: TextStyle,
): TableLayout {
  const cols = tableColumnCount(block)
  const anchored = tableAnchoredCells(block)

  // ── M-T4 — the TABLE BOX (outer left/right margins): tracks derive
  // against the narrowed box; the aligned x shifts by the left margin
  // (placeBlock adds it). Loud seam: margins that consume the box
  // THROW (the adapter must clamp before sending). Top/bottom margins
  // are NOT here — the adapter maps them to spaceBefore/spaceAfter
  // (the block tier's once-at-entry rule). ──
  const marginL = Math.max(0, block.margin?.left ?? 0)
  const marginR = Math.max(0, block.margin?.right ?? 0)
  const boxWidth = contentWidth - marginL - marginR
  if (boxWidth <= 0) {
    throw new Error(
      `table "${block.id}": horizontal margins (${marginL} + ${marginR}) leave no room in the ${contentWidth}px content box — the adapter must validate before sending`,
    )
  }

  // ── TRACKS (the engine owns the derivation) ──
  // Per column: the covering cells' colwidth entries. Conflict = throw.
  const widths: (number | null)[] = Array.from({ length: cols }, () => null)
  for (const { col, cell } of anchored) {
    const cw = cell.colwidth
    if (!cw) continue
    for (let dc = 0; dc < cell.colspan; dc++) {
      const track = col + dc
      const v = cw[dc]
      const w = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
      if (w == null) continue
      const existing = widths[track]
      if (existing == null) widths[track] = w
      else if (Math.abs(existing - w) > 0.01) {
        throw new Error(
          `table "${block.id}": column ${track} carries conflicting colwidths (${existing} vs ${w}) — the adapter must keep column cells in sync`,
        )
      }
    }
  }
  const fixedTotal = widths.reduce<number>((sum, w) => sum + (w ?? 0), 0)
  const unsetCount = widths.filter((w) => w == null).length
  const tracks: number[] = widths.map((w) => w ?? 0)
  let tableWidth: number
  if (unsetCount === 0) {
    // Fully fixed: the table is as wide as its tracks (the pageless
    // fixed <colgroup> look); over-wide tracks scale DOWN to the box.
    if (fixedTotal > boxWidth && fixedTotal > 0) {
      const factor = boxWidth / fixedTotal
      for (let c = 0; c < cols; c++) tracks[c] = (tracks[c] ?? 0) * factor
    }
    tableWidth = tracks.reduce((sum, w) => sum + w, 0)
  } else {
    // Some flexible columns: fixed columns first — shrinking
    // proportionally when they would crowd the flexible ones below the
    // track floor — then the flexible share the remainder equally. The
    // table fills the box (the width:100% look).
    const floor = unsetCount * CELL_MIN_TRACK
    if (fixedTotal > 0 && boxWidth - fixedTotal < floor) {
      const factor = Math.max(0, (boxWidth - floor) / fixedTotal)
      for (let c = 0; c < cols; c++) if (widths[c] != null) tracks[c] = (tracks[c] ?? 0) * factor
    }
    const flexTotal = boxWidth - tracks.reduce((sum, w) => sum + w, 0)
    const flexWidth = Math.max(flexTotal / unsetCount, 1)
    for (let c = 0; c < cols; c++) if (widths[c] == null) tracks[c] = flexWidth
    tableWidth = boxWidth
  }
  const laneXOf = (col: number): number => tracks.slice(0, col).reduce((sum, w) => sum + w, 0)

  // ── CELL LINE STACKS (one breaker, no fork: each cell's paragraphs
  // break at the lane's content width — the SAME breakLines prose
  // machinery). Canonical order: rows top-down, anchored cells
  // left-to-right, paragraphs in order, runs in order. The table's
  // concatenated text, canonical run indexes, and line indexes follow
  // EXACTLY this order (the shell's AdapterBlock builds the same
  // arrays — agreement by construction).
  //
  // THE SEPARATOR LAW (M-TABLES 2): EVERY cell paragraph's text slice
  // is followed by ONE '\n' separator in the canonical text — the
  // shell's AdapterBlock.text appends the same. Rationale: the
  // PM↔text-offset bridge is PER-PARAGRAPH, and a zero-length slice
  // (an empty cell) would share the offset space with its neighbors —
  // the caret/selection round-trip through blockOffsetToPmPos would
  // route EVERY empty cell to the FIRST one. The separator gives each
  // paragraph a DISTINCT textStart even at zero length (slice [k, k)
  // with the separator just before it). The separator never enters a
  // line's range (ranges are per-paragraph slices), never measures,
  // and never paints. ──
  const stacks: TableCellStack[] = []
  let textOffset = 0
  let runOffset = 0
  let lineIndexBase = 0
  for (const { rowIndex, cell, col } of anchored) {
    const laneWidth = tracks.slice(col, col + cell.colspan).reduce((sum, w) => sum + w, 0)
    // M-T4 — the cell's resolved padding narrows the lane's content
    // width (per-side: cell ← table default ← the engine constants).
    const pad = resolveCellPad(cell, block)
    const laneContentWidth = Math.max(laneWidth - pad.left - pad.right, 1)
    const lines: LineResult[] = []
    const linePara: number[] = []
    const paraBases: { textStart: number; runStart: number }[] = []
    let contentHeight = 0
    cell.content.forEach((para, paraIndex) => {
      paraBases.push({ textStart: textOffset, runStart: runOffset })
      const broken = breakLines(para.runs, metrics, laneContentWidth, baseStyle)
      broken.forEach((line) => {
        lines.push(line)
        linePara.push(paraIndex)
        contentHeight += line.height
      })
      // The canonical text offset advances by the breaker's token
      // lengths: an inline object contributes ONE position (the
      // U+FFFC the adapter also appends), a text run its text.
      textOffset += para.runs.reduce(
        (sum, run) => sum + (run.kind === 'inlineImage' ? 1 : run.text.length),
        0,
      )
      // The SEPARATOR LAW: +1 per paragraph (after the last one too —
      // the trailing separator keeps the accounting uniform; the
      // shell's text carries the same trailing '\n').
      textOffset += 1
      runOffset += para.runs.length
    })
    stacks.push({
      row: rowIndex,
      col,
      colspan: cell.colspan,
      rowspan: cell.rowspan,
      laneWidth,
      laneX: laneXOf(col),
      pad,
      fill: cell.backgroundColor ?? null,
      border: block.borderStyle ?? 'all',
      lines,
      linePara,
      paraBases,
      lineIndexBase,
      contentHeight,
    })
    lineIndexBase += lines.length
  }

  // ── ROW HEIGHTS (pass 1) ──
  const heights: number[] = block.rows.map((row) => row.minHeight ?? 0)
  for (const stack of stacks) {
    if (stack.rowspan === 1) {
      heights[stack.row] = Math.max(heights[stack.row]!, stack.contentHeight + stack.pad.top + stack.pad.bottom)
    }
  }
  // Rowspan distribution (row-major anchor order; later cells see
  // earlier cells' growth).
  for (const stack of stacks) {
    if (stack.rowspan === 1) continue
    const req = stack.contentHeight + stack.pad.top + stack.pad.bottom
    const spanSum = heights
      .slice(stack.row, stack.row + stack.rowspan)
      .reduce((sum, h) => sum + (h ?? 0), 0)
    if (req > spanSum) {
      const share = (req - spanSum) / stack.rowspan
      for (let r = stack.row; r < stack.row + stack.rowspan; r++) heights[r] = heights[r]! + share
    }
  }

  // ── BAND SLOTS per row ──
  // Atomic row (cantSplit === true AND fits a page): ONE band holding
  // every own cell's full stack. Split-allowed row (cantSplit unset —
  // Word/GDocs' DEFAULT) or monster row: per-line-grid bands (each own
  // cell contributes its k-th line to band k); the row's negotiated
  // height reconciles into the last band. Degenerate row (no own
  // lines — a rowspan-covered or empty row): one un-fragmentable band
  // (the R6 floor family owns the overflow). A monster row fragments
  // regardless of cantSplit — you can't keep together what can't fit
  // together.
  //
  // THE BAND-ALIGNMENT PRICE (M-FLOW ruling, spec of record): a
  // split-allowed row's lines are BAND-ALIGNED (a line never straddles
  // a band boundary — the rowspan ruling extended to ordinary rows),
  // so a row whose cells MIX line heights can tile taller than its
  // negotiated max stack (band k must be tall enough for the tallest
  // cell's line k, even where a shorter cell keeps the band). Uniform
  // line heights — the overwhelmingly common case — are pixel-for-
  // pixel the one-band model: bandSum == the stack height and the
  // pads reconcile into the last band. When the row fits its page
  // whole, the bands simply tile back-to-back — no split, same
  // geometry; R5 splits ONLY when the page remainder runs out.
  const rowBands: TableBand[][] = block.rows.map((rowData, r) => {
    const h = heights[r]!
    const own = stacks.filter((s) => s.row === r && s.rowspan === 1)
    const atomic = own.length === 0 || (rowData.cantSplit === true && h <= contentHeight)
    if (atomic) {
      const lanes: TableBand['lanes'] = []
      for (const s of own) {
        let y = s.pad.top
        s.lines.forEach((line, k) => {
          lanes.push({ stack: s, paraIndex: s.linePara[k]!, lineIndex: s.lineIndexBase + k, line, y })
          y += line.height
        })
      }
      return [{ row: r, height: h, lanes, isFirstOfRow: true, isHeader: rowData.isHeader, data: null as unknown as TableBandData, start: 0, end: 0 }]
    }
    const maxLines = Math.max(...own.map((s) => s.lines.length))
    const bands: TableBand[] = []
    for (let k = 0; k < maxLines; k++) {
      let height = 0
      const lanes: TableBand['lanes'] = []
      for (const s of own) {
        const line = s.lines[k]
        if (!line) continue
        // BAND 0 CARRIES THE TOP PAD (M-FLOW fix of a pre-existing
        // monster-path bug): the lane sits at pad.top, so its bottom
        // is pad.top + line.height — the band must be tall enough for
        // the lane it holds, or band 0's lines poke pad.top px into
        // band 1's region and overlap its lines (4px under the default
        // pads; pinned by the split-row tests). The BOTTOM pad rides
        // the last band via the reconcile below, so a uniform-line row
        // tiles to exactly its negotiated height h.
        const laneTop = k === 0 ? s.pad.top : 0
        height = Math.max(height, laneTop + line.height)
        lanes.push({
          stack: s,
          paraIndex: s.linePara[k]!,
          lineIndex: s.lineIndexBase + k,
          line,
          y: laneTop,
        })
      }
      bands.push({ row: r, height, lanes, isFirstOfRow: k === 0, isHeader: rowData.isHeader, data: null as unknown as TableBandData, start: 0, end: 0 })
    }
    // Reconcile: the row's negotiated height may exceed the bands' sum
    // (a rowspan share or minHeight drove it) — the last band absorbs.
    const bandSum = bands.reduce((sum, b) => sum + b.height, 0)
    if (bandSum < h) bands[bands.length - 1]!.height += h - bandSum
    return bands
  })
  const bands = rowBands.flat()

  // ── ROWSPAN LINE DISTRIBUTION (band-aligned greedy fill) ──
  // Each pass re-runs the whole distribution from scratch (the previous
  // pass's assignments cleared); growth (the span's last band growing
  // to hold the remainder) only ever increases band heights, so the
  // fill converges or hits the pass cap (bounded, deterministic).
  for (let pass = 0; pass < TABLE_FILL_PASSES; pass++) {
    for (const band of bands) {
      band.lanes = band.lanes.filter((l) => l.stack.rowspan === 1)
    }
    let grew = false
    for (const stack of stacks) {
      if (stack.rowspan === 1) continue
      const spanBands: TableBand[] = []
      for (let r = stack.row; r < stack.row + stack.rowspan; r++) spanBands.push(...rowBands[r]!)
      let cursor = 0
      let padPending = true
      for (let bi = 0; bi < spanBands.length && cursor < stack.lines.length; bi++) {
        const band = spanBands[bi]!
        const isLastBand = bi === spanBands.length - 1
        let used = 0
        for (const lane of band.lanes) {
          if (lane.stack === stack) used += stack.pad.top + lane.line.height
        }
        while (cursor < stack.lines.length) {
          const line = stack.lines[cursor]!
          const pad = padPending ? stack.pad.top : 0
          if (used + pad + line.height > band.height + 1e-9) {
            if (!isLastBand) break
            // The last band takes the whole remainder (grows to fit) —
            // content never vanishes (the R6 family's spirit).
            band.height = used + pad + line.height
            grew = true
          }
          band.lanes.push({
            stack,
            paraIndex: stack.linePara[cursor]!,
            lineIndex: stack.lineIndexBase + cursor,
            line,
            y: used + pad,
          })
          used += pad + line.height
          padPending = false
          cursor += 1
        }
      }
      if (cursor < stack.lines.length) grew = true // defensive; the last-band growth consumes all
    }
    if (!grew) break
  }

  // ── BAND DATA ASSEMBLY ──
  // Lanes sort to canonical order (row-major anchor order — the stable
  // sort keeps a cell's own lines adjacent); rect slices cover every
  // cell occupying the band's row (anchors AND rowspan continuations).
  for (const band of bands) {
    const ordered = [...band.lanes].sort((a, b) =>
      a.stack.row !== b.stack.row ? a.stack.row - b.stack.row : a.stack.col - b.stack.col,
    )
    const lines: TableBandLine[] = ordered.map((lane) => {
      const base = lane.stack.paraBases[lane.paraIndex]!
      const line = lane.line
      const textStart = base.textStart
      return {
        lineIndex: lane.lineIndex,
        x: lane.stack.laneX + lane.stack.pad.left,
        y: lane.y,
        laneWidth: lane.stack.laneWidth - lane.stack.pad.left - lane.stack.pad.right,
        rangeStart: textStart + line.start,
        rangeEnd: textStart + line.end,
        baseline: line.baseline,
        height: line.height,
        width: line.width,
        segments: line.segments.map((seg) => ({
          runIndex: base.runStart + seg.runIndex,
          start: textStart + seg.start,
          end: textStart + seg.end,
          x: seg.x,
        })),
        row: lane.stack.row,
        col: lane.stack.col,
      }
    })
    const rowCover = stacks
      .filter((s) => s.row <= band.row && band.row < s.row + s.rowspan)
      .sort((a, b) => a.col - b.col)
    const rects: TableBandRect[] = rowCover.map((s) => ({
      x: s.laneX,
      y: 0,
      width: s.laneWidth,
      height: band.height,
      fill: s.fill,
      border: s.border,
      colspan: s.colspan,
      rowspan: s.rowspan,
      row: s.row,
      col: s.col,
    }))
    let firstLineIndex = Number.MAX_SAFE_INTEGER
    let start = Number.MAX_SAFE_INTEGER
    let end = 0
    for (const l of lines) {
      firstLineIndex = Math.min(firstLineIndex, l.lineIndex)
      start = Math.min(start, l.rangeStart)
      end = Math.max(end, l.rangeEnd)
    }
    if (lines.length === 0) {
      // A degenerate band (no lines — e.g. a minHeight-tall empty row):
      // its range is the covering cells' text extent (informational).
      firstLineIndex = rowCover[0]?.lineIndexBase ?? 0
      start = rowCover[0]?.paraBases[0]?.textStart ?? 0
      end = start
    }
    band.data = { lines, rects, firstLineIndex, isHeader: band.isHeader }
    band.start = start
    band.end = end
    // Freeze the emission records at creation (the same immutability
    // posture as the emitted LineBoxes/PlacedRects).
    for (const l of lines) Object.freeze(l)
    Object.freeze(lines)
    for (const r of rects) Object.freeze(r)
    Object.freeze(rects)
    Object.freeze(band.data)
  }

  const headerBandCount = (() => {
    // The LEADING header prefix only (a mid-table all-header row styles
    // as a header but does not repeat — Word's top-rows rule).
    let n = 0
    for (const band of bands) {
      if (!band.isHeader) break
      n += 1
    }
    return n
  })()

  const results: LineResult[] = bands.map((band) => ({
    start: band.start,
    end: band.end,
    segments: [],
    width: tableWidth,
    height: band.height,
    baseline: 0,
    tableBand: band.data,
  }))

  return {
    tableWidth,
    tableX: alignOffset(block.align ?? 'left', tableWidth, contentWidth),
    tracks,
    bands,
    headerBandCount,
    results,
  }
}


// contentHash covers everything that determines a block's lines and
// placement: kind (all four kinds — and kind also routes the BREAKER
// and the EMIT: codeBlock vs prose semantics, image = atomic
// PlacedRect), runs (text + style), flow (keepLines/widowControl/
// bonds/forced breaks), the block-tier spacing (spaceBefore/
// spaceAfter — undefined-valued keys are dropped by stableStringify,
// so absent ≡ unset bit-for-bit), and the block-tier indent family
// (indentLeft/indentRight/firstLineIndent — placement geometry for
// text; for images they are IGNORED at placement but hash-covered
// anyway: uniform and conservative — an indent edit re-walks, never
// mis-splices). For IMAGES the hash covers src + width + height +
// align (the placement-relevant rule) AND alt: OPAQUE FIELDS
// PARTICIPATE WHEN THEY ECHO INTO OUTPUT — cache-relevance, not
// geometry-relevance, is the rule (placed[] echoes src and alt; a
// spliced-past alt edit would serve a stale echo and break parity).
// E-IMG-3 extends the same rule to float (placed[] echoes the rect
// and z). E-IMG-2: runs hash through the union dispatch — text runs
// {text, style} as before, inline objects by their full field set
// {kind, src, width, height, alt}.
// An id is NOT part of the hash — it is compared separately.
//
// IDENTITY CACHE: hashes are memoized on the block
// OBJECT. ADAPTER CONTRACT: the shell must reuse unchanged Block
// objects BY REFERENCE across layout calls (ProseMirror's structural
// sharing makes this natural — the app-side adapter caches on PM node
// identity). A shell that rebuilds all Block objects every call pays
// the full stringify again — correct, just unshared. Blocks are
// treated as immutable; a mutated
// block must be a NEW object (or the stale hash would be trusted —
// the parity fuzzer plus the hash-identity tests pin both directions).
const blockHashCache = new WeakMap<Block, string>()

function hashBlock(block: Block): string {
  let hash = blockHashCache.get(block)
  if (hash === undefined) {
    const base = {
      kind: block.kind,
      flow: block.flow,
      spaceBefore: block.spaceBefore,
      spaceAfter: block.spaceAfter,
      indentLeft: block.indentLeft,
      indentRight: block.indentRight,
      firstLineIndent: block.firstLineIndent,
      // M-RULER Phase 4: tab stops are now LAYOUT-RELEVANT (the \t
      // advance rule) — they ride the hash, so a stop edit re-breaks
      // the block (the Phase 3 ruling's deferred half: the field
      // becomes cache-relevant exactly when it becomes
      // layout-relevant). stableStringify drops undefined → absent ≡
      // unset bit-for-bit; stop-free hashes are unchanged.
      tabStops: block.tabStops,
    }
    hash = stableStringify(
      block.kind === 'image'
        ? {
            ...base,
            src: block.src,
            width: block.width,
            height: block.height,
            align: block.align,
            alt: block.alt,
            // E-IMG-3: float rides the hash — cache-relevant, not just
            // geometry-relevant: the placed rect AND z echo into
            // placed[], so a spliced-past float edit would serve a
            // stale echo (the E-IMG-1 alt ruling family). null is
            // dropped with undefined by stableStringify → absent ≡
            // unset bit-for-bit, so float-free image hashes are
            // unchanged.
            float: block.float ?? undefined,
          }
        : block.kind === 'equation'
          ? {
              // M-EQ: latex and fontSize ride the hash — both are the
              // metrics port's keys (an edit to either must re-measure
              // and re-walk, never serve a spliced stale rect); align
              // rides because the emit geometry reads it. The echoes
              // (latex/fontSize in placed[]) are covered by
              // construction — the E-IMG-1 alt ruling family.
              ...base,
              latex: block.latex,
              fontSize: block.fontSize,
              align: block.align,
            }
          : block.kind === 'table'
          ? {
              // M-TABLES: the hash covers the full grid structure —
              // rows (isHeader/minHeight/cantSplit), cells (colspan/
              // rowspan/colwidth/backgroundColor/padding) and each
              // cell paragraph's runs (the same run-union dispatch as
              // the flow tier). align/margin/cellPadding ride too (the
              // emit geometry and the padding resolution read them).
              // M-FLOW: cantSplit changes the BAND SLOTS (atomic vs
              // line-grid) — cache-relevant ≡ layout-relevant; absent
              // ≡ unset via the stableStringify drop rule.
              // Cell paragraph ids are NOT hashed (the cells are
              // embedded, never walked as blocks). Undefined/null
              // attrs drop (absent ≡ unset, the stableStringify rule);
              // BoxEdges sides normalize null → dropped so an explicit
              // null side hashes ≡ an absent side (they layout
              // identically — the inheritance floor).
              ...base,
              align: block.align,
              borderStyle: block.borderStyle,
              margin: block.margin ?? undefined,
              cellPadding: block.cellPadding
                ? {
                    top: block.cellPadding.top ?? undefined,
                    right: block.cellPadding.right ?? undefined,
                    bottom: block.cellPadding.bottom ?? undefined,
                    left: block.cellPadding.left ?? undefined,
                  }
                : undefined,
              rows: block.rows.map((row) => ({
                isHeader: row.isHeader,
                minHeight: row.minHeight ?? undefined,
                cantSplit: row.cantSplit ?? undefined,
                cells: row.cells.map((cell) => ({
                  colspan: cell.colspan,
                  rowspan: cell.rowspan,
                  colwidth: cell.colwidth ?? undefined,
                  backgroundColor: cell.backgroundColor ?? undefined,
                  padding: cell.padding
                    ? {
                        top: cell.padding.top ?? undefined,
                        right: cell.padding.right ?? undefined,
                        bottom: cell.padding.bottom ?? undefined,
                        left: cell.padding.left ?? undefined,
                      }
                    : undefined,
                  content: cell.content.map((para) => ({
                    runs: para.runs.map((run) =>
                      run.kind === 'inlineImage'
                        ? {
                            kind: run.kind,
                            src: run.src,
                            width: run.width,
                            height: run.height,
                            alt: run.alt,
                          }
                        : { text: run.text, style: run.style },
                    ),
                  })),
                })),
              })),
            }
          : block.kind === 'referenceTable'
            ? {
                // M-REFS: the hash covers the ENTRIES — each entry's
                // full runs (the same run-union dispatch as the flow
                // tier; the page-number run IS one of them, so a
                // re-resolved number re-breaks exactly this block) +
                // the entry's indentLeft (the level step — wrap
                // geometry). kind/flow/spacing/indentLeft/indentRight
                // ride via the explicit base below. firstLineIndent is
                // DELIBERATELY UNCOVERED — refused nonzero by
                // validation, so it can never reach a hash (and
                // explicit-0 vs absent normalize to the same hash);
                // tabStops is UNCOVERED too — the arm supplies its own
                // stop and never reads the field (not read → not
                // cache-relevant, the Phase 3 ruling's shape).
                kind: block.kind,
                flow: block.flow,
                spaceBefore: block.spaceBefore,
                spaceAfter: block.spaceAfter,
                indentLeft: block.indentLeft,
                indentRight: block.indentRight,
                entries: block.entries.map((entry) => ({
                  indentLeft: entry.indentLeft,
                  runs: entry.runs.map((run) =>
                    run.kind === 'inlineImage'
                      ? {
                          kind: run.kind,
                          src: run.src,
                          width: run.width,
                          height: run.height,
                          alt: run.alt,
                        }
                      : { text: run.text, style: run.style },
                  ),
                })),
              }
            : {
              ...base,
              runs: block.runs.map((run) =>
                // E-IMG-2 run union dispatch: an inline object's fields
                // are included BY CONSTRUCTION — the mapping names
                // kind/src/width/height/alt, so any of their edits
                // re-breaks the block. A text run maps to {text, style}
                // BIT-IDENTICALLY to the pre-union hash (an explicit
                // kind: 'text' is deliberately NOT hashed — absent ≡
                // 'text' ≡ unset, the stableStringify undefined-dropping
                // rule), so existing docs' hashes are unchanged.
                run.kind === 'inlineImage'
                  ? {
                      kind: run.kind,
                      src: run.src,
                      width: run.width,
                      height: run.height,
                      alt: run.alt,
                    }
                  : { text: run.text, style: run.style },
              ),
            },
    )
    blockHashCache.set(block, hash)
    hashCallCount += 1
  }
  return hash
}

// TEMP (validation): counts hashBlock stringification misses
// (cache misses). Remove once the identity cache is done being
// validated live.
export let hashCallCount = 0
export function resetHashCallCount() {
  hashCallCount = 0
}

// Hand-rolled stable stringify: object keys sorted, undefined-valued
// keys dropped (so {bold: undefined} ≡ {}). No new deps.
function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`
  }
  return '"unsupported"'
}

// Unknown block kinds are an ADAPTER/ENGINE VERSION SKEW (a newer
// shell feeding a stale engine — or vice versa), loud and upfront:
// before any cache work, before a deep TypeError could freeze the
// caller's relayout with an unreadable stack. The union here mirrors
// types.ts's Block.
const KNOWN_KINDS = new Set([
  'paragraph',
  'heading',
  'codeBlock',
  'image',
  'equation',
  'table',
  'referenceTable',
])
function validateKinds(doc: SemanticDoc): void {
  for (const block of doc.blocks) {
    if (!KNOWN_KINDS.has(block.kind)) {
      throw new Error(
        `unknown block kind '${block.kind}' (block "${block.id}") — engine/tensor version mismatch: rebuild @tensor-editor/engine (npm run build in the engine package) and reload`,
      )
    }
  }
}

// Duplicate ids are an adapter-contract violation, loud and upfront —
// before any cache work. Also protects the id-keyed lineCache and
// the splice id-verification from ambiguity.
function validateDuplicateIds(doc: SemanticDoc): void {
  const seen = new Set<string>()
  for (const block of doc.blocks) {
    if (seen.has(block.id)) {
      throw new Error(`duplicate block id: ${block.id}`)
    }
    seen.add(block.id)
  }
}

// INDENT SEAM (loud, upfront — next to the duplicate-id gate): a first
// line whose computed left edge (indentLeft + firstLineIndent) is
// negative would start left of the content box. The engine REFUSES
// that geometry — no clipping, no silent shift. ADAPTER CONTRACT: the
// adapter must validate before sending; this throw is the backstop.
// Only the SUM is checked: a negative sum is the one way any line's
// left edge goes negative (base lines sit at indentLeft alone, which
// the same sum covers when firstLineIndent is 0).
function validateIndentGeometry(doc: SemanticDoc): void {
  for (const block of doc.blocks) {
    const left = (block.indentLeft ?? 0) + (block.firstLineIndent ?? 0)
    if (left < 0) {
      throw new Error(
        `block "${block.id}": indentLeft ${block.indentLeft ?? 0} + firstLineIndent ${block.firstLineIndent ?? 0} = ${left} < 0 — the first line would start left of the content box; the adapter must validate before sending`,
      )
    }
  }
}

// INLINE OBJECTS IN CODE BLOCKS (E-IMG-2, ruled in the pre-coding
// presentation — loud seam): codeBlock runs carry source-line text
// only; the adapter must never project an inline image into code.
// The shared breaker would seat an object mechanically (the ORC is a
// one-position token there too), but the CONTRACT is the seam —
// refuse loudly, never silently lay out an object the code semantics
// never defined. Unreachable through the public API without the
// adapter having built the runs, so this is an adapter-contract gate.
function validateInlineInCode(doc: SemanticDoc): void {
  for (const block of doc.blocks) {
    if (block.kind === 'codeBlock' && block.runs.some((run) => run.kind === 'inlineImage')) {
      throw new Error(
        `block "${block.id}": codeBlock runs carry an inline image — inline objects are refused in code blocks (source-line text only); the adapter must validate before sending`,
      )
    }
  }
}

// FLOAT FLOW SEAM (E-IMG-3, ruled — loud, upfront, the bonds family):
// a floated image is not in flow — it cannot bond and must not derive
// pages. keepNext/keepPrevious ON a floated block, a bond pointing
// INTO one (A.keepNext where B is floated; B.keepPrevious where A is
// floated), and breakBefore/breakAfter on a floated block are all
// adapter-contract violations: THROW, never a silent no-op. The
// adapter expresses "float here, text continues on a new page" with
// breakBefore on the FOLLOWING text block. null counts as UNSET at
// every check (the PM JSON round-trip convention). keepLines/
// widowControl on floats are NOT refused — vacuous by construction,
// the block-image precedent.
function validateFloatFlow(doc: SemanticDoc): void {
  for (const block of doc.blocks) {
    if (block.kind !== 'image' || block.float == null) continue
    const flow = block.flow
    if (flow?.keepNext === true || flow?.keepPrevious === true) {
      throw new Error(
        `block "${block.id}": floated image carries keepNext/keepPrevious — a float is not in flow and cannot bond; the adapter must validate before sending`,
      )
    }
    if (flow?.breakBefore != null || flow?.breakAfter != null) {
      throw new Error(
        `block "${block.id}": floated image carries breakBefore/breakAfter — a float must not derive pages or slots; put the forced break on the following text block instead`,
      )
    }
  }
  for (let i = 0; i + 1 < doc.blocks.length; i++) {
    const a = doc.blocks[i]
    const b = doc.blocks[i + 1]
    const aFloat = a.kind === 'image' && a.float != null
    const bFloat = b.kind === 'image' && b.float != null
    if ((aFloat || bFloat) && (a.flow?.keepNext === true || b.flow?.keepPrevious === true)) {
      throw new Error(
        `blocks "${a.id}" → "${b.id}": bond touches a floated image — a float is not in flow and cannot bond; the adapter must validate before sending`,
      )
    }
  }
}

// REFERENCE TABLE SEAM (M-REFS — loud, upfront, the adapter-contract
// family): entries must carry ≥ 1 run (an empty entry has no line at
// all — the shell renders an empty collection as its placeholder
// entry), and firstLineIndent is meaningless per-entry — refused
// nonzero (the per-entry indentLeft replaces it). The entry-indent-
// past-wrap-width refusal lives in the getLines arm (it needs the
// content box's width, which validation doesn't see).
function validateReferenceEntries(doc: SemanticDoc): void {
  for (const block of doc.blocks) {
    if (block.kind !== 'referenceTable') continue
    if ((block.firstLineIndent ?? 0) !== 0) {
      throw new Error(
        `block "${block.id}": referenceTable carries firstLineIndent ${block.firstLineIndent} — ` +
          'meaningless per-entry (the entry indentLeft replaces it); the adapter must validate before sending',
      )
    }
    block.entries.forEach((entry, i) => {
      if (!Array.isArray(entry.runs) || entry.runs.length === 0) {
        throw new Error(
          `block "${block.id}" entry ${i}: reference entries must carry at least one run ` +
            '(the tab + page-number run included); the adapter must validate before sending',
        )
      }
    })
  }
}

// Greedy walk of ACTUAL line heights: how many lines starting at `from`
// fit within `height`. A line fits iff cumulative height stays within
// `height` — no epsilon.
function countFitting(results: readonly LineResult[], from: number, height: number): number {
  let used = 0
  let count = 0
  for (let i = from; i < results.length; i++) {
    const { height: lineHeight } = results[i]
    if (used + lineHeight > height) break
    used += lineHeight
    count++
  }
  return count
}
