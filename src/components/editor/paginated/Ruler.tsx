import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { PageGeometry } from '@tensor-editor/engine';
import { useConfigStore } from '@/lib/config/store';
import {
  RULER_HEIGHT,
  formatPxAsUnit,
  generateTicks,
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

interface MarkerProps {
  /** CSS px within the ruler's inner (page-width) container. */
  x: number;
  testId: string;
  label: string;
  children: ReactNode;
}

/** A marker: an absolutely-positioned hit target wrapped in the app's
 * tooltip (value shown in the user's measurement unit). Straddles the
 * bar's bottom edge — half on / half off — via the 50% own-height
 * translateY, so any marker shape hangs right at the boundary. */
function Marker({ x, testId, label, children }: MarkerProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            data-testid={testId}
            aria-label={label}
            className="absolute bottom-0 cursor-ew-resize"
            style={{ left: `${x}px`, transform: 'translateY(50%)' }}
          >
            {children}
          </div>
        }
      />
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function Ruler({
  geometry,
  zoom,
  model,
}: {
  /** The FIRST page's engine geometry — the single source of page and
   * content-box dims (L1: never re-derived from pageSetup here). */
  geometry: PageGeometry;
  /** zoomLevel / 100 — scales content positions, not the bar. */
  zoom: number;
  /** The caret block's indent attrs, or null (margins-only ruler). */
  model: RulerModel | null;
}) {
  const unit = useConfigStore((s) => s.config.editor.measurementUnit);
  // Canvas colors are computed-style READS at paint time, not live CSS —
  // subscribing to the theme is what makes a light/dark flip repaint.
  const theme = useConfigStore((s) => s.config.theme);
  const [deskW, setDeskW] = useState(0);
  const [deskScrollLeft, setDeskScrollLeft] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mutedProbeRef = useRef<HTMLSpanElement>(null);

  const pageW = geometry.size.width;
  const contentX = geometry.contentBox.x;
  const contentW = geometry.contentBox.width;
  const contentR = contentX + contentW;
  const pageWz = pageW * zoom;
  // The page strip's screen origin within this bar: the SAME centering
  // the desk scroller gives the zoom wrapper (clientWidth-based, so a
  // layout-taking vertical scrollbar can't skew it), minus the desk's
  // horizontal scroll so the bar tracks the page when zoom overflows.
  const pageLeft = Math.max(0, (deskW - pageWz) / 2) - deskScrollLeft;
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
    const contentLs = LABEL_PAD + contentX * zoom;
    const contentRs = LABEL_PAD + contentR * zoom;

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
      const inContent = x >= contentLs - 1e-6 && x <= contentRs + 1e-6;
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

    // Content-box rails — the margin markers' boundary, full height.
    ctx.fillStyle = fg;
    ctx.globalAlpha = 0.5;
    ctx.fillRect(Math.round(contentLs), 0, 1, RULER_HEIGHT);
    ctx.fillRect(Math.round(contentRs), 0, 1, RULER_HEIGHT);
    ctx.globalAlpha = 1;
  }, [canvasW, contentR, contentX, pageW, pageWz, theme, unit, zoom]);

  const fmt = (px: number, what: string): string =>
    `${what}: ${formatPxAsUnit(px, unit)} ${unitSuffix(unit)}`;

  // Indent marker positions (engine px → CSS px). The first-line apex
  // sits at indentLeft + firstLineIndent (the engine's line-0 left
  // edge); the box's LEFT edge at indentLeft (Word's convention).
  const firstLineX =
    model != null
      ? (contentX + model.indentLeft + model.firstLineIndent) * zoom
      : 0;
  const leftIndentX =
    model != null ? (contentX + model.indentLeft) * zoom : 0;
  const rightIndentX =
    model != null ? (contentX + contentW - model.indentRight) * zoom : 0;

  return (
    <TooltipProvider>
      <div
        ref={barRef}
        data-testid="ruler"
        className="absolute inset-x-0 top-0 z-30 select-none border-b border-border/60 bg-card"
        style={{ height: `${RULER_HEIGHT}px` }}
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
            left: `${pageLeft - LABEL_PAD}px`,
            width: `${canvasW}px`,
            height: `${RULER_HEIGHT}px`,
          }}
        />
        <div
          data-testid="ruler-inner"
          className="absolute top-0 h-full"
          style={{ left: `${pageLeft}px`, width: `${pageWz}px` }}
        >
          {/* Margin grabbers (drag wiring: Phase 2). The style.left is
              the content edge; the tab straddles it — and the bar's
              bottom edge (Marker's half-on/half-off law). */}
          <Marker
            x={contentX * zoom - 4.5}
            testId="ruler-margin-left"
            label={fmt(contentX, 'Left margin')}
          >
            <div className="h-[11px] w-[9px] rounded-[2px] border border-foreground/40 bg-card" />
          </Marker>
          <Marker
            x={contentR * zoom - 4.5}
            testId="ruler-margin-right"
            label={fmt(pageW - contentR, 'Right margin')}
          >
            <div className="h-[11px] w-[9px] rounded-[2px] border border-foreground/40 bg-card" />
          </Marker>
          {/* Indent markers (drag wiring: Phase 2) — hidden when the
              caret block carries no indent attrs (headings, code
              blocks, lists: structural indents are not attr edits). */}
          {model != null && (
            <>
              <Marker
                x={firstLineX - 6}
                testId="ruler-indent-first"
                label={fmt(model.firstLineIndent, 'First-line indent')}
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
                label={fmt(model.indentLeft, 'Left indent')}
              >
                <div className="h-[7px] w-[10px] rounded-[2px] bg-foreground" />
              </Marker>
              <Marker
                x={rightIndentX - 6}
                testId="ruler-indent-right"
                label={fmt(model.indentRight, 'Right indent')}
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
      </div>
    </TooltipProvider>
  );
}