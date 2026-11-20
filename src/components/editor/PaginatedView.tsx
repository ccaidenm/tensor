import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EditorContent, type Editor } from '@tiptap/react';
import type { Transaction } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import type { EquationMetrics, LayoutEngine, LayoutResult, LineBox, PageGeometry, TextMetrics } from '@tensor-editor/engine';
import { createLayoutEngine } from '@tensor-editor/engine';
import {
  pmDocToSemantic,
  referenceEntryAt,
  UnsupportedDocError,
  type AdapterBlock,
} from '@/lib/paginated/adapter';
import { navigateToReferenceTarget } from '@/lib/references/navigate';
import { EquationTooTallError } from '@tensor-editor/engine';
import { getRealMetrics, fontString } from '@/lib/paginated/metrics';
import { assertContiguity } from '@/lib/paginated/paint';
import { resolveReferencePages, type ReferencePagesMap } from '@/lib/paginated/referencePages';
import { computeLeaderCounts, adoptedLeaderCount } from '@/lib/paginated/referenceLeaders';
import {
  blockOffsetToPmPos,
  blockRangeAround,
  pmPosToBlockOffset,
  caretGeometry,
  caretStackRect,
  cellPosAt,
  inlineObjectRect,
  paintedBounds,
  textRangeLineRects,
  textRangeTextExtents,
  textRangeUnderlineRects,
  wordRangeAround,
  type CaretGeometry,
  type PaintedRect,
} from '@/lib/paginated/positionMap';
import { hitTest } from '@/lib/paginated/hitTest';
import { cellAround, findTable, TableMap } from '@tiptap/pm/tables';
import type { CellSelection as CellSelectionType } from '@tiptap/pm/tables';
import { TableCellLayer } from './paginated/TableCellLayer';
import { TableHeaderPins, type TableHeaderPin } from './paginated/TableHeaderPins';
import {
  IndexLineMarks,
  ReferenceTableBadges,
  type IndexLineMark,
  type ReferenceTableBadge,
} from './paginated/ReferenceGutter';
import type { ReferenceKind } from '@/lib/references/scan';
import { TableResizeHandles } from './paginated/TableResizeHandles';
import { deriveRulerModel } from '@/lib/paginated/ruler';
import { scrollCaretIntoView } from '@/lib/paginated/caretFollow';
import { setPaintedScrollHandler } from '@/lib/paginated/ScrollGuardExtension';
import { searchPluginKey } from '@/lib/editor/search/SearchExtension';
import { getSpellErrors, spellErrorAt } from '@/lib/editor/spell/SpellExtension';
import type { SpellError } from '@/lib/editor/spell/types';
import { getScrollParent } from '@/lib/editor/domUtils';
import { pasteFromSystemClipboard } from '@/lib/editor/clipboard';
import type { FloatingToolbarPosition } from '@/lib/editor/useFloatingToolbar';
import { useEditorState } from '@tiptap/react';
import { toLayoutOptions, type WatermarkSettings } from '@/lib/document/pageSetup';
import { useDocumentStore } from '@/lib/document/store';
import { selectionInBand } from '@/lib/editor/headerFooterCommands';
import { HeaderFooterSlots } from './paginated/HeaderFooterSlots';
import { useConfigStore } from '@/lib/config/store';
import { useFocusStore } from '@/lib/layout/focusStore';
import { useCommentStore } from '@/lib/comments/store';
import { commentTrackingKey } from '@/lib/editor/CommentExtension';
import { useStyleRegistryStore, lookupStyle } from '@/lib/styles/registry';
import { resolveNormalBase, baselineRunStyle, resolveRun } from '@/lib/styles/resolve';
import { ensureBlockIds } from '@/lib/editor/BlockIdExtension';
import { ensureStyleSync } from '@/lib/styles/styleExtensions';
import { applyRightClickSelection } from '@/lib/editor/rightClickSelection';
import { pageIndexAtY, pageTops, stackSize } from '@/lib/paginated/pageStack';
import { enableRegion, findBandContainer, type BandWhich } from '@/lib/editor/headerFooterCommands';
import { FINAL_SECTION_ID } from '@/lib/editor/HeaderFooterNodes';
import { PageSheet } from './paginated/PageSheet';
import { WatermarkLayer } from './paginated/WatermarkLayer';
import { BlockCanvas } from './paginated/BlockCanvas';
import { LineNumberGutter } from './paginated/LineNumberGutter';
import { ImageLayer } from './paginated/ImageLayer';
import { commitFloatDrag } from '@/lib/media/wrap';
import { useMediaStore } from '@/lib/media/store';
import { reportUnresolvedRefs } from '@/lib/media/diagnostics';
import { ImageSelection } from './paginated/ImageSelection';
import { countLineNumbers } from '@/lib/paginated/lineNumbers';
import { Ruler, VerticalRuler } from './paginated/Ruler';
import { useFontRegistryStore } from '@/lib/fonts/registry';
import { SelectionHighlights } from './paginated/SelectionHighlights';
import { SearchHighlights } from './paginated/SearchHighlights';
import { CommentHighlights, type CommentThreadPaint } from './paginated/CommentHighlights';
import { BreakMarks } from './paginated/BreakMarks';
import { SpellHighlights, type SpellBar } from './paginated/SpellHighlights';
import { FloatingToolbar } from './FloatingToolbar';
import { LinkBubble } from './LinkBubble';
import { SpellBubble } from './SpellBubble';
import { useLinkBubble } from '@/lib/editor/useLinkBubble';
import { EquationLayer } from './paginated/EquationLayer';
import { EquationEditorBubble } from './EquationEditorBubble';
import { useEquationEditor } from '@/lib/editor/useEquationEditor';
import { getEquationMetrics, katexFontEpochNow, subscribeKatexFonts } from '@/lib/equations/measure';
import { openUrl } from '@tauri-apps/plugin-opener';
import { bitmapVersionNow, getBitmapFailed, resolveMediaBitmap, subscribeBitmaps } from '@/lib/media/bitmapCache';
import { TooltipProvider } from '../ui/tooltip';

/**
 * PaginatedView — Tensor's default mode, first pixels.
 *
 * THE LAWS:
 *  L1: the engine computes, never paints; the shell paints, never
 *      computes. Every coordinate below is an engine-issued positioned
 *      fact (LineBox/PageGeometry); this file only adds container
 *      offsets (zoom stack, page gap, content box).
 *  L2: ONE engine instance + ONE RealMetrics instance, React refs, for
 *      the lifetime of this view. The engine's caches live INSIDE the
 *      engine instance — remounting either throws away warm walk/line caches
 *      mid-session, and pairing a differently-warm metrics instance
 *      with a cached engine silently violates parity.
 *  L3: the hidden PM view is INPUT ONLY — never measured, never
 *      positioned from. The legacy pipeline died of coordsAtPos/
 *      posAtCoords dead-zone ambiguity at page-break spacers; here PM
 *      geometry is never consulted at all — clicks hit-test the
 *      engine's LineBoxes instead (hitTest.ts).
 *  L4: pageSetup is read from the document store PER LAYOUT CALL,
 *      never captured at editor creation — the legacy frozen-options
 *      bug had spacer heights computed from stale margins forever
 *      after opening a file with different setup.
 *
 * NO DEBOUNCE, NO rAF BY DESIGN: PM update -> adapter ->
 * engine.layout -> setState -> paint, synchronously in one React
 * commit. The seam that makes that affordable is the engine's
 * incremental cache (blocksSpliced/linesRebroken) — a keystroke
 * re-walks only the edited block and its dependents.
 *
 * The selection overlay, search highlights, caret, floating
 * toolbar, and IME preview are all PROJECTIONS of PM state (see
 * positionMap.ts — the principle). All selection changes go through
 * PM transactions.
 */

const TOOLBAR_HEIGHT_EST = 44;
const TOOLBAR_WIDTH_EST = 340;
const EDGE_PAD = 8;

interface PaginatedViewProps {
  editor: Editor | null;
  /** TEST SEAM: inject deterministic metrics. Defaults to the app-wide
   * single RealMetrics (L2). The first injected instance wins for the
   * view's lifetime. */
  metrics?: TextMetrics;
  /** M-EQ TEST SEAM: inject the equation dims port the same way (the
   * real one is the KaTeX DOM measurer — jsdom cannot measure it). */
  equationMetrics?: EquationMetrics;
}

interface LayoutState {
  blocks: AdapterBlock[];
  result: LayoutResult;
  /** #58 — the NPC break facts (the BreakMarks layer's sidecar). */
  breakFacts: import('@/lib/paginated/adapter').AdapterResult['breakFacts'];
  /**
   * M-HEADER-FOOTER-3: the band blocks' ids — the cross-surface
   * selection clamp's membership set (from the adapter sidecar).
   */
  bandBlockIds: ReadonlySet<string>;
  /** Registry epoch this layout was built under — rides the STATE (not
   * a separate subscription) so BlockCanvas's epoch-keyed repaint can
   * never fire ahead of the relayout that owns it (a stale intermediate
   * paint of pre-edit ink). */
  styleEpoch: number;
}

interface SearchPaint {
  all: PaintedRect[];
  current: PaintedRect[];
}

/** #74 COLUMNS — the line-owns-x test for the text-track probes: the
 * line's column frame contains the content-box-relative x. Single-
 * column pages keep the y-only behavior (bit-identical — the additive
 * law); a columned page requires the click to fall in the line's own
 * slot band, so a column-2 click can never claim column-1 text. */
function lineOwnsX(page: PageGeometry, line: LineBox, x: number): boolean {
  if (page.columns == null) return true;
  const slot = page.columns[line.column ?? 0];
  if (!slot) return true;
  return x >= slot.x && x < slot.x + slot.width;
}

export function PaginatedView({ editor, metrics: injectedMetrics, equationMetrics: injectedEquationMetrics }: PaginatedViewProps) {
  // L2: one engine + one metrics for the view's lifetime.
  const engineRef = useRef<LayoutEngine | null>(null);
  const metricsRef = useRef<TextMetrics | null>(null);
  // M-EQ: the equation port ref — the SAME instance rides every engine
  // creation (initial + both recreate paths), so an injected test
  // double survives a recreate and the pairing law holds.
  const equationMetricsRef = useRef<EquationMetrics | null>(null);
  if (!engineRef.current) {
    if (!metricsRef.current) metricsRef.current = injectedMetrics ?? getRealMetrics();
    if (!equationMetricsRef.current) equationMetricsRef.current = injectedEquationMetrics ?? getEquationMetrics();
    // M-EQ: the equation dims port rides the engine from birth — the
    // same pairing law as TextMetrics (one warm ruler; the port's
    // cache is module-level, so recreate is measurement-cheap).
    engineRef.current = createLayoutEngine({
      metrics: metricsRef.current,
      equationMetrics: equationMetricsRef.current,
    });
  }

  const [layout, setLayout] = useState<LayoutState | null>(null);
  const [caret, setCaret] = useState<CaretGeometry | null>(null);
  // Blink-phase — solid on any input, blinking after
  // 500ms idle, hidden during non-collapsed selection and window blur.
  const [caretBlinking, setCaretBlinking] = useState(true);
  const [editorFocused, setEditorFocused] = useState(true);
  const blinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetCaretBlink = useCallback(() => {
    setCaretBlinking(false); // solid on any input
    if (blinkTimerRef.current) clearTimeout(blinkTimerRef.current);
    blinkTimerRef.current = setTimeout(() => setCaretBlinking(true), 500);
  }, []);
  const [selRects, setSelRects] = useState<PaintedRect[]>([]);
  /** M-REFS: the reference tables whose bounds carry the FIELD BORDER
   *  right now — the selection lives inside them (caret) or ON them
   *  (NodeSelection). Selection-driven chrome, the muted-band
   *  precedent; computed in the selection projection. */
  const [refBorders, setRefBorders] = useState<Set<string>>(() => new Set());
  const refBordersRef = useRef<Set<string>>(new Set());
  const [toolbarPos, setToolbarPos] = useState<FloatingToolbarPosition | null>(null);
  // M-IMAGES-1: the selected image's placed rect + model dims.
  // M-IMAGES-1.5: corner radius per image blockId (paint-only) —
  // derived from the PM doc so attr writes change its identity and
  // ImageLayer repaints; NO store epoch involved (no epoch churn).
  const imageRadii = useMemo(() => {
    const map = new Map<string, number>();
    editor?.state.doc.descendants((node) => {
      if (node.type.name === 'image' && typeof node.attrs.blockId === 'string') {
        map.set(node.attrs.blockId, Number(node.attrs.radius ?? 0));
      }
      return true;
    });
    return map;
  }, [editor?.state.doc]);
  // M-EQ-2: the equations' PAINT-ONLY color, per blockId (the
  // imageRadii precedent — paint facts stay out of the engine, so a
  // color edit repaints without any relayout). null = INHERIT (the
  // docDefaultText color below — the same derivation the canvas text
  // uses). Derived from the immutable PM doc at render time.
  const equationColors = useMemo(() => {
    const map = new Map<string, string | null>();
    editor?.state.doc.descendants((node) => {
      if (node.type.name === 'equation' && typeof node.attrs.blockId === 'string') {
        map.set(node.attrs.blockId, (node.attrs.color as string | null) ?? null);
      }
      return true;
    });
    return map;
  }, [editor?.state.doc]);
  const [imageSel, setImageSel] = useState<{
    placed: import('@tensor-editor/engine').PlacedRect;
    pos: number;
    float: { dx: number; dy: number; z: 'front' | 'behind' } | null;
    /** M-IMAGES-2.1: an INLINE object's selection — the overlay owns
     *  the visualization, float-drag is OFF (an in-flow object has no
     *  float placement of its own to drag into), resize stays. */
    inline: boolean;
  } | null>(null);
  const [searchPaint, setSearchPaint] = useState<SearchPaint | null>(null);
  // Spell/grammar flags: the flat-line projection (see updateSpellProjection).
  const [spellPaint, setSpellPaint] = useState<SpellBar[]>([]);
  // #COMMENTS — the anchored threads' painted rects (see
  // updateCommentProjection). Null = nothing to paint.
  const [commentPaint, setCommentPaint] = useState<{
    threads: CommentThreadPaint[];
    active: PaintedRect[];
  } | null>(null);
  // The suggestion bubble: set by a plain left-click on a flagged
  // word (GDocs behavior); the anchor derives at render time from the
  // error's painted extent (fresh through scrolls/zoom re-renders).
  const [spellBubble, setSpellBubble] = useState<SpellError | null>(null);
  const [composing, setComposing] = useState<string | null>(null);
  const [adapterError, setAdapterError] = useState<Error | null>(null);
  /** Pages whose canvases mount: viewport-visible ∪ ±1 buffer.
   * Sheets ALWAYS mount — scroll extents are geometry-owned. */
  const [visiblePages, setVisiblePages] = useState<Set<number> | null>(null);
  // Handlers below run inside PM's dispatch (outside React's render
  // cycle) — they read the fallback flag through this ref, not state.
  const adapterErrorRef = useRef<Error | null>(null);
  /** M-REFS: the resolver's warm map (the two-pass fixpoint's state) —
   *  identity-stable per the resolver; null on cold start/fallback. */
  const refPagesRef = useRef<ReferencePagesMap | null>(null);
  /** M-PAGEFIELD: the warm page TOTAL (the field placeholder's
   *  measured width source — the max-width digit string). The
   *  fixpoint: pass 1 measures with the warm total; the real total
   *  resolves off pass 1's page count; a widened placeholder
   *  re-lays-out (bounded, the M-REFS two-pass shape). */
  const fieldTotalRef = useRef<number | null>(null);

  const layoutRef = useRef<LayoutState | null>(null);
  const fontsReadyRef = useRef(false);
  const stackRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const relayoutRef = useRef<() => void>(() => {});
  const selectionProjectionRef = useRef<() => void>(() => {});
  const searchProjectionRef = useRef<() => void>(() => {});
  const spellProjectionRef = useRef<() => void>(() => {});
  // #COMMENTS — the comment projection (the search/spell pattern).
  const commentProjectionRef = useRef<() => void>(() => {});
  const pendingScrollRef = useRef(false);
  const prevSearchIndexRef = useRef(-1);
  const prevSearchStateRef = useRef<unknown>(null);
  // #COMMENTS — the projection's skip-state (the search pattern).
  const prevCommentRangesRef = useRef<ReadonlyArray<unknown> | null>(null);
  const prevActiveThreadRef = useRef<string | null>(null);
  const prevSpellErrorsRef = useRef<readonly unknown[] | null>(null);
  const draggingRef = useRef(false);
  const lastClickRef = useRef<{ t: number; x: number; y: number; c: number } | null>(null);
  // Virtualization: one observer watches every sheet; ratios drive the
  // canvas-visible set and the viewport-based status-bar page.
  const ioRatiosRef = useRef<Map<number, number>>(new Map());
  const ioRef = useRef<IntersectionObserver | null>(null);

  // Store subscriptions exist only to SCHEDULE relayout; the VALUES are
  // read fresh at call time (L4) — these selectors never feed options
  // directly.
  const pageSetup = useDocumentStore((s) => s.pageSetup);
  // #48 — the per-page styles (the positional map): paint-only ink,
  // so a map change re-renders without a relayout (the pageSetup
  // subscription's twin).
  const pageStyles = useDocumentStore((s) => s.pageStyles);
  // M-HEADER-FOOTER-2: the active-band signal (muted band ink + the
  // ruler's active-region accent) — selection-driven, one PM doc.
  const inBand = useEditorState({
    editor,
    selector: ({ editor: e }) => selectionInBand(e ?? null),
  });
  const defaultFontFamily = useConfigStore((s) => s.config.editor.defaultFontFamily);
  const defaultFontSize = useConfigStore((s) => s.config.editor.defaultFontSize);
  // REGISTRY EPOCH (M-STYLES): a definition edit bumps the epoch and
  // this effect relayouts — the adapter cache invalidates wholesale
  // (re-resolved runs/decor on every block) and the engine re-breaks
  // exactly the blocks whose contentHash changed (or splices the
  // paint-only ones; BlockCanvas's epoch key repaints those).
  const styleEpoch = useStyleRegistryStore((s) => s.epoch);
  const zoomLevel = useConfigStore((s) => s.config.editor.zoomLevel);
  const showFloatingToolbar = useConfigStore((s) => s.config.useFloatingToolbar);
  // Display-only ink (M6): NPCs paint on screen; never a layout fact.
  const showNonPrintingChars = useConfigStore((s) => s.config.editor.showNonPrintingChars);
  const showBreakMarks = useConfigStore((s) => s.config.editor.showBreakMarks);
  // M-IMAGES-1: caption display toggle (NPC precedent — ink only).
  const showCaptions = useConfigStore((s) => s.config.editor.showCaptions);
  // M-RULER: per-axis display gates (the command palette owns the
  // granular show/hide; the ribbon button toggles both). FOCUS MODE:
  // both bars hide with the chrome (the user ruling). THE HOOK LAW:
  // the focus subscription is UNCONDITIONAL — an `&&` on the config
  // selector would short-circuit the hook call itself, flipping the
  // component's hook count with the toggle (the 'Should have a queue'
  // crash). Combine AFTER both hooks have run.
  const showHorizontalRulerConfig = useConfigStore((s) => s.config.editor.showHorizontalRuler);
  const showVerticalRulerConfig = useConfigStore((s) => s.config.editor.showVerticalRuler);
  const focusActive = useFocusStore((s) => s.active);
  const showHorizontalRuler = showHorizontalRulerConfig && !focusActive;
  const showVerticalRuler = showVerticalRulerConfig && !focusActive;
  // #WATERMARK — the display toggle (the captions NPC precedent):
  // INK-ONLY — a hidden watermark gives back no space and triggers no
  // relayout (unlike showHeadersFooters below, which rides layout).
  const showWatermark = useConfigStore((s) => s.config.editor.showWatermark);
  // M-HEADER-FOOTER-2: the band display toggle (rides the layout —
  // a hidden band gives back its reservation; see relayout).
  const showHeadersFooters = useConfigStore((s) => s.config.editor.showHeadersFooters);
  // Accessibility: grammar flags as a double line (the pageless
  // fallback surface + PagelessEditor read this via a container class).
  const grammarDoubleLine = useConfigStore((s) => s.config.accessibility.grammarDoubleLine);
  // M-IMAGES-2.1 — the INLINE paint's arrival law: bumps when any
  // bitmap lands (pending inline objects repaint once; no relayout —
  // the bitmapVersion is geometry-free, it only rides boxKey).
  const [bitmapEpoch, setBitmapEpoch] = useState(0);
  useEffect(
    () =>
      subscribeBitmaps(() => {
        setBitmapEpoch(bitmapVersionNow());
      }),
    []
  );
  // M-IMAGES-2.2 — the unresolved-ref report ALSO rides store changes:
  // a MediaStore removal triggers no PM transaction (so no relayout),
  // but the doc's refs may have just gone gray — re-scan (dev only).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    return useMediaStore.subscribe(() => {
      const ed = useDocumentStore.getState().editor;
      if (ed) reportUnresolvedRefs(ed);
    });
  }, []);
  // M-IMAGES-2.2 — the painted projections (floating toolbar, caret)
  // track the VIEWPORT, not just the model: the desk's scroll moves
  // the anchored overlays with the content, so an image scrolled to
  // the desk's top edge keeps a toolbar computed for the OLD geometry
  // and gets clipped by the overflow-hidden desk wrapper (the ribbon
  // line). Recompute on scroll (the pageless hook's law, paginated
  // side) — the projection is a pure function of (layout, selection).
  // LISTENER PLACEMENT: the paginated root RE-MOUNTS across the view
  // branches (the fonts-gate stub renders no refs at all), so a
  // ref-anchored listener would attach to a node that doesn't exist
  // yet and die on the branch flip. Scroll events don't BUBBLE, but
  // they DO propagate down the CAPTURE phase from the document — one
  // stable document-level listener sees every scroller, desk included.
  useEffect(() => {
    if (!editor) return;
    const onScroll = () => selectionProjectionRef.current();
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions);
  }, [editor]);
  // M-RULER: the ruler bar is chrome OUTSIDE the desk's scroll flow —
  // this view portals it into the desk wrapper (the relative flex
  // container between the Ribbon and the scroller) as a static overlay:
  // flush under the ribbon, always visible, zero reflow on show/hide.
  // The wrapper is App-owned DOM; this closest() lookup is the one
  // structural contract between them. Re-runs on the layout flip: the
  // fonts-gate stub mounts a different root, so rootRef is null until
  // the real branch first commits.
  const hasLayout = layout !== null;
  const [deskWrapper, setDeskWrapper] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setDeskWrapper(
      rootRef.current?.closest<HTMLElement>('[data-desk-wrapper]') ?? null,
    );
  }, [hasLayout]);
  // Marker font fallback for EMPTY list items ("style from the block's
  // runs" — no runs → document default). Memoized for BlockCanvas's
  // prop-identity memo.
  const defaultRunStyle = useMemo(
    () => ({ fontFamily: defaultFontFamily, fontSize: defaultFontSize }),
    [defaultFontFamily, defaultFontSize]
  );
  const selectionColor = useConfigStore((s) => s.config.editor.selectionColor);
  const setPageInfo = useDocumentStore((s) => s.setPageInfo);
  // M-LINENUMS: document-level setting; the gutter is a pure
  // projection of it + LayoutResult (renders nothing when off).
  const lineNumbers = useDocumentStore((s) => s.lineNumbers);
  // M-FONTS: install/uninstall epoch — see the font-epoch effect.
  const fontEpoch = useFontRegistryStore((s) => s.epoch);
  const mergedStyles = useStyleRegistryStore((s) => s.merged);
  // The gutter speaks the document's baseStyle font (Editor.tsx's
  // resolveNormalBase spelling of the same idea).
  const gutterBase = useMemo(
    () => resolveNormalBase(defaultFontFamily, defaultFontSize, mergedStyles),
    [defaultFontFamily, defaultFontSize, mergedStyles]
  );
  // M-EQ-2: the equations' DEFAULT text color — the resolved 'normal'
  // run color (the same resolveRun the canvas painter consumes for
  // every text run; baseline hardcodes #000000, the normal style's
  // color property overrides). The DOM overlay must PAINT this
  // explicitly or it inherits chrome's --foreground (the off-white
  // mismatch the M-EQ-2 ruling fixes).
  const docDefaultTextColor = useMemo(() => {
    const normalDef = lookupStyle('normal', mergedStyles);
    return resolveRun({
      base: baselineRunStyle({ fontFamily: defaultFontFamily, fontSize: defaultFontSize }),
      para: normalDef,
    }).color;
  }, [defaultFontFamily, defaultFontSize, mergedStyles]);

  function computeToolbar(rects: readonly PaintedRect[]): FloatingToolbarPosition | null {
    const stack = stackRef.current;
    const bounds = paintedBounds(rects);
    if (!stack || !bounds) return null;
    const z = useConfigStore.getState().config.editor.zoomLevel / 100;
    const sr = stack.getBoundingClientRect();
    const view = (getScrollParent(stack) ?? stack).getBoundingClientRect();
    // ONE clearance (applied once by the toolbar's translateY) — the
    // old code subtracted EDGE_PAD here AND translated by 8px again,
    // floating the text toolbar twice as high as it should sit.
    const gap = EDGE_PAD;
    const aboveTop = sr.top + bounds.top * z;
    const belowTop = sr.top + bounds.bottom * z;
    // M-IMAGES-1.5: images anchor at their TOP edge (Word behavior) —
    // M-IMAGES-2.2: BUT ONLY WHEN IT FITS. The old forceAbove override
    // placed the toolbar above UNCONDITIONALLY, so an image scrolled
    // to the top of the desk had its toolbar clipped by the
    // overflow-hidden desk wrapper (right under the ribbon). The room
    // check (toolbar height + the gap clearance) wins for EVERYTHING
    // now: no room above → below the anchor.
    const fitsAbove = aboveTop - TOOLBAR_HEIGHT_EST - EDGE_PAD >= view.top;
    const placement = fitsAbove ? 'above' : 'below';
    const left = Math.min(
      Math.max(sr.left + bounds.left * z, view.left + EDGE_PAD),
      Math.max(view.left + EDGE_PAD, view.right - EDGE_PAD - TOOLBAR_WIDTH_EST)
    );
    return { left, top: aboveTop, bottom: belowTop, placement, gap };
  }

  function updateSelectionProjection() {
    const current = layoutRef.current;
    if (!editor || !current) return;
    const { selection } = editor.state;
    // Drag-select (any non-collapsed selection) dismisses the spell
    // bubble — it anchors one word; a collapsed caret placement (our
    // own opening click) keeps it open.
    if (!selection.empty) setSpellBubble(null);
    // M-HEADER-FOOTER-3: band selections project onto the ACTIVE page's
    // echo (recorded by the hit-test; viewport fallback). The surface
    // clamp: a selection whose ends sit on different surfaces (band vs
    // body — reachable via shift+click) paints ONLY the anchor's side
    // (PM state untouched — the painted projection stays honest).
    const inBandSel = selectionInBand(editor);
    const bandPage = inBandSel ? activeBandPage() : undefined;
    let surface: 'band' | 'body' | undefined;
    if (current.bandBlockIds.size > 0) {
      const a = pmPosToBlockOffset(current.blocks, selection.anchor);
      const h = pmPosToBlockOffset(current.blocks, selection.head);
      const aBand = a ? current.bandBlockIds.has(a.block.id) : false;
      const hBand = h ? current.bandBlockIds.has(h.block.id) : false;
      if (aBand !== hBand) surface = aBand ? 'band' : 'body';
    }
    const geom = caretGeometry(
      current.blocks,
      current.result,
      selection.head,
      metricsRef.current!,
      bandPage
    );
    // M-REFS: a NodeSelection on a reference table has NO text caret
    // (the equation treatment — an atom's selection is the block, not
    // a position in its projected text).
    const selNode0 = (selection as unknown as { node?: { type?: { name?: string } } }).node;
    const isReferenceTableNodeSelection = selNode0?.type?.name === 'referenceTable';
    setCaret(isReferenceTableNodeSelection ? null : geom);
    // Any input/selection motion resets the caret to solid;
    // the 500ms idle timer starts blinking.
    resetCaretBlink();
    // The status bar's page is VIEWPORT based (the
    // IntersectionObserver feed) — the caret no longer moves it.
    setPageInfo(current.result.pages.length, useDocumentStore.getState().currentPage);
    // M-IMAGES-1: a NodeSelection on an image projects to the
    // placed rect (selection state + resize handles).
    // M-IMAGES-2.1: an INLINE object's NodeSelection projects to its
    // PAINTED rect (inlineObjectRect — the token's line, baseline-
    // seated) — the same overlay treatment, minus float-drag (an
    // in-flow object has no float placement of its own to drag into).
    const selNode = (selection as unknown as { node?: { type?: { name?: string }; attrs?: Record<string, unknown> } }).node;
    const selName = selNode?.type?.name;
    const isBlockImageNodeSelection = selName === 'image';
    const isInlineImageNodeSelection = selName === 'inlineImage';
    // M-EQ: an equation NodeSelection shows NO floating toolbar — the
    // editor bubble is the equation's toolbar (it opens on the very
    // same selection; a text-format strip over an atom is noise).
    const isEquationNodeSelection = selName === 'equation';
    let inlineObjRect: import('@tensor-editor/engine').PlacedRect | null = null;
    if (isInlineImageNodeSelection) {
      const node = selNode as { attrs: { width?: unknown; height?: unknown } };
      inlineObjRect = inlineObjectRect(current.blocks, current.result, selection.from, metricsRef.current!);
      if (
        inlineObjRect &&
        typeof node.attrs.width === 'number' &&
        typeof node.attrs.height === 'number'
      ) {
        setImageSel({
          placed: inlineObjRect,
          pos: selection.from,
          float: null,
          inline: true,
        });
      } else {
        inlineObjRect = null;
        setImageSel(null);
      }
    } else if (isBlockImageNodeSelection) {
      const node = (selection as unknown as { node: { attrs: Record<string, unknown> } }).node;
      const blockId = node.attrs.blockId as string | undefined;
      const placedRect = blockId
        ? current.result.placed.find((pr) => pr.blockId === blockId) ?? null
        : null;
      const block = blockId ? current.blocks.find((b) => b.id === blockId) : undefined;
      if (placedRect && block && typeof node.attrs.width === 'number' && typeof node.attrs.height === 'number') {
        setImageSel({
          placed: placedRect,
          pos: block.from,
          float: (node.attrs.float as { dx: number; dy: number; z: 'front' | 'behind' } | null) ?? null,
          inline: false,
        });
      } else {
        setImageSel(null);
      }
    } else {
      setImageSel(null);
    }
    // The overlay owns the inline object's visualization — the text
    // selection band would paint a full line-box stripe OVER the
    // image (and zero-width before the object-aware walk). The
    // caret is suppressed too: a NodeSelection has no text caret.
    const tops = pageTops(current.result.pages, useDocumentStore.getState().pageSetup.pageGap);
    const stackRectOf = (pr: import('@tensor-editor/engine').PlacedRect): PaintedRect => ({
      pageIndex: pr.pageIndex,
      left: current.result.pages[pr.pageIndex]!.contentBox.x + pr.rect.x,
      top: tops[pr.pageIndex]! + current.result.pages[pr.pageIndex]!.contentBox.y + pr.rect.y,
      width: pr.rect.width,
      height: pr.rect.height,
    });
    // M-TABLES: a CELL selection paints the selected cells' rect
    // slices (every page slice — a split cell highlights across its
    // page fragments), matched by grid identity through the
    // cell-paragraph map's table (prosemirror-tables findCell — the
    // SAME grid identity the engine's cell rects echo).
    const isCellSelection = selection instanceof CellSelection;
    let cellRects: PaintedRect[] | null = null;
    if (isCellSelection) {
      cellRects = [];
      (selection as CellSelectionType).forEachCell((_node, pos) => {
        // The projection NEVER crashes a relayout: a boundary position
        // (a cell's end) can miss the map — skip that cell.
        try {
          // The CELL NODE's own offset is the map's key (not a position
          // inside it — cellAround resolves to the cell's start, which
          // sits inside the row, the depth findTable's map wants).
          const cellPos = cellAround(editor.state.doc.resolve(pos + 1));
          if (!cellPos) return;
          const loc = findTable(cellPos);
          if (!loc) return;
          const blockId = loc.node.attrs?.blockId;
          if (typeof blockId !== 'string') return;
          const cellBox = TableMap.get(loc.node).findCell(cellPos.pos - loc.start);
          for (const pr of current.result.placed) {
            if (pr.kind !== 'tableCell' || pr.blockId !== blockId) continue;
            if (pr.cell?.row !== cellBox.top || pr.cell?.col !== cellBox.left) continue;
            cellRects!.push(stackRectOf(pr));
          }
        } catch {
          return;
        }
      });
    }
    // M-TABLES: a caret parked inside a cell anchors the toolbar at
    // the CELL's slice on the caret's page (Word's context bar).
    let caretCellAnchor: PaintedRect | null = null;
    if (selection.empty && !isCellSelection) {
      try {
        const cellPos = cellAround(editor.state.doc.resolve(selection.head));
        const loc = cellPos ? findTable(cellPos) : null;
        const blockId = loc?.node.attrs?.blockId;
        if (cellPos && loc && typeof blockId === 'string') {
          const cellBox = TableMap.get(loc.node).findCell(cellPos.pos - loc.start);
          const pageIdx = geom?.pageIndex ?? 0;
          const slice = current.result.placed.find(
            (p) =>
              p.kind === 'tableCell' &&
              p.blockId === blockId &&
              p.cell?.row === cellBox.top &&
              p.cell?.col === cellBox.left &&
              p.pageIndex === pageIdx,
          );
          if (slice) caretCellAnchor = stackRectOf(slice);
        }
      } catch {
        caretCellAnchor = null; // a boundary position missed the map — no anchor
      }
    }
    const rects = isCellSelection
      ? cellRects!
      : selection.empty || isInlineImageNodeSelection || isReferenceTableNodeSelection
        ? []
        : textRangeLineRects(
            current.blocks,
            current.result,
            selection.from,
            selection.to,
            metricsRef.current!,
            useDocumentStore.getState().pageSetup.pageGap,
            bandPage,
            surface,
            current.bandBlockIds
          );
    if (isInlineImageNodeSelection || isCellSelection || isReferenceTableNodeSelection) setCaret(null);
    setSelRects(rects);
    // M-REFS: the FIELD BORDER set — reference blocks whose bounds
    // hold the selection (caret strictly inside, or a NodeSelection ON
    // the container). Ancestry-walk (the selectionInReferenceTable
    // helper's shape), keyed by the node's stable blockId.
    const borders = new Set<string>();
    type RefNodeLike = { type?: { name?: string }; attrs?: { blockId?: string } } | null | undefined;
    const addRef = (node: RefNodeLike) => {
      if (node?.type?.name === 'referenceTable') {
        const id = node.attrs?.blockId;
        if (id) borders.add(id);
      }
    };
    addRef((selection as unknown as { node?: RefNodeLike }).node);
    for (let d = selection.$from.depth; d > 0; d--) addRef(selection.$from.node(d));
    for (let d = selection.$to.depth; d > 0; d--) addRef(selection.$to.node(d));
    const prevBorders = refBordersRef.current;
    if (prevBorders.size !== borders.size || [...borders].some((id) => !prevBorders.has(id))) {
      refBordersRef.current = borders;
      setRefBorders(borders);
    }
    const imageNode = isBlockImageNodeSelection
      ? (selection as unknown as { node: { attrs: { blockId?: string } } }).node
      : null;
    const imageRectForToolbar =
      imageNode?.attrs.blockId != null
        ? current.result.placed.find((pr) => pr.blockId === imageNode.attrs.blockId) ?? null
        : null;
    // The image toolbar's rect is STACK-LOCAL (the same frame the text
    // path feeds — pageIndex stride + contentBox included). The first
    // cut passed content-relative coords, so the toolbar landed ~a
    // page-top/center and 96px left of the image (the reported
    // "center, a little left"). The INLINE object rides its painted
    // rect (placed[] holds block images only — lines hold objects).
    const imageToolbarRect: PaintedRect | null = imageRectForToolbar
      ? stackRectOf(imageRectForToolbar)
      : inlineObjRect
        ? stackRectOf(inlineObjRect)
        : null;
    setToolbarPos(
      !draggingRef.current &&
        useConfigStore.getState().config.useFloatingToolbar &&
        !isEquationNodeSelection &&
        !isReferenceTableNodeSelection &&
        (imageToolbarRect || caretCellAnchor || isCellSelection || !selection.empty)
        ? computeToolbar(
            imageToolbarRect
              ? [imageToolbarRect]
              : caretCellAnchor
                ? [caretCellAnchor]
                : isCellSelection
                  ? cellRects!
                  : rects,
          )
        : null
    );
  }

  function updateSearchProjection(force = false) {
    if (!editor) return;
    const st = searchPluginKey.getState(editor.state);
    const current = layoutRef.current;
    if (!st || !current) return;
    // Selection-only transactions leave the plugin state object identical
    // — skip re-projection (and the re-render) for those.
    if (!force && st === prevSearchStateRef.current) return;
    prevSearchStateRef.current = st;
    const stack = stackRef.current;
    const gap = useDocumentStore.getState().pageSetup.pageGap;
    const m = metricsRef.current!;
    const all: PaintedRect[] = [];
    for (const match of st.matches) {
      all.push(
        ...textRangeTextExtents(current.blocks, current.result, match.from, match.to, m, gap)
      );
    }
    const cur = st.currentIndex >= 0 ? st.matches[st.currentIndex] : undefined;
    const currentRects = cur
      ? textRangeTextExtents(current.blocks, current.result, cur.from, cur.to, m, gap)
      : [];
    setSearchPaint({ all, current: currentRects });
    if (st.currentIndex !== prevSearchIndexRef.current) {
      prevSearchIndexRef.current = st.currentIndex;
      // Current-match navigation scrolls via the minimal-edge follow.
      if (currentRects.length && stack) {
        const r = currentRects[0];
        scrollCaretIntoView(
          stack,
          { left: r.left, top: r.top, height: r.height },
          useConfigStore.getState().config.editor.zoomLevel / 100
        );
      }
    }
  }

  /** The spell flags' projection — the search pattern, one word at a
   *  time: PM plugin state (error ranges) mapped through positionMap
   *  into flat underline bars, KIND-TAGGED (spelling red, grammar
   *  blue — SpellHighlights owns the colors, and the optional double
   *  line rides the same bars). Recomputed on relayout (geometry moved)
   *  and on spell-meta transactions (results arrived — those dispatch
   *  WITHOUT doc changes, the same seam search's index metas ride).
   *  Doc-changing transactions reach this through relayout()'s force. */
  /** #COMMENTS — the comment projection (the search pattern): the
   *  tracking plugin's PM ranges mapped through positionMap into tinted
   *  rects, grouped per thread, with the ACTIVE thread's deeper tier.
   *  Recomputed on relayout (geometry moved) and on comment-store
   *  changes (the subscription below — active thread rides selection
   *  moves, anchored membership rides mark steps; neither can be seen
   *  from the doc-change seam alone). Skips when the ranges array is
   *  reference-identical AND the active thread is unchanged (the
   *  search projection's skip law). */
  function updateCommentProjection(force = false) {
    if (!editor) return;
    const st = commentTrackingKey.getState(editor.state);
    const current = layoutRef.current;
    if (!st || !current) return;
    const activeId = useCommentStore.getState().activeThreadId;
    if (!force && st.ranges === prevCommentRangesRef.current && activeId === prevActiveThreadRef.current)
      return;
    prevCommentRangesRef.current = st.ranges;
    prevActiveThreadRef.current = activeId;
    const gap = useDocumentStore.getState().pageSetup.pageGap;
    const m = metricsRef.current!;
    const byThread = new Map<string, PaintedRect[]>();
    const active: PaintedRect[] = [];
    for (const range of st.ranges) {
      const rects = textRangeTextExtents(current.blocks, current.result, range.from, range.to, m, gap);
      if (rects.length === 0) continue;
      const arr = byThread.get(range.threadId) ?? [];
      arr.push(...rects);
      byThread.set(range.threadId, arr);
      if (range.threadId === activeId) active.push(...rects);
    }
    setCommentPaint(byThread.size > 0 ? { threads: [...byThread.entries()].map(([id, rects]) => ({ id, rects })), active } : null);
  }

  function updateSpellProjection(force = false) {
    if (!editor) return;
    const current = layoutRef.current;
    if (!current) return;
    const errors = getSpellErrors(editor.state);
    if (!force && errors === prevSpellErrorsRef.current) return;
    prevSpellErrorsRef.current = errors;
    const gap = useDocumentStore.getState().pageSetup.pageGap;
    const bars: SpellBar[] = [];
    for (const e of errors) {
      for (const rect of textRangeUnderlineRects(
        current.blocks,
        current.result,
        e.from,
        e.to,
        metricsRef.current!,
        gap
      )) {
        bars.push({ ...rect, kind: e.kind });
      }
    }
    setSpellPaint(bars);
  }

  function relayout() {
    if (!editor || !fontsReadyRef.current) return;
    // L4: read per call, never captured.
    const pageSetupNow = useDocumentStore.getState().pageSetup;
    // M-HEADER-FOOTER-2: the band options read PER CALL (L4) — the
    // different-first-page flag travels in .wpdoc metadata; the ENGINE
    // owns the band geometry (placement, anchor, reservation) off the
    // adapter's doc.bands. No shell-side reservation exists anymore.
    const hfSettings = useDocumentStore.getState().headerFooter;
    const { defaultFontFamily: family, defaultFontSize: size } =
      useConfigStore.getState().config.editor;
    const registryNow = useStyleRegistryStore.getState();
    // baseStyle := resolve('normal') from the merged registry
    // (amendment 6): unedited 'normal' falls to the config defaults;
    // an edited 'normal' overrides them — and baseStyle's existing
    // baseStyleHash path carries the change wholesale into the engine
    // (empty lines measure under baseStyle, so they restyle too).
    const baseStyle = resolveNormalBase(family, size, registryNow.merged);
    // ADAPTER-CONTRACT GUARD (M6.1 fallback audit): this view's mount
    // effects run BEFORE the editor's onCreate (child effects first),
    // so the FIRST relayout can race the BlockIdExtension's initial
    // mint pass. The old blanket catch silently degraded every such
    // race into a fallback boot; the sentinel-only catch exposed it.
    // Running the idempotent mint pass here (a no-op once ids exist)
    // makes the handoff contract true regardless of effect order.
    // The heading styleId sync is the same load-path twin.
    ensureBlockIds(editor);
    ensureStyleSync(editor);
    // M-IMAGES-2.2 — the UNRESOLVED-REF report (dev-only): a media://
    // ref whose id is NOT in the MediaStore paints the placeholder in
    // every surface with zero trace of WHY. The other silent-gray
    // causes (decode failure) got their own diagnostic in bitmapCache;
    // this is the missing-media half of the loud posture.
    if (import.meta.env.DEV) reportUnresolvedRefs(editor);
    try {
      const __t0 = performance.now();
      // M-REFS — THE TWO-PASS FIXPOINT: pass 1 lays out with the WARM
      // numbers (the resolver's identity-stable map, null on cold
      // start → '' runs); the resolver reads pass 1's placement and,
      // iff any entry's number moved, pass 2 re-converts + re-lays-out
      // with the fresh map. Steady state: the resolver returns the
      // SAME map → pass 2 skipped, conversion caches stay warm. The
      // capped-at-2 ruling: numbers are read off pass 1; a number's
      // own width change re-resolves on the NEXT relayout (one-pass
      // lag in the pathological oscillation case, by ruling).
      const refPagesIn = refPagesRef.current;
      const fieldTotalIn = fieldTotalRef.current ?? undefined;
      const pass1 = pmDocToSemantic(editor.state.doc, baseStyle, {
        definitions: registryNow.merged,
        epoch: registryNow.epoch,
      }, {
        // M-HEADER-FOOTER-2: per-call band options (L4) — the engine
        // owns the band geometry from here.
        differentFirstPage: hfSettings?.differentFirstPage ?? false,
      }, refPagesIn ?? undefined, fieldTotalIn, pageSetupNow);
      const result1 = engineRef.current!.layout(
        // M-HEADER-FOOTER-2: the View ▸ Show Headers & Footers toggle is
        // DISPLAY-ONLY but rides the LAYOUT (the captions precedent is
        // ink-only; a hidden band must also GIVE BACK its reservation —
        // Word collapses the area). Stripping doc.bands pre-layout does
        // both: no band lines, body reclaimed. Per-call read (L4).
        useConfigStore.getState().config.editor.showHeadersFooters === false
          ? { ...pass1.doc, bands: undefined }
          : pass1.doc,
        {
          ...toLayoutOptions(pageSetupNow),
          // #58 — the resolved section table (absent when the doc
          // carries no sectionBreak nodes — the additive law).
          ...(pass1.sections ? { sections: pass1.sections } : {}),
        },
      );
      const refPagesOut = resolveReferencePages(pass1.blocks, result1.lines, refPagesIn);
      // M-PAGEFIELD: the total resolves off pass 1's page count — the
      // fixpoint re-converts + re-lays-out when the placeholder's
      // digit width must GROW (1 → 2 digits). Identity-stable when
      // unchanged (the same number → pass 2 skipped, caches warm).
      const totalNow = result1.pages.length;
      let adapted = pass1;
      let result = result1;
      const refPagesMoved = refPagesOut && refPagesOut !== refPagesIn;
      const fieldWidened = fieldTotalIn !== totalNow;
      if (refPagesMoved || fieldWidened) {
        if (refPagesMoved) refPagesRef.current = refPagesOut;
        if (fieldWidened) fieldTotalRef.current = totalNow;
        adapted = pmDocToSemantic(editor.state.doc, baseStyle, {
          definitions: registryNow.merged,
          epoch: registryNow.epoch,
        }, {
          differentFirstPage: hfSettings?.differentFirstPage ?? false,
        }, refPagesMoved ? refPagesOut : refPagesIn ?? undefined, totalNow, pageSetupNow);
        result = engineRef.current!.layout(
          useConfigStore.getState().config.editor.showHeadersFooters === false
            ? { ...adapted.doc, bands: undefined }
            : adapted.doc,
          {
            ...toLayoutOptions(pageSetupNow),
            ...(adapted.sections ? { sections: adapted.sections } : {}),
          },
        );
      }
      // Permanent benchmark seam: total relayout time, readable
      // by the self-driving bench and the coalescing test. The
      // engine's lastStats ride along (M-STYLES acceptance receipt —
      // devtools-quotable without touching engine internals).
      const __w = globalThis as {
        __benchRelayouts?: {
          relayouts: Array<{ total: number; at: number; lastStats?: unknown }>;
        };
      };
      __w.__benchRelayouts ??= { relayouts: [] };
      __w.__benchRelayouts.relayouts.push({
        total: performance.now() - __t0,
        at: performance.now(),
        lastStats: { ...engineRef.current!.lastStats },
      });
      assertContiguity(result);
      // M-REFS-10 — THE LEADER ADOPTION (the "entire leading is
      // selectable" ruling): measure the resolved dot counts off the
      // FRESH layout; when any container's model span length differs,
      // schedule the generator's FORCED pass (debounced — pagination
      // churn coalesces) so the spans adopt the full count and the
      // ENTIRE leader becomes real, selectable text. The fixpoint:
      // after adoption the fill = 0, the counts recompute equal, no
      // further writes.
      computeLeaderCounts(adapted.blocks, result.lines, metricsRef.current!);
      scheduleLeaderAdoption();
      // M-REFS-7 — the relayout leg of the debug seam: one entry per
      // layout call (version + walk stats). With the BlockCanvas leg,
      // the user's next repro discriminates: layouts running + no
      // canvas entries = the render path is dead; no layouts = the
      // update pipeline is dead (the frozen-relayout ghost theory).
      const dbgLayout = (globalThis as { __tensorPaintDebug?: { log: unknown[] } }).__tensorPaintDebug;
      if (dbgLayout) {
        dbgLayout.log.push({
          relayout: result.version,
          walked: engineRef.current!.lastStats.blocksWalked,
          spliced: engineRef.current!.lastStats.blocksSpliced,
        });
      }
      const next: LayoutState = { blocks: adapted.blocks, result, styleEpoch: registryNow.epoch, bandBlockIds: adapted.bandBlockIds, breakFacts: adapted.breakFacts };
      layoutRef.current = next;
      // No flushSync — React batches setLayout calls
      // from N input events into ONE render + ONE useLayoutEffect paint
      // per frame (the "paint once per frame" model). For single keys,
      // the microtask render fires within the same frame; for bursts,
      // all keys' adapter+engine run in the input events, and the
      // canvas paints once with the final state.
      setLayout(next);
      setAdapterError(null);
      adapterErrorRef.current = null;
      updateSelectionProjection();
      updateSearchProjection(true);
      updateSpellProjection(true);
      updateCommentProjection(true);
    } catch (err) {
      // FALLBACK AUDIT (M6.1, CONVENTIONS.md): the pageless fallback
      // catches ONLY the sentinel family — a document using a node the
      // projection doesn't support yet, or (M-EQ) an equation the
      // engine refuses (taller than any page — user input, not a bug;
      // the pageless surface renders the node view natively, no height
      // limit). Anything else is a real adapter/engine bug: rethrow in
      // dev so it crashes LOUDLY (a silent degrade would hide it); prod
      // keeps the never-eat-the-document fallback behind a loud console
      // error. Blanket Error catches that swallow bugs are banned.
      if (
        !(err instanceof UnsupportedDocError) &&
        !(err instanceof EquationTooTallError) &&
        import.meta.env.DEV
      ) {
        throw err;
      }
      console.error('[PaginatedView] layout failed; falling back to pageless rendering:', err);
      const error = err instanceof Error ? err : new Error(String(err));
      adapterErrorRef.current = error;
      setAdapterError(error);
      setPageInfo(1, 1);
    }
  }
  // M-HEADER-FOOTER-3: the ACTIVE BAND PAGE — the page whose band echo
  // the caret/selection/toolbar project onto. Band blocks echo on every
  // page with IDENTICAL ranges, so the projections need the page the
  // user interacted with: pmPosAt records it on every band hit (the
  // ONE hit-test seam); band selections without a click (Go-to-Header,
  // enable) fall back to the viewport's current page.
  const bandPageRef = useRef<number | null>(null);
  function activeBandPage(): number {
    return bandPageRef.current ?? Math.max(0, useDocumentStore.getState().currentPage - 1);
  }

  relayoutRef.current = relayout;
  selectionProjectionRef.current = updateSelectionProjection;
  searchProjectionRef.current = updateSearchProjection;
  spellProjectionRef.current = updateSpellProjection;
  commentProjectionRef.current = updateCommentProjection;

  function pmPosAt(e: { clientX: number; clientY: number }): number | null {
    const current = layoutRef.current;
    const stack = stackRef.current;
    if (!current || !stack) return null;
    const z = useConfigStore.getState().config.editor.zoomLevel / 100;
    const r = stack.getBoundingClientRect();
    const hit = hitTest(
      current.result,
      current.blocks,
      metricsRef.current!,
      useDocumentStore.getState().pageSetup.pageGap,
      (e.clientX - r.left) / z,
      (e.clientY - r.top) / z
    );
    if (!hit) return null;
    // M-HEADER-FOOTER-3: every band hit records its page — the echo
    // projections (caret/selection/toolbar/bubble) resolve THAT page.
    if (hit.band != null) bandPageRef.current = hit.pageIndex;
    const block = current.blocks.find((b) => b.id === hit.blockId);
    // M-REFS: entry hits map to TRUE positions inside the container's
    // real paragraphs (the sidecar bridge in blockOffsetToPmPos — the
    // cell-map precedent); no unit mapping, no interception.
    return block ? blockOffsetToPmPos(block, hit.offset) : null;
  }

  function startDrag(anchor: number) {
    draggingRef.current = true;
    setToolbarPos(null);
    const schedule =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (f: FrameRequestCallback) => {
            f(0);
            return 0;
          };
    let scheduled = false;
    let pending: { clientX: number; clientY: number } | null = null;

    const extend = () => {
      scheduled = false;
      if (!pending) return;
      const point = pending;
      pending = null;
      const pos = pmPosAt(point);
      if (pos != null) {
        // M-TABLES: a drag crossing a cell wall becomes a CELL
        // selection (prosemirror-tables' drag rule, shell-side — the
        // painted surface owns the events; the hidden view never sees
        // the mouse). Same cell → the plain text selection.
        const anchorCell = editor ? cellPosAt(editor.state.doc, anchor) : null;
        const headCell = editor && pos != null ? cellPosAt(editor.state.doc, pos) : null;
        if (anchorCell != null && headCell != null && anchorCell !== headCell) {
          editor?.commands.setCellSelection({ anchorCell, headCell });
        } else {
          editor?.commands.setTextSelection({ from: anchor, to: pos });
        }
      }
    };
    const onMove = (ev: MouseEvent) => {
      pending = { clientX: ev.clientX, clientY: ev.clientY };
      if (!scheduled) {
        scheduled = true;
        schedule(extend);
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      draggingRef.current = false;
      // The drag is final — surface the toolbar at the settled selection.
      selectionProjectionRef.current();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp, { once: true });
  }

  // Release-side belt-and-braces for the middle button: some engines
  // paste the primary selection on mouseup or auxclick instead of the
  // press (Firefox does). Killing the default there too makes "off"
  // hold everywhere.
  function swallowMiddleClick(e: React.MouseEvent) {
    if (e.button === 1) e.preventDefault();
  }

  /** M-T4 — the image-at-click probe for the CONTEXTMENU arm: the
   *  mousedown arm's image hit-test, spelled for the event that
   *  survives menu dismissal. FRONT/in-flow images win; a behind float
   *  only counts where no text line sits (the mousedown z-rules). */
  function imageBlockAtClick(e: React.MouseEvent): number | null {
    const stack = stackRef.current;
    if (!stack || !layout) return null;
    const z = useConfigStore.getState().config.editor.zoomLevel / 100;
    const sr = stack.getBoundingClientRect();
    const localX = (e.clientX - sr.left) / z;
    const localY = (e.clientY - sr.top) / z;
    const tops = pageTops(layout.result.pages, pageSetup.pageGap);
    const pageIndex = pageIndexAtY(tops, layout.result.pages.length, localY);
    const page = layout.result.pages[pageIndex]!;
    const inPageY = localY - tops[pageIndex]! - page.contentBox.y;
    const inPageX = localX - page.contentBox.x;
    const inside = (p: (typeof layout.result.placed)[number]) =>
      inPageX >= p.rect.x &&
      inPageX <= p.rect.x + p.rect.width &&
      inPageY >= p.rect.y &&
      inPageY <= p.rect.y + p.rect.height;
    const front = layout.result.placed.filter(
      (p) =>
        (p.kind === 'image' || p.kind === 'equation') &&
        p.pageIndex === pageIndex &&
        p.z !== 'behind',
    );
    for (let i = front.length - 1; i >= 0; i--) {
      const p = front[i]!;
      if (!inside(p)) continue;
      const block = layout.blocks.find((b) => b.id === p.blockId);
      if (block) return block.from;
    }
    const textTrackHit = layout.result.lines.some(
      (l) =>
        l.pageIndex === pageIndex &&
        inPageY >= l.rect.y &&
        inPageY <= l.rect.y + l.rect.height &&
        lineOwnsX(page, l, inPageX),
    );
    if (!textTrackHit) {
      const behind = layout.result.placed.filter(
        (p) => p.kind === 'image' && p.pageIndex === pageIndex && p.z === 'behind',
      );
      for (let i = behind.length - 1; i >= 0; i--) {
        const p = behind[i]!;
        if (!inside(p)) continue;
        const block = layout.blocks.find((b) => b.id === p.blockId);
        if (block) return block.from;
      }
    }
    return null;
  }

  /** M-T4 — the CONTEXTMENU arm of the right-click rule: the menu reads
   *  the CLICK, never the stale selection. The mousedown arm
   *  (handleMouseDown) resolves the click in the common case; this arm
   *  covers the case its mousedown was CONSUMED — right-clicking
   *  elsewhere while the menu is already open dismisses it and swallows
   *  the mousedown, so the selection would stay wherever it was
   *  ("selected an image, right-clicked in a table, still image
   *  options"). The native contextmenu event still fires and reaches
   *  the surface, BEFORE the menu trigger's own handler (DOM bubbling:
   *  deeper first — base-ui's trigger then stopEvent's it), so the
   *  re-opened menu reads the click-resolved selection. Idempotent
   *  with the mousedown arm (same rule, same coordinates). */
  function handleContextMenu(e: React.MouseEvent) {
    if (!editor || adapterError || !layout) return;
    if (e.button !== 2) return;
    // Coordinate-less dispatches (tests, keyboard-invoked menus) must
    // not resolve against the nearest line — the selection stays
    // wherever its owner put it.
    if (!Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return;
    const imageFrom = imageBlockAtClick(e);
    if (imageFrom != null) {
      editor.commands.setNodeSelection(imageFrom);
      return;
    }
    applyRightClickSelection(editor, pmPosAt(e));
  }

  /** #58 — the UNLINK flow (Word's edit-unlinks): double-clicking a
   *  LIVE band strip of an INHERITING section creates that section's
   *  own header/footer — seeded with a copy of the inherited content —
   *  instead of word-selecting into the doc default (whose edits would
   *  restyle every section). An OVERRIDING section's strip dblclicks
   *  normally (word-select in its own content). Uniform docs: normal
   *  word-select everywhere (there is nothing to unlink). */
  function handleBandDoubleClick(e: React.MouseEvent) {
    if (!editor || adapterError || !layout) return;
    const stack = stackRef.current;
    if (!stack) return;
    const z = useConfigStore.getState().config.editor.zoomLevel / 100;
    const sr = stack.getBoundingClientRect();
    const localY = (e.clientY - sr.top) / z;
    const tops = pageTops(layout.result.pages, pageSetup.pageGap);
    const pageIndex = pageIndexAtY(tops, layout.result.pages.length, localY);
    const page = layout.result.pages[pageIndex]!;
    const inPageY = localY - tops[pageIndex]!;
    const which: BandWhich | null =
      inPageY < page.contentBox.y
        ? 'header'
        : inPageY > page.contentBox.y + page.contentBox.height
          ? 'footer'
          : null;
    if (!which) return; // the body — normal word-select
    // A sectioned document only (a uniform doc has nothing to unlink).
    if (sectionIds.length === 0) return;
    const variant =
      pageIndex === 0 && (useDocumentStore.getState().headerFooter?.differentFirstPage ?? false)
        ? 'first'
        : 'default';
    const sectionId = sectionIdOfPage(page.sectionIndex);
    // An OVERRIDING section's band is live content — normal editing.
    if (findBandContainer(editor, which, variant, sectionId)) return;
    // The section INHERITS — unlink: create its own band (the seed =
    // a copy of the inherited content) and focus it.
    e.preventDefault();
    enableRegion(editor, which, variant, sectionId);
  }

  function handleMouseDown(e: React.MouseEvent) {
    if (!editor || adapterError || !layout) return;
    // Middle button: paste-on-middle-click (settings > General >
    // Behavior). The webview's DEFAULT middle-click action on Linux
    // pastes the X11 primary selection into the focused editable
    // (WebKitGTK), so the press is preventDefaulted UNCONDITIONALLY —
    // the toggle is the single source of truth. Off = nothing at all
    // (native paste and autoscroll both die here); on = caret to the
    // click point, then the system clipboard replays through PM's own
    // paste handler.
    if (e.button === 1) {
      e.preventDefault();
      if (!useConfigStore.getState().config.editor.pasteOnMiddleClick) return;
      if (!editor || adapterError || !layout) return;
      (editor.view.dom as HTMLElement).focus({ preventScroll: true });
      const pos = pmPosAt(e);
      if (pos != null) editor.commands.setTextSelection(pos);
      void pasteFromSystemClipboard(editor);
      return;
    }
    e.preventDefault();
    // The hidden PM view receives keyboard focus with preventScroll: its
    // geometry is meaningless (L3), so letting the browser reveal its
    // native caret would scroll the App container to a nonsense spot.
    (editor.view.dom as HTMLElement).focus({ preventScroll: true });

    // M-IMAGES-2: the Z-AWARE image hit-test. z is PAINT ORDER and the
    // click rule mirrors it: 'front' floats (+ in-flow images — they
    // never overlap text) WIN, checked first, topmost = last placed[];
    // 'behind' floats LOSE to text — a click inside a line's rect goes
    // to the text; a behind float is only selectable in text-empty
    // space. Images are not in lines[], so the text hitTest below
    // never sees them.
    const stack = stackRef.current;
    let behindCandidate: string | null = null;
    if (stack && layout.result.placed.length > 0) {
      const z = useConfigStore.getState().config.editor.zoomLevel / 100;
      const sr = stack.getBoundingClientRect();
      const localX = (e.clientX - sr.left) / z;
      const localY = (e.clientY - sr.top) / z;
      const tops = pageTops(layout.result.pages, pageSetup.pageGap);
      const pageIndex = pageIndexAtY(tops, layout.result.pages.length, localY);
      const page = layout.result.pages[pageIndex]!;
      const inPageY = localY - tops[pageIndex]! - page.contentBox.y;
      const inPageX = localX - page.contentBox.x;
      const inside = (p: (typeof layout.result.placed)[number]) =>
        inPageX >= p.rect.x &&
        inPageX <= p.rect.x + p.rect.width &&
        inPageY >= p.rect.y &&
        inPageY <= p.rect.y + p.rect.height;
      // 1. FRONT + in-flow (topmost wins): IMAGES and EQUATIONS — the
      //    tableCell rects are paint geometry; a click inside a cell
      //    routes to the text hitTest (the caret/cell rules).
      //    Equations are in-flow atomics (no z, never behind) — the
      //    same group by construction.
      for (let i = layout.result.placed.length - 1; i >= 0; i--) {
        const p = layout.result.placed[i]!;
        if (
          (p.kind !== 'image' && p.kind !== 'equation') ||
          p.pageIndex !== pageIndex ||
          p.z === 'behind'
        )
          continue;
        if (inside(p)) {
          const block = layout.blocks.find((b) => b.id === p.blockId);
          if (block) {
            editor.commands.setNodeSelection(block.from);
            return;
          }
        }
      }
      // 2. The text track: a line's rect under the click means text
      //    wins over any behind float (the paint-order mirror). #74 —
      //    the line must own the click's COLUMN too.
      const textTrackHit = layout.result.lines.some(
        (l) =>
          l.pageIndex === pageIndex &&
          inPageY >= l.rect.y &&
          inPageY <= l.rect.y + l.rect.height &&
          lineOwnsX(page, l, inPageX),
      );
      // 3. BEHIND floats — only in text-empty space:
      if (!textTrackHit) {
        for (let i = layout.result.placed.length - 1; i >= 0; i--) {
          const p = layout.result.placed[i]!;
          if (p.kind !== 'image' || p.pageIndex !== pageIndex || p.z !== 'behind') continue;
          if (inside(p)) {
            behindCandidate = p.blockId;
            break;
          }
        }
      }
    }

    // M-REFS — THE CONTAINER-MODEL CLICK: entries are REAL text — a
    // plain click/caret/drag flows PM's NATIVE path (the generic hit
    // resolves to true positions INSIDE entry paragraphs through the
    // sidecar bridge; nothing is intercepted). The ONE custom arm:
    // Ctrl/Cmd+click ANYWHERE in a row navigates (M-REFS-11: the rows
    // are ALWAYS hyperlinking invisibly — the semantic link mark is
    // the model data the future exporters map; the editor's follow is
    // the modifier click, Word's field convention).
    if (stack && (e.ctrlKey || e.metaKey)) {
      const rz = useConfigStore.getState().config.editor.zoomLevel / 100;
      const rs = stack.getBoundingClientRect();
      const refHit = hitTest(
        layout.result,
        layout.blocks,
        metricsRef.current!,
        useDocumentStore.getState().pageSetup.pageGap,
        (e.clientX - rs.left) / rz,
        (e.clientY - rs.top) / rz
      );
      const refBlock = refHit ? layout.blocks.find((b) => b.id === refHit.blockId) : undefined;
      if (refBlock?.reference) {
        const entry = referenceEntryAt(refBlock.reference, refHit!.offset);
        // The placeholder carries ZERO targets — visible, never
        // navigable (an honest no-op, not a silent caret jump).
        if (entry && entry.targets.length > 0) {
          e.preventDefault();
          navigateToReferenceTarget(editor, entry.targets[0]!);
          return;
        }
      }
    }

    const pos = pmPosAt(e);
    if (behindCandidate) {
      const block = layout.blocks.find((b) => b.id === behindCandidate);
      if (block) {
        editor.commands.setNodeSelection(block.from);
        return;
      }
    }
    // M-IMAGES-2.1 — the INLINE object's click: hitTest resolves the
    // token to its PM position (blockOffsetToPmPos — the object token
    // occupies exactly the position BEFORE the node); nodeAt(pos) IS
    // the inline image when the click landed inside the object's
    // painted rect. NodeSelection, the same treatment a block image
    // gets: the toolbar swaps to the image group (Wrap/Alt/Radius
    // reachable), Backspace deletes. Clicking the TEXT around it
    // resolves inside a text node → nodeAt is undefined → text path.
    if (pos != null) {
      const nodeAtPos = editor.state.doc.nodeAt(pos);
      if (nodeAtPos?.type.name === 'inlineImage') {
        editor.commands.setNodeSelection(pos);
        return;
      }
    }
    if (pos == null) return;

    // M-T4 — THE RIGHT-CLICK RULE (Word), the ONE shared spelling
    // (rightClickSelection.ts): the image hit-test above has already
    // returned for image clicks, so this is the keep-inside /
    // collapse-outside arm — the context menu reads the selection AT
    // THE CLICK. The old path ran the click-count logic for every
    // button, so a right-click after recent lefts landed on count 2/3
    // and silently re-selected the whole WORD or PARAGRAPH.
    if (e.button === 2) {
      applyRightClickSelection(editor, pos);
      return;
    }

    const now = Date.now();
    const prev = lastClickRef.current;
    const dx = prev ? e.clientX - prev.x : 999;
    const dy = prev ? e.clientY - prev.y : 999;
    const count =
      prev && now - prev.t < 500 && dx * dx + dy * dy < 100
        ? Math.min(prev.c + 1, 3)
        : 1;
    lastClickRef.current = { t: now, x: e.clientX, y: e.clientY, c: count };

    if (count === 2) {
      editor.commands.setTextSelection(wordRangeAround(editor.state.doc, pos));
      return;
    }
    if (count === 3) {
      editor.commands.setTextSelection(blockRangeAround(editor.state.doc, pos) ?? pos);
      return;
    }

    // Ctrl/Cmd+click on a painted link opens it via the OS
    // (the committed legacy rule — plain click places the caret, the
    // bubble's Open button stays). Opened through the same plugin-opener
    // the bubble uses.
    if (e.ctrlKey || e.metaKey) {
      const linkMark = editor.state.doc.resolve(pos).marks().find((m) => m.type.name === 'link');
      const href = linkMark?.attrs.href;
      if (typeof href === 'string' && href) {
        e.preventDefault();
        void openUrl(href);
        return;
      }
    }

    if (e.shiftKey) {
      // Extend from PM's own anchor — the shell never tracks selection.
      editor.commands.setTextSelection({ from: editor.state.selection.anchor, to: pos });
    } else {
      editor.commands.setTextSelection(pos);
      // GDocs-style: a plain single click on a flagged word opens the
      // suggestion bubble. The caret still places and drag-select
      // still starts (a drag makes the selection non-empty, which
      // dismisses the bubble again — only a real click keeps it).
      const error = spellErrorAt(editor.state, pos);
      if (error) setSpellBubble(error);
      startDrag(pos);
    }
  }

  // PM-driven relayout (L3's only PM read: the MODEL, not the view's
  // geometry). Also the font gate: the first layout must wait on
  // document.fonts.ready — the engine's line cache never invalidates on
  // metrics identity, so pre-font-load measurement would cache
  // fallback-font widths for the whole session (see metrics.ts).
  //
  // The caret-follow TRIGGER is PM's own intent flag —
  // `transaction.scrolledIntoView` is set only by tr.scrollIntoView(),
  // which PM's key/input handling sets on caret motion; layout churn
  // alone dispatches no flagged transaction, so churn never scrolls.
  // The FOLLOW runs synchronously with the dispatch, AFTER the layout
  // it must read is fresh: a doc-changing transaction follows at the
  // end of 'update' (relayout ran first), a selection-only one at the
  // end of 'selectionUpdate'.
  useEffect(() => {
    if (!editor) return;

    const followPendingScroll = () => {
      if (!pendingScrollRef.current) return;
      pendingScrollRef.current = false;
      if (adapterErrorRef.current) return; // fallback: PM native already scrolled the visible DOM
      const current = layoutRef.current;
      const stack = stackRef.current;
      if (!current || !stack) return; // nothing painted yet: nothing to reveal
      const caretGeom = caretGeometry(
        current.blocks,
        current.result,
        editor.state.selection.head,
        metricsRef.current!,
        selectionInBand(editor) ? activeBandPage() : undefined
      );
      if (!caretGeom) return; // selection outside text: nothing to reveal
      const { pageSetup: setupNow } = useDocumentStore.getState();
      const zoomNow = useConfigStore.getState().config.editor.zoomLevel / 100;
      // #58: the caret's OWN page carries the geometry (mixed sections).
      const caretPage = current.result.pages[caretGeom.pageIndex]!;
      const topsNow = pageTops(current.result.pages, setupNow.pageGap);
      scrollCaretIntoView(
        stack,
        caretStackRect(
          caretGeom,
          caretPage.contentBox.x,
          caretPage.contentBox.y,
          topsNow[caretGeom.pageIndex]!
        ),
        zoomNow
      );
    };

    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      // Search/spell meta (query/index, error results) arrives without
      // doc changes; doc changes are covered by the relayout in
      // 'update' below.
      if (!transaction.docChanged) {
        searchProjectionRef.current();
        spellProjectionRef.current();
      }
      if (transaction.scrolledIntoView) pendingScrollRef.current = true;
    };
    const onDocUpdate = () => {
      // Typing invalidates the anchored word (the recheck that
      // follows will re-flag whatever survives the edit).
      setSpellBubble(null);
      // Synchronous-first — adapter+engine+commit run in
      // the input event's own task; text paints in the input's frame.
      // Over SYNC_BUDGET_PER_FRAME per ~16ms window, the coalescer
      // (rAF) takes over as the pressure valve.
      trySyncOrDeferRef.current();
      followPendingScroll();
    };
    const onSelectionUpdate = ({ transaction }: { transaction: Transaction }) => {
      selectionProjectionRef.current();
      // Selection-only motion (no doc change): the layout is already
      // current — follow now. Doc-changing transactions are followed by
      // the 'update' handler above (after relayout), not here.
      if (!transaction.docChanged) followPendingScroll();
    };
    editor.on('transaction', onTransaction);
    editor.on('update', onDocUpdate);
    editor.on('selectionUpdate', onSelectionUpdate);

    // Font gate: custom fonts must be LOADED before the first measure —
    // the engine's line cache never invalidates on metrics identity, so
    // pre-load measurement would cache fallback-font widths for the whole
    // session. document.fonts.load forces the configured base font's
    // load; mark-level families are covered by fonts.ready (the hidden
    // view renders them, triggering their loads).
    let cancelled = false;
    void (async () => {
      if (typeof document !== 'undefined' && document.fonts) {
        const { defaultFontFamily: family, defaultFontSize: size } =
          useConfigStore.getState().config.editor;
        if (typeof document.fonts.load === 'function') {
          try {
            await document.fonts.load(fontString({ fontFamily: family, fontSize: size }));
          } catch {
            // unsupported/unregistered font string — ready below still gates
          }
        }
        await document.fonts.ready;
      }
      if (cancelled) return;
      fontsReadyRef.current = true;
      relayoutRef.current();
    })();

    return () => {
      cancelled = true;
      editor.off('transaction', onTransaction);
      editor.off('update', onDocUpdate);
      editor.off('selectionUpdate', onSelectionUpdate);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (adoptionTimerRef.current !== null) {
        clearTimeout(adoptionTimerRef.current);
        adoptionTimerRef.current = null;
      }
    };
  }, [editor]);

  // Store-driven reflow (A4 -> Letter, default font changes, registry
  // epoch bumps) relayouts WITHOUT remounting the view: the engine
  // stays warm, its opts-invalidation path handles the geometry
  // change, the adapter's epoch-tagged identity cache handles the
  // registry change.
  useEffect(() => {
    relayoutRef.current();
    // M-HEADER-FOOTER-2: showHeadersFooters rides the LAYOUT (the band
    // strip above) — its flips relayout through this same warm path.
  }, [pageSetup, defaultFontFamily, defaultFontSize, styleEpoch, showHeadersFooters]);

  // M-HEADER-FOOTER-2: settings writes (differentFirstPage) relayout
  // through the same warm path — the flag feeds the adapter's band
  // options, read fresh per call (L4, inside relayout itself).
  // Content edits ride the standard PM 'update' relayout.
  useEffect(() => {
    let lastHf: unknown = useDocumentStore.getState().headerFooter;
    const unsubDoc = useDocumentStore.subscribe((s) => {
      if (s.headerFooter !== lastHf) {
        lastHf = s.headerFooter;
        relayoutRef.current();
      }
    });
    return () => {
      unsubDoc();
    };
  }, []);

  // #COMMENTS — the comment store is the projection's trigger for
  // every NON-transaction change (active thread, anchored membership,
  // thread edits): the transaction seams (relayout for geometry/doc,
  // onTransaction for selection) can't see store-only writes like
  // deleteThread's active reset. The projection's skip law keeps the
  // redundant calls free (identity compare on ranges + active id).
  useEffect(() => {
    const unsub = useCommentStore.subscribe(() => commentProjectionRef.current());
    return unsub;
  }, []);

  // M-FONTS: a font install/uninstall changes the RULER mid-session.
  // The font registry's epoch bump means a FontFace was registered or
  // removed — visible docs must re-measure NOW (live, not
  // next-launch). Two things happen, in order:
  const firstFontEpochRun = useRef(true);
  useEffect(() => {
    // Mount run is a no-op: at cold-boot the engine is fresh anyway
    // (a relaunch's loadFromDisk re-registrations land before the
    // first measure — the gate covers them). Only LATER bumps (an
    // install/uninstall during this session) take the recreate path.
    if (firstFontEpochRun.current) {
      firstFontEpochRun.current = false;
      return;
    }
    let cancelled = false;
    void (async () => {
      // 1. RE-GATE: every registered face is loaded before any
      //    measure — the M5.6 law, now also the re-gate (fonts
      //    re-gate before first layout after any install).
      if (typeof document !== 'undefined' && document.fonts) {
        await document.fonts.ready;
      }
      if (cancelled) return;
      // 2. ENGINE RECREATE — the stale-cache remedy. The engine
      //    drops its line caches only when opts/baseStyle HASHES
      //    change (engine layout.ts); a doc that referenced 'MyFont'
      //    BEFORE the font existed measured fallback widths, and the
      //    strings are identical pre/post install — so a plain
      //    relayout would re-serve those fallback-width LineBoxes
      //    forever. Recreating the engine starts the cache cold.
      //    WHY ADAPTER REUSE IS SAFE: the pairing law (metrics.ts)
      //    forbids a WARM metrics paired with a CACHED engine — the
      //    reverse (a warm ruler with a COLD cache) is exactly the
      //    legal direction. The adapter's Blocks/runs are unchanged
      //    by a font install (only the ruler changed), so reusing
      //    them is legal; the fresh engine re-measures them with the
      //    now-real font.
      engineRef.current = createLayoutEngine({
        metrics: metricsRef.current!,
        equationMetrics: equationMetricsRef.current!,
      });
      relayoutRef.current();
    })();
    return () => {
      cancelled = true;
    };
  }, [fontEpoch]);

  // M-EQ: KaTeX font arrival — an equation measured before the math
  // fonts land caches fallback-font dims in the WALK cache (placed
  // rects), the identical hazard the M-FONTS recreate cures for text.
  // loadingdone already means the batch finished — no re-gate; the
  // remedy is the same cold-cache recreate + relayout.
  const katexEpochRef = useRef(katexFontEpochNow());
  useEffect(
    () =>
      subscribeKatexFonts(() => {
        const now = katexFontEpochNow();
        if (now === katexEpochRef.current) return;
        katexEpochRef.current = now;
        engineRef.current = createLayoutEngine({
          metrics: metricsRef.current!,
          equationMetrics: equationMetricsRef.current!,
        });
        relayoutRef.current();
      }),
    [],
  );

  // One IntersectionObserver over all sheets. Visible
  // (±1 buffer) pages mount canvases; the sheet with the highest
  // intersection ratio is the status bar's current page — viewport
  // based, not caret based.
  useEffect(() => {
    const IO = (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
    if (!IO) return;
    const io = new IO((entries) => {
      for (const entry of entries) {
        const idx = Number((entry.target as HTMLElement).dataset.pageIndex);
        if (Number.isNaN(idx)) continue;
        if (entry.isIntersecting) ioRatiosRef.current.set(idx, entry.intersectionRatio);
        else ioRatiosRef.current.delete(idx);
      }
      const visible = new Set<number>();
      for (const p of ioRatiosRef.current.keys()) {
        visible.add(p - 1);
        visible.add(p);
        visible.add(p + 1);
      }
      visible.delete(-1);
      setVisiblePages(visible);
      let top = -1;
      let topRatio = -1;
      for (const [p, r] of ioRatiosRef.current) {
        if (r > topRatio) {
          topRatio = r;
          top = p;
        }
      }
      if (top >= 0) {
        const count = layoutRef.current?.result.pages.length ?? 1;
        setPageInfo(count, top + 1);
      }
    });
    ioRef.current = io;
    return () => {
      io.disconnect();
      ioRef.current = null;
    };
  }, [setPageInfo]);

  const observeSheet = useCallback((el: HTMLDivElement | null) => {
    if (el && ioRef.current) ioRef.current.observe(el);
  }, []);

  // Synchronous-first. The relayout (adapter+engine+commit,
  // 1-3.5ms) runs INLINE with the input event — text paints in the
  // input's own frame (the GDocs model). The rAF coalescer survives as
  // a pressure valve: after SYNC_BUDGET_PER_FRAME sync relayouts in
  // one ~16ms window (script/IME batch), further updates defer and
  // coalesce. Measured: normal typing is 1
  // keystroke per frame, well under budget.
  // Budget = Infinity — process ALL keys in their input
  // events, paint once per frame (React batches setLayout calls from
  // N input events into one render). Stagger dies by construction.
  const SYNC_BUDGET_PER_FRAME = Infinity;
  const syncBudgetRef = useRef({ count: 0, frameStart: 0 });
  const rafRef = useRef<number | null>(null);
  /** M-REFS-10 — THE ADOPTION NUDGE: when the measured leader counts
   *  differ from the model's spans, dispatch the generator's FORCED
   *  pass (debounced — pagination churn coalesces into one write).
   *  The diff walk reads the PM doc's refLeader spans per row and
   *  compares with the counts store; equal ⇒ no dispatch (the
   *  fixpoint). Debounce 300ms: faster typing re-measures before the
   *  write lands (one adoption per settle, the search-store rhythm). */
  const adoptionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleLeaderAdoption = useCallback(() => {
    const ed = editor;
    if (!ed || !fontsReadyRef.current) return;
    if (adoptionTimerRef.current) clearTimeout(adoptionTimerRef.current);
    adoptionTimerRef.current = setTimeout(() => {
      adoptionTimerRef.current = null;
      if (adapterErrorRef.current) return;
      // A DRAG holds raw PM positions (startDrag's anchor) — an
      // adoption rewrite would shift them mid-flight. Reschedule;
      // the next relayout re-measures after the drag settles.
      if (draggingRef.current) {
        scheduleLeaderAdoption();
        return;
      }
      let diff = false;
      ed.state.doc.descendants((node) => {
        if (diff || node.type.name !== 'referenceTable') return !diff;
        const blockId = String(node.attrs.blockId ?? '');
        let i = 0;
        node.forEach((child) => {
          if (diff) return;
          if (child.type.name !== 'paragraph') return;
          if (node.attrs.leaders === false) return;
          const adopted = adoptedLeaderCount(blockId, i);
          if (adopted == null) return; // no measurement — nothing to adopt
          let spanLen = 0;
          child.forEach((inline) => {
            if (inline.isText && inline.marks.some((m) => m.type.name === 'refLeader')) {
              spanLen += inline.text?.length ?? 0;
            }
          });
          if (spanLen !== adopted) diff = true;
          i += 1;
        });
        return false;
      });
      if (diff) {
        ed.view.dispatch(ed.state.tr.setMeta('refRefresh', true));
      }
    }, 300);
  }, [editor]);

  const scheduleCoalescedRelayout = useCallback(() => {
    if (rafRef.current !== null) return; // already scheduled — coalesce
    const raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb: FrameRequestCallback) => {
            return setTimeout(() => cb(0), 16) as unknown as number;
          };
    rafRef.current = raf(() => {
      rafRef.current = null;
      relayoutRef.current();
    });
  }, []);
  const scheduleCoalescedRelayoutRef = useRef(scheduleCoalescedRelayout);
  scheduleCoalescedRelayoutRef.current = scheduleCoalescedRelayout;

  const trySyncOrDeferRelayout = useCallback(() => {
    const b = syncBudgetRef.current;
    const now = performance.now();
    if (now - b.frameStart > 16) {
      // New frame (16ms ≈ one 60fps boundary) — reset the budget.
      b.count = 0;
      b.frameStart = now;
    }
    // Benchmark seam: which branch fired.
    const t = globalThis as { __benchSync?: { sync: number; deferred: number } };
    t.__benchSync ??= { sync: 0, deferred: 0 };
    if (b.count < SYNC_BUDGET_PER_FRAME) {
      b.count += 1;
      t.__benchSync.sync += 1;
      relayoutRef.current();
      return;
    }
    // Over budget — defer to the coalescer (rAF).
    t.__benchSync.deferred += 1;
    scheduleCoalescedRelayoutRef.current();
  }, []);
  const trySyncOrDeferRef = useRef(trySyncOrDeferRelayout);
  trySyncOrDeferRef.current = trySyncOrDeferRelayout;

  // Group lines per page per block, document order — MEMOIZED on the
  // LayoutResult reference: a stable result yields stable
  // group objects, so memoized BlockCanvases skip re-render entirely on
  // unrelated state changes; a relayout (new result) rebuilds groups and
  // only blocks with new LineBox references repaint (the engine shares
  // frozen LineBoxes zero-copy across results). Computed before the
  // early returns — hooks must be unconditional.
  const groupsByPage = useMemo(() => {
    // #74 COLUMNS — the group key is blockId + COLUMN: a block whose
    // fragment flows from column 1 into column 2 gets ONE canvas PER
    // COLUMN (a single canvas would be non-monotonic in y — the
    // column-2 lines restart at the slot top — and duplicate the React
    // key). Within a column the fragment stays y-monotonic; the
    // column index rides the group (the canvas's columnFrame).
    const map = new Map<number, { blockId: string; column?: number; lines: LineBox[] }[]>();
    if (!layout) return map;
    for (const line of layout.result.lines) {
      let pageGroups = map.get(line.pageIndex);
      if (!pageGroups) {
        pageGroups = [];
        map.set(line.pageIndex, pageGroups);
      }
      let group = pageGroups.find(
        (g) => g.blockId === line.blockId && (g.column ?? 0) === (line.column ?? 0),
      );
      if (!group) {
        group = {
          blockId: line.blockId,
          ...(line.column != null ? { column: line.column } : {}),
          lines: [],
        };
        pageGroups.push(group);
      }
      group.lines.push(line);
    }
    return map;
  }, [layout]);

  // M-T3 — the header-row pins: ONE per table, at the table's first
  // band (the page where that band lands). Pinned state reads the PM
  // doc (the table's first row's cells are all tableHeader); the y
  // comes from the engine's placed rects (anchor row 0, col 0 — the
  // band slice's top). The gutter is the user's spec'd home ("the
  // gutter is where the lucide icon pin should be").
  const headerPins = useMemo<TableHeaderPin[]>(() => {
    if (!layout || !editor) return [];
    const out: TableHeaderPin[] = [];
    for (const block of layout.blocks) {
      if (!block.table) continue;
      const tableNode = editor.state.doc.nodeAt(block.from);
      if (!tableNode || tableNode.childCount === 0) continue;
      const firstRow = tableNode.child(0);
      const pinned =
        firstRow.childCount > 0 && firstRow.firstChild?.type.name === 'tableHeader';
      let best: { pageIndex: number; y: number; height: number } | null = null;
      for (const pr of layout.result.placed) {
        if (pr.kind !== 'tableCell' || pr.blockId !== block.id || !pr.cell) continue;
        if (pr.cell.row !== 0 || pr.cell.col !== 0) continue;
        if (!best || pr.pageIndex < best.pageIndex || (pr.pageIndex === best.pageIndex && pr.rect.y < best.y)) {
          best = { pageIndex: pr.pageIndex, y: pr.rect.y, height: pr.rect.height };
        }
      }
      if (best) out.push({ blockId: block.id, pageIndex: best.pageIndex, y: best.y, height: best.height, pinned });
    }
    return out;
  }, [layout, editor]);

  /** M-REFS — the gutter TYPE BADGES: one per reference table, at its
   * first line overall (a fragmenting table badges only its true
   * start). Kind read from the PM node (the model fact), geometry from
   * the engine's LineBoxes. */
  const referenceBadges = useMemo<ReferenceTableBadge[]>(() => {
    if (!layout || !editor) return [];
    const out: ReferenceTableBadge[] = [];
    for (const block of layout.blocks) {
      if (!block.reference) continue;
      const node = editor.state.doc.nodeAt(block.from);
      const kind: ReferenceKind =
        node?.attrs?.kind === 'figures' || node?.attrs?.kind === 'index' ? node.attrs.kind : 'toc';
      let best: { pageIndex: number; y: number; height: number } | null = null;
      for (const line of layout.result.lines) {
        if (line.blockId !== block.id) continue;
        if (!best || line.pageIndex < best.pageIndex || (line.pageIndex === best.pageIndex && line.rect.y < best.y)) {
          best = { pageIndex: line.pageIndex, y: line.rect.y, height: line.rect.height };
        }
      }
      if (best) out.push({ blockId: block.id, pos: block.from, kind, pageIndex: best.pageIndex, y: best.y, height: best.height });
    }
    return out;
  }, [layout, editor]);

  /** M-REFS — the INDEX BOOKMARKS (GDocs): one bookmark per LINE that
   * carries an indexEntry mark — the marked terms listed in the
   * tooltip. Doc walk → block-offset → line lookup (the search
   * projection's math, gutter-local). */
  const indexBookmarks = useMemo<IndexLineMark[]>(() => {
    if (!layout || !editor) return [];
    const marks: Array<{ from: number; to: number; term: string }> = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.marks.some((m) => m.type.name === 'indexEntry')) {
        marks.push({ from: pos, to: pos + node.nodeSize, term: node.text ?? '' });
      }
    });
    const out: IndexLineMark[] = [];
    const seen = new Set<string>();
    for (const mark of marks) {
      const bo = pmPosToBlockOffset(layout.blocks, mark.from);
      if (!bo) continue;
      for (const line of layout.result.lines) {
        if (line.blockId !== bo.block.id) continue;
        if (line.rangeEnd <= bo.offset || line.rangeStart >= bo.offset + (mark.to - mark.from)) continue;
        const key = `${line.pageIndex}:${Math.round(line.rect.y)}`;
        if (seen.has(key)) {
          // Same line, another term — merge into the tooltip list.
          const existing = out.find((m) => `${m.pageIndex}:${Math.round(m.y)}` === key);
          if (existing && !existing.terms.includes(mark.term)) existing.terms.push(mark.term);
          continue;
        }
        seen.add(key);
        out.push({
          id: key,
          pageIndex: line.pageIndex,
          y: line.rect.y,
          height: line.rect.height,
          terms: [mark.term],
        });
      }
    }
    return out;
  }, [layout, editor]);

  /** M-GUTTER — CONTEXTUAL REPLACEMENT: the per-page set of line y-
   *  offsets whose NUMBER yields its slot to a contextual gutter
   *  element (a header pin, a ref-table badge, an index bookmark).
   *  The y is the shared key between the icon layers and the number
   *  gutter (lines stack — y is unique per page except table lanes,
   *  where a covered number pair is an acceptable v1 edge). */
  const gutterReplaced = useMemo(() => {
    const byPage = new Map<number, Set<number>>();
    const add = (pageIndex: number, y: number) => {
      let set = byPage.get(pageIndex);
      if (!set) {
        set = new Set();
        byPage.set(pageIndex, set);
      }
      set.add(y);
    };
    for (const pin of headerPins) if (pin.pinned) add(pin.pageIndex, pin.y);
    for (const badge of referenceBadges) add(badge.pageIndex, badge.y);
    for (const mark of indexBookmarks) add(mark.pageIndex, mark.y);
    return byPage;
  }, [headerPins, referenceBadges, indexBookmarks]);

  // The pin's toggle: park the selection in the table's first cell
  // (toggleHeaderRow operates on the selection's row), toggle, restore
  // the user's selection — the caret never visibly jumps.
  const toggleTableHeader = useCallback((blockId: string) => {
    if (!editor) return;
    const block = layoutRef.current?.blocks.find((b) => b.id === blockId);
    if (!block) return;
    const { from: selFrom, to: selTo } = editor.state.selection;
    const anchor = block.from + 3; // table open + row open + cell open
    editor
      .chain()
      .command(({ tr, dispatch }) => {
        if (dispatch) tr.setSelection(TextSelection.create(tr.doc, anchor));
        return true;
      })
      .toggleHeaderRow()
      .setTextSelection({ from: selFrom, to: selTo })
      .run();
  }, [editor]);

  // Caret-follow registration: block PM's native
  // scroll-to-selection (L3) and decline only in the adapter fallback,
  // where the visible pageless DOM is the real content.
  useEffect(() => {
    if (!editor) return;
    setPaintedScrollHandler(() => !adapterErrorRef.current);
    return () => setPaintedScrollHandler(null);
  }, [editor]);

  // Editor focus/blur hides the caret entirely.
  useEffect(() => {
    if (!editor) return;
    const onBlur = () => setEditorFocused(false);
    const onFocus = () => setEditorFocused(true);
    editor.on('blur', onBlur);
    editor.on('focus', onFocus);
    return () => {
      editor.off('blur', onBlur);
      editor.off('focus', onFocus);
      if (blinkTimerRef.current) clearTimeout(blinkTimerRef.current);
    };
  }, [editor]);

  // IME composition preview. The one sanctioned L3
  // exception: composition text is INPUT STATE read from events on the
  // hidden view, never geometry — PM keeps the in-progress string out
  // of the doc model until compositionend, so the engine can't paint
  // it. The preview is positioned purely from engine rects.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom as HTMLElement;
    const onStart = () => setComposing('');
    const onUpdate = (e: CompositionEvent) => setComposing(e.data);
    const onEnd = () => setComposing(null);
    dom.addEventListener('compositionstart', onStart);
    dom.addEventListener('compositionupdate', onUpdate);
    dom.addEventListener('compositionend', onEnd);
    return () => {
      dom.removeEventListener('compositionstart', onStart);
      dom.removeEventListener('compositionupdate', onUpdate);
      dom.removeEventListener('compositionend', onEnd);
    };
  }, [editor]);

  // Link bubble: painted-rect anchor (L3 — the hidden view's coordsAtPos
  // must never position anything). Resolves a doc position to the
  // viewport position of its first painted line.
  const linkCoordsFor = useCallback((pos: number) => {
    const current = layoutRef.current;
    const stack = stackRef.current;
    if (!current || !stack) return { left: 0, top: 0 };
    const z = useConfigStore.getState().config.editor.zoomLevel / 100;
    const sr = stack.getBoundingClientRect();
    const geom = caretGeometry(current.blocks, current.result, pos, metricsRef.current!, activeBandPage());
    const page0 = current.result.pages[0];
    if (!geom || !page0) return { left: 0, top: 0 };
    const { pageSetup: setup } = useDocumentStore.getState();
    // #58: the caret's OWN page carries the geometry (mixed sections).
    const caretPage = current.result.pages[geom.pageIndex]!;
    const r = caretStackRect(
      geom,
      caretPage.contentBox.x,
      caretPage.contentBox.y,
      pageTops(current.result.pages, setup.pageGap)[geom.pageIndex]!
    );
    return { left: sr.left + r.left * z, top: sr.top + (r.top + r.height) * z };
  }, []);
  const linkBubbleRef = useRef<HTMLDivElement>(null);
  const linkBubble = useLinkBubble(editor, linkBubbleRef, linkCoordsFor);

  // M-EQ: the equation bubble's painted-rect anchor (L3 — the hidden
  // view's geometry must never position it): the placed[] rect for the
  // equation at `pos`, converted to viewport coords BELOW the rect,
  // horizontally centered (the same half-bubble offset the pageless
  // DOM anchor applies).
  const equationCoordsFor = useCallback((pos: number) => {
    const current = layoutRef.current;
    const stack = stackRef.current;
    if (!current || !stack) return { left: 0, top: 0 };
    const block = current.blocks.find((b) => b.from === pos);
    const placed = block
      ? current.result.placed.find((p) => p.kind === 'equation' && p.blockId === block.id)
      : undefined;
    if (!placed) return { left: 0, top: 0 };
    const z = useConfigStore.getState().config.editor.zoomLevel / 100;
    const sr = stack.getBoundingClientRect();
    const page = current.result.pages[placed.pageIndex]!;
    const top = pageTops(current.result.pages, pageSetup.pageGap)[placed.pageIndex]!;
    return {
      left:
        sr.left +
        (page.contentBox.x + placed.rect.x + placed.rect.width / 2 - 160) * z,
      top: sr.top + (top + page.contentBox.y + placed.rect.y + placed.rect.height) * z + 4,
    };
  }, [pageSetup.pageGap]);
  const equationBubbleRef = useRef<HTMLDivElement>(null);
  const { state: equationState, close: closeEquationEditor } = useEquationEditor(
    editor,
    equationBubbleRef,
    equationCoordsFor,
  );

  if (!editor) return null;

  // #58 — the SECTION→ID map (break order = section order): the band
  // slots resolve a page's section tag to enable/focus the right
  // container. A plain render-time walk over the immutable PM state
  // (the rulerModel precedent — NO hook: this sits after the early
  // returns; the derivation is cheap, breaks are top-level atoms).
  const sectionIds: (string | null)[] = [];
  editor.state.doc.forEach((node) => {
    if (node.type.name === 'sectionBreak') {
      const tag = node.attrs.sectionId;
      sectionIds.push(typeof tag === 'string' && tag ? tag : null);
    }
  });
  const sectionIdOfPage = (sectionIndex: number): string | null => {
    // The FINAL section has no break node — its band-override identity
    // is the reserved id (the store law's spelling). SECTIONED docs
    // only: a uniform doc's pages stay untagged (they ARE the doc
    // default).
    if (sectionIds.length === 0) return null;
    return sectionIds[sectionIndex] ?? (sectionIndex === sectionIds.length ? FINAL_SECTION_ID : null);
  };
  // #58 — the per-section PAGE BACKGROUND: each break's setup carries
  // its section's color; UNSET inherits the doc default (the store's
  // pageColor — the two-level band model).
  // #48 — the PER-PAGE LAYER rides on top: the positional pageStyles
  // map (page number → background; the PageSetup comment block in
  // pageSetup.ts is the ruling — an entry for a page that no longer
  // exists is inert, the chain just falls through). Print/PDF honor
  // the SAME chain (buildDocument resolves it per printed page).
  const sectionColors: (string | undefined)[] = [];
  editor.state.doc.forEach((node) => {
    if (node.type.name === 'sectionBreak') {
      const color = (node.attrs.setup as { pageColor?: string } | undefined)?.pageColor;
      sectionColors.push(typeof color === 'string' && color ? color : undefined);
    }
  });
  const backgroundForPage = (pageIndex: number, sectionIndex: number): string | undefined =>
    pageStyles[pageIndex]?.background ??
    sectionColors[sectionIndex] ??
    (pageSetup.pageColor || undefined);

  // #WATERMARK — the per-section → doc chain (the pageColor twin, no
  // positional layer — watermarks are section/doc-level by the AC).
  // Each break's setup carries its section's watermark wholesale
  // (PageSetup-riding); UNSET inherits the doc default (the store's).
  // Print/PDF honor the SAME chain (buildDocument resolves it per
  // printed page).
  const sectionWatermarks: (WatermarkSettings | undefined)[] = [];
  editor.state.doc.forEach((node) => {
    if (node.type.name === 'sectionBreak') {
      const wm = (node.attrs.setup as { watermark?: WatermarkSettings | null } | undefined)
        ?.watermark;
      sectionWatermarks.push(wm ?? undefined);
    }
  });
  const watermarkForPage = (sectionIndex: number): WatermarkSettings | null | undefined =>
    sectionWatermarks[sectionIndex] ?? pageSetup.watermark ?? undefined;

  // Fallback: the strict-adapter throw surfaces as a pageless render of
  // the SAME EditorContent — never a crash. The input-view container
  // flips from hidden-input to visible pageless in place.
  if (adapterError) {
    return (
      <div
        // The accessibility double-line class (the pageless surface's
        // decoration styling — same rule as PagelessEditor's container).
        className={`relative ${grammarDoubleLine ? 'grammar-double-line' : ''}`}
        data-testid="paginated-fallback"
      >
        <div className="mx-auto w-full max-w-3xl px-8 py-6">
          <div
            className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            data-testid="paginated-fallback-banner"
          >
            This document contains content the paginated engine does not handle yet (tables,
            lists, quotes, code blocks, rules). Rendering without pages — nothing is lost.
          </div>
          <EditorContent
            editor={editor}
            className="prose prose-neutral max-w-none focus:outline-none text-black"
          />
        </div>
      </div>
    );
  }

  if (!layout || layout.result.pages.length === 0) {
    // Fonts gate or a momentarily empty doc: the input view still mounts
    // (keyboard input must never wait on paint).
    return (
      <div className="relative">
        <HiddenInputView editor={editor} />
      </div>
    );
  }

  const { result, blocks } = layout;
  // #58 — pageW/pageH are gone (pages differ per section); every
  // consumer reads its OWN page's geometry or the cumulative table.
  // The rulers keep the desk's FIRST page (their section-aware
  // follow-up rides Phase 2's band work).
  const firstGeometry = result.pages[0];
  const gap = pageSetup.pageGap;
  const z = zoomLevel / 100;
  // M-RULER: the caret block's indent attrs — derived straight from the
  // immutable PM state at render time (selection and doc changes always
  // re-render through the projection setStates, so this never goes
  // stale; the derivation itself is cheap — one node(1) read). null
  // renders the margins-only ruler (headings/codeBlocks/lists).
  // M-HEADER-FOOTER-2: ONE editor — band content rides the same PM
  // state, so the ruler rules it identically (tab stops land in band
  // paragraphs while the selection sits there).
  const rulerModel = editor && layout ? deriveRulerModel(editor.state) : null;
  // #74 COLUMNS — the caret's COLUMN frame for the ruler: the caret
  // block's first line's slot on its own page (the engine's grid
  // facts). Undefined single-column — the ruler stays content-framed.
  const rulerColumnFrame = (() => {
    if (!layout || !editor) return undefined;
    const head = editor.state.selection.head ?? editor.state.selection.from;
    const block = layout.blocks.find((b) => head >= b.from && head <= b.to);
    if (!block) return undefined;
    const line = result.lines.find((l) => l.blockId === block.id);
    if (!line || line.column == null) return undefined;
    const slot = result.pages[line.pageIndex]?.columns?.[line.column];
    return slot ? { left: slot.x, width: slot.width } : undefined;
  })();
  // #58 — the stack's cumulative arithmetic (mixed page sizes): the
  // sheet tops, the max width, the total height — one helper, shared
  // with the hit-testers and the overlays.
  const pageTopTable = pageTops(result.pages, gap);
  const stackDims = stackSize(result.pages, gap);
  const stackW = stackDims.width;
  const stackH = stackDims.height;
  const rootRect = rootRef.current?.getBoundingClientRect();
  // The spell bubble's anchor: the flagged word's painted text extent
  // (stack-local pre-zoom) → viewport (the transform's scale applied —
  // the bubble is chrome rendered at 100%, the toolbar law). Recomputed
  // every render, so scrolls/zooms re-anchor it for free.
  const spellBubbleAnchor = (() => {
    if (!spellBubble || !layout) return null;
    const exts = textRangeTextExtents(
      layout.blocks,
      layout.result,
      spellBubble.from,
      spellBubble.to,
      metricsRef.current!,
      gap,
      activeBandPage() // the bubble anchors the ACTIVE echo (the click's page)
    );
    const bounds = paintedBounds(exts);
    const stack = stackRef.current;
    if (!bounds || !stack) return null;
    const sr = stack.getBoundingClientRect();
    return { left: sr.left + bounds.left * z, top: sr.top + bounds.bottom * z + 4 };
  })();
  // M-LINENUMS: numbers are a pure function of the CURRENT layout —
  // recomputed every render, so a mid-document edit re-numbers in the
  // same commit (the no-debounce law; never memoized).
  const lnNumbers = lineNumbers?.enabled
    ? countLineNumbers(result.lines, lineNumbers.mode, lineNumbers.countBy ?? 1)
    : null;

  return (
    // M-T4: the CONTEXTMENU arm lives on the ROOT (not the zoom
    // wrapper) — deeper than the menu trigger (so it runs before
    // base-ui's stopEvent), above every painted surface (so every
    // real right-click bubbles through), and level with where the
    // menu tests dispatch.
    <div
      className="relative"
      data-testid="paginated-root"
      ref={rootRef}
      onContextMenu={handleContextMenu}
    >
      <HiddenInputView editor={editor} />
      {/* M-RULER Phase 5: the vertical ruler — a wrapper-FIXED viewport
          column (the background spans the container at every scroll
          position) whose SCALE translates with the desk's scroll:
          page-attached ticks, Word's fixed-bar/moving-scale model. */}
      {showVerticalRuler &&
        deskWrapper &&
        editor &&
        createPortal(
          <VerticalRuler
            pages={result.pages}
            zoom={z}
            editor={editor}
          />,
          deskWrapper,
        )}
      {/* Explicit outer size = natural stack dimensions x zoom, so scroll
          extents are correct BY CONSTRUCTION; the inner stack transform
          scales; every painted child lives inside the transform; NOTHING
          compensates per-element for zoom. Top-left origin: the wrapper
          is exactly stack*z wide, so the scaled stack fills it exactly.
          No overflow:hidden — sheet shadows bleed, and box-shadows
          never create scrollable overflow. */}
      <div
        data-testid="paginated-zoom-wrapper"
        className="cursor-text"
        style={{
          width: `${stackW * z}px`,
          height: `${stackH * z}px`,
          margin: '0 auto',
          position: 'relative',
        }}
        onMouseDown={handleMouseDown}
        onMouseUp={swallowMiddleClick}
        onAuxClick={swallowMiddleClick}
        onDoubleClick={handleBandDoubleClick}
      >
        <div
          ref={stackRef}
          data-testid="paginated-stack"
          data-layout-version={result.version}
          style={{
            width: `${stackW}px`,
            height: `${stackH}px`,
            position: 'relative',
            transform: `scale(${z})`,
            transformOrigin: 'top left',
          }}
        >
          {/* M-GUTTER: the shared tooltip provider for page-mounted
              chrome (header pins, ref-table badges, index bookmarks)
              — the popups portal to body, so zoom never scales them
              and the stack's overflow never clips them. */}
          <TooltipProvider delay={200}>
          {result.pages.map((page) => {
            const pageGroups = groupsByPage.get(page.index) ?? [];
            return (
              <PageSheet
                key={page.index}
                geometry={page}
                top={pageTopTable[page.index]!}
                observeRef={observeSheet}
                background={backgroundForPage(page.index, page.sectionIndex)}
              >
                {/* #WATERMARK — FIRST child of the sheet: behind all
                    content by mount order (above the sheet's own
                    background, below behind-floats and the text
                    canvases). Paint-only ink: the toggle hides
                    without a relayout; pointer-events never see it. */}
                {showWatermark &&
                  (visiblePages === null || visiblePages.has(page.index)) && (
                    <WatermarkLayer
                      geometry={page}
                      watermark={watermarkForPage(page.sectionIndex)}
                      metrics={metricsRef.current!}
                      baseFontFamily={defaultFontFamily}
                    />
                  )}
                {/* M-IMAGES-2 PAINT ORDER: 'behind' floats mount (and
                    paint) BEFORE the text tracks; 'front' + in-flow
                    mount AFTER (z is PAINT ORDER — the engine's
                    field, split at the shell's two layer seams). */}
                {(visiblePages === null || visiblePages.has(page.index)) && (
                  <ImageLayer
                    geometry={page}
                    placed={result.placed.filter(
                      (p) => p.pageIndex === page.index && p.z === 'behind' && p.kind === 'image',
                    )}
                    radii={imageRadii}
                  />
                )}
                {/* M-TABLES: cell fills/borders paint UNDER the text
                    tracks (above the sheet + behind-floats). */}
                {(visiblePages === null || visiblePages.has(page.index)) && (
                  <TableCellLayer
                    geometry={page}
                    cells={result.placed.filter(
                      (p) => p.pageIndex === page.index && p.kind === 'tableCell',
                    )}
                  />
                )}
                {(visiblePages === null || visiblePages.has(page.index)) &&
                  pageGroups.map((group) => {
                    const block = blocks.find((b) => b.id === group.blockId);
                    if (!block) return null;
                    const minY = group.lines[0].rect.y;
                    // #74 — the group's COLUMN frame (the decor surface
                    // + the wrap input are the column's; absent ≡ the
                    // content box).
                    const slot =
                      group.column != null ? page.columns?.[group.column] : undefined;
                    const frameLeft = slot ? slot.x : 0;
                    const frameWidth = slot ? slot.width : page.contentBox.width;
                    // M-HEADER-FOOTER-2: band groups — muted ink unless
                    // the selection sits in a band container (the
                    // active-band signal, selection-driven).
                    const bandWhich = group.lines[0].band;
                    return (
                      <BlockCanvas
                        key={`${group.blockId}|${group.column ?? 0}`}
                        lines={group.lines}
                        runs={block.runs}
                        text={block.text}
                        metrics={metricsRef.current!}
                        left={page.contentBox.x}
                        top={page.contentBox.y + minY}
                        width={page.contentBox.width}
                        muted={bandWhich ? !inBand : undefined}
                        align={block.align}
                        runDecor={block.runDecor}
                        npc={showNonPrintingChars}
                        paint={block.paint}
                        markerStyle={
                          (block.runs.find((r) => r.kind !== 'inlineImage') as
                            | { style: import('@tensor-editor/engine').TextStyle }
                            | undefined)?.style ?? defaultRunStyle
                        }
                        wrapWidth={
                          frameWidth -
                          (block.indentLeft ?? 0) -
                          (block.indentRight ?? 0)
                        }
                        columnFrame={
                          group.column != null
                            ? { left: frameLeft, width: frameWidth }
                            : undefined
                        }
                        styleEpoch={layout.styleEpoch}
                        showCaptions={showCaptions}
                        resolveBitmap={resolveMediaBitmap}
                        bitmapFailed={getBitmapFailed}
                        bitmapEpoch={bitmapEpoch}
                        referenceBorder={refBorders.has(group.blockId)}
                        referenceEntries={blocks.find((b) => b.id === group.blockId)?.reference?.entries}
                        pageNumber={page.index + 1}
                        pageTotal={result.pages.length}
                      />
                    );
                  })}
                {/* M-TABLES: the column drag handles (above the text
                    canvases for pointer reach). */}
                {(visiblePages === null || visiblePages.has(page.index)) && (
                  <TableResizeHandles
                    geometry={page}
                    cells={result.placed.filter(
                      (p) => p.pageIndex === page.index && p.kind === 'tableCell',
                    )}
                    editor={editor}
                    tablePosOf={(blockId) => blocks.find((b) => b.id === blockId)?.from ?? null}
                  />
                )}
                {lnNumbers &&
                  (() => {
                    const entries: { line: (typeof result.lines)[number]; number: number }[] = [];
                    // #74 — the v1 ruling: the gutter DISABLES on
                    // columned pages (two lanes share the same ys — the
                    // numbers would collide in the margin strip).
                    // Single-column pages number exactly as before.
                    if (page.columns != null) return null;
                    for (let i = 0; i < result.lines.length; i++) {
                      const line = result.lines[i]!;
                      if (line.pageIndex !== page.index) continue;
                      const number = lnNumbers[i]!;
                      if (number != null) entries.push({ line, number });
                    }
                    return entries.length > 0 ? (
                      <LineNumberGutter
                        contentBox={page.contentBox}
                        entries={entries}
                        // M-GUTTER: contextual icons own these lines'
                        // slots; their numbers hide.
                        suppressed={gutterReplaced.get(page.index)}
                        fontFamily={gutterBase.fontFamily}
                        fontSize={gutterBase.fontSize}
                      />
                    ) : null;
                  })()}
                {/* M-T3: the header-row pins (gutter chrome, click-to-toggle). */}
                <TableHeaderPins geometry={page} pins={headerPins} onToggle={toggleTableHeader} />
                {/* M-REFS: the collection badges (one per table, at its
                    first line — click selects the block) + the index
                    bookmarks (one per marked line, GDocs-style). */}
                <ReferenceTableBadges
                  geometry={page}
                  badges={referenceBadges}
                  onSelect={(pos) => editor.commands.setNodeSelection(pos)}
                />
                <IndexLineMarks geometry={page} marks={indexBookmarks} />

                {/* The selected image's border + resize handles. An
                    INLINE object gets no float drag (in-flow objects
                    have no float placement of their own to drag into)
                    — its onFloatDrag is undefined and the body drag is
                    inert (ImageSelection's receipt). */}
                {imageSel && imageSel.placed.pageIndex === page.index && (
                  <ImageSelection
                    geometry={page}
                    placed={imageSel.placed}
                    editor={editor}
                    pos={imageSel.pos}
                    zoom={zoomLevel / 100}
                    onFloatDrag={
                      imageSel.inline
                        ? undefined
                        : (dx: number, dy: number) =>
                            commitFloatDrag(editor, imageSel.pos, imageSel.float, dx, dy)
                    }
                  />
                )}
                <ImageLayer
                  geometry={page}
                  placed={result.placed.filter(
                    (p) => p.pageIndex === page.index && p.z !== 'behind',
                  )}
                  radii={imageRadii}
                />
                {/* M-EQ: the equations — in-flow atomics, DOM overlay
                    (KaTeX HTML cannot drawImage), pointer-through.
                    Colors ride the paint-only map (the imageRadii
                    precedent) + the doc-default text color. */}
                {(visiblePages === null || visiblePages.has(page.index)) && (
                  <EquationLayer
                    geometry={page}
                    placed={result.placed.filter(
                      (p) => p.pageIndex === page.index && p.kind === 'equation',
                    )}
                    colors={equationColors}
                    defaultColor={docDefaultTextColor}
                  />
                )}
                {/* M-HEADER-FOOTER-2: the band CLICK SLOTS — dblclick
                    targets where a region has no container. Band
                    CONTENT is canvas paint (engine band lines —
                    see the BlockCanvas muted pass), interaction is
                    the ONE hidden view via hitTest's band-strip rule. */}
                <HeaderFooterSlots
                  pageIndex={page.index}
                  geometry={page}
                  editor={editor}
                  sectionId={sectionIdOfPage(page.sectionIndex)}
                />
              </PageSheet>
            );
          })}
          </TooltipProvider>
          {spellPaint.length > 0 && <SpellHighlights bars={spellPaint} />}
          {searchPaint && (
            <SearchHighlights matches={searchPaint.all} current={searchPaint.current} />
          )}
          {/* #COMMENTS — the anchored threads' tint (the search pattern:
              base tier for every anchored thread, the active tier on
              top for the caret's thread). Document ink — visible
              regardless of the boundary toggle; the toggle governs the
              gutter + space reservation only. */}
          {commentPaint && (
            <CommentHighlights threads={commentPaint.threads} active={commentPaint.active} />
          )}
          {/* #58 — the break marks (the structural NPC layer, the
              Review ▸ Show Break Marks toggle): the page/section-break
              badges — view-only ink, never printed. */}
          {showBreakMarks && (
            <BreakMarks facts={layout.breakFacts} result={result} pageGap={gap} />
          )}
          <SelectionHighlights rects={selRects} color={selectionColor || undefined} />
          {caret && editorFocused && selRects.length === 0 &&
            (() => {
              const caretPage = result.pages[caret.pageIndex]!;
              const r = caretStackRect(
                caret,
                caretPage.contentBox.x,
                caretPage.contentBox.y,
                pageTopTable[caret.pageIndex]!
              );
              return (
                <div
                  data-testid="synthetic-caret"
                  aria-hidden="true"
                  className={`tensor-caret ${caretBlinking ? 'tensor-caret-blinking' : ''}`}
                  style={{ left: `${r.left}px`, top: `${r.top}px`, height: `${r.height}px` }}
                />
              );
            })()}
          {composing != null && caret &&
            (() => {
              const caretPage = result.pages[caret.pageIndex]!;
              const r = caretStackRect(
                caret,
                caretPage.contentBox.x,
                caretPage.contentBox.y,
                pageTopTable[caret.pageIndex]!
              );
              return (
                <div
                  data-testid="composing-preview"
                  aria-hidden="true"
                  className="pointer-events-none absolute whitespace-pre text-primary underline"
                  style={{
                    left: `${r.left}px`,
                    top: `${r.top}px`,
                    fontFamily: defaultFontFamily,
                    fontSize: `${defaultFontSize}px`,
                    lineHeight: `${r.height}px`,
                  }}
                >
                  {composing}
                </div>
              );
            })()}
        </div>
      </div>
      {/* The link bubble anchors at PAINTED coords (linkCoordsFor) —
          the hidden view's geometry never positions it (L3). */}
      {linkBubble && rootRect && (
        <LinkBubble
          ref={linkBubbleRef}
          editor={editor}
          bubble={linkBubble}
          containerTop={rootRect.top}
          containerLeft={rootRect.left}
        />
      )}

      {/* M-EQ: the equation editor — portaled to body + fixed + max z
          INSIDE the component (escapes the scroll container's overflow
          clip: a dragged bubble must never go under the ribbon). The
          painted-rect anchor resolver is passed in; the bubble
          re-derives it at render (fresh through scrolls/zoom). */}
      {equationState && (
        <EquationEditorBubble
          ref={equationBubbleRef}
          editor={editor}
          state={equationState}
          coordsFor={equationCoordsFor}
          onClose={closeEquationEditor}
        />
      )}
      {/* The floating toolbar is UI chrome, not document content — it
          renders OUTSIDE the zoom transform at 100% scale, positioned
          from the selection's painted bounding box. */}
      {toolbarPos && showFloatingToolbar && rootRect && (
        <TooltipProvider>
          <FloatingToolbar
            editor={editor}
            position={toolbarPos}
            containerTop={rootRect.top}
            containerLeft={rootRect.left}
          />
        </TooltipProvider>
      )}
      {/* The spell suggestion bubble — same chrome law: outside the
          transform, viewport-anchored, opened by a plain click on a
          flagged word (the right-click menu stays spelling-free by
          the user ruling). */}
      {spellBubble && spellBubbleAnchor && rootRect && (
        <SpellBubble
          editor={editor}
          error={spellBubble}
          left={spellBubbleAnchor.left - rootRect.left}
          top={spellBubbleAnchor.top - rootRect.top}
          onClose={() => setSpellBubble(null)}
        />
      )}
      {/* M-RULER: the ruler bar portals OUT of the scroll flow into the
          desk wrapper — static overlay chrome pinned to its top edge
          (flush under the ribbon; show/hide reflows nothing). Geometry
          comes from the engine's PageGeometry — the same facts the
          pages below paint. */}
      {showHorizontalRuler &&
        deskWrapper &&
        editor &&
        createPortal(
          <Ruler geometry={firstGeometry} zoom={z} model={rulerModel} editor={editor} columnFrame={rulerColumnFrame} />,
          deskWrapper,
        )}
    </div>
  );
}

/**
 * L3's physical form — the structural fix ("kill Suspect B"):
 * the hidden PM view is portaled to document.body and positioned FIXED,
 * a sibling of the App scroller rather than a descendant. Nothing
 * inside a scroll container can be scroll-triggered by it. The
 * contenteditable itself is untouched — keyboard input, IME, and the
 * model selection all live here. NOT aria-hidden (a11y): opacity 0
 * keeps it in the accessibility tree, which is exactly where screen
 * readers should find the editable text.
 */
function HiddenInputView({ editor }: { editor: Editor }) {
  return createPortal(
    <div
      className="pm-input-only"
      style={{ position: 'fixed', top: 0, left: 0, width: '600px', opacity: 0, pointerEvents: 'none' }}
    >
      <EditorContent
        editor={editor}
        className="prose prose-neutral max-w-none focus:outline-none text-black"
      />
    </div>,
    document.body
  );
}
