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
  lineForOffset,
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
import { CommentsGutter, useCommentsGutterVisible } from '@/components/comments/CommentsGutter';
import { useStyleRegistryStore, lookupStyle } from '@/lib/styles/registry';
import { resolveNormalBase, baselineRunStyle, resolveRun } from '@/lib/styles/resolve';
import { ensureBlockIds } from '@/lib/editor/BlockIdExtension';
import { ensureStyleSync } from '@/lib/styles/styleExtensions';
import { applyRightClickSelection } from '@/lib/editor/rightClickSelection';
import { pageGridLayout, pageIndexAtPoint } from '@/lib/paginated/pageStack';
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
import { PLACEHOLDER_TEXT } from '@/lib/editor/PlaceholderExtension';
import { TooltipProvider } from '../ui/tooltip';

/**
 * PaginatedView — Tensor's default mode, first pixels.
 *
 * THE LAWS:
 *  L1: the engine computes, never paints; the shell paints, never
 *      computes — every coordinate is an engine-issued fact; this file
 *      adds only container offsets (zoom stack, page gap, content box).
 *  L2: ONE engine + ONE RealMetrics for the view's lifetime — remounts
 *      throw away warm caches, and a mismatched metrics pairing
 *      violates parity.
 *  L3: the hidden PM view is INPUT ONLY — never measured or
 *      positioned from; clicks hit-test the engine's LineBoxes
 *      (hitTest.ts).
 *  L4: pageSetup is read PER LAYOUT CALL, never captured at editor
 *      creation (the legacy frozen-margins bug).
 *
 * NO DEBOUNCE, NO rAF BY DESIGN: PM update -> adapter -> layout ->
 * setState -> paint in one commit; the engine's incremental cache
 * makes a keystroke re-walk only the edited block. The overlay,
 * highlights, caret, and toolbar are PROJECTIONS of PM state
 * (positionMap.ts).
 */

const SYNC_BUDGET_PER_FRAME = Infinity;
const TOOLBAR_HEIGHT_EST = 44;
const TOOLBAR_WIDTH_EST = 340;
const EDGE_PAD = 8;

interface PaginatedViewProps {
  editor: Editor | null;
  /** TEST SEAM: inject deterministic metrics. Defaults to the app-wide
   * single RealMetrics (L2). The first injected instance wins for the
   * view's lifetime. */
  metrics?: TextMetrics;
  /** TEST SEAM: inject the equation dims port the same way (the real
   * one is the KaTeX DOM measurer — jsdom cannot measure it). */
  equationMetrics?: EquationMetrics;
}

interface LayoutState {
  blocks: AdapterBlock[];
  result: LayoutResult;
  /** #58 — the NPC break facts (the BreakMarks layer's sidecar). */
  breakFacts: import('@/lib/paginated/adapter').AdapterResult['breakFacts'];
  /** #101 — SPLIT VIEW: the column-aware page grid (the tops, the
   *  lefts, the stack size) the desk renders from. */
  pageGrid: import('@/lib/paginated/pageStack').PageGridLayout;
  /** The band blocks' ids — the cross-surface selection clamp's
   *  membership set (from the adapter sidecar). */
  bandBlockIds: ReadonlySet<string>;
  /** Registry epoch this layout was built under — rides the STATE so
   *  BlockCanvas's epoch-keyed repaint can never fire ahead of the
   *  relayout that owns it. */
  styleEpoch: number;
}

interface SearchPaint {
  all: PaintedRect[];
  current: PaintedRect[];
}

/**
 * #74 — the line-owns-x test for the text-track probes: the line's
 * column frame must contain the x. Single-column pages keep the
 * y-only behavior (bit-identical).
 */
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
  // The equation port ref — the SAME instance rides every engine
  // creation, so an injected test double survives a recreate.
  const equationMetricsRef = useRef<EquationMetrics | null>(null);
  if (!engineRef.current) {
    if (!metricsRef.current) metricsRef.current = injectedMetrics ?? getRealMetrics();
    if (!equationMetricsRef.current) equationMetricsRef.current = injectedEquationMetrics ?? getEquationMetrics();
    // The equation dims port rides the engine from birth (the same
    // pairing law as TextMetrics).
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
  /** The reference tables whose bounds carry the FIELD BORDER right
   *  now — the selection lives inside them (caret) or ON them
   *  (NodeSelection). */
  const [refBorders, setRefBorders] = useState<Set<string>>(() => new Set());
  const refBordersRef = useRef<Set<string>>(new Set());
  const [toolbarPos, setToolbarPos] = useState<FloatingToolbarPosition | null>(null);
  // Corner radius per image blockId (paint-only) — attr writes change
  // the memo's identity and ImageLayer repaints; no epoch churn.
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
  // The equations' PAINT-ONLY color per blockId (null = inherit the
  // docDefaultText derivation) — paint facts stay out of the engine,
  // so a color edit repaints without any relayout.
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
    /** An INLINE object's selection — the overlay owns the
     *  visualization; float-drag is off (in-flow objects have no float
     *  placement), resize stays. */
    inline: boolean;
  } | null>(null);
  const [searchPaint, setSearchPaint] = useState<SearchPaint | null>(null);
  // Spell/grammar flags: the flat-line projection (see updateSpellProjection).
  const [spellPaint, setSpellPaint] = useState<SpellBar[]>([]);
  // The anchored threads' painted rects (see updateCommentProjection).
  const [commentPaint, setCommentPaint] = useState<{
    threads: CommentThreadPaint[];
    active: PaintedRect[];
  } | null>(null);
  // The suggestion bubble: set by a plain left-click on a flagged
  // word; the anchor derives at render time from the error's painted
  // extent (fresh through scrolls/zoom re-renders).
  const [spellBubble, setSpellBubble] = useState<SpellError | null>(null);
  const [composing, setComposing] = useState<string | null>(null);
  const [adapterError, setAdapterError] = useState<Error | null>(null);
  /** Pages whose canvases mount: viewport-visible ∪ ±1 buffer.
   * Sheets ALWAYS mount — scroll extents are geometry-owned. */
  const [visiblePages, setVisiblePages] = useState<Set<number> | null>(null);
  // Handlers below run inside PM's dispatch (outside React's render
  // cycle) — they read the fallback flag through this ref, not state.
  const adapterErrorRef = useRef<Error | null>(null);
  /** The resolver's warm map (the fixpoint's state) — identity-stable
   *  per the resolver; null on cold start/fallback. */
  const refPagesRef = useRef<ReferencePagesMap | null>(null);
  /** The warm page TOTAL (the field placeholder's measured-width
   *  source). The fixpoint: pass 1 measures with the warm total; a
   *  widened placeholder re-lays-out. */
  const fieldTotalRef = useRef<number | null>(null);

  const layoutRef = useRef<LayoutState | null>(null);
  const fontsReadyRef = useRef(false);
  const stackRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const relayoutRef = useRef<() => void>(() => {});
  const selectionProjectionRef = useRef<() => void>(() => {});
  const searchProjectionRef = useRef<() => void>(() => {});
  const spellProjectionRef = useRef<() => void>(() => {});
  // The comment projection (the search/spell pattern).
  const commentProjectionRef = useRef<() => void>(() => {});
  const pendingScrollRef = useRef(false);
  const prevSearchIndexRef = useRef(-1);
  const prevSearchStateRef = useRef<unknown>(null);
  // The projection's skip-state (the search pattern).
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
  // #101 — the desk's page arrangement (1 = the classic stack); flips
  // schedule the warm relayout (the frame adjustment lives at the
  // commit).
  const pageColumns = useConfigStore((s) => s.config.editor.pageColumns);
  // #48 — the per-page styles (positional): paint-only ink — a map
  // change re-renders without a relayout.
  const pageStyles = useDocumentStore((s) => s.pageStyles);
  // The active-band signal (muted band ink + the ruler's
  // active-region accent) — selection-driven.
  const inBand = useEditorState({
    editor,
    selector: ({ editor: e }) => selectionInBand(e ?? null),
  });
  const defaultFontFamily = useConfigStore((s) => s.config.editor.defaultFontFamily);
  const defaultFontSize = useConfigStore((s) => s.config.editor.defaultFontSize);
  // REGISTRY EPOCH: a definition edit bumps the epoch and this effect
  // relayouts — the adapter cache invalidates wholesale; the engine
  // re-breaks exactly the changed-hash blocks, splices paint-only
  // ones.
  const styleEpoch = useStyleRegistryStore((s) => s.epoch);
  const zoomLevel = useConfigStore((s) => s.config.editor.zoomLevel);
  const showFloatingToolbar = useConfigStore((s) => s.config.useFloatingToolbar);
  // The shared visibility law: the gutter renders and the desk
  // reserves the same width iff true (one selector — they never
  // drift).
  const boundaryVisible = useCommentsGutterVisible();
  // Display-only ink: NPCs paint on screen; never a layout fact.
  const showNonPrintingChars = useConfigStore((s) => s.config.editor.showNonPrintingChars);
  const showBreakMarks = useConfigStore((s) => s.config.editor.showBreakMarks);
  // Caption display toggle (ink only).
  const showCaptions = useConfigStore((s) => s.config.editor.showCaptions);
  // Per-axis display gates (the palette owns granular show/hide; the
  // ribbon toggles both); both hide in focus mode. HOOK LAW: the
  // focus subscription is UNCONDITIONAL — `&&`-gating the config
  // selector would flip the hook count ('Should have a queue'
  // crash); combine AFTER both hooks run.
  const showHorizontalRulerConfig = useConfigStore((s) => s.config.editor.showHorizontalRuler);
  const showVerticalRulerConfig = useConfigStore((s) => s.config.editor.showVerticalRuler);
  const focusActive = useFocusStore((s) => s.active);
  const showHorizontalRuler = showHorizontalRulerConfig && !focusActive;
  const showVerticalRuler = showVerticalRulerConfig && !focusActive;
  // The watermark display toggle: INK-ONLY — a hidden watermark gives
  // back no space and triggers no relayout (unlike showHeadersFooters).
  const showWatermark = useConfigStore((s) => s.config.editor.showWatermark);
  // The band display toggle (rides the layout — a hidden band gives
  // back its reservation; see relayout).
  const showHeadersFooters = useConfigStore((s) => s.config.editor.showHeadersFooters);
  // Accessibility: grammar flags as a double line (the pageless
  // fallback surface + PagelessEditor read this via a container class).
  const grammarDoubleLine = useConfigStore((s) => s.config.accessibility.grammarDoubleLine);
  // The INLINE paint's arrival law: bumps when any bitmap lands
  // (pending inline objects repaint once; no relayout — the
  // bitmapVersion is geometry-free).
  const [bitmapEpoch, setBitmapEpoch] = useState(0);
  useEffect(
    () =>
      subscribeBitmaps(() => {
        setBitmapEpoch(bitmapVersionNow());
      }),
    []
  );
  // The unresolved-ref report also rides store changes: a MediaStore
  // removal triggers no PM transaction, so re-scan (dev only).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    return useMediaStore.subscribe(() => {
      const ed = useDocumentStore.getState().editor;
      if (ed) reportUnresolvedRefs(ed);
    });
  }, []);
  // The painted projections (toolbar, caret) track the VIEWPORT, not
  // just the model — recompute on scroll; the projection is a pure
  // function of (layout, selection). LISTENER PLACEMENT: the root
  // RE-MOUNTS across the view branches, so a ref-anchored listener
  // would die on the branch flip — scroll doesn't BUBBLE but does
  // propagate down the CAPTURE phase, so one document-level listener
  // sees every scroller.
  useEffect(() => {
    if (!editor) return;
    const onScroll = () => selectionProjectionRef.current();
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions);
  }, [editor]);
  // The ruler bar is chrome OUTSIDE the desk's scroll flow — portaled
  // into the desk wrapper (App-owned DOM; this closest() lookup is
  // the one structural contract) as a static overlay: flush under the
  // ribbon, zero reflow on show/hide. Re-runs on the layout flip.
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
  // Document-level setting; the gutter is a pure projection of it +
  // LayoutResult (renders nothing when off).
  const lineNumbers = useDocumentStore((s) => s.lineNumbers);
  // Install/uninstall epoch — see the font-epoch effect.
  const fontEpoch = useFontRegistryStore((s) => s.epoch);
  const mergedStyles = useStyleRegistryStore((s) => s.merged);
  // The gutter speaks the document's baseStyle font (Editor.tsx's
  // resolveNormalBase spelling of the same idea).
  const gutterBase = useMemo(
    () => resolveNormalBase(defaultFontFamily, defaultFontSize, mergedStyles),
    [defaultFontFamily, defaultFontSize, mergedStyles]
  );
  // The equations' DEFAULT text color — the resolved 'normal' run
  // color (the same resolveRun the canvas painter consumes). The DOM
  // overlay must PAINT this explicitly or it inherits chrome's
  // --foreground.
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
    // Images anchor at their TOP edge (Word behavior) — BUT ONLY WHEN
    // IT FITS: the old unconditional forceAbove clipped an image's
    // toolbar against the desk wrapper's top edge. The room check
    // (toolbar height + gap) wins for EVERYTHING.
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
    // Band selections project onto the ACTIVE page's echo (the
    // hit-test records it). The surface clamp: a selection spanning
    // band and body paints only the anchor's side — PM state
    // untouched.
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
    // A NodeSelection on a reference table has NO text caret (the
    // equation treatment — an atom's selection is the block).
    const selNode0 = (selection as unknown as { node?: { type?: { name?: string } } }).node;
    const isReferenceTableNodeSelection = selNode0?.type?.name === 'referenceTable';
    setCaret(isReferenceTableNodeSelection ? null : geom);
    // Any input/selection motion resets the caret to solid;
    // the 500ms idle timer starts blinking.
    resetCaretBlink();
    // The status bar's page is VIEWPORT based (the
    // IntersectionObserver feed) — the caret no longer moves it.
    setPageInfo(current.result.pages.length, useDocumentStore.getState().currentPage);
    // A NodeSelection on an image projects to the placed rect; an
    // INLINE object projects to its PAINTED rect (inlineObjectRect) —
    // the same overlay, minus float-drag.
    const selNode = (selection as unknown as { node?: { type?: { name?: string }; attrs?: Record<string, unknown> } }).node;
    const selName = selNode?.type?.name;
    const isBlockImageNodeSelection = selName === 'image';
    const isInlineImageNodeSelection = selName === 'inlineImage';
    // An equation NodeSelection shows NO floating toolbar — the
    // editor bubble is the equation's toolbar (it opens on the same
    // selection; a text-format strip over an atom is noise).
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
    const tops = current.pageGrid.tops;
    const stackRectOf = (pr: import('@tensor-editor/engine').PlacedRect): PaintedRect => ({
      pageIndex: pr.pageIndex,
      left: current.result.pages[pr.pageIndex]!.contentBox.x + pr.rect.x,
      top: tops[pr.pageIndex]! + current.result.pages[pr.pageIndex]!.contentBox.y + pr.rect.y,
      width: pr.rect.width,
      height: pr.rect.height,
    });
    // A CELL selection paints the selected cells' rect slices (every
    // page fragment), matched by grid identity through the
    // cell-paragraph map's table (the SAME grid identity the
    // engine's cell rects echo).
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
    // A caret parked inside a cell anchors the toolbar at the CELL's
    // slice on the caret's page (Word's context bar).
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
            current.bandBlockIds,
            current.pageGrid.tops
          );
    if (isInlineImageNodeSelection || isCellSelection || isReferenceTableNodeSelection) setCaret(null);
    setSelRects(rects);
    // The FIELD BORDER set — reference blocks whose bounds hold the
    // selection (caret inside, or a NodeSelection on the container),
    // keyed by blockId.
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
    // The image toolbar's rect is STACK-LOCAL (the same frame the
    // text path feeds). The INLINE object rides its painted rect
    // (placed[] holds block images only — lines hold objects).
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
        ...textRangeTextExtents(current.blocks, current.result, match.from, match.to, m, gap, undefined, current.pageGrid.tops)
      );
    }
    const cur = st.currentIndex >= 0 ? st.matches[st.currentIndex] : undefined;
    const currentRects = cur
      ? textRangeTextExtents(current.blocks, current.result, cur.from, cur.to, m, gap, undefined, current.pageGrid.tops)
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

  /** The comment projection (the search pattern): tracked PM ranges
   *  mapped into tinted rects, grouped per thread, with the ACTIVE
   *  thread's deeper tier. Recomputed on relayout and comment-store
   *  changes; skips when the ranges array is reference-identical AND
   *  the active thread is unchanged. */
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
      const rects = textRangeTextExtents(current.blocks, current.result, range.from, range.to, m, gap, undefined, current.pageGrid.tops);
      if (rects.length === 0) continue;
      const arr = byThread.get(range.threadId) ?? [];
      arr.push(...rects);
      byThread.set(range.threadId, arr);
      if (range.threadId === activeId) active.push(...rects);
    }
    setCommentPaint(byThread.size > 0 ? { threads: [...byThread.entries()].map(([id, rects]) => ({ id, rects })), active } : null);
  }

  /** The spell flags' projection — the search pattern: error ranges
   *  mapped through positionMap into flat underline bars, KIND-TAGGED
   *  (SpellHighlights owns the colors). Recomputed on relayout and on
   *  spell-meta transactions (results arrive WITHOUT doc changes);
   *  doc-changing transactions reach this through relayout()'s force. */
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
        gap,
        current.pageGrid.tops
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
    // The different-first-page flag travels in .wpdoc metadata; the
    // ENGINE owns the band geometry off doc.bands (no shell-side
    // reservation).
    const hfSettings = useDocumentStore.getState().headerFooter;
    const { defaultFontFamily: family, defaultFontSize: size } =
      useConfigStore.getState().config.editor;
    const registryNow = useStyleRegistryStore.getState();
    // baseStyle := resolve('normal') from the merged registry: an
    // edited 'normal' overrides the config defaults, and baseStyle's
    // hash path carries the change wholesale into the engine (empty
    // lines measure under baseStyle, so they restyle too).
    const baseStyle = resolveNormalBase(family, size, registryNow.merged);
    // ADAPTER-CONTRACT GUARD: this view's mount effects run BEFORE
    // the editor's onCreate (child effects first), so the first
    // relayout can race the BlockIdExtension's mint pass — running
    // the idempotent mint here makes the handoff true regardless of
    // effect order.
    ensureBlockIds(editor);
    ensureStyleSync(editor);
    // The UNRESOLVED-REF report (dev-only): a media:// ref missing
    // from the MediaStore gets a loud diagnostic (the missing-media
    // half of the loud posture).
    if (import.meta.env.DEV) reportUnresolvedRefs(editor);
    try {
      const __t0 = performance.now();
      // THE TWO-PASS FIXPOINT: pass 1 lays out with the WARM numbers
      // (null on cold start → '' runs); the resolver reads pass 1's
      // placement and, iff a number moved, pass 2 re-converts +
      // re-lays-out. Steady state: the resolver returns the SAME map
      // → pass 2 skipped, conversion caches stay warm.
      const refPagesIn = refPagesRef.current;
      const fieldTotalIn = fieldTotalRef.current ?? undefined;
      const pass1 = pmDocToSemantic(editor.state.doc, baseStyle, {
        definitions: registryNow.merged,
        epoch: registryNow.epoch,
      }, {
        // Per-call band options (L4) — the engine owns the band
        // geometry from here.
        differentFirstPage: hfSettings?.differentFirstPage ?? false,
      }, refPagesIn ?? undefined, fieldTotalIn, pageSetupNow);
      const result1 = engineRef.current!.layout(
        // The Show Headers & Footers toggle is DISPLAY-ONLY but rides
        // the LAYOUT: a hidden band must also GIVE BACK its reservation
        // (Word collapses the area). Stripping doc.bands does both.
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
      // The total resolves off pass 1's page count — the fixpoint
      // re-lays-out when the placeholder's digit width must GROW;
      // identity-stable when unchanged (pass 2 skipped).
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
      // Permanent benchmark seam: total relayout time + the engine's
      // lastStats, readable by the bench and the coalescing test.
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
      // THE LEADER ADOPTION: measure the resolved dot counts off the
      // FRESH layout; when a container's model span length differs,
      // schedule the generator's FORCED pass (debounced) so the ENTIRE
      // leader becomes real, selectable text.
      computeLeaderCounts(adapted.blocks, result.lines, metricsRef.current!);
      scheduleLeaderAdoption();
      // The relayout leg of the debug seam: one entry per layout call
      // — with the BlockCanvas leg, a repro discriminates a dead
      // render path from a dead update pipeline.
      const dbgLayout = (globalThis as { __tensorPaintDebug?: { log: unknown[] } }).__tensorPaintDebug;
      if (dbgLayout) {
        dbgLayout.log.push({
          relayout: result.version,
          walked: engineRef.current!.lastStats.blocksWalked,
          spliced: engineRef.current!.lastStats.blocksSpliced,
        });
      }
      // #101 — THE FRAME ADJUSTMENT (the STACK frame): pages arrange
      // row-major, so each page's stack-local origin gains its COLUMN
      // offset — folded into contentBox.x ONCE here. Every STACK-frame
      // consumer (selection bands, caret, spell/search/comment paint,
      // break marks, hit-testers, coords callbacks) then lands in the
      // page's own column with zero per-site changes; rect.x stays
      // content-relative; columns 1 = the identity.
      // THE OTHER FRAME: content INSIDE a PageSheet lives in the PAGE
      // frame — the fold rolls back OFF at the sheet boundary (the
      // render's `localPage`, the exact inverse) before any in-sheet
      // consumer reads it. Two frames, two one-place transformations.
      const pageColumns = useConfigStore.getState().config.editor.pageColumns;
      const grid = pageGridLayout(result.pages, pageSetup.pageGap, pageColumns);
      const adjustedPages =
        pageColumns > 1
          ? result.pages.map((p, i) => ({
              ...p,
              contentBox: { ...p.contentBox, x: p.contentBox.x + grid.lefts[i]! },
            }))
          : result.pages;
      const adjusted: LayoutState = {
        blocks: adapted.blocks,
        result: { ...result, pages: adjustedPages },
        styleEpoch: registryNow.epoch,
        bandBlockIds: adapted.bandBlockIds,
        breakFacts: adapted.breakFacts,
        pageGrid: grid,
      };
      const next: LayoutState = adjusted;
      layoutRef.current = next;
      // No flushSync — React batches setLayout calls from N input
      // events into ONE render + paint per frame; bursts run all the
      // adapter+engine work in the input events and paint once with
      // the final state.
      setLayout(next);
      setAdapterError(null);
      adapterErrorRef.current = null;
      updateSelectionProjection();
      updateSearchProjection(true);
      updateSpellProjection(true);
      updateCommentProjection(true);
    } catch (err) {
      // FALLBACK AUDIT: the pageless fallback catches ONLY the
      // sentinel family — an unsupported node kind, or an equation the
      // engine refuses (taller than any page — user input, not a bug).
      // Anything else is a real bug: rethrow in dev; prod keeps the
      // never-eat-the-document fallback behind a loud console error.
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
  // The ACTIVE BAND PAGE — band blocks echo on every page with
  // IDENTICAL ranges, so the projections need the page the user
  // interacted with: pmPosAt records it on every band hit; non-click
  // band selections fall back to the viewport's page.
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
      (e.clientY - r.top) / z,
      useConfigStore.getState().config.editor.pageColumns
    );
    if (!hit) return null;
    // Every band hit records its page — the echo projections
    // (caret/selection/toolbar/bubble) resolve THAT page.
    if (hit.band != null) bandPageRef.current = hit.pageIndex;
    const block = current.blocks.find((b) => b.id === hit.blockId);
    // Entry hits map to TRUE positions inside the container's
    // paragraphs (the sidecar bridge in blockOffsetToPmPos).
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
        // A drag crossing a cell wall becomes a CELL selection (the
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

  /** The image-at-click probe for the CONTEXTMENU arm: the mousedown
   *  arm's image hit-test, spelled for the event that survives menu
   *  dismissal. FRONT/in-flow images win; a behind float only counts
   *  where no text line sits. */
  function imageBlockAtClick(e: React.MouseEvent): number | null {
    const stack = stackRef.current;
    if (!stack || !layout) return null;
    const z = useConfigStore.getState().config.editor.zoomLevel / 100;
    const sr = stack.getBoundingClientRect();
    const localX = (e.clientX - sr.left) / z;
    const localY = (e.clientY - sr.top) / z;
    // The COMMIT grid (rides the layout with the folded frames): the
    // point hit and the content offsets stay internally consistent
    // even in the one-frame window after a columns flip.
    const grid = layout.pageGrid;
    const pageIndex = pageIndexAtPoint(grid, layout.result.pages, localX, localY, pageSetup.pageGap);
    const page = layout.result.pages[pageIndex]!;
    const inPageY = localY - grid.tops[pageIndex]! - page.contentBox.y;
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

  /** The CONTEXTMENU arm of the right-click rule: the menu reads the
   *  CLICK, never the stale selection — covers the case where the
   *  mousedown was CONSUMED (menu already open, right-click
   *  elsewhere); the native contextmenu event still fires, so the
   *  re-opened menu reads the click-resolved selection. Idempotent
   *  with the mousedown arm. */
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
   *  own header/footer seeded with the inherited content; an
   *  OVERRIDING section's strip dblclicks normally (uniform docs have
   *  nothing to unlink). */
  function handleBandDoubleClick(e: React.MouseEvent) {
    if (!editor || adapterError || !layout) return;
    const stack = stackRef.current;
    if (!stack) return;
    const z = useConfigStore.getState().config.editor.zoomLevel / 100;
    const sr = stack.getBoundingClientRect();
    const localX = (e.clientX - sr.left) / z;
    const localY = (e.clientY - sr.top) / z;
    // #101 — the POINT hit (the grid's row/column law): the dblclick
    // belongs to the page the user double-clicked, not the row's last
    // member.
    const pageIndex = pageIndexAtPoint(
      layout.pageGrid,
      layout.result.pages,
      localX,
      localY,
      pageSetup.pageGap,
    );
    const tops = layout.pageGrid.tops;
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
    // Middle button (settings > General > Behavior): the webview's
    // DEFAULT middle-click pastes the X11 primary selection, so the
    // press is preventDefaulted UNCONDITIONALLY. Off = nothing; on =
    // caret to the click point, then the system clipboard replays
    // through PM's paste handler.
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

    // The Z-AWARE image hit-test (z is PAINT ORDER): 'front' floats +
    // in-flow images win, topmost = last placed[], checked first;
    // 'behind' floats lose to text — only selectable in text-empty
    // space. Images are not in lines[], so the text hitTest never
    // sees them.
    const stack = stackRef.current;
    let behindCandidate: string | null = null;
    if (stack && layout.result.placed.length > 0) {
      const z = useConfigStore.getState().config.editor.zoomLevel / 100;
      const sr = stack.getBoundingClientRect();
      const localX = (e.clientX - sr.left) / z;
      const localY = (e.clientY - sr.top) / z;
      // The COMMIT grid (rides the layout with the folded frames).
      const grid = layout.pageGrid;
      const pageIndex = pageIndexAtPoint(grid, layout.result.pages, localX, localY, pageSetup.pageGap);
      const page = layout.result.pages[pageIndex]!;
      const inPageY = localY - grid.tops[pageIndex]! - page.contentBox.y;
      const inPageX = localX - page.contentBox.x;
      const inside = (p: (typeof layout.result.placed)[number]) =>
        inPageX >= p.rect.x &&
        inPageX <= p.rect.x + p.rect.width &&
        inPageY >= p.rect.y &&
        inPageY <= p.rect.y + p.rect.height;
      // 1. FRONT + in-flow (topmost wins): images and equations
      //    (equations are in-flow atomics, no z). tableCell rects are
      //    paint geometry — their clicks route to the text hitTest.
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

    // THE CONTAINER-MODEL CLICK: entries are REAL text — a plain
    // click flows PM's NATIVE path. The ONE custom arm: Ctrl/Cmd+click
    // ANYWHERE in a row navigates (the rows are always invisibly
    // hyperlinking; the editor's follow is the modifier click).
    if (stack && (e.ctrlKey || e.metaKey)) {
      const rz = useConfigStore.getState().config.editor.zoomLevel / 100;
      const rs = stack.getBoundingClientRect();
      const refHit = hitTest(
        layout.result,
        layout.blocks,
        metricsRef.current!,
        useDocumentStore.getState().pageSetup.pageGap,
        (e.clientX - rs.left) / rz,
        (e.clientY - rs.top) / rz,
        useConfigStore.getState().config.editor.pageColumns
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
    // The INLINE object's click: hitTest resolves the token to its PM
    // position; nodeAt(pos) IS the inline image when the click landed
    // inside its painted rect → NodeSelection (the block image
    // treatment). Clicking surrounding TEXT resolves inside a text
    // node → the text path.
    if (pos != null) {
      const nodeAtPos = editor.state.doc.nodeAt(pos);
      if (nodeAtPos?.type.name === 'inlineImage') {
        editor.commands.setNodeSelection(pos);
        return;
      }
    }
    if (pos == null) return;

    // THE RIGHT-CLICK RULE (Word, the one shared spelling in
    // rightClickSelection.ts): the image arm above already returned,
    // so this is keep-inside / collapse-outside — the menu reads the
    // selection AT THE CLICK.
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

    // Ctrl/Cmd+click on a painted link opens it via the OS (plain
    // click places the caret; the bubble's Open button stays).
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
      // suggestion bubble; drag-select dismisses it again (only a real
      // click keeps it).
      const error = spellErrorAt(editor.state, pos);
      if (error) setSpellBubble(error);
      startDrag(pos);
    }
  }

  // PM-driven relayout (L3's only PM read: the MODEL, not the view's
  // geometry). Also the font gate: the first layout waits on
  // document.fonts.ready — the engine's line cache never invalidates
  // on metrics identity, so pre-font-load measurement would cache
  // fallback-font widths for the session.
  // The caret-follow TRIGGER is PM's own intent flag —
  // transaction.scrolledIntoView is set only by tr.scrollIntoView();
  // layout churn alone never scrolls. The FOLLOW runs synchronously
  // with the dispatch, AFTER the layout it must read is fresh.
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
      const zoomNow = useConfigStore.getState().config.editor.zoomLevel / 100;
      // #58: the caret's OWN page carries the geometry (mixed sections).
      const caretPage = current.result.pages[caretGeom.pageIndex]!;
      const topsNow = current.pageGrid.tops;
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
      // Synchronous-first — adapter+engine+commit run in the input
      // event's own task; over SYNC_BUDGET_PER_FRAME per ~16ms window,
      // the rAF coalescer takes over as the pressure valve.
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

    // Font gate: custom fonts must be LOADED before the first measure
    // (pre-load measurement would cache fallback-font widths for the
    // session — the line cache never invalidates on metrics identity).
    // document.fonts.load forces the base font; mark-level families
    // are covered by fonts.ready.
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

  // Store-driven reflow (page size, default font, registry epoch)
  // relayouts WITHOUT remounting: the engine stays warm; the adapter's
  // epoch-tagged cache handles the registry change.
  useEffect(() => {
    relayoutRef.current();
    // showHeadersFooters rides the LAYOUT — flips relayout through
    // this warm path. #101 — pageColumns rides too: the frame
    // adjustment lives at the commit, so a flip MUST re-commit.
  }, [pageSetup, defaultFontFamily, defaultFontSize, styleEpoch, showHeadersFooters, pageColumns]);

  // differentFirstPage writes relayout through the same warm path —
  // the flag feeds the adapter's band options, read per call (L4).
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

  // The comment store is the projection's trigger for every
  // NON-transaction change (active thread, membership, edits) — the
  // transaction seams can't see store-only writes like deleteThread's
  // active reset. The skip law keeps redundant calls free.
  useEffect(() => {
    const unsub = useCommentStore.subscribe(() => commentProjectionRef.current());
    return unsub;
  }, []);

  // A font install/uninstall changes the RULER mid-session: visible
  // docs must re-measure NOW. Two things happen, in order:
  const firstFontEpochRun = useRef(true);
  useEffect(() => {
    // Mount run is a no-op: at cold-boot the engine is fresh anyway.
    // Only LATER bumps (an install/uninstall during this session)
    // take the recreate path.
    if (firstFontEpochRun.current) {
      firstFontEpochRun.current = false;
      return;
    }
    let cancelled = false;
    void (async () => {
      // 1. RE-GATE: every registered face is loaded before any
      //    measure.
      if (typeof document !== 'undefined' && document.fonts) {
        await document.fonts.ready;
      }
      if (cancelled) return;
      // 2. ENGINE RECREATE — the stale-cache remedy. The engine drops
      //    its line caches only when opts/baseStyle hashes change; a
      //    doc that referenced 'MyFont' BEFORE the font existed
      //    measured fallback widths, and the strings are identical
      //    pre/post install — a plain relayout would re-serve those
      //    LineBoxes forever. The pairing law forbids warm metrics +
      //    cached engine; warm ruler + cold cache is the legal
      //    direction, and the adapter's Blocks are unchanged by a
      //    font install.
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

  // KaTeX font arrival — an equation measured before the math fonts
  // land caches fallback dims in the WALK cache; the remedy is the
  // same cold-cache recreate + relayout (no re-gate: loadingdone
  // means the batch finished).
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

  // One IntersectionObserver over all sheets. Visible (±1 buffer)
  // pages mount canvases; the highest-ratio sheet is the status
  // bar's current page — viewport based, not caret based.
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

  // Synchronous-first: the relayout runs INLINE with the input event
  // — text paints in the input's own frame (the GDocs model). The rAF
  // coalescer survives as a pressure valve: over
  // SYNC_BUDGET_PER_FRAME sync relayouts in one ~16ms window, further
  // updates defer and coalesce. Budget = Infinity — process ALL keys
  // in their input events, paint once per frame (React batches the
  // setLayout calls into one render).
  const syncBudgetRef = useRef({ count: 0, frameStart: 0 });
  const rafRef = useRef<number | null>(null);
  /** THE ADOPTION NUDGE: when the measured leader counts differ
   *  from the model's spans, dispatch the generator's FORCED pass
   *  (debounced — pagination churn coalesces into one write); equal ⇒
   *  no dispatch (the fixpoint). Debounce 300ms — one adoption per
   *  settle. */
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
  // LayoutResult reference: a stable result yields stable group
  // objects (memoized BlockCanvases skip re-render on unrelated state
  // changes); a relayout rebuilds groups and only changed blocks
  // repaint (the engine shares frozen LineBoxes zero-copy). Computed
  // before the early returns — hooks must be unconditional.
  const groupsByPage = useMemo(() => {
    // #74 — the group key is blockId + COLUMN: a block flowing
    // between columns gets ONE canvas PER COLUMN (a single canvas
    // would be non-monotonic in y); within a column the fragment
    // stays y-monotonic, and the column index rides the group.
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

  // The header-row pins: ONE per table, at the table's first band.
  // Pinned state reads the PM doc (first row all tableHeader); the y
  // comes from the engine's placed rects (anchor row 0, col 0).
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

  /** The gutter TYPE BADGES: one per reference table, at its first
   *  line overall (a fragmenting table badges only its true start).
   *  Kind from the PM node, geometry from the engine's LineBoxes. */
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

  /** The INDEX BOOKMARKS (GDocs): one bookmark per LINE carrying an
   *  indexEntry mark — the marked terms listed in the tooltip (the
   *  search projection's math, gutter-local). */
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

  /** CONTEXTUAL REPLACEMENT: the per-page set of line y-offsets
   *  whose NUMBER yields its slot to a contextual gutter element (a
   *  header pin, a ref badge, an index bookmark). The y is the shared
   *  key between the icon layers and the number gutter. */
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

  // IME composition preview — the one sanctioned L3 exception:
  // composition text is INPUT STATE read from events on the hidden
  // view, never geometry (PM keeps it out of the doc model until
  // compositionend); the preview is positioned from engine rects.
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
    // #58: the caret's OWN page carries the geometry (mixed sections).
    const caretPage = current.result.pages[geom.pageIndex]!;
    const r = caretStackRect(
      geom,
      caretPage.contentBox.x,
      caretPage.contentBox.y,
      current.pageGrid.tops[geom.pageIndex]!
    );
    return { left: sr.left + r.left * z, top: sr.top + (r.top + r.height) * z };
  }, []);
  const linkBubbleRef = useRef<HTMLDivElement>(null);
  const linkBubble = useLinkBubble(editor, linkBubbleRef, linkCoordsFor);

  // The equation bubble's painted-rect anchor (L3): the placed[] rect
  // for the equation at `pos`, converted to viewport coords BELOW the
  // rect, horizontally centered (the pageless DOM anchor's offset).
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
    const top = current.pageGrid.tops[placed.pageIndex]!;
    return {
      left:
        sr.left +
        (page.contentBox.x + placed.rect.x + placed.rect.width / 2 - 160) * z,
      top: sr.top + (top + page.contentBox.y + placed.rect.y + placed.rect.height) * z + 4,
    };
  }, []);
  const equationBubbleRef = useRef<HTMLDivElement>(null);
  const { state: equationState, close: closeEquationEditor } = useEquationEditor(
    editor,
    equationBubbleRef,
    equationCoordsFor,
  );

  if (!editor) return null;

  // #58 — the SECTION→ID map (break order = section order) for the
  // band slots. A plain render-time walk over immutable PM state (NO
  // hook: this sits after the early returns; the derivation is cheap).
  const sectionIds: (string | null)[] = [];
  editor.state.doc.forEach((node) => {
    if (node.type.name === 'sectionBreak') {
      const tag = node.attrs.sectionId;
      sectionIds.push(typeof tag === 'string' && tag ? tag : null);
    }
  });
  const sectionIdOfPage = (sectionIndex: number): string | null => {
    // The FINAL section has no break node — its band-override identity
    // is the reserved id. SECTIONED docs only: a uniform doc's pages
    // stay untagged (they ARE the doc default).
    if (sectionIds.length === 0) return null;
    return sectionIds[sectionIndex] ?? (sectionIndex === sectionIds.length ? FINAL_SECTION_ID : null);
  };
  // #58 — the per-section PAGE BACKGROUND: each break's setup carries
  // its section's color; UNSET inherits the doc default.
  // #48 — the PER-PAGE LAYER rides on top: the positional pageStyles
  // map (an entry for a page that no longer exists is inert).
  // Print/PDF honor the SAME chain (buildDocument resolves it per
  // printed page).
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

  // The per-section → doc watermark chain (the pageColor twin, no
  // positional layer — watermarks are section/doc-level): each break's
  // setup carries its section's watermark; UNSET inherits the doc
  // default; print/PDF honor the SAME chain.
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
  // The empty-document placeholder: the doc holds one empty paragraph.
  // Decoration ink, never text (PlaceholderExtension covers the
  // pageless surface; this covers the canvas).
  const docPlaceholder =
    editor.state.doc.childCount === 1 &&
    editor.state.doc.firstChild!.isTextblock &&
    editor.state.doc.firstChild!.content.size === 0
      ? PLACEHOLDER_TEXT
      : undefined;
  // #58 — pageW/pageH are gone (pages differ per section); every
  // consumer reads its OWN page's geometry or the cumulative table
  // (the rulers keep the desk's FIRST page).
  const firstGeometry = result.pages[0];
  const gap = pageSetup.pageGap;
  const z = zoomLevel / 100;
  // The caret block's indent attrs — derived from immutable PM state
  // at render time (selection/doc changes re-render through the
  // projections, so it never goes stale). null renders the
  // margins-only ruler. Band content rides the same PM state, so the
  // ruler rules it identically.
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
  // #101 — SPLIT VIEW: the caret's split column — WHICH strip wears
  // the caret's model (indents/tabs/column frame); the other stays
  // margins-only (Word's active-ruler law, one ruler per page).
  const rulerSplitColumn = (() => {
    if (!layout || !editor || pageColumns !== 2) return 0;
    const head = editor.state.selection.head ?? editor.state.selection.from;
    const block = layout.blocks.find((b) => head >= b.from && head <= b.to);
    if (!block) return 0;
    // The CARET'S OWN line — a block may SPAN the page break (its first
    // line sits on the previous page while the caret is on this one);
    // the block's first line would pin the model to the wrong strip.
    const blockLines = result.lines.filter((l) => l.blockId === block.id && !l.band);
    const line = lineForOffset(blockLines, head - block.from) ?? blockLines[0];
    return (line?.pageIndex ?? 0) % 2;
  })();
  // #101 — the rulers read the PAGE-LOCAL frame — the fold's exact
  // inverse (the commit grid's left): a strip mounted over its own
  // column anchors to the page's OWN margins. columns 1 = the
  // identity.
  const localPageGeometry = (p: PageGeometry): PageGeometry => ({
    ...p,
    contentBox: { ...p.contentBox, x: p.contentBox.x - layout.pageGrid.lefts[p.index]! },
  });
  // #101 — the per-column ruler sets: column c's pages are the
  // indices ≡ c (mod columns); their scales read the grid's ROW tops
  // (row-mates share a top). columns 1 ≡ the full set (legacy).
  const splitRulers = pageColumns === 2 && result.pages.length > 1;
  const columnPages = (c: number) => result.pages.filter((_, i) => i % 2 === c);
  const columnTops = (c: number) => columnPages(c).map((p) => pageGrid.tops[p.index]!);
  // #58 — the stack's cumulative arithmetic (mixed sizes), shared
  // with the hit-testers and overlays. #101 — the column-aware grid
  // (1 = the classic stack); the tops table keeps the name.
  const pageGrid = pageGridLayout(result.pages, gap, pageColumns);
  const pageTopTable = pageGrid.tops;
  const pageLeftTable = pageGrid.lefts;
  const stackW = pageGrid.size.width;
  const stackH = pageGrid.size.height;
  const rootRect = rootRef.current?.getBoundingClientRect();
  // The spell bubble's anchor: the flagged word's painted extent →
  // viewport (the bubble is chrome rendered at 100%). Recomputed every
  // render, so scrolls/zooms re-anchor it for free.
  const spellBubbleAnchor = (() => {
    if (!spellBubble || !layout) return null;
    const exts = textRangeTextExtents(
      layout.blocks,
      layout.result,
      spellBubble.from,
      spellBubble.to,
      metricsRef.current!,
      gap,
      activeBandPage(), // the bubble anchors the ACTIVE echo (the click's page)
      layout.pageGrid.tops
    );
    const bounds = paintedBounds(exts);
    const stack = stackRef.current;
    if (!bounds || !stack) return null;
    const sr = stack.getBoundingClientRect();
    return { left: sr.left + bounds.left * z, top: sr.top + bounds.bottom * z + 4 };
  })();
  // Numbers are a pure function of the CURRENT layout — recomputed
  // every render, so a mid-document edit re-numbers in the same
  // commit (never memoized).
  const lnNumbers = lineNumbers?.enabled
    ? countLineNumbers(result.lines, lineNumbers.mode, lineNumbers.countBy ?? 1)
    : null;

  return (
    // The CONTEXTMENU arm lives on the ROOT (not the zoom wrapper) —
    // deeper than the menu trigger (runs before base-ui's stopEvent),
    // above every painted surface.
    <div
      className="relative"
      data-testid="paginated-root"
      ref={rootRef}
      onContextMenu={handleContextMenu}
    >
      <HiddenInputView editor={editor} />
      {/* The vertical ruler — a wrapper-FIXED viewport column whose
          SCALE translates with the desk's scroll: page-attached
          ticks, Word's fixed-bar/moving-scale model. */}
      {showVerticalRuler &&
        deskWrapper &&
        editor &&
        createPortal(
          splitRulers ? (
            <>
              {/* The LEFT edge rules the LEFT column; the RIGHT edge
                  the right — each paints its own pages' scales off the
                  grid's row tops (the y-only walk would double-paint). */}
              <VerticalRuler
                pages={columnPages(0)}
                tops={columnTops(0)}
                zoom={z}
                editor={editor}
              />
              <VerticalRuler
                pages={columnPages(1)}
                tops={columnTops(1)}
                zoom={z}
                editor={editor}
                side="right"
                testId="ruler-vertical-right"
              />
            </>
          ) : (
            <VerticalRuler pages={result.pages} zoom={z} editor={editor} />
          ),
          deskWrapper,
        )}
      {/* Explicit outer size = stack × zoom, so scroll extents are
          correct BY CONSTRUCTION; the inner transform scales; nothing
          compensates per-element. No overflow:hidden — sheet shadows
          bleed, and box-shadows never create scrollable overflow. */}
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
          {/* The shared tooltip provider for page-mounted chrome
              (pins, badges, bookmarks) — the popups portal to body,
              so zoom never scales them and overflow never clips. */}
          <TooltipProvider delay={200}>
          {result.pages.map((page) => {
            const pageGroups = groupsByPage.get(page.index) ?? [];
            // #101 — SPLIT VIEW: THE SHEET FRAME (the coordinate-frame
            // boundary). The commit folds the column offset into
            // contentBox.x for the STACK frame — the stack-local
            // siblings (selection bands, the caret, spell/search/
            // comment paint, break marks) and the hit-testers read the
            // folded pages. But everything mounted INSIDE this sheet
            // lives in the PAGE frame: the sheet is already positioned
            // at the column's left (the `left` prop), so its children
            // must see the UNFOLDED margin — the fold rolls back OFF
            // once here, its exact inverse (the commit grid's left;
            // columns 1's lefts are all 0, the identity). Every
            // in-sheet consumer below takes `localPage`; stack-level
            // consumers outside this map keep the folded pages.
            const localPage = {
              ...page,
              contentBox: {
                ...page.contentBox,
                x: page.contentBox.x - layout.pageGrid.lefts[page.index]!,
              },
            };
            return (
              <PageSheet
                key={page.index}
                geometry={localPage}
                top={pageTopTable[page.index]!}
                left={pageLeftTable[page.index]!}
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
                      geometry={localPage}
                      watermark={watermarkForPage(page.sectionIndex)}
                      metrics={metricsRef.current!}
                      baseFontFamily={defaultFontFamily}
                    />
                  )}
                {/* PAINT ORDER: 'behind' floats mount (and paint)
                    BEFORE the text tracks; 'front' + in-flow mount
                    AFTER (z is paint order). */}
                {(visiblePages === null || visiblePages.has(page.index)) && (
                  <ImageLayer
                    geometry={localPage}
                    placed={result.placed.filter(
                      (p) => p.pageIndex === page.index && p.z === 'behind' && p.kind === 'image',
                    )}
                    radii={imageRadii}
                  />
                )}
                {/* Cell fills/borders paint UNDER the text tracks. */}
                {(visiblePages === null || visiblePages.has(page.index)) && (
                  <TableCellLayer
                    geometry={localPage}
                    cells={result.placed.filter(
                      (p) => p.pageIndex === page.index && p.kind === 'tableCell',
                    )}
                  />
                )}
                {(visiblePages === null || visiblePages.has(page.index)) &&
                  pageGroups.map((group, gi) => {
                    const block = blocks.find((b) => b.id === group.blockId);
                    if (!block) return null;
                    const minY = group.lines[0].rect.y;
                    // #74 — the group's COLUMN frame (the decor surface
                    // + the wrap input are the column's; absent ≡ the
                    // content box).
                    const slot =
                      group.column != null ? page.columns?.[group.column] : undefined;
                    const frameLeft = slot ? slot.x : 0;
                    const frameWidth = slot ? slot.width : localPage.contentBox.width;
                    // Band groups — muted ink unless the selection
                    // sits in a band container.
                    const bandWhich = group.lines[0].band;
                    return (
                      <BlockCanvas
                        key={`${group.blockId}|${group.column ?? 0}`}
                        lines={group.lines}
                        runs={block.runs}
                        text={block.text}
                        metrics={metricsRef.current!}
                        left={localPage.contentBox.x}
                        top={localPage.contentBox.y + minY}
                        width={localPage.contentBox.width}
                        muted={bandWhich ? !inBand : undefined}
                        align={block.align}
                        runDecor={block.runDecor}
                        npc={showNonPrintingChars}
                        placeholder={
                          docPlaceholder != null && page.index === 0 && gi === 0
                            ? docPlaceholder
                            : undefined
                        }
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
                {/* The column drag handles (above the text canvases
                    for pointer reach). */}
                {(visiblePages === null || visiblePages.has(page.index)) && (
                  <TableResizeHandles
                    geometry={localPage}
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
                        contentBox={localPage.contentBox}
                        entries={entries}
                        // Contextual icons own these lines' slots;
                        // their numbers hide.
                        suppressed={gutterReplaced.get(page.index)}
                        fontFamily={gutterBase.fontFamily}
                        fontSize={gutterBase.fontSize}
                      />
                    ) : null;
                  })()}
                {/* The header-row pins (gutter chrome, click-to-toggle). */}
                <TableHeaderPins geometry={localPage} pins={headerPins} onToggle={toggleTableHeader} />
                {/* The collection badges (one per table, at its first
                    line — click selects the block) + the index
                    bookmarks (one per marked line). */}
                <ReferenceTableBadges
                  geometry={localPage}
                  badges={referenceBadges}
                  onSelect={(pos) => editor.commands.setNodeSelection(pos)}
                />
                <IndexLineMarks geometry={localPage} marks={indexBookmarks} />

                {/* The selected image's border + resize handles. An
                    INLINE object gets no float drag (in-flow objects
                    have no float placement of their own to drag into)
                    — its onFloatDrag is undefined and the body drag is
                    inert (ImageSelection's receipt). */}
                {imageSel && imageSel.placed.pageIndex === page.index && (
                  <ImageSelection
                    geometry={localPage}
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
                  geometry={localPage}
                  placed={result.placed.filter(
                    (p) => p.pageIndex === page.index && p.z !== 'behind',
                  )}
                  radii={imageRadii}
                />
                {/* The equations — in-flow atomics, DOM overlay (KaTeX
                    HTML cannot drawImage), pointer-through. Colors ride
                    the paint-only map + the doc-default text color. */}
                {(visiblePages === null || visiblePages.has(page.index)) && (
                  <EquationLayer
                    geometry={localPage}
                    placed={result.placed.filter(
                      (p) => p.pageIndex === page.index && p.kind === 'equation',
                    )}
                    colors={equationColors}
                    defaultColor={docDefaultTextColor}
                  />
                )}
                {/* The band CLICK SLOTS — dblclick targets where a
                    region has no container. Band content is canvas
                    paint; interaction is the hidden view via
                    hitTest's band-strip rule. */}
                <HeaderFooterSlots
                  pageIndex={page.index}
                  geometry={localPage}
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
              gutter only. */}
          {commentPaint && (
            <CommentHighlights threads={commentPaint.threads} active={commentPaint.active} />
          )}
          {/* #58 — the break marks (the structural NPC layer, the
              Review ▸ Show Break Marks toggle): the page/section-break
              badges — view-only ink, never printed. */}
          {showBreakMarks && (
            <BreakMarks facts={layout.breakFacts} result={result} pageGap={gap} tops={layout.pageGrid.tops} />
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
          {/* #COMMENTS — the boundary gutter (the anchored thread cards).
              A sibling of the stack in the UNSCALED zoom-wrapper: cards
              render at 100% chrome size while their anchors read stack
              coordinates × zoom (the getAnchorTop contract). left-full
              attaches at the sheet's right edge — THE OVERLAY RULING:
              the document never moves (no reservation); the column
              overlays whatever whitespace exists. */}
          {boundaryVisible && editor && (
            <CommentsGutter
              getAnchorTop={(threadId) => {
                const st = commentTrackingKey.getState(editor.state);
                if (!st || !layoutRef.current || !metricsRef.current) return null;
                const span = st.ranges.find((r) => r.threadId === threadId);
                if (!span) return null;
                const rects = textRangeTextExtents(
                  layoutRef.current.blocks,
                  layoutRef.current.result,
                  span.from,
                  span.to,
                  metricsRef.current,
                  gap,
                  undefined,
                  layoutRef.current.pageGrid.tops
                );
                return rects[0] ? rects[0].top * z : null;
              }}
              scale={1}
            />
          )}
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

      {/* The equation editor — portaled to body + fixed + max z
          (escapes the scroll container's overflow clip). The anchor
          resolver is passed in; the bubble re-derives it at render
          (fresh through scrolls/zoom). */}
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
      {/* The ruler bar portals OUT of the scroll flow into the desk
          wrapper — static overlay chrome, flush under the ribbon;
          geometry from the engine's PageGeometry. #101 — ONE STRIP
          PER COLUMN: the desk-wide bar belongs to the first strip;
          the second rides beside it (transparent, strip-local), each
          ruling its own page's geometry; the caret's strip wears the
          model (Word's active-ruler law). */}
      {showHorizontalRuler &&
        deskWrapper &&
        editor &&
        createPortal(
          splitRulers && result.pages[1] ? (
            <>
              <Ruler
                geometry={localPageGeometry(result.pages[0]!)}
                zoom={z}
                model={rulerSplitColumn === 0 ? rulerModel : null}
                editor={editor}
                columnFrame={rulerSplitColumn === 0 ? rulerColumnFrame : undefined}
                arrangement={{ stackWidthZ: stackW * z, columnLeftZ: pageLeftTable[0]! * z }}
              />
              <Ruler
                geometry={localPageGeometry(result.pages[1])}
                zoom={z}
                model={rulerSplitColumn === 1 ? rulerModel : null}
                editor={editor}
                columnFrame={rulerSplitColumn === 1 ? rulerColumnFrame : undefined}
                arrangement={{ stackWidthZ: stackW * z, columnLeftZ: pageLeftTable[1]! * z }}
                chrome={false}
                testId="ruler-split"
              />
            </>
          ) : (
            <Ruler geometry={localPageGeometry(firstGeometry)} zoom={z} model={rulerModel} editor={editor} columnFrame={rulerColumnFrame} />
          ),
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
