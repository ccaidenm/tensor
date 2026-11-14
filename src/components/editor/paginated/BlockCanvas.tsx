import { memo, useLayoutEffect, useRef } from 'react';
import type { LineBox, Run, TextMetrics, TextStyle } from '@tensor-editor/engine';
import type { BlockPaint, RunDecor, TextAlign } from '@/lib/paginated/adapter';
import { paintLines } from '@/lib/paginated/paint';

interface BlockCanvasProps {
  /** One block's LineBoxes on ONE page, document order. */
  lines: readonly LineBox[];
  runs: readonly Run[];
  text: string;
  metrics: TextMetrics;
  /** Absolute placement inside the page sheet (content-box derived). */
  left: number;
  top: number;
  width: number;
  align: TextAlign;
  runDecor: readonly RunDecor[];
  /** Non-printing characters (config.editor.showNonPrintingChars) —
   * display-only ink, never a layout fact, never in print/export. */
  npc?: boolean;
  /** Block paint hints (list marker, blockquote, code bg, rule) —
   * M6.1 paint-only decor, identity-stable per adapter conversion. */
  paint?: BlockPaint;
  /** Marker font: the block's first run style, else the document
   * default ("style from the block's runs"). */
  markerStyle?: TextStyle;
  /**
   * REGISTRY EPOCH (M-STYLES amendment 1): the repaint key's third
   * leg. A RunDecor-level property edit (a style's COLOR) changes no
   * layout-relevant fact — the engine splices (blocksWalked = 0) and
   * hands back the SAME frozen LineBox references, so the line
   * identity test below would skip the repaint and the new color
   * would stay invisible behind the dirty-skip. The epoch forces the
   * repaint: any definition edit repaints every block once, and the
   * epoch comes from the same store subscription PaginatedView uses.
   */
  styleEpoch: number;
  /** M-IMAGES-1: caption DISPLAY toggle — false skips the caption
   *  blocks' text ink (blank space: layout is engine-owned and stays
   *  untouched — the NPC precedent, presentation-only). */
  showCaptions: boolean;
  /** M-IMAGES-2: the block's BASE wrap width (contentBox.width −
   *  indentLeft − indentRight) — the engine's breakLines maxWidth
   *  (layout.ts:392), and the object clamp's input. The inline paint
   *  clamp uses the SAME fitDownImage primitive on the SAME value —
   *  never a re-derivation. */
  wrapWidth: number;
  /** M-IMAGES-2.1: the bitmap resolver (media/bitmapCache) — the
   *  inline paint's LAST seam (M-IMAGES-2 shipped it undefined: the
   *  gray placeholder fired unconditionally). Absent → placeholder. */
  resolveBitmap?: (sha: string) => HTMLImageElement | undefined;
  /** M-IMAGES-2.2: terminal-failure probe (the failed box vs the
   *  pending tint). */
  bitmapFailed?: (sha: string) => boolean;
  /** M-IMAGES-2.1: bumps when ANY bitmap lands — rides boxKey so the
   *  inline paint repaints ONCE on arrival (the arrival law). */
  bitmapEpoch: number;
  /**
   * M-HEADER-FOOTER-2: MUTED ink — the INACTIVE band look (grayed
   * while the selection sits outside the band containers). Passed to
   * paintLines' extras; rides boxKey (a mute flip repaints, the
   * styleEpoch precedent).
   */
  muted?: boolean;
  /**
   * M-REFS: the reference-table FIELD BORDER's selection fact — true
   * only while the caret sits inside this container (PaginatedView
   * computes it per selection projection). Rides boxKey: entering/
   * leaving the table repaints the block once, the mute precedent.
   */
  referenceBorder?: boolean;
  /**
   * M-REFS-8: the container's sidecar entries (leaderLen per row) —
   * the PAINTER's leader tag: gap-filling dots drawn after each
   * row's refLeader span at the span's own measured style. Rides
   * boxKey via the paint hint's identity (the sidecar array changes
   * ⇒ the conversion changed ⇒ new lines anyway).
   */
  referenceEntries?: import('@/lib/paginated/adapter').ReferenceSidecarEntry[];
  /**
   * M-PAGEFIELD: the per-page field resolution — THIS page's 1-based
   * number and the document's total. Field runs draw the resolution
   * instead of the measured placeholder. Both props are stable per
   * canvas (the group is per page; the total rides the relayout).
   */
  pageNumber: number;
  pageTotal: number;
}

/**
 * The per-block-per-page paint surface. DPR-scaled canvas; one
 * fillText per LineSegment so bold/italic survive wrapping.
 *
 * DIRTY-BLOCK REPAINT, NO REBUILD PER KEYSTROKE: the
 * engine shares frozen LineBox objects zero-copy across layout calls,
 * so reference equality IS the dirty bit.
 *
 * DAMAGE-ONLY RASTER: on a single-block text edit, the
 * damage is from the first changed line to the end of the block's
 * fragment on this page (a re-wrap moves everything below). Only that
 * region is cleared and redrawn; identical lines above the edit keep
 * their pixels. Falls back to full repaint on canvas resize, first-line
 * edits, or style changes (the fallback cost = the old behavior).
 */
export const BlockCanvas = memo(function BlockCanvas({ lines, runs, text, metrics, left, top, width, align, runDecor, npc, paint, markerStyle, styleEpoch, showCaptions, wrapWidth, resolveBitmap, bitmapFailed, bitmapEpoch, muted, referenceBorder, referenceEntries, pageNumber, pageTotal }: BlockCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const prevLinesRef = useRef<readonly LineBox[] | null>(null);
  const prevTextRef = useRef('');
  const prevBoxRef = useRef('');

  const first = lines[0];
  const last = lines[lines.length - 1];
  const height = last.rect.y + last.rect.height - first.rect.y;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const decorKey = runDecor.map((d) => `${d.color}|${d.highlight}|${d.underline}|${d.strike}`).join(';');
    const paintKey = paint ? JSON.stringify(paint) : '';
    // M-REFS HARDENING (the stale-ink class-killer): the key carries a
    // CONTENT FINGERPRINT of the line set (count + first/last ranges),
    // not just object references — a line-set change forces the
    // repaint even when the engine handed back reused frozen
    // references, so the bitmap can never outlive the geometry it
    // was painted from (the reported "text gone from the model but
    // still painted / condensed into one line" class).
    const lineFingerprint = `${lines.length}:${lines[0]?.rangeStart ?? 0}-${lines[lines.length - 1]?.rangeEnd ?? 0}`;
    const boxKey = `${left}|${top}|${width}|${height}|${align}|${decorKey}|${npc === true ? 'npc' : ''}|${paintKey}|ep${styleEpoch}|cap${showCaptions ? '1' : '0'}|bmp${bitmapEpoch}|muted${muted ? '1' : '0'}|ln${lineFingerprint}|ref${referenceBorder ? '1' : '0'}`;
    // boxKey carries the registry epoch: ANY definition edit breaks
    // the boxKey comparison and forces the repaint below — even when
    // the engine spliced (same LineBox references, blocksWalked = 0)
    // and only paint-tier facts (decor color) changed. `height` rides
    // the key too (the full extent — a shrunk block with otherwise
    // identical facts must repaint or the old bitmap squishes behind
    // the smaller CSS size, the reported "2 lines condensed into 1").
    const unchanged =
      prevBoxRef.current === boxKey &&
      prevTextRef.current === text &&
      prevLinesRef.current !== null &&
      prevLinesRef.current.length === lines.length &&
      lines.every((l, i) => l === prevLinesRef.current![i]);
    // M-REFS-7 — THE GHOST DEBUG SEAM (definitive): logs EVERY effect
    // run INCLUDING the unchanged SKIPs (round 6's log missed skips —
    // an empty log with live typing means the EFFECT isn't running at
    // all, i.e. the relayout pipeline is dead, which is the ghost).
    const dbgAll = (globalThis as { __tensorPaintDebug?: { log: unknown[] } }).__tensorPaintDebug;
    if (dbgAll) {
      dbgAll.log.push({
        blockId: lines[0].blockId,
        decision: unchanged ? 'SKIP' : 'PAINT',
        textLen: text.length,
        nLines: lines.length,
        height,
      });
    }
    if (unchanged) return;
    const __w = globalThis as {
      __benchPaints?: { paints: Array<{ at: number; blockId: string; px2?: number }> };
    };
    (__w.__benchPaints ??= { paints: [] }).paints.push({ at: performance.now(), blockId: lines[0].blockId });

    const dpr = window.devicePixelRatio || 1;
    const newW = Math.max(1, Math.round(width * dpr));
    const newH = Math.max(1, Math.round(height * dpr));

    // DAMAGE-ONLY: if the canvas bitmap size and placement are unchanged,
    // and the text change starts beyond the first line, only clear and
    // redraw from the first changed line down.
    let damageFrom = 0;
    if (
      canvas.width === newW &&
      canvas.height === newH &&
      prevBoxRef.current === boxKey &&
      prevTextRef.current &&
      prevTextRef.current !== text
    ) {
      const oldText = prevTextRef.current;
      let firstDiff = 0;
      const common = Math.min(oldText.length, text.length);
      while (firstDiff < common && oldText[firstDiff] === text[firstDiff]) firstDiff++;
      damageFrom = lines.findIndex((l) => firstDiff < l.rangeEnd);
      if (damageFrom < 0) damageFrom = 0;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // (The PAINT decisions log above; the boxKey rode the round-6 log.)

    try {
      if (damageFrom > 0) {
        // Damage-only: clear from the first changed line's top to the
        // canvas bottom, redraw those lines (same coordinate space).
        const damageTop = lines[damageFrom].rect.y - first.rect.y;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, damageTop, width, height - damageTop);
        paintLines(ctx, lines.slice(damageFrom), runs, text, first.rect.y, metrics, { align, contentWidth: width, runDecor, npc, paint, markerStyle, showCaptions, objectMaxWidth: wrapWidth, resolveBitmap, bitmapFailed, muted, referenceBorder, referenceEntries, fieldPage: { number: pageNumber, total: pageTotal } });
        // Receipt: px² actually rasterized (cleared + repainted region).
        __w.__benchPaints!.paints[__w.__benchPaints!.paints.length - 1].px2 = width * (height - damageTop);
      } else {
        // Full repaint (canvas resize, edit at line 0, style change, or
        // initial mount) — same as the previous behavior.
        canvas.width = newW;
        canvas.height = newH;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        paintLines(ctx, lines, runs, text, first.rect.y, metrics, { align, contentWidth: width, runDecor, npc, paint, markerStyle, showCaptions, objectMaxWidth: wrapWidth, resolveBitmap, bitmapFailed, muted, referenceBorder, referenceEntries, fieldPage: { number: pageNumber, total: pageTotal } });
        // Receipt: full canvas.
        __w.__benchPaints!.paints[__w.__benchPaints!.paints.length - 1].px2 = width * height;
      }
    } catch (err) {
      // THE STALE-INK GUARD (the reported ghost class): a thrown paint
      // must NEVER leave a half-cleared bitmap behind refs that make
      // the next render SKIP — that is exactly "the model moved on but
      // the canvas still shows the old text until the next keystroke".
      // One full-repaint retry IN THE SAME FRAME (a transient resolver
      // race is the plausible cause); if even that fails, reset the
      // refs so the next render repaints fully. Loud either way.
      console.error('[BlockCanvas] paint failed — retrying full repaint', err);
      try {
        canvas.width = newW;
        canvas.height = newH;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        paintLines(ctx, lines, runs, text, first.rect.y, metrics, { align, contentWidth: width, runDecor, npc, paint, markerStyle, showCaptions, objectMaxWidth: wrapWidth, resolveBitmap, bitmapFailed, muted, referenceBorder, referenceEntries, fieldPage: { number: pageNumber, total: pageTotal } });
      } catch (retryErr) {
        console.error('[BlockCanvas] repaint retry failed — full repaint armed for next render', retryErr);
        prevLinesRef.current = null;
        prevTextRef.current = '';
        prevBoxRef.current = '';
        return;
      }
    }

    prevLinesRef.current = lines;
    prevTextRef.current = text;
    prevBoxRef.current = boxKey;
  // showCaptions + wrapWidth + bitmapEpoch ride the repaint KEY —
  // each flips the paint when it changes (the arrival repaint).
  // M-PAGEFIELD: pageNumber/pageTotal ride too — a virtualized canvas
  // can be REUSED across pages (the per-page group's identity is the
  // block, not the page), and a total change re-measures the fields.
  }, [lines, runs, text, metrics, left, top, width, height, first.rect.y, align, runDecor, npc, paint, markerStyle, styleEpoch, showCaptions, wrapWidth, resolveBitmap, bitmapFailed, bitmapEpoch, muted, referenceBorder, referenceEntries, pageNumber, pageTotal]);

  return (
    <canvas
      ref={canvasRef}
      data-block-id={lines[0].blockId}
      // M-HEADER-FOOTER-2: band canvases carry their band identity (test
      // surface + future per-band ink routing).
      data-band={lines[0].band}
      role="presentation"
      className="absolute"
      style={{ left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` }}
    />
  );
});