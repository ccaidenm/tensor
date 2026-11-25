import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RefObject } from 'react';
import {
  generateTicks,
  RULER_HEIGHT,
} from '@/lib/paginated/ruler';
import { useConfigStore } from '@/lib/config/store';
import { useDocumentStore } from '@/lib/document/store';
import { ptToPx } from '@/lib/document/pageSetup';

/** Functional tick heights (px up from the bar's bottom edge) — the
 *  paginated bar's own values, mirrored locally (they're module-local
 *  there). Majors run FULL height by design. */
const MED_LEN = 7;
const MIN_LEN = 4;

/**
 * The horizontal ruler over the continuous strip — READ-ONLY. Mimics
 * the paginated bar's visual language 1:1 minus numbers (same two-tone
 * ink, same rails, no band fills); geometry comes from the strip's DOM
 * boxes — no engine PageGeometry in continuous flow. Scale = viewport
 * rect ÷ offsetWidth; zoom, resize, and scroll all re-measure. Portaled
 * into [data-desk-wrapper] as absolute top-0, outside the scroll flow;
 * gated on config.editor.showHorizontalRuler.
 */

/** The canvas overhang on each side of the strip: the edge tick draws
 *  its pixel column exactly AT the strip's edge and would clip against
 *  an exactly-sized canvas. */
const LABEL_PAD = 12;

export interface RulerGeo {
  /** The strip's viewport left relative to the wrapper. */
  left: number;
  /** The strip's RENDERED width (viewport px — includes zoom). */
  width: number;
  /** The rendered/layout scale (zoom folded in). */
  scale: number;
  /** The content box's left/right insets (VIEWPORT px): the computed
   *  padding × scale. The two-tone ink boundary. */
  contentL: number;
  contentR: number;
}

/** Pure geometry (unit-testable — jsdom has no layout, so the
 *  component test asserts structure while this carries the math). */
export function measureRulerGeo(
  stripRect: { left: number; width: number },
  stripOffsetWidth: number,
  wrapperLeft: number,
  computedPaddingLeftPx: number,
  computedPaddingRightPx: number,
): RulerGeo {
  // ZERO-RECT GUARD (jsdom has no layout): a non-finite/zero scale
  // would make generateTicks' width NaN — its `x > width` loop never
  // terminates for NaN. Scale 1 + zero width keep consumers finite.
  let scale = stripRect.width / (stripOffsetWidth || 1);
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;
  return {
    left: stripRect.left - wrapperLeft,
    width: stripRect.width,
    scale,
    contentL: computedPaddingLeftPx * scale,
    contentR: stripRect.width - computedPaddingRightPx * scale,
  };
}

export function PagelessRuler({ containerRef }: { containerRef: RefObject<HTMLDivElement | null> }) {
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [geo, setGeo] = useState<RulerGeo | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const mutedProbeRef = useRef<HTMLSpanElement>(null);
  const unit = useConfigStore((s) => s.config.editor.measurementUnit);
  const theme = useConfigStore((s) => s.config.theme);
  const margins = useDocumentStore((s) => s.pageSetup.margins);
  const marginsRef = useRef(margins);
  marginsRef.current = margins;

  // THE MEASUREMENT LOOP: strip viewport rect vs desk wrapper rect
  // positions the bar; the pure measureRulerGeo carries the math.
  useEffect(() => {
    const measure = () => {
      const wrapper = document.querySelector('[data-desk-wrapper]') as HTMLElement | null;
      const strip = containerRef.current?.querySelector('[data-testid="pageless-surface"]') as HTMLElement | null;
      if (!wrapper || !strip) return;
      setPortalTarget(wrapper);
      const w = wrapper.getBoundingClientRect();
      const s = strip.getBoundingClientRect();
      const style = getComputedStyle(strip);
      const leftPad = parseFloat(style.paddingLeft) || ptToPx(marginsRef.current.left);
      const rightPad = parseFloat(style.paddingRight) || ptToPx(marginsRef.current.right);
      setGeo(measureRulerGeo(
        { left: s.left, width: s.width },
        strip.offsetWidth,
        w.left,
        leftPad,
        rightPad,
      ));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (containerRef.current) observer.observe(containerRef.current);
    window.addEventListener('resize', measure);
    const scroller = document.querySelector('[data-desk-scroll]');
    scroller?.addEventListener('scroll', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      scroller?.removeEventListener('scroll', measure);
    };
  }, [containerRef]);

  // THE PAINT (DPR-scaled): the tick field spans only the strip
  // (overhang keeps edge ticks unclipped), foreground inside the
  // content box / muted in margins, rails at the content edges, no
  // numbers. Redraws on geometry, unit, and theme.
  useEffect(() => {
    if (!geo) return;
    const canvas = canvasRef.current;
    const bar = barRef.current;
    if (!canvas || !bar) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const canvasW = Math.max(1, Math.round(geo.width + LABEL_PAD * 2));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(canvasW * dpr));
    canvas.height = Math.max(1, Math.round(RULER_HEIGHT * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvasW, RULER_HEIGHT);

    // Theme reads at paint time: foreground ink for the content span
    // and rails, muted for margins. --primary (brand orange) is never a tick ink.
    const fg = getComputedStyle(bar).color || '#000';
    const muted =
      (mutedProbeRef.current && getComputedStyle(mutedProbeRef.current).color) || fg;

    // Canvas-local coords: the canvas sits at stripLeft − PAD, so the
    // strip's left edge is PAD in — applying geo.left here TOO would
    // double the offset.
    const contentLs = LABEL_PAD + geo.contentL;
    const contentRs = LABEL_PAD + geo.contentR;

    // The strip grid (generateTicks over the LAYOUT width), rendered at
    // the geo scale, inked by region. THE EMPTY GUARD: a zero-width
    // strip (jsdom) paints nothing.
    const layoutWidth = geo.width / geo.scale;
    if (!Number.isFinite(layoutWidth) || layoutWidth <= 0) return;
    for (const tick of generateTicks(layoutWidth, unit)) {
      const x = LABEL_PAD + tick.x * geo.scale;
      const rx = Math.round(x);
      const inContent = x >= contentLs - 1e-6 && x <= contentRs + 1e-6;
      if (tick.kind === 'major') {
        // Full-height major in its region's ink.
        ctx.fillStyle = inContent ? fg : muted;
        ctx.globalAlpha = inContent ? 0.9 : 0.5;
        ctx.fillRect(rx, 0, 1, RULER_HEIGHT);
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

    // THE RAILS — the content box's edges, full height, foreground.
    ctx.globalAlpha = 1;
    ctx.fillStyle = fg;
    ctx.fillRect(Math.round(contentLs) - 1, 0, 2, RULER_HEIGHT);
    ctx.fillRect(Math.round(contentRs) - 1, 0, 2, RULER_HEIGHT);
  }, [geo, unit, theme]);

  if (!portalTarget || !geo) return null;

  return createPortal(
    <div
      ref={barRef}
      className="absolute inset-x-0 top-0 z-30 select-none border-b border-border/60 bg-card"
      style={{ height: `${RULER_HEIGHT}px` }}
      data-testid="pageless-ruler"
    >
      {/* Ink probe: the canvas can't resolve Tailwind tokens — this
          invisible span's computed color feeds the muted margin ink. */}
      <span ref={mutedProbeRef} aria-hidden className="invisible absolute text-muted-foreground" />
      <canvas
        ref={canvasRef}
        data-testid="pageless-ruler-canvas"
        role="presentation"
        className="pointer-events-none absolute top-0"
        style={{
          left: `${geo.left - LABEL_PAD}px`,
          width: `${geo.width + LABEL_PAD * 2}px`,
          height: `${RULER_HEIGHT}px`,
        }}
      />
    </div>,
    portalTarget,
  );
}
