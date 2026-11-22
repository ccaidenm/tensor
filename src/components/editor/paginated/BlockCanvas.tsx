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
   * paint-only decor, identity-stable per adapter conversion. */
  paint?: BlockPaint;
  /** Marker font: the block's first run style, else the document
   * default ("style from the block's runs"). */
  markerStyle?: TextStyle;
  /**
   * REGISTRY EPOCH — the repaint key's third leg. A style property edit
   * changes no layout fact: the engine hands back the SAME frozen
   * LineBox references, so the identity test below would skip the
   * repaint and the new color would stay invisible. Any definition edit
   * bumps the epoch and repaints every block once.
   */
  styleEpoch: number;
  /** Caption DISPLAY toggle — false skips the caption blocks' text ink
   *  (layout is engine-owned and stays untouched — presentation-only). */
  showCaptions: boolean;
  /** The block's BASE wrap width (contentBox.width − indents) — the
   *  engine's breakLines maxWidth, and the object clamp's input. The
   *  inline paint clamp uses the SAME fitDownImage primitive on the
   *  SAME value — never a re-derivation. #74 — under columns this is
   *  the COLUMN's base wrap. */
  wrapWidth: number;
  /**
   * #74 — the group's COLUMN frame (content-box-relative): the decor
   * surfaces (blockquote/code tints, the reference border, the rule
   * line) and the align container span the COLUMN. Absent ≡ the
   * content box (single-column — bit-identical paint). The group is
   * per-column (PaginatedView keys blockId+column).
   */
  columnFrame?: { left: number; width: number };
  /** The bitmap resolver (media/bitmapCache). Absent → placeholder. */
  resolveBitmap?: (sha: string) => HTMLImageElement | undefined;
  /** Terminal-failure probe (the failed box vs the
   *  pending tint). */
  bitmapFailed?: (sha: string) => boolean;
  /** Bumps when ANY bitmap lands — rides boxKey so the
   *  inline paint repaints ONCE on arrival. */
  bitmapEpoch: number;
  /**
   * MUTED ink — the INACTIVE band look (grayed while the selection
   * sits outside the band containers). Passed to paintLines' extras;
   * rides boxKey (a mute flip repaints).
   */
  muted?: boolean;
  /**
   * The reference-table FIELD BORDER's selection fact — true
   * only while the caret sits inside this container (PaginatedView
   * computes it per selection projection). Rides boxKey: entering/
   * leaving the table repaints the block once.
   */
  referenceBorder?: boolean;
  /**
   * The container's sidecar entries (leaderLen per row) — the
   * PAINTER's leader tag: gap-filling dots drawn after each
   * row's refLeader span at the span's own measured style. Rides
   * boxKey via the paint hint's identity (the sidecar array changes
   * ⇒ the conversion changed ⇒ new lines anyway).
   */
  referenceEntries?: import('@/lib/paginated/adapter').ReferenceSidecarEntry[];
  /**
   * The per-page field resolution — THIS page's 1-based
   * number and the document's total. Field runs draw the resolution
   * instead of the measured placeholder. Both props are stable per
   * canvas (the total rides the relayout).
   */
  pageNumber: number;
  pageTotal: number;
}

/**
 * The per-block-per-page paint surface: DPR-scaled canvas, one
 * fillText per LineSegment (bold/italic survive wrapping). The engine
 * shares frozen LineBox objects zero-copy across layout calls, so
 * reference equality IS the dirty bit. DAMAGE-ONLY RASTER: a text edit
 * clears/redraws only from the first changed line down; full repaint
 * on resize, first-line edits, or style changes.
 */
export const BlockCanvas = memo(function BlockCanvas({ lines, runs, text, metrics, left, top, width, align, runDecor, npc, paint, markerStyle, styleEpoch, showCaptions, wrapWidth, columnFrame, resolveBitmap, bitmapFailed, bitmapEpoch, muted, referenceBorder, referenceEntries, pageNumber, pageTotal }: BlockCanvasProps) {
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
    // STALE-INK HARDENING: the key carries a CONTENT FINGERPRINT of the
    // line set (count + first/last ranges), not just references — a
    // line-set change forces the repaint even when the engine reused
    // frozen references, so the bitmap never outlives its geometry.
    const lineFingerprint = `${lines.length}:${lines[0]?.rangeStart ?? 0}-${lines[lines.length - 1]?.rangeEnd ?? 0}`;
    const boxKey = `${left}|${top}|${width}|${height}|${align}|${decorKey}|${npc === true ? 'npc' : ''}|${paintKey}|ep${styleEpoch}|cap${showCaptions ? '1' : '0'}|bmp${bitmapEpoch}|muted${muted ? '1' : '0'}|ln${lineFingerprint}|ref${referenceBorder ? '1' : '0'}`;
    // boxKey carries the registry epoch (any definition edit forces the
    // repaint, even a spliced same-references change) and `height` (a
    // shrunk block must repaint or the old bitmap squishes behind the
    // smaller CSS size).
    const unchanged =
      prevBoxRef.current === boxKey &&
      prevTextRef.current === text &&
      prevLinesRef.current !== null &&
      prevLinesRef.current.length === lines.length &&
      lines.every((l, i) => l === prevLinesRef.current![i]);
    // THE GHOST DEBUG SEAM: logs EVERY effect run INCLUDING the
    // unchanged SKIPs — an empty log with live typing means the effect
    // isn't running at all (the relayout pipeline is dead).
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

    try {
      if (damageFrom > 0) {
        // Damage-only: clear from the first changed line's top to the
        // canvas bottom, redraw those lines (same coordinate space).
        const damageTop = lines[damageFrom].rect.y - first.rect.y;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, damageTop, width, height - damageTop);
        paintLines(ctx, lines.slice(damageFrom), runs, text, first.rect.y, metrics, { align, contentWidth: columnFrame ? columnFrame.width : width, columnLeft: columnFrame?.left, runDecor, npc, paint, markerStyle, showCaptions, objectMaxWidth: wrapWidth, resolveBitmap, bitmapFailed, muted, referenceBorder, referenceEntries, fieldPage: { number: pageNumber, total: pageTotal } });
        // Receipt: px² actually rasterized (cleared + repainted region).
        __w.__benchPaints!.paints[__w.__benchPaints!.paints.length - 1].px2 = width * (height - damageTop);
      } else {
        // Full repaint (canvas resize, edit at line 0, style change, or
        // initial mount).
        canvas.width = newW;
        canvas.height = newH;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        paintLines(ctx, lines, runs, text, first.rect.y, metrics, { align, contentWidth: columnFrame ? columnFrame.width : width, columnLeft: columnFrame?.left, runDecor, npc, paint, markerStyle, showCaptions, objectMaxWidth: wrapWidth, resolveBitmap, bitmapFailed, muted, referenceBorder, referenceEntries, fieldPage: { number: pageNumber, total: pageTotal } });
        // Receipt: full canvas.
        __w.__benchPaints!.paints[__w.__benchPaints!.paints.length - 1].px2 = width * height;
      }
    } catch (err) {
      // THE STALE-INK GUARD: a thrown paint must NEVER leave a
      // half-cleared bitmap behind refs that make the next render SKIP
      // (stale ink until the next keystroke). One full-repaint retry in
      // the same frame; if even that fails, reset the refs so the next
      // render repaints fully.
      console.error('[BlockCanvas] paint failed — retrying full repaint', err);
      try {
        canvas.width = newW;
        canvas.height = newH;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        paintLines(ctx, lines, runs, text, first.rect.y, metrics, { align, contentWidth: columnFrame ? columnFrame.width : width, columnLeft: columnFrame?.left, runDecor, npc, paint, markerStyle, showCaptions, objectMaxWidth: wrapWidth, resolveBitmap, bitmapFailed, muted, referenceBorder, referenceEntries, fieldPage: { number: pageNumber, total: pageTotal } });
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
  // each flips the paint when it changes. pageNumber/pageTotal ride
  // too: a virtualized canvas can be REUSED across pages (the group's
  // identity is the block, not the page), and a total change
  // re-measures the fields.
  }, [lines, runs, text, metrics, left, top, width, height, first.rect.y, align, runDecor, npc, paint, markerStyle, styleEpoch, showCaptions, wrapWidth, columnFrame, resolveBitmap, bitmapFailed, bitmapEpoch, muted, referenceBorder, referenceEntries, pageNumber, pageTotal]);

  return (
    <canvas
      ref={canvasRef}
      data-block-id={lines[0].blockId}
      // Band canvases carry their band identity (test surface).
      data-band={lines[0].band}
      role="presentation"
      className="absolute"
      style={{ left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` }}
    />
  );
});