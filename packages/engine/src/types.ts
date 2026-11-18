// tensor-engine data model. Pure data declarations only — behavior
// lives in layout.ts.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface TextStyle {
  fontFamily: string
  fontSize: number
  bold?: boolean
  italic?: boolean
  /**
   * Line-height multiplier, default 1.0. BOTTOM-ONLY LEADING (M6
   * ruling — spec of record): a line box's height = (ascent +
   * descent) × lineHeight and the baseline sits at `ascent` from the
   * box top; ALL the added leading lives BELOW the glyphs.
   * Rationale: the top-left of a line box is always text — inter-line
   * space lives below, and above-line space belongs to the block
   * tier (spaceBefore/spaceAfter), never to the line. Word-family
   * convention, deliberately chosen over CSS half-leading.
   * INVARIANT: absent or 1.0 produces numbers IDENTICAL to the
   * lineHeight-free layout — pinned bit-for-bit by tests.
   */
  lineHeight?: number
  /**
   * Variant caps (M-STYLES): 'small-caps' is LAYOUT-RELEVANT, not
   * paint-only — small-cap glyphs measure narrower than full caps in
   * real fonts, so the metrics PORT consumes it (measure/ascent/
   * descent all key on the full style). The engine never interprets
   * it: it flows through run.style into contentHash (a variant edit
   * re-breaks the run's block) and is handed back opaquely to the
   * measurer. Test doubles may ignore it (FakeMetrics does — its
   * width depends only on text length), but the REAL metrics must
   * apply it or measured widths diverge from painted advances.
   */
  fontVariant?: 'small-caps' | 'normal'
}

/**
 * The Run union's text arm (E-IMG-2). `kind` is OPTIONAL and absent ≡
 * 'text' — existing documents, fixtures, and adapter outputs stay
 * valid as-is (ruled in the E-IMG-2/3 session); every run consumer
 * dispatches on `run.kind === 'inlineImage'` and treats everything
 * else as text.
 */
export interface TextRun {
  kind?: 'text'
  text: string
  style: TextStyle
  /**
   * M-PAGEFIELD: the SHELL's per-page field marker — the run's text is
   * the MEASURED placeholder (the warm total's max-width digits), and
   * the shell's painter substitutes the per-page resolution at draw
   * time. The engine treats the run as plain text and never reads this
   * field (not read → not cache-relevant, the Phase 3 ruling's shape;
   * hashBlock's text-run mapping deliberately drops it, while the
   * placeholder TEXT rides — a total-width change re-breaks the line).
   */
  fieldKind?: 'page' | 'pages'
}

/**
 * INLINE IMAGE OBJECT (E-IMG-2) — the Run union's object arm. An
 * UNBREAKABLE token in the breaker: exactly ONE position in the
 * block's concatenated text (an object-replacement token — never a
 * space, so never a break point; length 1, so never split), seated
 * BOTTOM-AT-BASELINE (CSS default seating: it extends imageHeight
 * above the baseline, nothing below). src is OPAQUE —
 * 'media://<sha256>' in Tensor; the engine never resolves or loads
 * it, and LayoutResult never echoes run data: paint data is the
 * SHELL's to resolve via the segment contract (see segmentsFor in
 * line-breaker.ts). width/height are REQUIRED DOCUMENT DATA — dims
 * are data (the M5.6+ ruling): the metrics port is never consulted
 * for objects; the breaker clamps an over-wide object to the base
 * wrap width via the shared fit-down primitive, aspect preserved.
 * All fields ride contentHash by construction (hashBlock names them).
 */
export interface InlineImageRun {
  kind: 'inlineImage'
  /** OPAQUE — never resolved or loaded by the engine. */
  src: string
  /** Intrinsic px, REQUIRED document data, never fetched at layout time. */
  width: number
  height: number
  /** OPAQUE a11y metadata — hash-covered uniformly (conservative). */
  alt: string
}

export type Run = TextRun | InlineImageRun

/**
 * Port only. The real (canvas-based) implementation lives in the shell
 * repo, never here. The engine consumes measurement; it does not perform
 * it. No caching in the engine — memoization is the production metrics
 * implementation's job.
 */
export interface TextMetrics {
  /** Advance width of `text` under `style`, in px. */
  measure(text: string, style: TextStyle): number
  ascent(style: TextStyle): number
  descent(style: TextStyle): number
}

/**
 * M-EQ — Port only. The real (KaTeX-measuring) implementation lives in
 * the shell repo, never here — the engine consumes measurement, it does
 * not perform it (the TextMetrics law, mirrored). An equation's dims
 * are DERIVED facts — a pure function of (latex, fontSize) under the
 * renderer's fonts — so unlike an image's user-set document data they
 * arrive through this port at layout time. The implementation MUST be
 * synchronous and MUST memoize (the TextMetrics contract); the engine
 * never caches on its behalf. A font's async load landing late is the
 * SHELL's invalidation problem (re-measure + relayout) — the engine
 * just re-runs the port when asked.
 */
export interface EquationMetrics {
  /** Natural rendered size of `latex` at `fontSize`, in px. */
  measure(latex: string, fontSize: number): { width: number; height: number }
}

export interface LineSegment {
  /** Index into the paragraph's runs array. */
  runIndex: number
  /**
   * Offsets into the concatenated run text, clamped to the line's range.
   * Edit survival: plain character offsets, same contract as LineResult
   * start/end — edits before an offset shift it.
   */
  start: number
  end: number
  /**
   * M-RULER Phase 4: the segment's start x, LINE-RELATIVE (0 = the line
   * box's left edge; the shell adds rect.x + alignment). Emitted by the
   * breaker's pen walk — the shell consumes these for paint, offset-x
   * and hit-testing instead of re-measuring prefix sums, which CANNOT
   * model tab advances (a \t's jump is pen-dependent, and center/right
   * stops reposition their text). A \t is its OWN segment (the breaker
   * splits at tabs): it paints nothing and its advance is the gap to
   * the next segment's x — the placed pen jump.
   */
  x: number
}

export interface LineResult {
  /**
   * Offsets into the concatenated run text (runs joined in array order).
   * Edit survival: plain character offsets — edits before an offset shift
   * it; they name source positions, not re-flowed fragments.
   */
  start: number
  end: number
  /** Run boundaries survive breaking. */
  segments: LineSegment[]
  /** Measured. */
  width: number
  /** Max ascent + max descent over runs in the line. */
  height: number
  /** Max ascent over runs in the line. */
  baseline: number
  /**
   * M-TABLES (INTERNAL): present on the synthetic BAND results a table
   * block feeds the placement machine — one per row-band; the machine's
   * emit branch expands it into the band's parallel cell LineBoxes +
   * cell rects. Never present on prose/code lines. The band's start/end
   * span its covered text range (informational).
   */
  tableBand?: TableBandData
  /**
   * M-REFS (INTERNAL): present on the flattened per-LINE results a
   * referenceTable block feeds the placement machine — one per entry
   * line. `x` is the line's LEFT EDGE (px, content-box-relative — the
   * block's indentLeft + the entry's indentLeft) for the emit branch's
   * LineBox rect; `entryIndex` names the entry the line belongs to
   * (the shell's sidecar join — click navigation resolves the hit
   * offset's entry). Never present on prose/code/table lines.
   */
  referenceLine?: { entryIndex: number; x: number }
}

/**
 * One cell line's READY-TO-EMIT data inside a band (M-TABLES).
 * Geometry is TABLE-relative (the emitter adds the table's x offset and
 * the band top). Segments are RE-BASED: runIndex indexes the table's
 * canonical run array and start/end index the table's concatenated
 * text (the shell's AdapterBlock carries the same arrays).
 */
export interface TableBandLine {
  lineIndex: number
  /** Cell-lane content left edge (table-relative; includes CELL_PAD_H). */
  x: number
  /** Band-relative y. */
  y: number
  /**
   * The lane's CONTENT width (union track width − 2·CELL_PAD_H): the
   * shell's selection-rect clamp bound — [rect.x, rect.x + laneWidth].
   */
  laneWidth: number
  rangeStart: number
  rangeEnd: number
  baseline: number
  height: number
  /** The line's INK width (the breaker's measured width, re-based). */
  width: number
  segments: LineSegment[]
  row: number
  col: number
}

/** One cell rect slice in a band (M-TABLES), TABLE-relative. */
export interface TableBandRect {
  x: number
  /** Band-relative y (always 0 — a slice covers its whole band). */
  y: number
  width: number
  height: number
  fill: string | null
  border: 'all' | 'none' | 'outer'
  colspan: number
  rowspan: number
  row: number
  col: number
}

export interface TableBandData {
  /** Cell line emissions, canonical (row-major cell) order. */
  lines: TableBandLine[]
  /** Cell rect slices, document order. */
  rects: TableBandRect[]
  /** The smallest canonical lineIndex among `lines` — FragmentBreak.atLine. */
  firstLineIndex: number
  isHeader: boolean
}

/**
 * Per-block flow control. Field names deliberately mirror OOXML
 * (w:keepNext, w:keepLines, ...) for a future DOCX round-trip. null
 * counts as UNSET at every use site — PM attribute JSON round-trips
 * use null for absent attrs.
 */
export interface FlowPolicy {
  /**
   * Atomic placement: never split this block across pages. Blocks taller
   * than a page still fragment — you can't keep together what can't fit
   * together.
   */
  keepLines?: boolean
  /**
   * Widow/orphan protection for this block. Overrides the DOCUMENT-LEVEL
   * DEFAULT (LayoutOptions.preventWidowsAndOrphans). false = natural
   * split (no boundary adjustments).
   */
  widowControl?: boolean
  /**
   * BOND (A→B): A's last line and B's first line share a page.
   * Enforced at A's placement via a lookahead of B's first-line height;
   * bounded shapes, give-up drops loudly.
   */
  keepNext?: boolean
  /** BOND: same bond as keepNext on the previous block — one mechanism, two spellings. */
  keepPrevious?: boolean
  /**
   * Structural tier (precedence 1): force a break before this block.
   * 'page' closes to the next PAGE (a fresh-page start is a no-op);
   * 'column' (#74) closes to the next FLOW SLOT — the next column of
   * the page, else the next page (a fresh-slot start is a no-op) —
   * the manual column break, Word's newsletter-flow early wrap. A
   * bond at this boundary drops — a page/column that must start with
   * B cannot also start with A's last fragment (manual breaks outrank
   * bonds — Word parity).
   */
  breakBefore?: 'page' | 'column' | null
  /**
   * Structural tier (precedence 1): force a break after this block —
   * 'page' closes to the next page; 'column' (#74) to the next slot.
   * Emits no FragmentBreak.
   */
  breakAfter?: 'page' | 'column' | null
}

export interface BlockBase {
  id: string
  kind:
    | 'paragraph'
    | 'heading'
    | 'codeBlock'
    | 'image'
    | 'equation'
    | 'table'
    | 'referenceTable'
  flow?: FlowPolicy
  /**
   * Vertical space (px) above the block's first line. Applied ONCE at
   * block entry: fragment continuations (a mid-block page split) never
   * re-apply it. Consumed before the fit walk, so fits/orphan/widow
   * evaluate against the line tops; the y>0 loop-freedom guards test
   * the PRE-spaceBefore cursor (spaceBefore is not "content" — a page
   * holding only spaceBefore is still fresh).
   */
  spaceBefore?: number
  /** Vertical space (px) after the block's last line. Participates in the NEXT block's fits. */
  spaceAfter?: number
  /**
   * BLOCK-LEVEL INDENT GEOMETRY (px, default 0): narrows the wrap
   * width (contentBox.width − indentLeft) and shifts every LineBox
   * rect.x to indentLeft. It is NOT a run style — it never paints, it
   * only changes wrapping and placement. Horizontal, so unlike
   * spaceBefore it applies to EVERY line of EVERY fragment: a mid-block
   * page split keeps the indent on the continuation.
   */
  indentLeft?: number
  /**
   * Right half of the indent family (px, default 0): narrows the
   * wrap width from the RIGHT (contentBox.width − indentLeft −
   * indentRight). rect.x stays at indentLeft; the measured widths
   * come from the narrower wrap. Preserved on fragment continuations
   * like indentLeft.
   */
  indentRight?: number
  /**
   * FIRST-LINE INDENT (px, default 0; the indent family's third
   * member): ONLY lineIndex 0 of the block gets effective left
   * indent = indentLeft + firstLineIndent, and line 0 BREAKS at its
   * own width (first line wraps at contentBox.width − (indentLeft +
   * firstLineIndent) − indentRight; wrapped lines at the base
   * width). POSITIVE indents the first line INWARD; NEGATIVE under a
   * larger indentLeft is the HANGING indent (the classic
   * bibliography/legal style: line 0 sits out at the left, wrapped
   * lines sit in at indentLeft) — there is deliberately NO third
   * field for it. CONTINUATION RULE (mirror of spaceBefore's): the
   * first-line indent applies ONCE, at the block's true start
   * (lineIndex 0, wherever the start rules put it); fragments on
   * later pages resume at the BASE indent. LOUD SEAM: the engine
   * THROWS on a negative computed left edge (indentLeft +
   * firstLineIndent < 0) — the adapter must validate before sending.
   */
  firstLineIndent?: number
  /**
   * TAB STOPS (M-RULER Phase 3/3.5; px, measured from the COLUMN's
   * LEFT EDGE — Word's margin-relative convention: indent edits never
   * move tab stops. COLUMNS (#74) made the frame literal: in a
   * multi-column section each column re-anchors the stop grid
   * (column left ≡ content-box left in single-column documents, so
   * existing docs parse identically — the additive law). Ascending by position, deduped — the adapter
   * normalizes on the way in. INERT until the Phase 4 breaker consumes
   * them (the \t advance rule): hashBlock deliberately does NOT cover
   * this field yet, so a tabStops edit splices the cached lines instead
   * of re-breaking them (identical output — the breaker never reads the
   * field). Phase 4 adds the hash coverage together with the
   * consumption, so the field becomes cache-relevant exactly when it
   * becomes layout-relevant. The ALIGNMENT kinds change the advance
   * math there: left = the run starts at the stop; center = the run
   * centers ON it; right = the run ENDS at it.
   */
  tabStops?: TabStop[]
}

/**
 * One tab stop's alignment kind (M-RULER 3.5 — the OOXML w:tab val
 * spelling, minus decimal for now). The RULER renders a glyph per kind
 * and the BREAKER (Phase 4) computes each kind's advance differently.
 */
export interface TabStop {
  /** px from the COLUMN's left edge (≡ the content box's, single-column). */
  position: number
  alignment: 'left' | 'center' | 'right'
}

export interface ParagraphBlock extends BlockBase {
  kind: 'paragraph'
  runs: Run[]
}

export interface HeadingBlock extends BlockBase {
  kind: 'heading'
  level: number
  runs: Run[]
}

/**
 * ADAPTER CONTRACT — PAGELESS LOOK, matched not redesigned: in the
 * pageless editor a code block renders through TipTap's CodeBlock
 * extension as `<pre><code>` with NO font of its own; the UA
 * stylesheet's `pre { font-family: monospace }` applies and the
 * font-size INHERITS the editor container's document-default size
 * (16px in the shell config). So the shell's adapter must emit runs
 * carrying `fontFamily: 'monospace'` + the document-default size —
 * the engine never restyles, it breaks runs as given.
 */
export interface CodeBlockBlock extends BlockBase {
  kind: 'codeBlock'
  runs: Run[]
}

export type Block =
  | ParagraphBlock
  | HeadingBlock
  | CodeBlockBlock
  | ImageBlock
  | EquationBlock
  | TableBlock
  | ReferenceTableBlock

/**
 * ATOMIC VISUAL BLOCK — image. Never fragmented, never line-broken:
 * exactly ONE placement decision in the walk (a single synthetic "line"
 * internally). src is OPAQUE: the engine never resolves or loads it —
 * in Tensor it is 'media://<sha256>', but the engine treats it as an
 * uninterpreted string that only echoes through to placed[]. The
 * intrinsic width/height are REQUIRED DOCUMENT DATA (the adapter
 * supplies them; the engine never fetches anything at layout time).
 * Two-sided law: the SHELL must never compute layout — a shell-side
 * scale would be a second derivation; the engine owns this math and
 * emits the FINAL placed dims in placed[]. The indent family is wrap
 * geometry and is IGNORED for images (they don't wrap); `align` is
 * their horizontal control, relative to the full content box
 * (Word: a centered image centers on the column, not the indented
 * text edge). keepLines on an image is vacuous by construction —
 * atomicity is structural, not a keepLines special case.
 */
export interface ImageBlock extends BlockBase {
  kind: 'image'
  /** OPAQUE — never resolved or loaded; echoes through to placed[]. */
  src: string
  /** Intrinsic px, REQUIRED document data, never fetched at layout time. */
  width: number
  height: number
  /** Default 'left'. Positions the placed rect via the shared alignOffset. */
  align?: 'left' | 'center' | 'right'
  /** OPAQUE echo — a11y metadata, never rendered by the engine. */
  alt: string
  /**
   * ANCHORED FLOAT (E-IMG-3, v1 wrap NONE). When present the block
   * contributes ZERO height to the flow — text lays out as if the
   * block isn't there; the walk records the ANCHOR (the flow position
   * where the block would have started) and the placed rect = anchor +
   * (dx, dy), clamped to the FULL PAGE BOX (margins included — the
   * page is the canvas; a float may sit IN the margin). z is PAINT
   * ORDER, not layout. LOUD SEAM: bonds and forced breaks on a floated
   * block THROW at layout() entry (validateFloatFlow) — a float is not
   * in flow and must not derive pages; put a forced break on the
   * following text block instead. contentHash covers float: the
   * placed rect and z echo into placed[] (cache-relevance, the E-IMG-1
   * alt ruling family). Like FlowPolicy, PM attribute JSON round-trips
   * use null for absent attrs: null counts as UNSET at every use site.
   */
  float?: { dx: number; dy: number; z: 'front' | 'behind' } | null
}

/**
 * M-EQ — ATOMIC VISUAL BLOCK — equation. Never fragmented, never
 * line-broken: exactly ONE placement decision in the walk (a single
 * synthetic "line" internally), the image family's atomicity by
 * construction.
 *
 * THE DIMS RULING (the image contract's deliberate inversion): an
 * equation's width/height are NOT document data — they are DERIVED
 * facts, a pure function of (latex, fontSize) under the renderer's
 * fonts. The adapter cannot measure (L1: pure conversion, no DOM), so
 * the engine asks the EquationMetrics PORT at layout time (the
 * TextMetrics law: the engine consumes measurement, never performs
 * it — the real KaTeX-based implementation lives in the shell). The
 * port MUST be sync and MUST memoize (the TextMetrics contract).
 *
 * NO FIT-DOWN (the image family's other deliberate inversion): an
 * equation is never rescaled — shrinking a formula's font to squeeze
 * it into a box misrepresents the math. Over-tall (taller than the
 * content box: can never fit ANY page) throws LOUD in the getLines
 * arm. Over-wide is ALLOWED to overflow the content box horizontally
 * (Word's convention: a wide formula centers and bleeds into the
 * margins; the rect's x goes negative via the shared alignOffset, the
 * same frame floats already emit) — the vertical band is still wholly
 * the equation's, so no text ever overlaps it.
 *
 * latex is OPAQUE to the engine EXCEPT as the metrics port's key: it
 * never interprets the source, it echoes it through to placed[] so the
 * shell's paint layer re-renders the math (paint data is the shell's
 * to resolve). fontSize is the port's second key — the adapter sends
 * the document-default run size the equation renders at.
 */
export interface EquationBlock extends BlockBase {
  kind: 'equation'
  /** OPAQUE LaTeX source — the metrics port's key; echoes to placed[]. */
  latex: string
  /** px — the metrics port's second key (the resolved document-default size). */
  fontSize: number
  /** Default 'center' (Word's display-equation convention). */
  align?: 'left' | 'center' | 'right'
}

/**
 * M-TABLES — the TABLE block. THE MODEL: rows hold cells; cells hold
 * the SAME ParagraphBlock the flow tier uses (the engine breaks each
 * cell's paragraphs at the CELL's track width — one breaker, no fork).
 * The GRID is the adapter's to have validated (a rectangular grid is a
 * ProseMirror fixTables guarantee); the engine re-derives column
 * count/track geometry from the cells' colspans and validates loudly.
 *
 * PAGE-BREAKING MODEL (the spec of record for this kind): the table's
 * flow units are ROWS, expressed internally as BANDS — a band is one
 * row's line-grid slice (a cantSplit row is exactly one band — atomic,
 * it moves wholly; a split-allowed row — the null/absent DEFAULT,
 * Word's "Allow row to break across pages" — and a row taller than
 * the content box fragment into per-line-grid bands, the codeBlock
 * "taller-than-page" ruling family). Bands tile the flow
 * track like lines; the cell LINES within a band are PARALLEL lanes
 * (same y, one per column) — they ride lines[] as ordinary LineBoxes
 * carrying `tableCell` lane identity, so the shell's caret/selection/
 * search machinery consumes them unchanged. Cell fills/borders ride
 * placed[] as kind:'tableCell' rects (paint geometry anchored to the
 * bands — NOT flow participants).
 *
 * HEADER ROWS (isHeader): the table's LEADING header rows re-emit at
 * the top of every continuation page the table fragments onto (Word's
 * "Repeat Header Rows"); the repeats are extra emissions of the same
 * logical lines (same lineIndex/ranges), not new flow units.
 *
 * ROWSPAN: a cell spanning multiple rows lays its line stack out at
 * the union width; its height requirement is distributed equally over
 * the spanned rows' heights, and its lines are placed BAND-ALIGNED
 * (greedy fill per band — a line never straddles a band boundary; the
 * band remainder is absorbed as vertical slack the cell fill covers).
 *
 * CELL CONTENT RESTRICTION (v1): paragraphs only. The adapter throws
 * the UnsupportedDocError sentinel for anything else inside a cell
 * (the pageless fallback renders it) — a cell's codeBlock/blockquote/
 * image projection is future work.
 */
export interface TableBlock extends BlockBase {
  kind: 'table'
  rows: TableRowData[]
  /** Horizontal placement of the table within the content box (default 'left'; shared alignOffset). */
  align?: 'left' | 'center' | 'right'
  /**
   * The table-level border preset ('all' default — absent ≡ 'all'), echoed
   * into every cell rect's paint data (the painter renders the grid with it).
   */
  borderStyle?: 'all' | 'none' | 'outer'
  /**
   * M-T4 — OUTER margins (px): left/right inset the table box (the
   * track width budget narrows; the aligned x shifts). Top/bottom map
   * to the block-tier spaceBefore/spaceAfter in the ADAPTER — a table
   * margin above/below IS block spacing, and the engine's
   * once-at-entry rule owns it (no parallel mechanism). Absent ≡ 0.
   */
  margin?: { left: number; right: number } | null
  /**
   * M-T4 — default cell padding (per-side; null sides fall to the
   * engine constants). Per-cell `padding` overrides per-side.
   */
  cellPadding?: BoxEdges | null
}

export interface TableRowData {
  /** Header cells (tableHeader) — leading rows that repeat across pages. */
  isHeader: boolean
  cells: TableCellData[]
  /**
   * Minimum row height (px) — M-T3's panel wires the UI; the contract
   * lives here now. null/absent = pure content height ("at least"
   * spacing is max(content, this)). Never a MAXIMUM: rows grow.
   */
  minHeight?: number | null
  /**
   * M-FLOW (row split) — Word's per-row "Allow row to break across
   * pages" checkbox, OOXML w:cantSplit spelling. true = the row is
   * ATOMIC: it moves wholly to the next page when it doesn't fit the
   * page remainder. null/absent = the row MAY split at the cell line
   * grid (Word's AND GDocs' DEFAULT), the monster-row per-line-grid
   * banding applied to ordinary rows — bands that fit stay, R5 splits
   * only when the remainder runs out. A monster row (taller than the
   * content box) fragments regardless: you can't keep together what
   * can't fit together. null counts as unset at every use site (the
   * PM JSON round-trip convention, FlowPolicy's law).
   */
  cantSplit?: boolean | null
}

/**
 * M-T4 — per-side box edges (px). Every side is INDEPENDENTLY nullable:
 * null = "unset — inherit the next tier" (cell ← the table's default
 * ← the engine's built-in constants). The PM attribute JSON round-trip
 * convention (null for absent), applied per side.
 */
export interface BoxEdges {
  top: number | null
  right: number | null
  bottom: number | null
  left: number | null
}

export interface TableCellData {
  colspan: number
  rowspan: number
  /**
   * Per-spanned-column px widths — the PM cell colwidth attr's echo
   * (the resizable table's stored track data). Sparse by position:
   * entry j names the j-th spanned column; null/absent entries (and
   * absent/null arrays) leave that column flexible. The ENGINE owns
   * the track derivation (layout math, two-sided law); the adapter
   * never precomputes tracks.
   */
  colwidth?: (number | null)[] | null
  /** Cell shading (paint data — echoes into the placed rect). */
  backgroundColor?: string | null
  /**
   * M-T4 — per-cell padding override; a null side inherits the
   * table's cellPadding, then the engine constants.
   */
  padding?: BoxEdges | null
  /** Paragraph-only (see the class comment). */
  content: ParagraphBlock[]
}

/**
 * M-REFS — the REFERENCE TABLE block (Table of Contents / Table of
 * Figures / Index — the shell's collection kinds). THE MODEL: the
 * block carries ENTRIES — one flow unit per entry, expressed
 * internally as flattened per-LINE LineResults (the table-band
 * family's shape, minus the lanes: an entry is ONE text lane). Each
 * entry's runs are COMPLETE line content — the entry text runs, a tab
 * run ('\t'), and the page-number run — so the entry breaks, wraps,
 * and right-aligns through the ONE breaker + the ONE tab machinery
 * (the getLines arm supplies the right tab stop at the entry's wrap
 * width; the LEADER dots between text and number are paint-side ink
 * the shell derives from the line's segments — never layout).
 * `indentLeft` is per-entry (px): the ToC level indents move the LEFT
 * edge; the numbers stay right-aligned at the shared margin.
 *
 * ENTRIES ARE DERIVED FACTS (the equation-law family): the block
 * carries NO cached copy of the document text it summarizes — the
 * shell's scanner rebuilds entries as the document changes, and the
 * page numbers (resolved by the shell's two-pass fixpoint against the
 * layout's own placement) ride the entry runs by construction — a
 * number edit is an entry-runs edit, so the hash covers it (the
 * cache-relevance ≡ layout-relevance rule; a re-resolved number
 * re-breaks exactly this block). The engine knows nothing of
 * navigation targets: entries are opaque text lanes; the shell's
 * sidecar (AdapterBlock.reference) maps block-text offsets → PM
 * target positions for click navigation.
 *
 * CANONICAL TEXT ORDER (the table's receipt): entries in array order,
 * runs in array order within each entry — the same concatenation the
 * shell's AdapterBlock.text mirrors; LineBox rangeStart/rangeEnd and
 * segment offsets index it. The block has NO top-level runs field —
 * the entries ARE the content.
 *
 * REFUSALS (validateReferenceEntries — loud, upfront):
 * firstLineIndent is meaningless per-entry and refused nonzero (the
 * per-entry indentLeft replaces it); an entry indent at/past the
 * entry's wrap width is refused (the adapter clamps — a zero-width
 * lane cannot break); entries must carry ≥ 1 run (an empty entry has
 * no line at all — the shell renders empties as its placeholder
 * entry). block.tabStops is IGNORED (the arm supplies its own stop)
 * and deliberately NOT hash-covered for this kind — not read, not
 * cache-relevant.
 */
export interface ReferenceTableBlock extends BlockBase {
  kind: 'referenceTable'
  entries: ReferenceEntry[]
}

/** One entry's flow content. runs = the COMPLETE line content (the
 * entry text runs — INCLUDING the leader dots span, a REAL text run
 * the shell's painter extends with extra dot ink to fill the gap at
 * the run's own style — plus the tab run and the page-number run);
 * indentLeft = the entry's own left indent (px, ON TOP of the
 * block's indentLeft — the ToC level step).
 *
 * M-REFS-8 — THE LEADER IS SHELL INK (the round-8 ruling): the
 * engine NEVER rewrites run text — the block-text contract (the
 * entries' concatenation ≡ the shell's AdapterBlock.text) must hold
 * bit-for-bit, and a run-text stretch breaks it (the painter slices
 * the SHELL's text by segment offsets). The gap-filling dots are
 * PAINT-SIDE ink derived from the line's placed segments and the
 * leader run's own measured style (the shell owns it). */
export interface ReferenceEntry {
  runs: Run[]
  indentLeft?: number
}

export interface SemanticDoc {
  blocks: Block[]
  /**
   * REQUIRED document default font, supplied by the adapter — defaults
   * live at the edges, never in the engine. Feeds empty-line metrics:
   * a PRESENT run's style (even zero-length — the adapter's
   * empty-textblock projection) wins over baseStyle; baseStyle is the
   * no-runs-at-all fallback only (P1 ruling).
   */
  baseStyle: TextStyle
  /**
   * M-HEADER-FOOTER: the header/footer bands — a SIBLING input, never
   * in flow order (the adapter routes band nodes OUT of `blocks`).
   * Band blocks are laid out top-down inside the per-page band strips
   * (paragraph/heading only — validateKinds enforces), the SAME
   * line-breaking as body prose at the band wrap width, and re-emitted
   * on EVERY page (the table header-repeat precedent: echoes of the
   * same logical lines, not new flow units). The body contentBox
   * shrinks by the TALLER of the first-page vs rest-page band needs —
   * single shared contentBox (the walk machine's contract), the max
   * across pages (the engine's one-geometry-per-doc limit).
   */
  bands?: BandSet
}

export interface BandSet {
  /** Default-page header blocks (all pages but the first under differentFirstPage). */
  header?: Block[]
  /** Default-page footer blocks. */
  footer?: Block[]
  /** First-page header blocks (used only under differentFirstPage). */
  firstHeader?: Block[]
  /** First-page footer blocks. */
  firstFooter?: Block[]
  /** Page 1 paints the first* regions; other pages the default ones. */
  differentFirstPage?: boolean
  /**
   * The band anchor distance from the page edge (px). Default
   * BAND_ANCHOR_PX (Word's 36pt at 96dpi = 48px).
   */
  anchorPx?: number
  /**
   * #58 SECTIONS — the per-section band OVERRIDES: section s's band is
   * its override here, else the doc-level default above (Word's "link
   * to previous" resolution — the adapter resolves the tagged band
   * containers to section indexes; untagged containers ARE the doc
   * default). Absent (or a missing entry) = the section inherits. The
   * first* regions are meaningful only under differentFirstPage and
   * only for section 0 (the doc's page 0 lives there); sections > 0
   * always paint the default class.
   */
  perSection?: PerSectionBands[]
}

/** One section's band overrides (the non-inherited content). */
export interface PerSectionBands {
  /** The 0-based section index (the LayoutOptions.sections order). */
  section: number
  header?: Block[]
  footer?: Block[]
  firstHeader?: Block[]
  firstFooter?: Block[]
}

/** Word's header/footer anchor distance: 36pt → 48 CSS px (96dpi). */
export const BAND_ANCHOR_PX = 48

export interface LayoutOptions {
  page: { width: number; height: number }
  margins: { top: number; right: number; bottom: number; left: number }
  /**
   * #74 COLUMNS — the DOCUMENT-LEVEL DEFAULT column spec
   * (newsletter-style multi-column flow). Absent/undefined ≡ ONE
   * column ≡ today's shape exactly — the additive law: existing docs
   * and every existing test parse bit-identically. The single-section
   * fallback (no `sections` boundaries) folds this default in; with
   * boundaries, each SectionGeometry carries its own spec (the
   * adapter resolves the complete table — the #58 law).
   *
   * RIDES THE CONTEXT HASH: stableStringify(opts) covers this, so a
   * columns change invalidates the walk caches wholesale.
   */
  columns?: ColumnsSpec
  /**
   * DOCUMENT-LEVEL DEFAULT for widow/orphan protection. Default true
   * when omitted; per-block flow.widowControl overrides this.
   */
  preventWidowsAndOrphans?: boolean
  /**
   * #58 SECTIONS — the per-section geometry table. Each boundary is a
   * FORCED PAGE BREAK + a geometry swap: the walk crossing it closes
   * a non-fresh page (the breakBefore law) and switches the ACTIVE
   * geometry (page dims, margins, band wrap width, contentBox) to
   * `geometry` — the FOLLOWING section's setup.
   *
   * THE ADAPTER RESOLVES EVERYTHING: the shell's sectionBreak nodes
   * carry the PRECEDING section's props (Word's sectPr spelling), so
   * the adapter — which sees the whole doc — emits one boundary per
   * section START: afterBlock -1 carries section 0's geometry (the
   * first break's attrs), each subsequent boundary carries the next
   * break's attrs or the doc defaults for the final section. The
   * engine never parses node attrs. Absent → ONE section of the
   * opts geometry (today's shape exactly — additive).
   *
   * RIDES THE CONTEXT HASH: stableStringify(opts) covers sections, so
   * any boundary/geometry change invalidates the walk caches wholesale
   * (the same class as a page-margin change — L4's per-call law).
   */
  sections?: SectionBoundary[]
}

/** One section's page geometry (the active-geometry swap target). */
export interface SectionGeometry {
  page: { width: number; height: number }
  margins: { top: number; right: number; bottom: number; left: number }
  /**
   * #74 COLUMNS — this section's column spec. Absent ≡ one column
   * (the additive law). Resolved into per-column slots against the
   * section's content box (see ColumnSlot); rides the geometry swap
   * verbatim (page dims, margins — and now the column grid — switch
   * with the active section).
   */
  columns?: ColumnsSpec
}

/**
 * #74 COLUMNS — one section's newsletter-style column spec. `count`
 * columns with `gap` px between neighbors (default Word's 0.5" =
 * DEFAULT_COLUMN_GAP), each wrapping text independently: flow fills
 * column 0 top-down, wraps to column 1, and only wraps to a new PAGE
 * when every column on the page is full. `widths` (optional) makes
 * the columns UNEQUAL: relative weights (any positive numbers —
 * fractions of the shared width, NOT px), normalized to the
 * post-gap space; absent ≡ equal columns. `balanced` (default true)
 * equalizes the heights of the columns on the section's LAST page
   * (Word's balance law — the walk balances at the section-end
   * decision point, so the cache stores the balanced form and
   * splice/prefix reuse stays exact).
 */
export interface ColumnsSpec {
  /** Column count, integer >= 1. 1 ≡ single column (the additive law). */
  count: number
  /** px between neighboring columns. Default DEFAULT_COLUMN_GAP. */
  gap?: number
  /** Relative per-column weights (unequal columns). Absent ≡ equal. */
  widths?: number[]
  /** Balance the section's last-page column heights. Default true. */
  balanced?: boolean
}

/**
 * #74 COLUMNS — one resolved column slot (engine-issued fact, the
 * contentBox law applied to columns): the column's left edge `x` and
 * `width`, both CONTENT-BOX-relative — the shell adds contentBox.x
 * exactly as it does for every LineBox.rect. PageGeometry carries one
 * array per page (its section's grid) so consumers never derive the
 * geometry; LineBox.column indexes into it.
 */
export interface ColumnSlot {
  x: number
  width: number
}

/** Word's default column spacing: 0.5" at 96dpi. */
export const DEFAULT_COLUMN_GAP = 48

export interface SectionBoundary {
  /**
   * The boundary sits BETWEEN blocks[afterBlock] and
   * blocks[afterBlock + 1]; -1 = the document start (section 0's
   * geometry — the walk applies it before the first block). Boundaries
   * must be sorted ascending; several may share afterBlock (consecutive
   * breaks — an EMPTY middle section holds no pages: pages derive from
   * placed lines, the walk's invariant; its geometry simply never
   * renders).
   */
  afterBlock: number
  geometry: SectionGeometry
  /**
   * #58 — how the section STARTS (Word's "Section start"): 'nextPage'
   * closes the previous page; 'continuous' flows on — UNLESS the new
   * section's geometry differs, which Word upgrades to a page start
   * (a page cannot hold two geometries — the engine's one-geometry-
   * per-page law; the same-page sections simply share the frame).
   * The doc-start boundary (−1) ignores this (a document opens a page).
   */
  type?: 'nextPage' | 'continuous'
}

export interface PageGeometry {
  index: number
  size: Rect
  contentBox: Rect
  /**
   * #58 — the section this page belongs to (0-based, in boundary
   * order). Derives from the walk's own per-block entry pages: a block
   * never spans a boundary (the boundary closes before the block), so
   * every page a block touches carries its entry section. Uniform
   * documents (no sections option) are all 0.
   */
  sectionIndex: number
  /**
   * #74 COLUMNS — the page's column grid (its section's resolved
   * slots, frozen). Present IFF the section carries MORE THAN ONE
   * column (the additive law: single-column pages omit the field —
   * existing snapshots are pinned on it). LineBox.column indexes
   * into this array; consumers (ruler, hit-test, canvas grouping)
   * read the facts, never re-derive.
   */
  columns?: ColumnSlot[]
}

export interface LineBox {
  /** Edit survival: author-assigned, stable across edits by contract. */
  blockId: string
  /**
   * 0-based within the block, continuous across page fragments.
   * Edit survival: a positional ordinal recomputed on every layout — an
   * inserted line before it shifts the number, so treat it as position,
   * not stable identity.
   */
  lineIndex: number
  pageIndex: number
  /** Relative to the page content box. */
  rect: Rect
  baseline: number
  /**
   * Offsets into the block's concatenated run text (runs joined in array
   * order). Edit survival: plain character offsets — edits before an offset
   * shift it; they name source positions, which do survive edits, not
   * re-flowed fragments.
   */
  rangeStart: number
  rangeEnd: number
  /**
   * Copied from the line's LineResult — consumers never derive run
   * boundaries. Edit survival: plain character offsets into the
   * concatenated run text, same contract as rangeStart/rangeEnd.
   */
  segments: LineSegment[]
  /**
   * M-TABLES: present IFF this line is a TABLE CELL's line — the lane
   * identity (grid row/col of the cell ANCHOR — a spanned cell's
   * continuation carries the anchor's identity) and the lane's CONTENT
   * width (union track width − 2·CELL_PAD_H — the selection clamp's
   * bound; rect.width is the line's INK width). The shell clamps
   * selection rects to [rect.x, rect.x + width] and matches lines to
   * cells through (row, col). Cell lines within one band are PARALLEL
   * (same rect.y) — the flow track's contiguity contract is band-wise,
   * not line-wise (paint.ts).
   */
  tableCell?: { row: number; col: number; width: number }
  /**
   * M-HEADER-FOOTER: present IFF this line is a HEADER/FOOTER band's
   * line. Band lines ride `lines[]` like body lines (they need
   * caret/hit/segments) but NEVER the flow walk: `rect` stays
   * CONTENT-BOX-RELATIVE (a header line above the contentBox carries
   * NEGATIVE y — the float precedent made out-of-box coordinates
   * legal), and consumers that tile the flow track (the shell's
   * contiguity assert, line counting) must skip them.
   */
  band?: 'header' | 'footer'
  /**
   * #74 COLUMNS: present IFF this line's page's section carries more
   * than one column — the 0-based column index this line flows in
   * (an index into PageGeometry.columns). rect.x is COLUMN-offset
   * (colLeft + indent already folded in by the engine), so every
   * rect-consuming consumer is column-blind; only lane-bounded
   * consumers (hit-test, selection stripe clamps, canvas grouping)
   * read this. Absent on single-column docs (the additive law) and
   * on band lines (margins never flow).
   */
  column?: number
}

export interface FragmentBreak {
  blockId: string
  /**
   * Edit survival: a positional line ordinal, recomputed on every layout.
   * Pin: emitted ONLY when a block splits mid-block. atLine = the
   * lineIndex of the block's first line in the NEW FLOW SLOT (the line
   * that begins it); atLine >= 1 always. #74 COLUMNS: a slot may be a
   * COLUMN of the same pageIndex (a column continuation — the walk
   * fills column 0, then column 1, before wrapping the page), so
   * "the line that begins the new page" reads "the new slot" now; a
   * block pushed wholly to a new slot by a START move emits NO
   * FragmentBreak.
   */
  atLine: number
  /** Index of the PAGE the continuation begins on (a column continuation keeps the page). */
  pageIndex: number
}

/**
 * Per-call cache statistics — DEBUG SURFACE, documented as such: not
 * API-stable, never consulted by the engine itself.
 */
export interface LastStats {
  /** Blocks placed through the walk machine this call (lineCache hits count). */
  blocksWalked: number
  /** breakLines() invocations this call (lineCache misses). */
  linesRebroken: number
  /** Cached walk entries consumed by verified splice this call. */
  blocksSpliced: number
  /**
   * Current cache epoch. Persists across calls; resets to 0 in a fresh
   * engine; increments on wholesale (opts/baseStyle) invalidation.
   */
  cacheEpoch: number
  /** True when an opts/baseStyle change dropped the caches this call. */
  invalidated: boolean
}

/**
 * One ATOMIC VISUAL block's placement — images and equations;
 * horizontalRule may migrate to this array later (do not assume kind
 * is only 'image').
 * Field set designed so FLOATS (E-IMG-3) extend it additively — they
 * do, via the optional float/z fields below; nothing existing changed
 * shape (absent optionals are omitted by serialization — golden
 * snapshots are pinned on it). Order discipline: placed[] follows
 * DOCUMENT order, exactly like lines[] — floats interleaved with
 * block images at their block positions — a sibling array, never
 * interleaved with lines[]; consumers merge the two by (pageIndex,
 * rect.y). Images and equations never appear in lines[]. Edit
 * survival: echoes (src, alt, latex, fontSize) are the adapter's
 * stable strings; the rect is recomputed every layout (positional,
 * like LineBox.rect).
 */
/**
 * M-TABLES — a table cell's paint geometry (kind: 'tableCell' rects in
 * placed[]): the cell's box for this page fragment (a row split across
 * pages emits the cell's SLICE per page; a rowspan cell's box spans
 * its rows' bands — the slice covers only the bands on this page).
 * NOT a flow participant (the bands own the flow track — paint.ts's
 * contiguity contract skips this kind); rect is content-box-relative
 * like every PlacedRect.
 */
export interface TableCellPaint {
  /** Cell shading echo (null = transparent). */
  fill: string | null
  /** The table-level border preset the painter renders the grid with. */
  border: 'all' | 'none' | 'outer'
  colspan: number
  rowspan: number
  /** Grid row/col of the cell ANCHOR (the shell's PM-side cell matcher). */
  row: number
  col: number
}

export interface PlacedRect {
  /** Edit survival: author-assigned, stable across edits by contract. */
  blockId: string
  kind: 'image' | 'tableCell' | 'equation'
  /** OPAQUE echo of ImageBlock.src — images only. */
  src?: string
  /** OPAQUE echo of ImageBlock.alt — cache-relevant: it rides contentHash. Images only. */
  alt?: string
  /**
   * M-EQ — OPAQUE echo of EquationBlock.latex — equations only. The
   * shell's paint layer re-renders the math from it; the engine never
   * interprets the source.
   */
  latex?: string
  /** M-EQ — OPAQUE echo of EquationBlock.fontSize — equations only (the paint size). */
  fontSize?: number
  pageIndex: number
  /**
   * Relative to the page content box — same frame as LineBox.rect —
   * for FLOATS too (single frame for the whole array): a float may sit
   * IN the margin, so a floated rect can carry NEGATIVE x/y (or x
   * beyond the content width); the clamp that put it there ran in PAGE
   * coordinates.
   */
  rect: Rect
  /**
   * Present iff this rect was FLOATED (E-IMG-3): echo of the float
   * spec's dx/dy. Cache-relevant — rides contentHash (an edit must
   * re-walk, never serve a stale spliced echo).
   */
  float?: { dx: number; dy: number }
  /**
   * PAINT ORDER, not layout (E-IMG-3): present iff floated — 'behind'
   * paints under the text, 'front' over it. The engine's geometry is
   * byte-identical for either value; only this echo differs.
   */
  z?: 'front' | 'behind'
  /** Present iff kind: 'tableCell' — the cell's paint/grid data. */
  cell?: TableCellPaint
}

/**
 * Treat as immutable. The engine shares cached LineBox/FragmentBreak/
 * PlacedRect objects across results (zero-copy); callers mutating them
 * corrupt the cache AND parity. Emitted records are Object.freeze'd.
 */
export interface LayoutResult {
  pages: PageGeometry[]
  /** Document order. */
  lines: LineBox[]
  breaks: FragmentBreak[]
  /**
   * Document order. One entry per atomic visual block (images) —
   * block images and FLOATS (E-IMG-3) alike, interleaved at their
   * block positions; floats carry their float/z echoes. Sibling of
   * lines[] — consumers merge by (pageIndex, rect.y).
   */
  placed: PlacedRect[]
  /**
   * Cheap staleness signal, NOT a guarantee of change. Bumps ONLY when
   * a call performed any re-break/re-walk; a fully-cache-served call
   * keeps version.
   */
  version: number
}

export interface LayoutEngine {
  layout(doc: SemanticDoc, opts: LayoutOptions): LayoutResult
  /**
   * Debug surface: stats of the LAST layout() call. Rebuilt from
   * scratch every call — never accumulated (a stale counter would
   * make the scripted counts lie). Not API-stable.
   */
  readonly lastStats: LastStats
}
