import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { Editor } from '@tiptap/core';
import type { PageGeometry, TabStop } from '@tensor-editor/engine';
import { pageTops } from '@/lib/paginated/pageStack';
import { applyPageSetup, sectionSetupAt } from '@/lib/editor/sections';
import type { PageSetup } from '@/lib/document/pageSetup';
import { useConfigStore } from '@/lib/config/store';
import { useDocumentStore } from '@/lib/document/store';
import { useDocumentPropertiesStore } from '@/lib/document/propertiesStore';
import { useEditorState } from '@tiptap/react';
import { MoveHorizontal, MoveLeft, MoveRight } from 'lucide-react';
import { useReducedMotion } from '@/lib/accessibility/useReducedMotion';
import { pxToPt, ptToPx } from '@/lib/document/pageSetup';
import {
  RULER_HEIGHT,
  RULER_WIDTH,
  MIN_CONTENT_WIDTH_PT,
  clampMarginSpan,
  formatPxAsUnit,
  generateTicks,
  snapToMinor,
  unitSuffix,
  type RulerModel,
} from '@/lib/paginated/ruler';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

/**
 * M-RULER — the horizontal ruler bar (Phase 1: READ-ONLY).
 *
 * Mount law: STATIC OVERLAY CHROME. PaginatedView portals this bar into
 * the desk wrapper (`[data-desk-wrapper]`, the relative flex container
 * between the Ribbon and the desk scroller) as `absolute top-0` — flush
 * under the ribbon by construction, OUTSIDE the scroll flow (always
 * visible, never scrolls away), and show/hide mounts/unmounts an
 * overlay over the desk's existing top padding: ZERO reflow of the
 * document container. The view gates the portal on
 * `config.editor.showRuler` (component teardown on hide — the clean-
 * slate guarantee); the page's breathing room IS the desk's top
 * padding (pt-8: 18px of bar + 14px gap).
 *
 * Alignment law: the page centers inside the DESK SCROLLER's
 * clientWidth (scrollbar-correct — a width the strip itself does not
 * have when a classic vertical scrollbar takes layout space), so the
 * inner container is positioned by `pageLeft`, computed from the
 * scroller's clientWidth and minus its scrollLeft — the bar tracks the
 * page when zoom overflows horizontally. The scroller is found via the
 * `[data-desk-scroll]` attribute (the second — and last — DOM contract
 * between this bar and App's desk structure).
 *
 * Zoom law: the bar is UI chrome at 100% (FloatingToolbar law); only
 * the CONTENT is scaled — every geometry value is an engine px
 * multiplied by `zoom` at paint time. The geometry itself comes from
 * the engine's PageGeometry (L1) — page width, margins, orientation
 * and custom sizes are never re-derived here.
 *
 * DESIGN (the thin-ruler pass): the tick field spans ONLY the page
 * strip — no desk-wide texture. TWO-TONE ink: ticks inside the content
 * box (majors, mediums, minors and their numbers) are FOREGROUND ink —
 * near-white in dark mode, near-black in light (the app's --primary is
 * the brand orange, never a neutral, so ticks never wear it);
 * everything in the margin spans — including the edge majors (0, 8, …)
 * — recedes to muted ink. Majors run the FULL bar height, their number
 * overlaid vertically centered inside a knockout box of bar-background
 * ink, so lines stop cleanly around the digits instead of crossing
 * them. The content-box boundary is marked by two full-height rails
 * under the margin grabbers, and ALL handles straddle the bar's bottom
 * edge, half on / half off (the thin-bar ruling — handles live at the
 * boundary, Word-style).
 *
 * Rendering split: canvas for the tick field (DPR-scaled, the
 * BlockCanvas discipline), DOM for markers (draggable hit targets with
 * tooltips in the user's measurement unit). Reads are wired in Phase
 * 2/3; nothing here writes yet.
 */

/** Numbered majors must clear this much screen px or the label is
 * dropped (dense units at low zoom — Word drops numbers the same way). */
const LABEL_MIN_GAP = 14;

/** Functional tick heights (px up from the bar's bottom edge). Majors
 * are full-height (RULER_HEIGHT) by design. */
const MED_LEN = 7;
const MIN_LEN = 4;

/** The label knockout box: height and vertical centering inside the bar. */
const LABEL_BOX_H = 12;
const LABEL_BOX_PAD = 3;

/** Canvas overhang on each side of the page strip: the "0" label is
 * CENTERED on the page's left edge (half its knockout box reaches left
 * of it) and the final 8.5" tick draws its pixel column exactly AT the
 * page's right edge — both would clip against a canvas that spans the
 * strip exactly. The overhang is invisible: the canvas paints nothing
 * there and the bar's background shows through. */
const LABEL_PAD = 12;

/** A marker: an absolutely-positioned hit target wrapped in the app's
 * tooltip (value shown in the user's measurement unit). Straddles the
 * bar's bottom edge — half on / half off — via the 50% own-height
 * translateY, so any marker shape hangs right at the boundary. The
 * wrapper div (not the tooltip trigger) owns positioning and pointer
 * handling — plain DOM, so drag logic never routes through the tooltip
 * machinery. */
function Marker({
  x,
  testId,
  label,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  children,
}: {
  /** CSS px within the ruler's inner (page-width) container. */
  x: number;
  testId: string;
  label: string;
  onPointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      aria-label={label}
      className="absolute bottom-0 cursor-ew-resize touch-none"
      style={{ left: `${x}px`, transform: 'translateY(50%)' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <Tooltip>
        <TooltipTrigger render={<span className="block">{children}</span>} />
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </div>
  );
}

/** The stop glyphs (Word's shapes): ⌐ left, ┴ center, right mirrored. */
function TabGlyph({ alignment }: { alignment: TabStop['alignment'] }) {
  return (
    <span className="relative block h-[9px] w-[7px]">
      <span
        className={`absolute top-0 h-full w-[2px] bg-foreground ${
          alignment === 'right'
            ? 'right-0'
            : alignment === 'center'
              ? 'left-[2.5px]'
              : 'left-0'
        }`}
      />
      <span className="absolute bottom-0 h-[2px] w-full bg-foreground" />
    </span>
  );
}

/** The tooltip's direction icon (Lucide, muted) — the side the text
 *  sits on: left tab → text flows right; right tab → text ends at the
 *  stop; center → both (M-RULER 3.5 ruling). */
const ALIGNMENT_ARROW: Record<TabStop['alignment'], ReactNode> = {
  left: <MoveRight size={12} className="text-muted-foreground" />,
  center: <MoveHorizontal size={12} className="text-muted-foreground" />,
  right: <MoveLeft size={12} className="text-muted-foreground" />,
};

/** The margin drag handle: the ENTIRE bar-height column at a content
 * edge is grabbable (the thin-bar ruling made a small tab too hard a
 * target — the grab region is now the full vertical height of the
 * ruler, Word-style), while the little arrows stay reserved as the
 * indent markers' handles. The tab below the boundary is the visual
 * affordance only. Zones render BEFORE the indent markers in the inner
 * container, so an arrow's sliver wins its own overlap, by design. */
function MarginHandle({
  x,
  testId,
  label,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: {
  /** Screen px (inner-container-relative) of the content edge. */
  x: number;
  testId: string;
  label: string;
  onPointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel?: (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      data-testid={testId}
      aria-label={label}
      className="absolute top-0 z-0 h-full w-[16px] -translate-x-1/2 cursor-ew-resize touch-none"
      style={{ left: `${x}px` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <Tooltip>
        <TooltipTrigger render={<span className="absolute inset-0 block" />} />
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      {/* The grabber tab — decorative now, straddling the bar's bottom
          edge; the full-height column above it is the hit target. */}
      <div className="pointer-events-none absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2">
        <div className="h-[11px] w-[9px] rounded-xs border border-foreground/40 bg-card" />
      </div>
    </div>
  );
}

export function Ruler({
  geometry,
  zoom,
  model,
  editor,
  columnFrame,
  arrangement,
  chrome = true,
  testId = 'ruler',
}: {
  /** The FIRST page's engine geometry — the single source of page and
   * content-box dims (L1: never re-derived from pageSetup here). */
  geometry: PageGeometry;
  /** zoomLevel / 100 — scales content positions, not the bar. */
  zoom: number;
  /** The caret block's indent attrs + tab stops, or null (margins-only
   * ruler — headings/codeBlocks/lists carry none of these). */
  model: RulerModel | null;
  /** The PM editor — the tab-stop writers route through it (PM
   * transactions: undoable, one step per gesture). Null in the fonts
   * gate stub only; every tab handler guards. */
  editor: Editor | null;
  /**
   * #74 COLUMNS — the caret's COLUMN frame (CONTENT-BOX-relative
   * left/width, from the engine's resolved grid facts). Present IFF
   * the caret's block's first line flows in a columned section — the
   * ruler's ACTIVE frame becomes the column (Word's ruler-in-columns
   * law): ticks ink within the column, the rails/indent markers/
   * stop glyphs/band gates are column-relative. Absent ≡ the content
   * box (single-column — bit-identical). The page strip, the margin
   * regions, and the margin DRAG handles stay PAGE-framed (margins
   * are page properties; only the flow frame narrows).
   */
  columnFrame?: { left: number; width: number };
  /**
   * #101 — SPLIT VIEW: the desk arrangement — the stack's zoomed
   * width (the CENTERING base: the desk centers the WHOLE stack, not
   * this strip's page) and this column's zoomed stack-local left.
   * pageLeft = desk centering + column left − scroll. Absent ≡ the
   * legacy single-page math (stackWidth = pageW, columnLeft = 0 —
   * bit-identical).
   */
  arrangement?: { stackWidthZ: number; columnLeftZ: number };
  /**
   * #101 — SPLIT VIEW: false = the STRIP variant — a transparent,
   * strip-local container (the desk-wide chrome bar belongs to the
   * FIRST strip only; a second full-width bar would block its
   * sibling's handles). Same ink, same handles, narrower reach.
   */
  chrome?: boolean;
  /** The test hook (the split column's strip wears its own). */
  testId?: string;
}) {
  const unit = useConfigStore((s) => s.config.editor.measurementUnit);
  // Canvas colors are computed-style READS at paint time, not live CSS —
  // subscribing to the theme is what makes a light/dark flip repaint.
  const theme = useConfigStore((s) => s.config.theme);
  // The a11y Reduce Motion setting splits the margin-drag write modes:
  // reduced → preview + commit-on-release; not reduced → live reflow
  // under the drag (the user's walk-back of the preview-only ruling).
  const reducedMotion = useReducedMotion();
  const [deskW, setDeskW] = useState(0);
  const [deskScrollLeft, setDeskScrollLeft] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const mutedProbeRef = useRef<HTMLSpanElement>(null);

  const pageW = geometry.size.width;
  const contentX = geometry.contentBox.x;
  const contentW = geometry.contentBox.width;
  const contentR = contentX + contentW;
  // #74 — the ACTIVE frame: the caret's column under columns, else the
  // content box. Everything flow-relative (ticks ink, the rails, the
  // indent markers, the stop glyphs, the band gates) reads THESE.
  const columned = columnFrame != null;
  const frameX = contentX + (columnFrame?.left ?? 0);
  const frameW = columnFrame?.width ?? contentW;
  const frameR = frameX + frameW;
  const pageWz = pageW * zoom;
  // The page strip's screen origin within this bar: the SAME centering
  // the desk scroller gives the zoom wrapper (clientWidth-based, so a
  // layout-taking vertical scrollbar can't skew it), minus the desk's
  // horizontal scroll so the bar tracks the page when zoom overflows.
  const stackWidthZ = arrangement?.stackWidthZ ?? pageWz;
  const columnLeftZ = arrangement?.columnLeftZ ?? 0;
  const pageLeft = Math.max(0, (deskW - stackWidthZ) / 2) + columnLeftZ - deskScrollLeft;
  // The strip variant positions relative to its own container (which
  // starts at pageLeft − LABEL_PAD): the canvas at 0, the page strip
  // at LABEL_PAD. The chrome variant positions within the full-width
  // bar. One number drives the inner, the badge, and the dblclick.
  const innerLeft = chrome ? pageLeft : LABEL_PAD;
  // The canvas covers the strip PLUS the edge overhangs (LABEL_PAD law).
  const canvasW = pageWz + LABEL_PAD * 2;

  // Track the desk scroller's clientWidth/scrollLeft (the alignment law).
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const scroller = bar.parentElement?.querySelector<HTMLDivElement>(
      '[data-desk-scroll]',
    );
    if (!scroller) return;
    const deskRo = new ResizeObserver(() => setDeskW(scroller.clientWidth));
    deskRo.observe(scroller);
    const onScroll = () => setDeskScrollLeft(scroller.scrollLeft);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    setDeskW(scroller.clientWidth);
    setDeskScrollLeft(scroller.scrollLeft);
    return () => {
      deskRo.disconnect();
      scroller.removeEventListener('scroll', onScroll);
    };
  }, []);

  // ── M-RULER PHASE 2: margin dragging (two write modes) ──
  // Split on the a11y Reduce Motion setting (the user's walk-back of the
  // original preview-only ruling):
  //  • Reduce Motion ON (or the system preference): PREVIEW + COMMIT-ON-
  //    RELEASE — the bar shows the draft (canvas regions, rails, the
  //    dragged handle, the badge) while the document reflows exactly
  //    ONCE, at release.
  //  • Reduce Motion OFF: LIVE — drag frames commit through the single
  //    setPageSetup writer, rAF-coalesced to ≤ one store write per
  //    frame, so the document reflows under the drag in real time.
  // Both modes never write before the first move, and both commit the
  // final draft at release — the equality guard makes that idempotent in
  // live mode (a redundant write would churn isDirty for nothing).
  interface MarginDrag {
    side: 'left' | 'right';
    /** Client X at pointerdown — the drag is DELTA-based, so the math
     *  never depends on the handle's own hit-box position. */
    startClientX: number;
    /** The dragged edge's engine-px position at pointerdown. */
    startEdgePx: number;
    /** Current draft engine px (snapped + clamped). */
    draftPx: number;
  }

  const marginDragRef = useRef<MarginDrag | null>(null);
  const [marginDrag, setMarginDrag] = useState<MarginDrag | null>(null);
  const pendingWriteRef = useRef<number | null>(null);

  /** ONE margin write, through the ONE writer. Reads the store FRESH
 *  (L4); margins in POINTS — the store's canonical unit — via the
 *  shared pxToPt; skips redundant writes (live mode's last frame may
 *  already hold the value, and a no-move gesture must not dirty the
 *  document). Takes the drag EXPLICITLY: the release path nulls the
 *  ref before committing, so the ref is never the source of truth. */
  function commitMargin(drag: MarginDrag, px: number) {
    const ps = useDocumentStore.getState().pageSetup;
    const margins = { ...ps.margins };
    if (drag.side === 'left') margins.left = pxToPt(px);
    else margins.right = pxToPt(pageW - px);
    if (margins.left === ps.margins.left && margins.right === ps.margins.right) {
      return;
    }
    useDocumentStore.getState().setPageSetup({ ...ps, margins });
  }

  function startMarginDrag(side: 'left' | 'right') {
    return (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      // Chrome, not document: never steal focus from the editor.
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      const startEdgePx = side === 'left' ? contentX : contentR;
      const drag: MarginDrag = {
        side,
        startClientX: e.clientX,
        startEdgePx,
        draftPx: startEdgePx,
      };
      marginDragRef.current = drag;
      setMarginDrag(drag);
    };
  }

  function moveMarginDrag(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = marginDragRef.current;
    if (!drag) return;
    const raw = drag.startEdgePx + (e.clientX - drag.startClientX) / zoom;
    const snapped = e.altKey ? raw : snapToMinor(raw, unit);
    const [left, right] = clampMarginSpan(
      drag.side === 'left' ? snapped : contentX,
      drag.side === 'right' ? snapped : contentR,
      pageW,
    );
    const draftPx = drag.side === 'left' ? left : right;
    if (draftPx === drag.draftPx) return;
    const next = { ...drag, draftPx };
    marginDragRef.current = next;
    setMarginDrag(next);
    // LIVE MODE (Reduce Motion off): the document reflows under the
    // drag — one write per frame, always carrying the NEWEST draft
    // (each move cancels the prior pending frame). No rAF in the
    // environment → synchronous; release stays idempotent either way.
    if (!reducedMotion) {
      if (pendingWriteRef.current != null) {
        cancelAnimationFrame(pendingWriteRef.current);
      }
      if (typeof requestAnimationFrame === 'function') {
        pendingWriteRef.current = requestAnimationFrame(() => {
          pendingWriteRef.current = null;
          commitMargin(next, next.draftPx);
        });
      } else {
        commitMargin(next, next.draftPx);
      }
    }
  }

  function endMarginDrag(commit: boolean) {
    return () => {
      if (pendingWriteRef.current != null) {
        cancelAnimationFrame(pendingWriteRef.current);
        pendingWriteRef.current = null;
      }
      const drag = marginDragRef.current;
      marginDragRef.current = null;
      setMarginDrag(null);
      // The release commit: preview mode's ONLY write; live mode's final
      // frame (idempotent when the last rAF already landed).
      if (drag && commit) commitMargin(drag, drag.draftPx);
    };
  }

  // Word's convention: double-click the ruler OVER a margin region to
  // open page setup — the ONE PageSetupDialog (the margins presets
  // live in it; the drag here commits through the store as before).
  function handleBarDoubleClick(e: ReactMouseEvent<HTMLDivElement>) {
    const rectLeft = barRef.current?.getBoundingClientRect().left ?? 0;
    const x = (e.clientX - rectLeft - (chrome ? pageLeft : LABEL_PAD)) / zoom;
    if (x < contentX || x > contentR) {
      useDocumentPropertiesStore.getState().openPageSetup();
    }
  }

  // The PREVIEW edges: the dragged side follows the draft, the other
  // stays at its committed geometry. Everything bar-level (canvas
  // regions, rails, grabbers, indent markers) reads these, so the
  // preview is complete without touching the document.
  const dragContentL = marginDrag?.side === 'left' ? marginDrag.draftPx : contentX;
  const dragContentR = marginDrag?.side === 'right' ? marginDrag.draftPx : contentR;

  // ── M-RULER PHASE 3: tab stops ──
  // The band (the content area of the page strip) ADDS a stop on click
  // (snapped to the tick grid; Alt = free). An existing stop's marker
  // DRAGS — preview on the bar, ONE PM transaction at release — and
  // dragging it out of the content band REMOVES it. Tab stops are PM
  // attributes, so their writes are UNDOABLE and MUST stay one-step-
  // per-gesture: unlike the margin drags there is NO live-commit mode
  // here in either Reduce Motion setting (a transaction per frame
  // would flood the undo stack).
  interface TabDrag {
    index: number;
    startClientX: number;
    startStopPx: number;
    draftPx: number;
    removing: boolean;
  }

  const tabDragRef = useRef<TabDrag | null>(null);
  const [tabDrag, setTabDrag] = useState<TabDrag | null>(null);
  // The band's pending click (down → up with <4px travel adds a stop).
  // Ref only: nothing renders from it, so a bare band press costs no
  // render.
  const tabAddRef = useRef<{ clientX: number } | null>(null);

  /** Engine px from the PAGE's left edge for a pointer event (the
   *  inner container's frame — the tab-stop positions' own frame). */
  function bandPageX(e: { clientX: number }): number | null {
    const rect = innerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return (e.clientX - rect.left) / zoom;
  }

  function handleBandPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    // Markers own their events; bare band clicks only.
    if (e.target !== e.currentTarget || e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    tabAddRef.current = { clientX: e.clientX };
  }

  function handleBandPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const down = tabAddRef.current;
    tabAddRef.current = null;
    if (!down || !editor || !model) return;
    if (Math.abs(e.clientX - down.clientX) >= 4) return; // a drag, not a click
    const pageX = bandPageX(e);
    if (pageX == null) return;
    // #74 — the band gates and the stop writes are the ACTIVE frame's
    // (column-relative under columns — the engine's tab-stop frame).
    const rawStop = pageX - frameX;
    if (rawStop < 0 || rawStop > frameW) return; // margin spans stay inert
    const snapped = e.altKey ? rawStop : snapToMinor(pageX, unit) - frameX;
    const stop = Math.min(frameW, Math.max(0, snapped));
    // Left-click adds the DEFAULT kind (left) — the context menu owns
    // the alignment choice.
    editor.commands.setTabStops([...model.tabStops, { position: stop, alignment: 'left' }]);
  }

  function startTabDrag(index: number) {
    return (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || !editor) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      const startStopPx = model?.tabStops[index]?.position ?? 0;
      const drag: TabDrag = {
        index,
        startClientX: e.clientX,
        startStopPx,
        draftPx: startStopPx,
        removing: false,
      };
      tabDragRef.current = drag;
      setTabDrag(drag);
    };
  }

  function moveTabDrag(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = tabDragRef.current;
    if (!drag) return;
    const raw = drag.startStopPx + (e.clientX - drag.startClientX) / zoom;
    const snapped = e.altKey ? raw : snapToMinor(frameX + raw, unit) - frameX;
    // Out of the ACTIVE band = the removal drag (a small tolerance is
    // unnecessary — the snap grid keeps in-band jitters on-grid).
    const next: TabDrag = {
      ...drag,
      draftPx: snapped,
      removing: raw < 0 || raw > frameW,
    };
    tabDragRef.current = next;
    setTabDrag(next);
  }

  function endTabDrag(commit: boolean) {
    return () => {
      const drag = tabDragRef.current;
      tabDragRef.current = null;
      setTabDrag(null);
      if (!drag || !commit || !editor || !model) return;
      const stops = [...model.tabStops];
      if (drag.removing) stops.splice(drag.index, 1);
      else stops[drag.index] = { ...stops[drag.index], position: drag.draftPx };
      editor.commands.setTabStops(stops);
    };
  }

  // ── the tab context menu (M-RULER 3.5): right-click the band to add
  // with an alignment (GDocs's move), right-click a stop to re-align or
  // remove it. Band actions apply through setTabStops — every selected
  // paragraph, like the click-add; stop actions target the caret block
  // (stops may legitimately differ per block in a selection).
  type TabMenu =
    | { mode: 'band'; pageX: number }
    | { mode: 'stop'; index: number; pageX: number };
  const [tabMenu, setTabMenu] = useState<TabMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!tabMenu) return;
    const onOutside = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setTabMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTabMenu(null);
    };
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [tabMenu]);

  function handleBandContextMenu(e: ReactMouseEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return; // stops own their menus
    e.preventDefault();
    // M-T4: stop the SYNTHETIC bubble too — the ruler portals out of
    // PaginatedView, so its React-tree parents include the document
    // context menu's trigger; without this, right-clicking a band
    // opened BOTH the tab-stop menu and the app menu stacked.
    e.stopPropagation();
    const pageX = bandPageX(e);
    if (pageX == null) return;
    // #74 — the band menu and its stop write are the ACTIVE frame's.
    const rawStop = pageX - frameX;
    if (rawStop < 0 || rawStop > frameW) return; // margins: no menu
    setTabMenu({ mode: 'band', pageX });
  }

  function addStopAt(alignment: TabStop['alignment']) {
    if (!tabMenu || tabMenu.mode !== 'band' || !editor || !model) return;
    const snapped = snapToMinor(tabMenu.pageX, unit) - frameX;
    const stop = Math.min(frameW, Math.max(0, snapped));
    editor.commands.setTabStops([
      ...model.tabStops,
      { position: stop, alignment },
    ]);
    setTabMenu(null);
  }

  function changeStopAlignment(alignment: TabStop['alignment']) {
    if (!tabMenu || tabMenu.mode !== 'stop' || !editor || !model) return;
    editor.commands.setTabStops(
      model.tabStops.map((s, i) =>
        i === tabMenu.index ? { ...s, alignment } : s,
      ),
    );
    setTabMenu(null);
  }

  function removeStop() {
    if (!tabMenu || tabMenu.mode !== 'stop' || !editor || !model) return;
    editor.commands.setTabStops(
      model.tabStops.filter((_, i) => i !== tabMenu.index),
    );
    setTabMenu(null);
  }

  // Deps are the PAINT INPUTS as primitives, deliberately NOT the
  // geometry object: relayout issues a new PageGeometry per call even
  // when values are identical (zero-copy contract covers LineBoxes, not
  // necessarily pages), and a value-identical page must not repaint the
  // bar into the paint-ops window (the dirty-repaint pin depends on it).
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const bar = barRef.current;
    if (!canvas || !bar) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(canvasW * dpr));
    canvas.height = Math.max(1, Math.round(RULER_HEIGHT * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvasW, RULER_HEIGHT);

    // Three theme reads at paint time: foreground ink (the usable span
    // AND the rails), muted ink (the margin spans), and the bar's own
    // background (the number knockouts). Foreground IS the "white in
    // dark mode" ink the two-tone design wants — the app's --primary is
    // the brand ORANGE, never a neutral, so it must not ink ticks. The
    // theme subscription above re-runs this effect on a light/dark flip.
    const fg = getComputedStyle(bar).color || '#000';
    const muted =
      (mutedProbeRef.current && getComputedStyle(mutedProbeRef.current).color) ||
      fg;
    const barBg = getComputedStyle(bar).backgroundColor || 'transparent';

    // CANVAS-LOCAL coordinates: the canvas ELEMENT sits at
    // pageLeft − LABEL_PAD, so the page strip's left edge is LABEL_PAD
    // in from the canvas boundary — the overhang keeps the edge labels
    // and the final tick unclipped. Applying pageLeft in here TOO would
    // double the offset — the exact bug behind "0 renders at inch ~6.5"
    // (ticks at 2×pageLeft + tick.x).
    const contentLs = LABEL_PAD + dragContentL * zoom;
    const contentRs = LABEL_PAD + dragContentR * zoom;
    // #74 — the ACTIVE frame's screen edges: the caret's column under
    // columns (ticks ink within it; the rest of the page grays —
    // Word's ruler-in-columns look), the content box single-column.
    const frameLs = LABEL_PAD + frameX * zoom;
    const frameRs = LABEL_PAD + frameR * zoom;

    // Numbered majors ride full-height ticks — set the text state once.
    ctx.font = '500 9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // The page-strip grid (generateTicks: majors numbered 0 from the
    // page's left edge), inked by region: primary inside the content
    // box, muted in the margin spans — edge majors included.
    const labels: Array<{ x: number; text: string; ink: string; alpha: number }> = [];
    let lastLabelX = -Infinity;
    for (const tick of generateTicks(pageW, unit)) {
      const x = LABEL_PAD + tick.x * zoom;
      const rx = Math.round(x);
      // #74 — "usable" means the ACTIVE frame (the column's band under
      // columns; the other columns' spans gray with the margins).
      const inContent = x >= frameLs - 1e-6 && x <= frameRs + 1e-6;
      if (tick.kind === 'major') {
        // Full-height major; the number is drawn over a knockout box
        // below (the line shows through everywhere but the digits).
        ctx.fillStyle = inContent ? fg : muted;
        ctx.globalAlpha = inContent ? 0.9 : 0.5;
        ctx.fillRect(rx, 0, 1, RULER_HEIGHT);
        if (x - lastLabelX >= LABEL_MIN_GAP) {
          labels.push({
            x,
            text: String(tick.label),
            ink: inContent ? fg : muted,
            alpha: inContent ? 1 : 0.8,
          });
          lastLabelX = x;
        }
      } else if (inContent) {
        // Usable-space ticks: medium/minor in foreground ink.
        ctx.fillStyle = fg;
        ctx.globalAlpha = tick.kind === 'medium' ? 0.7 : 0.45;
        const len = tick.kind === 'medium' ? MED_LEN : MIN_LEN;
        ctx.fillRect(rx, RULER_HEIGHT - len, 1, len);
      } else {
        // Margin-span texture — muted, short.
        ctx.fillStyle = muted;
        ctx.globalAlpha = 0.4;
        ctx.fillRect(rx, RULER_HEIGHT - MIN_LEN, 1, MIN_LEN);
      }
    }

    // Knockout boxes behind the numbers — bar-background ink, so the
    // tick lines form a clean "border" around each label instead of
    // running through the digits.
    ctx.globalAlpha = 1;
    ctx.fillStyle = barBg;
    for (const label of labels) {
      const w = ctx.measureText(label.text).width + LABEL_BOX_PAD * 2;
      ctx.fillRect(
        label.x - w / 2,
        (RULER_HEIGHT - LABEL_BOX_H) / 2,
        w,
        LABEL_BOX_H,
      );
    }
    // The numbers themselves, over their knockouts, in their region's ink.
    for (const label of labels) {
      ctx.fillStyle = label.ink;
      ctx.globalAlpha = label.alpha;
      ctx.fillText(label.text, label.x, RULER_HEIGHT / 2);
    }

    // The rails. Single-column: the content box's edges, full height
    // (today's paint, bit-identical). #74 columned: the COLUMN's edges
    // in fg; the content box's edges stay visible but muted (the
    // margin boundary — the margin DRAG handles still live there).
    ctx.fillStyle = fg;
    if (columned) {
      ctx.globalAlpha = 0.2;
      ctx.fillRect(Math.round(contentLs), 0, 1, RULER_HEIGHT);
      ctx.fillRect(Math.round(contentRs), 0, 1, RULER_HEIGHT);
      ctx.globalAlpha = 0.5;
      ctx.fillRect(Math.round(frameLs), 0, 1, RULER_HEIGHT);
      ctx.fillRect(Math.round(frameRs), 0, 1, RULER_HEIGHT);
    } else {
      ctx.globalAlpha = 0.5;
      ctx.fillRect(Math.round(contentLs), 0, 1, RULER_HEIGHT);
      ctx.fillRect(Math.round(contentRs), 0, 1, RULER_HEIGHT);
    }
    ctx.globalAlpha = 1;
  }, [canvasW, dragContentL, dragContentR, frameX, frameR, columned, pageW, pageWz, theme, unit, zoom]);

  const fmt = (px: number, what: string): string =>
    `${what}: ${formatPxAsUnit(px, unit)} ${unitSuffix(unit)}`;
  const fmtVal = (px: number): string =>
    `${formatPxAsUnit(px, unit)} ${unitSuffix(unit)}`;

  // The drag badge (shared by margin and tab drags): the live value at
  // the draft edge/stop, in the user's measurement unit.
  // ── M-RULER: indent dragging (the markers' handles) ──
  // Preview on the bar, ONE undoable PM transaction at release
  // (setIndents — the tab-stop ruling: PM attrs never write per-frame,
  // which would flood the undo stack; the Reduce Motion split is a
  // margin-only concern). Word's marker semantics: the first-line
  // triangle moves the first-line offset independently; the left box
  // moves indentLeft (the triangle rides along — line 0's edge is
  // indentLeft + firstLineIndent); the right marker moves indentRight
  // (grows leftward from the content's right edge — its delta
  // inverts). Clamps: the engine's negative-left-edge guard
  // (indentLeft + firstLineIndent ≥ 0) and the shared 0.5" content
  // floor. Page-anchored tick snapping (Alt = free).
  interface IndentDrag {
    which: 'first' | 'left' | 'right';
    startClientX: number;
    startValuePx: number;
    draftPx: number;
  }
  const indentDragRef = useRef<IndentDrag | null>(null);
  const [indentDrag, setIndentDrag] = useState<IndentDrag | null>(null);

  function startIndentDrag(which: 'first' | 'left' | 'right') {
    return (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || !editor || !model) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      const startValuePx =
        which === 'first'
          ? model.firstLineIndent
          : which === 'left'
            ? model.indentLeft
            : model.indentRight;
      const d: IndentDrag = {
        which,
        startClientX: e.clientX,
        startValuePx,
        draftPx: startValuePx,
      };
      indentDragRef.current = d;
      setIndentDrag(d);
    };
  }

    function moveIndentDrag(e: ReactPointerEvent<HTMLDivElement>) {
    const d = indentDragRef.current;
    if (!d || !model) return;
    // The MARKER follows the pointer exactly (both directions); the
    // value derives afterwards — inverted for the right marker (it
    // grows leftward from the content's right edge).
    const delta = (e.clientX - d.startClientX) / zoom;
    // #74 — the markers anchor to the ACTIVE frame's edges.
    const startMarkerPageX =
      d.which === 'first'
        ? frameX + model.indentLeft + d.startValuePx
        : d.which === 'left'
          ? frameX + d.startValuePx
          : frameR - d.startValuePx;
    const rawMarkerX = startMarkerPageX + delta;
    const markerPageX = e.altKey ? rawMarkerX : snapToMinor(rawMarkerX, unit);
    let value =
      d.which === 'right'
        ? frameR - markerPageX
        : d.which === 'first'
          ? markerPageX - (frameX + model.indentLeft)
          : markerPageX - frameX;
    // Clamps: the engine's negative-left-edge guard + the content floor.
    const floor = ptToPx(MIN_CONTENT_WIDTH_PT);
    if (d.which === 'first') {
      value = Math.max(-model.indentLeft, value);
      value = Math.min(frameW - model.indentLeft - model.indentRight - floor, value);
    } else if (d.which === 'left') {
      value = Math.max(Math.max(0, -model.firstLineIndent), value);
      value = Math.min(frameW - model.indentRight - floor, value);
    } else {
      value = Math.max(0, value);
      value = Math.min(frameW - model.indentLeft - floor, value);
    }
    // Math.max(-0, …) yields NEGATIVE zero — Object.is(−0, 0) is false,
    // so the stored attr must be normalized (the hang-clamp pin).
    if (value === 0) value = 0;
    if (value === d.draftPx) return;
    const next = { ...d, draftPx: value };
    indentDragRef.current = next;
    setIndentDrag(next);
  }

    function endIndentDrag(commit: boolean) {
    return () => {
      const d = indentDragRef.current;
      indentDragRef.current = null;
      setIndentDrag(null);
      if (!d || !commit || !editor) return;
      editor.commands.setIndents(
        d.which === 'first'
          ? { firstLineIndent: d.draftPx }
          : d.which === 'left'
            ? { indentLeft: d.draftPx }
            : { indentRight: d.draftPx },
      );
    };
  }

  // Indent marker positions (engine px → CSS px), live with any indent
  // drag preview. The first-line apex sits at indentLeft +
  // firstLineIndent (the engine's line-0 left edge); the box's LEFT
  // edge at indentLeft (Word's convention). All ride the PREVIEW
  // left/right edges, so a margin drag carries them along.
  const liveFli = indentDrag?.which === 'first' ? indentDrag.draftPx : (model?.firstLineIndent ?? 0);
  const liveLeft = indentDrag?.which === 'left' ? indentDrag.draftPx : (model?.indentLeft ?? 0);
  const liveRight = indentDrag?.which === 'right' ? indentDrag.draftPx : (model?.indentRight ?? 0);
  // #74 — the markers anchor to the ACTIVE frame (the column's edges
  // under columns); the margin-drag preview stays PAGE-framed and does
  // not move them.
  const firstLineX = model != null ? (frameX + liveLeft + liveFli) * zoom : 0;
  const leftIndentX = model != null ? (frameX + liveLeft) * zoom : 0;
  const rightIndentX = model != null ? (frameR - liveRight) * zoom : 0;

  const dragBadge = marginDrag
    ? {
        x: innerLeft + marginDrag.draftPx * zoom,
        text:
          marginDrag.side === 'left'
            ? fmtVal(marginDrag.draftPx)
            : fmtVal(pageW - marginDrag.draftPx),
      }
    : tabDrag
      ? {
          // #74 — the dragged glyph anchors to the ACTIVE frame.
          x: innerLeft + (frameX + tabDrag.draftPx) * zoom,
          text: fmtVal(tabDrag.draftPx),
        }
      : indentDrag
        ? {
            x:
              innerLeft +
              (indentDrag.which === 'first'
                ? frameX + (model?.indentLeft ?? 0) + indentDrag.draftPx
                : indentDrag.which === 'left'
                  ? frameX + indentDrag.draftPx
                  : frameR - indentDrag.draftPx) *
                zoom,
            text: fmtVal(indentDrag.draftPx),
          }
        : null;

  return (
    <TooltipProvider>
      <div
        ref={barRef}
        data-testid={testId}
        className={`absolute top-0 z-30 select-none border-b border-border/60 bg-card${
          chrome ? ' inset-x-0' : ''
        }${marginDrag ? ' cursor-ew-resize' : ''}`}
        style={
          chrome
            ? { height: `${RULER_HEIGHT}px` }
            : { left: `${pageLeft - LABEL_PAD}px`, width: `${canvasW}px`, height: `${RULER_HEIGHT}px` }
        }
        onDoubleClick={handleBarDoubleClick}
      >
        {/* Ink probes: the canvas can't resolve Tailwind tokens, so this
            invisible span's computed color feeds the muted margin ink. */}
        <span
          ref={mutedProbeRef}
          aria-hidden
          className="invisible absolute text-muted-foreground"
        />
        <canvas
          ref={canvasRef}
          data-testid="ruler-canvas"
          role="presentation"
          className="pointer-events-none absolute top-0"
          style={{
            left: `${chrome ? pageLeft - LABEL_PAD : 0}px`,
            width: `${canvasW}px`,
            height: `${RULER_HEIGHT}px`,
          }}
        />
        <div
          data-testid="ruler-inner"
          ref={innerRef}
          className="absolute top-0 h-full"
          style={{ left: `${innerLeft}px`, width: `${pageWz}px` }}
          onPointerDown={handleBandPointerDown}
          onPointerUp={handleBandPointerUp}
          onPointerCancel={() => {
            tabAddRef.current = null;
          }}
          onContextMenu={handleBandContextMenu}
        >
          {/* Margin handles — the PHASE 2 drag targets: the full bar-height
              column at each content edge (preview-aware `x`; the little
              tab is decorative). The indent markers' arrows keep their
              own slivers — they are the indentation handles. */}
          <MarginHandle
            x={dragContentL * zoom}
            testId="ruler-margin-left"
            label={fmt(dragContentL, 'Left margin')}
            onPointerDown={startMarginDrag('left')}
            onPointerMove={moveMarginDrag}
            onPointerUp={endMarginDrag(true)}
            onPointerCancel={endMarginDrag(false)}
          />
          <MarginHandle
            x={dragContentR * zoom}
            testId="ruler-margin-right"
            label={fmt(pageW - dragContentR, 'Right margin')}
            onPointerDown={startMarginDrag('right')}
            onPointerMove={moveMarginDrag}
            onPointerUp={endMarginDrag(true)}
            onPointerCancel={endMarginDrag(false)}
          />
          {/* Tab stops (Phase 3/3.5): one glyph per stop of the caret
              block — ⌐ left, ┴ center, right mirrored — hanging at the
              band's bottom edge (Word's zone). Drag = move (preview on
              the bar, ONE undoable PM transaction at release); drag out
              of the content band = remove (the glyph fades); right-
              click = the alignment menu. Rides the PREVIEW left edge,
              so a margin drag carries the stops along. */}
          {model?.tabStops.map((stop, i) => {
            const dragging = tabDrag?.index === i;
            const draft = dragging ? tabDrag!.draftPx : stop.position;
            const removing = dragging && tabDrag!.removing;
            return (
              <div
                key={stop.position}
                data-testid="ruler-tab-stop"
                aria-label={`${stop.alignment} tab stop at ${fmtVal(stop.position)}`}
                className={`absolute bottom-0 -translate-x-1/2 translate-y-1/2 touch-none cursor-ew-resize${removing ? ' opacity-40' : ''}`}
                // #74 — the glyph anchors to the ACTIVE frame's left
                // (the column's left under columns; the frame does not
                // drag, so the margin-drag preview no longer applies).
                style={{ left: `${(frameX + draft) * zoom}px` }}
                onPointerDown={startTabDrag(i)}
                onPointerMove={moveTabDrag}
                onPointerUp={endTabDrag(true)}
                onPointerCancel={endTabDrag(false)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setTabMenu({ mode: 'stop', index: i, pageX: frameX + stop.position });
                }}
              >
                <Tooltip>
                  <TooltipTrigger render={<span className="block p-1" />}>
                    <TabGlyph alignment={stop.alignment} />
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <span className="text-muted-foreground">
                      {ALIGNMENT_ARROW[stop.alignment]}
                    </span>
                    <span>{fmtVal(stop.position)}</span>
                  </TooltipContent>
                </Tooltip>
              </div>
            );
          })}
          {/* Indent markers (drag wiring: a later phase) — hidden when the
              caret block carries no indent attrs (headings, code
              blocks, lists: structural indents are not attr edits). */}
          {model != null && (
            <>
              <Marker
                x={firstLineX - 6}
                testId="ruler-indent-first"
                label={fmt(liveFli, 'First-line indent')}
                onPointerDown={startIndentDrag('first')}
                onPointerMove={moveIndentDrag}
                onPointerUp={endIndentDrag(true)}
                onPointerCancel={endIndentDrag(false)}
              >
                <div
                  className="border-x-transparent border-t-foreground"
                  style={{
                    borderLeftWidth: 6,
                    borderRightWidth: 6,
                    borderTopWidth: 7,
                    borderStyle: 'solid',
                  }}
                />
              </Marker>
              <Marker
                x={leftIndentX}
                testId="ruler-indent-left"
                label={fmt(liveLeft, 'Left indent')}
                onPointerDown={startIndentDrag('left')}
                onPointerMove={moveIndentDrag}
                onPointerUp={endIndentDrag(true)}
                onPointerCancel={endIndentDrag(false)}
              >
                <div className="h-[7px] w-[10px] rounded-xs bg-foreground" />
              </Marker>
              <Marker
                x={rightIndentX - 6}
                testId="ruler-indent-right"
                label={fmt(liveRight, 'Right indent')}
                onPointerDown={startIndentDrag('right')}
                onPointerMove={moveIndentDrag}
                onPointerUp={endIndentDrag(true)}
                onPointerCancel={endIndentDrag(false)}
              >
                <div
                  className="border-x-transparent border-b-foreground"
                  style={{
                    borderLeftWidth: 6,
                    borderRightWidth: 6,
                    borderBottomWidth: 7,
                    borderStyle: 'solid',
                  }}
                />
              </Marker>
            </>
          )}
        </div>
        {/* The drag badge (margin + tab drags): the live value at the
            draft edge/stop, in the user's measurement unit — the
            "current length shown in real time" criterion.
            Pointer-transparent; hangs below the bar. */}
        {dragBadge && (
          <div
            data-testid="ruler-drag-badge"
            className="pointer-events-none absolute top-full z-40 mt-1 -translate-x-1/2 whitespace-nowrap rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-foreground shadow-sm"
            style={{ left: `${dragBadge.x}px` }}
          >
            {dragBadge.text}
          </div>
        )}
        {/* The tab context menu (3.5): band right-click adds with an
            alignment; stop right-click re-aligns or removes. Clamped to
            stay inside the bar; closes on outside pointerdown/Esc. */}
        {tabMenu && (
          <div
            ref={menuRef}
            data-testid="ruler-tab-menu"
            className="absolute top-full z-50 mt-1 min-w-[130px] -translate-x-1/2 rounded-md border border-border bg-background py-1 shadow-md"
            style={{
              left: `${Math.min(
                Math.max(innerLeft + tabMenu.pageX * zoom, 70),
                Math.max(70, deskW - 70),
              )}px`,
            }}
          >
            {tabMenu.mode === 'band'
              ? (['left', 'center', 'right'] as const).map((alignment) => (
                  <button
                    key={alignment}
                    data-testid={`ruler-tab-menu-${alignment}`}
                    className="block w-full px-2.5 py-1 text-left text-xs hover:bg-muted"
                    onClick={() => addStopAt(alignment)}
                  >
                    Add {alignment} tab
                  </button>
                ))
              : (
                  <>
                    {(['left', 'center', 'right'] as const).map((alignment) => (
                      <button
                        key={alignment}
                        data-testid={`ruler-tab-menu-${alignment}`}
                        className="block w-full px-2.5 py-1 text-left text-xs hover:bg-muted"
                        onClick={() => changeStopAlignment(alignment)}
                      >
                        {alignment === 'left'
                          ? 'Left tab'
                          : alignment === 'center'
                            ? 'Center tab'
                            : 'Right tab'}
                      </button>
                    ))}
                    <div className="my-1 h-px bg-border" />
                    <button
                      data-testid="ruler-tab-menu-remove"
                      className="block w-full px-2.5 py-1 text-left text-xs text-destructive hover:bg-muted"
                      onClick={removeStop}
                    >
                      Remove tab stop
                    </button>
                  </>
                )}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
/**
 * M-RULER Phase 5 — the VERTICAL ruler.
 *
 * Mount law: wrapper-FIXED viewport column (the same desk-wrapper
 * overlay the horizontal bar portals into — `absolute inset-y-0
 * left-0`), so the background spans the entire container height at
 * every scroll position (the horizontal's w-full law, verticalized).
 * The SCALE travels instead: the whole tick field translates by the
 * desk's scrollTop (page-attached ticks, Word's fixed-bar/moving-scale
 * model), repainted from the scroll listener — the paint loop skips
 * pages outside the visible range, so a scroll frame costs strokes for
 * the visible pages only.
 *
 * One margin-handle pair per page, all reading/writing the same store
 * margins through the same two write modes (live vs preview on Reduce
 * Motion) as the horizontal drags. The pad top offset (the desk's
 * pt-8) is read from the scroller's computed style — the same
 * documented coupling as the horizontal's flush mount.
 */
export function VerticalRuler({
  pages,
  zoom,
  editor,
  tops: topsProp,
  side = 'left',
  testId = 'ruler-vertical',
}: {
  /** #58 — the walk's per-page geometry (mixed sections make pages
   *  differ; the ruler paints EACH page's own margins). */
  pages: PageGeometry[];
  zoom: number;
  editor: Editor | null;
  /**
   * #101 — SPLIT VIEW: the scale's tops for THESE pages — the grid's
   * ROW tops (row-mates share a top), passed by the caller. Absent ≡
   * the internal y-only pageTops walk (the classic stack — legacy,
   * bit-identical).
   */
  tops?: number[];
  /** #101 — SPLIT VIEW: which desk edge the column rides. 'right'
   *  mirrors the badge and the tooltip direction. */
  side?: 'left' | 'right';
  /** The test hook (the split column's ruler wears its own). */
  testId?: string;
}) {
  const unit = useConfigStore((s) => s.config.editor.measurementUnit);
  const theme = useConfigStore((s) => s.config.theme);
  const reducedMotion = useReducedMotion();
  const pageGap = useDocumentStore((s) => s.pageSetup.pageGap);
  const [containerH, setContainerH] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [padTop, setPadTop] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mutedProbeRef = useRef<HTMLSpanElement>(null);
  // M-HEADER-FOOTER: the accent probe for the active-band highlight.
  const primaryProbeRef = useRef<HTMLSpanElement>(null);
  // M-HEADER-FOOTER-2: the active band signal — selection-driven (a
  // band container in the selection's ancestry), the one-PM-doc law.
  const editorForBand = useDocumentStore((s) => s.editor);
  const hfSurface = useEditorState({
    editor: editorForBand,
    selector: ({ editor: e }): 'header' | 'footer' | null => {
      if (!e) return null;
      const { $from } = e.state.selection;
      for (let d = $from.depth; d > 0; d--) {
        const name = $from.node(d).type.name;
        if (name === 'headerBlock') return 'header';
        if (name === 'footerBlock') return 'footer';
      }
      return null;
    },
  });

  // #58 — per-page geometry: the cumulative sheet tops (mixed page
  // heights) and each page's own margins. The MARGIN HANDLES mount on
  // EVERY page and their drag writes DOCUMENT-WIDE (the applyPageSetup
  // 'document' scope — the ribbon quick controls' law: quick surfaces
  // are doc-wide; the Page Setup dialog carries the scoped power).
  // Mixed sections: each handle pair sits at ITS page's own edges; the
  // drag derives the top/bottom pt from THAT page's frame and merges
  // the result into every section.
  const firstPage = pages[0];
  const firstPageH = firstPage?.size.height ?? 0;
  const firstContentY = firstPage?.contentBox.y ?? 0;
  const firstContentB =
    (firstPage ? firstPage.contentBox.y + firstPage.contentBox.height : 0);
  const tops = useMemo(
    () => topsProp ?? pageTops(pages, pageGap),
    [topsProp, pages, pageGap],
  );
  // The paint-window signature (the deps law — primitives only: a
  // value-identical pages array must not repaint into the paint-ops
  // window).
  const geoKey = pages
    .map(
      (p) =>
        `${p.size.width},${p.size.height},${p.contentBox.y},${p.contentBox.height}`,
    )
    .join('|');
  const topsKey = tops.join(',');
  // The handle set: EVERY page (the drag is document-wide — the
  // Page Setup dialog is the scoped surface).
  const handlePages = useMemo(() => pages.map((_, i) => i), [pages]);
  // The scale's screen origin: the desk's top padding (pt-8) minus the
  // scroll — page-attached ticks in a viewport-fixed column.
  const scaleTop = padTop - scrollTop;

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    // The bar's parent IS the desk wrapper; the scroller is its child.
    const scroller = bar.parentElement?.querySelector('[data-desk-scroll]') as HTMLDivElement | null;
    if (!scroller) return;
    const wrapperRo = new ResizeObserver(() => setContainerH(bar.parentElement!.clientHeight));
    wrapperRo.observe(bar.parentElement!);
    setContainerH(bar.parentElement!.clientHeight);
    setPadTop(parseFloat(getComputedStyle(scroller).paddingTop) || 0);
    const onScroll = () => setScrollTop(scroller.scrollTop);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    setScrollTop(scroller.scrollTop);
    return () => {
      wrapperRo.disconnect();
      scroller.removeEventListener('scroll', onScroll);
    };
  }, []);

  // Deps are the PAINT INPUTS as primitives (the horizontal bar's law:
  // a value-identical PageGeometry must not repaint into the paint-ops
  // window) — plus scrollTop/padTop/containerH: the scale's frame.
  // pages/tops ride THROUGH geoKey/topsKey (array identity must not
  // gate the paint — only values).
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const bar = barRef.current;
    if (!canvas || !bar) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(RULER_WIDTH * dpr));
    canvas.height = Math.max(1, Math.round(containerH * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, RULER_WIDTH, containerH);

    const fg = getComputedStyle(bar).color || '#000';
    const muted =
      (mutedProbeRef.current && getComputedStyle(mutedProbeRef.current).color) || fg;
    const barBg = getComputedStyle(bar).backgroundColor || 'transparent';

    ctx.font = '500 9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let p = 0; p < pages.length; p++) {
      const page = pages[p]!;
      const pageH = page.size.height;
      const pageHz = pageH * zoom;
      const contentY = page.contentBox.y;
      const contentB = contentY + page.contentBox.height;
      const pageTop = scaleTop + tops[p]! * zoom; // screen y of the page's top edge
      // Off-viewport cull — only meaningful with a measured container
      // (jsdom's zero-height degenerate paints everything, keeping the
      // paint-ops assertions honest for every page).
      if (containerH > 0 && (pageTop > containerH || pageTop + pageHz < 0)) continue;
      const topMs = pageTop + contentY * zoom; // the top margin's inner edge
      const botMs = pageTop + contentB * zoom; // the bottom margin's inner edge
      // Margin strips (un-usable space) — muted ink, mirrored two-tone.
      ctx.fillStyle = muted;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(0, Math.round(pageTop), RULER_WIDTH, 1); // page top edge
      ctx.fillRect(0, Math.round(botMs), RULER_WIDTH, 1); // bottom edge
      ctx.globalAlpha = 0.08;
      ctx.fillRect(0, pageTop, RULER_WIDTH, topMs - pageTop);
      ctx.fillRect(0, botMs, RULER_WIDTH, pageTop + pageHz - botMs);

      // M-HEADER-FOOTER: the ACTIVE band's margin strip wears the
      // accent wash (a focused header tints the top strip, a footer
      // the bottom) — the ruler's active-region cue.
      if (hfSurface !== null && primaryProbeRef.current) {
        const primary = getComputedStyle(primaryProbeRef.current).color;
        if (primary) {
          ctx.fillStyle = primary;
          ctx.globalAlpha = 0.18;
          if (hfSurface === 'header') ctx.fillRect(0, pageTop, RULER_WIDTH, topMs - pageTop);
          else ctx.fillRect(0, botMs, RULER_WIDTH, pageTop + pageHz - botMs);
        }
      }

      // The page's tick field: functional (fg) inside the content span,
      // muted short ticks in the margin spans; majors numbered 0 from
      // the page's top edge (Word's vertical numbering), rendered
      // UPRIGHT over a bar-background knockout (the horizontal label
      // treatment, transplanted).
      const ticks = generateTicks(pageH, unit);
      for (const tick of ticks) {
        const y = pageTop + tick.x * zoom;
        const ry = Math.round(y);
        const inContent = y >= topMs - 1e-6 && y <= botMs + 1e-6;
        if (tick.kind === 'major') {
          ctx.fillStyle = inContent ? fg : muted;
          ctx.globalAlpha = inContent ? 0.9 : 0.5;
          ctx.fillRect(0, ry, RULER_WIDTH, 1);
          if (inContent) {
            const label = String(tick.label);
            // UPRIGHT number (the horizontal's treatment): centered in
            // the bar's width at the tick's y, over a bar-background
            // knockout so the major line forms the border around the
            // digits.
            const w = ctx.measureText(label).width + LABEL_BOX_PAD * 2;
            ctx.globalAlpha = 1;
            ctx.fillStyle = barBg;
            ctx.fillRect(RULER_WIDTH / 2 - w / 2, y - LABEL_BOX_H / 2, w, LABEL_BOX_H);
            ctx.fillStyle = fg;
            ctx.fillText(label, RULER_WIDTH / 2, y + 0.5);
          }
        } else if (inContent) {
          ctx.fillStyle = fg;
          ctx.globalAlpha = tick.kind === 'medium' ? 0.7 : 0.45;
          const len = tick.kind === 'medium' ? MED_LEN : MIN_LEN;
          ctx.fillRect(RULER_WIDTH - len, ry, len, 1);
        } else {
          ctx.fillStyle = muted;
          ctx.globalAlpha = 0.4;
          ctx.fillRect(RULER_WIDTH - MIN_LEN, ry, MIN_LEN, 1);
        }
      }
      // Content-box rails — the margin handles' boundaries (vertical
      // 1px lines spanning the bar's width).
      ctx.fillStyle = fg;
      ctx.globalAlpha = 0.5;
      ctx.fillRect(0, Math.round(topMs), RULER_WIDTH, 1);
      ctx.fillRect(0, Math.round(botMs), RULER_WIDTH, 1);
    }
    ctx.globalAlpha = 1;
    // The deps law: primitives only (geoKey/topsKey) — pages/tops ride
    // THROUGH them (array identity must not gate the paint).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    containerH,
    geoKey,
    topsKey,
    hfSurface,
    padTop,
    scaleTop,
    theme,
    unit,
    zoom,
  ]);

  // ── vertical margin dragging (top/bottom) — the horizontal's two
  // write modes, y-axis plumbing ──
  interface VMarginDrag {
    side: 'top' | 'bottom';
    page: number;
    startClientY: number;
    startEdgePx: number;
    draftPx: number;
    /** #58 — the setup BEFORE the drag (ONE undo entry per drag: the
     *  frames write without history/push; the end commit re-applies
     *  the final margins as the ONE item + pushes this). */
    startSetup: PageSetup;
  }
  const dragRef = useRef<VMarginDrag | null>(null);
  const [drag, setDrag] = useState<VMarginDrag | null>(null);
  const pendingWriteRef = useRef<number | null>(null);

  function commitMargin(d: VMarginDrag, px: number, opts?: {
    pushUndo?: boolean;
    addToHistory?: boolean;
    undoPrev?: PageSetup;
  }) {
    const ps = useDocumentStore.getState().pageSetup;
    const margins = { ...ps.margins };
    // The drag page's own height (mixed sections — the dragged page's
    // frame defines the bottom edge). #101 — SPLIT VIEW + Word's law:
    // the drag writes THE DRAGGED PAGE'S SECTION (the left ruler rules
    // the left column's pages, the right ruler the right's — a right-
    // ruler drag must not move a left page of another section). The
    // write seeds from the section's OWN effective setup (a mixed-
    // geometry doc never takes the store's size). A uniform doc (no
    // breaks) collapses to the store — the one-section case IS
    // document-wide; both pages share the one margin set.
    const dragPageH = pages[d.page]?.size.height ?? firstPageH;
    if (d.side === 'top') margins.top = pxToPt(px);
    else margins.bottom = pxToPt(dragPageH - px);
    if (margins.top === ps.margins.top && margins.bottom === ps.margins.bottom) return;
    const sectionIndex = pages[d.page]?.sectionIndex ?? 0;
    const full = { ...sectionSetupAt(editor, ps, sectionIndex), margins };
    applyPageSetup('sections', full, { margins }, { ...opts, sectionSet: [sectionIndex] });
  }

  function startDrag(side: 'top' | 'bottom', page: number) {
    return (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || !editor) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      // The drag page's OWN edges (mixed sections — the handles sit
      // at each page's real margins).
      const dragPage = pages[page];
      const startEdgePx = side === 'top'
        ? (dragPage?.contentBox.y ?? firstContentY)
        : ((dragPage ? dragPage.contentBox.y + dragPage.contentBox.height : 0) || firstContentB);
      const d: VMarginDrag = {
        side,
        page,
        startClientY: e.clientY,
        startEdgePx,
        draftPx: startEdgePx,
        startSetup: useDocumentStore.getState().pageSetup,
      };
      dragRef.current = d;
      setDrag(d);
    };
  }

  function moveDrag(e: ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    const dragPageH = pages[d.page]?.size.height ?? firstPageH;
    const dragPage = pages[d.page];
    const pageContentY = dragPage?.contentBox.y ?? firstContentY;
    const pageContentB = dragPage ? dragPage.contentBox.y + dragPage.contentBox.height : 0;
    const raw = d.startEdgePx + (e.clientY - d.startClientY) / zoom;
    const snapped = e.altKey ? raw : snapToMinor(raw, unit);
    const [top, bottom] = clampMarginSpan(
      d.side === 'top' ? snapped : pageContentY,
      d.side === 'bottom' ? snapped : pageContentB,
      dragPageH,
    );
    const draftPx = d.side === 'top' ? top : bottom;
    if (draftPx === d.draftPx) return;
    const next = { ...d, draftPx };
    dragRef.current = next;
    setDrag(next);
    if (!reducedMotion) {
      if (pendingWriteRef.current != null) cancelAnimationFrame(pendingWriteRef.current);
      if (typeof requestAnimationFrame === 'function') {
        pendingWriteRef.current = requestAnimationFrame(() => {
          pendingWriteRef.current = null;
          // The LIVE preview: no history item, no undo push (the drag's
          // end commit is the ONE entry).
          commitMargin(next, next.draftPx, { pushUndo: false, addToHistory: false });
        });
      } else {
        commitMargin(next, next.draftPx, { pushUndo: false, addToHistory: false });
      }
    }
  }

  function endDrag(commit: boolean) {
    return () => {
      if (pendingWriteRef.current != null) {
        cancelAnimationFrame(pendingWriteRef.current);
        pendingWriteRef.current = null;
      }
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (d && commit) {
        // ONE history item + ONE undo entry per drag (the pre-drag
        // setup rides as the entry's previous value).
        commitMargin(d, d.draftPx, {
          pushUndo: true,
          addToHistory: true,
          undoPrev: d.startSetup,
        });
      }
    };
  }

  // The handle/badge screen-y law: the scale's origin + the page's
  // CUMULATIVE stack offset + the edge (all × zoom), in the wrapper
  // frame (#58 — pages differ; the table carries the offsets).
  const handleY = (page: number, edgePx: number): number =>
    scaleTop + tops[page]! * zoom + edgePx * zoom;

  const fmt = (px: number, what: string): string =>
    `${what}: ${formatPxAsUnit(px, unit)} ${unitSuffix(unit)}`;
  const fmtVal = (px: number): string =>
    `${formatPxAsUnit(px, unit)} ${unitSuffix(unit)}`;

  const badge = drag
    ? {
        y: handleY(drag.page, drag.draftPx),
        text:
          drag.side === 'top'
            ? fmtVal(drag.draftPx)
            : fmtVal((pages[drag.page]?.size.height ?? firstPageH) - drag.draftPx),
      }
    : null;

  return (
    <TooltipProvider>
      <div
        ref={barRef}
        data-testid={testId}
        className={`absolute inset-y-0 z-20 select-none bg-card${drag ? ' cursor-ns-resize' : ''} ${
          side === 'right' ? 'right-0' : 'left-0'
        }`}
        style={{ [side]: 0, width: `${RULER_WIDTH}px` } as CSSProperties}
      >
        <span
          ref={mutedProbeRef}
          aria-hidden
          className="invisible absolute text-muted-foreground"
        />
        {/* M-HEADER-FOOTER: the primary-ink probe for the active-band
            highlight (the muted probe's pattern; --primary is fine HERE
            — the band highlight is SUPPOSED to wear the accent, unlike
            ticks). */}
        <span
          ref={primaryProbeRef}
          aria-hidden
          className="invisible absolute text-primary"
        />
        <canvas
          ref={canvasRef}
          data-testid="ruler-vertical-canvas"
          role="presentation"
          className="pointer-events-none absolute left-0 top-0"
          style={{ width: `${RULER_WIDTH}px`, height: `${containerH}px` }}
        />
        {/* Per-page margin handles (#58): full-width columns at each
            HANDLE-SET page's content-box edges (the horizontal's
            full-height law, rotated). The set = the FINAL section's
            pages — the store margins those drags write are exactly
            these edges; uniform docs mount every page (unchanged).
            TODO(#58 Phase 2): per-section handle targeting. */}
        {handlePages.map((p) => {
          const pageEdges = (() => {
            const pg = pages[p];
            const y = pg?.contentBox.y ?? firstContentY;
            const b = pg ? pg.contentBox.y + pg.contentBox.height : 0;
            const h = pg?.size.height ?? firstPageH;
            return { y, b, h };
          })();
          const topY = handleY(p, drag?.side === 'top' && drag.page === p ? drag.draftPx : pageEdges.y);
          const botY = handleY(p, drag?.side === 'bottom' && drag.page === p ? drag.draftPx : pageEdges.b);
          return (
            <div key={p}>
              <div
                data-testid={p === 0 ? `${testId}-top` : undefined}
                aria-label={fmt(pageEdges.y, 'Top margin')}
                className="absolute left-0 w-full h-[16px] -translate-y-1/2 cursor-ns-resize touch-none"
                style={{ top: `${topY}px` }}
                onPointerDown={startDrag('top', p)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag(true)}
                onPointerCancel={endDrag(false)}
              >
                <Tooltip>
                  <TooltipTrigger render={<span className="absolute inset-0 block" />} />
                  <TooltipContent side={side === 'right' ? 'left' : 'right'}>
                    {fmt(pageEdges.y, 'Top margin')}
                  </TooltipContent>
                </Tooltip>
                <div className="pointer-events-none absolute left-0 top-1/2 -translate-y-1/2 h-[9px] w-[11px] rounded-xs border border-foreground/40 bg-card" />
              </div>
              <div
                data-testid={p === 0 ? `${testId}-bottom` : undefined}
                aria-label={fmt(pageEdges.h - pageEdges.b, 'Bottom margin')}
                className="absolute left-0 w-full h-[16px] -translate-y-1/2 cursor-ns-resize touch-none"
                style={{ top: `${botY}px` }}
                onPointerDown={startDrag('bottom', p)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag(true)}
                onPointerCancel={endDrag(false)}
              >
                <Tooltip>
                  <TooltipTrigger render={<span className="absolute inset-0 block" />} />
                  <TooltipContent side={side === 'right' ? 'left' : 'right'}>
                    {fmt(pageEdges.h - pageEdges.b, 'Bottom margin')}
                  </TooltipContent>
                </Tooltip>
                <div className="pointer-events-none absolute left-0 top-1/2 -translate-y-1/2 h-[9px] w-[11px] rounded-xs border border-foreground/40 bg-card" />
              </div>
            </div>
          );
        })}
        {badge && (
          <div
            data-testid={`${testId}-drag-badge`}
            className={`pointer-events-none absolute z-40 -translate-y-1/2 whitespace-nowrap rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-foreground shadow-sm ${
              side === 'right' ? 'mr-1' : 'ml-1'
            }`}
            style={{ top: `${badge.y}px`, [side]: `${RULER_WIDTH}px` } as CSSProperties}
          >
            {badge.text}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
