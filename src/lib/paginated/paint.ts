import type { LayoutResult, LineBox, Run, TextMetrics, TextStyle } from '@tensor-editor/engine';
import type { BlockPaint, RunDecor, TextAlign } from './adapter';
import { applyVariantCaps, fontString } from './metrics';
import { bulletMarkerText, orderedMarkerText } from '@/lib/print/markers';
import { alignOffset, fieldShiftBefore } from './positionMap';
import { fitDownImage } from '@tensor-editor/engine';
import { FAILED_HATCH, FAILED_TINT, PENDING_TINT } from '@/lib/media/bitmapCache';

/**
 * Painting LineBox[] onto a per-block-per-page canvas. L1: the shell
 * paints, never computes — coordinates come from the engine's
 * positioned facts; the only measurements are glyph advances through
 * the SAME metrics instance the engine measured with.
 *
 * BLOCK DECOR (paint-only — the engine ignores the hints):
 * backgrounds and borders draw per line so fragments tile seamlessly
 * across pages; list markers draw on the block's first line only, in
 * the indent gutter [indent − 32, indent).
 */

const DEFAULT_TEXT_COLOR = '#000';

/** Muted ink for non-printing-character glyphs (canvas has no theme). */
const NPC_COLOR = 'rgba(0, 0, 0, 0.45)';

/** Block-decor constants (canvas has no theme access — pageless-look
 * approximations of the prose classes). */
const QUOTE_BORDER_COLOR = '#d4d4d8';
const QUOTE_BG_COLOR = 'rgba(0, 0, 0, 0.04)';
const CODE_BG_COLOR = '#f4f4f5';
/** The field border — concrete hex (canvas cannot resolve theme
 * variables). */
const REF_BORDER_COLOR = '#d4d4d8';
const RULE_COLOR = '#a1a1aa';
const LIST_INDENT_PX = 32;

/** Muted ink for inactive band text (canvas has no theme). */
const MUTED_TEXT_COLOR = 'rgba(0, 0, 0, 0.55)';

/**
 * The DESATURATE ruling: an inactive band's ink keeps its LUMA and
 * loses its HUE (grayscale at 55% opacity), never a flat gray — a
 * colored header stays recognizable as the author's choice.
 * Unparseable colors fall back to the flat gray.
 */
export function mutedColorOf(color: string | undefined): string {
  if (!color) return MUTED_TEXT_COLOR;
  const hex = color.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(hex)) return MUTED_TEXT_COLOR;
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  // Rec.601 luma — the classic grayscale weightings.
  const luma = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  return `rgba(${luma}, ${luma}, ${luma}, 0.55)`;
}

export interface PaintExtras {
  align: TextAlign;
  contentWidth: number;
  /**
   * #74 — the group's COLUMN frame (content-box-relative): the decor
   * surfaces span the COLUMN, not the content box. Absent ≡ the
   * content box (single-column — bit-identical).
   */
  columnLeft?: number;
  runDecor: readonly RunDecor[];
  /**
   * NON-PRINTING CHARACTERS (paint-only): ¶ at every block end,
   * middle-dot for nbsp, arrow for tabs. OFF unless explicitly set —
   * no print/export path passes it. Glyph substitution is INK only:
   * x still advances by the MEASURED widths, so painted positions
   * never move.
   */
  npc?: boolean;
  /** Block paint hints (adapter BlockPaint): list marker, blockquote
   * border/tint, rule line. Absent = plain block, nothing extra. */
  paint?: BlockPaint;
  /**
   * The reference-table FIELD BORDER is selection-driven:
   * paint.reference is the KIND fact, this the SELECTION fact — the
   * border paints only when BOTH hold.
   */
  referenceBorder?: boolean;
  /**
   * The leader-ink tag (leaderLen per row): for each leader row,
   * extra dots draw after the refLeader span — at the span's OWN
   * measured style — up to the page number. Pure ink: the
   * block-text contract holds.
   */
  referenceEntries?: import('@/lib/paginated/adapter').ReferenceSidecarEntry[];
  /**
   * The per-page field resolution: THIS page's 1-based number + the
   * document's total. A fieldKind segment draws the resolved text
   * instead of the measured placeholder. Absent = no fields.
   */
  fieldPage?: { number: number; total: number };
  /** The marker's font — resolved by the caller from the block's first
   *  run, falling back to the document default for empty items
   *  ("style from the block's runs"). */
  markerStyle?: TextStyle;
  /** Caption display toggle — false = skip this block's text ink
   *  entirely (the space stays). */
  showCaptions?: boolean;
  /** The block's BASE wrap width — the inline-object clamp's input;
   *  the paint clamp calls the same fitDownImage on the same value. */
  objectMaxWidth?: number;
  /** Resolve a decoded bitmap for an inline image's sha; absent → the
   *  tinted placeholder, terminal failure → the failed box. */
  resolveBitmap?: (sha: string) => HTMLImageElement | undefined;
  /**
   * MUTED ink — the inactive header/footer band look: text ink takes
   * MUTED_TEXT_COLOR over decor color; the user's own highlight and
   * underline stay.
   */
  muted?: boolean;
  /** Terminal-failure probe for the placeholder split (pending tint
   *  vs failed box). */
  bitmapFailed?: (sha: string) => boolean;
}

/** Paint-only glyph substitution: nbsp → middle-dot, tab → arrow. */
function npcSubstitute(s: string): string {
  return s.replace(/\u00A0/g, '·').replace(/\t/g, '→');
}


export function paintLines(
  ctx: CanvasRenderingContext2D,
  lines: readonly LineBox[],
  runs: readonly Run[],
  text: string,
  minY: number,
  metrics: TextMetrics,
  extras: PaintExtras
): void {
  const align = extras.align;
  const contentWidth = extras.contentWidth;
  // #74 — the COLUMN frame: the decor surfaces and the align container
  // are the column's (left defaults to 0 = the content box's left).
  const columnLeft = extras.columnLeft ?? 0;
  const columnWidth = contentWidth;
  const runDecor = extras.runDecor;
  const npc = extras.npc === true;
  const paint = extras.paint;
  // Caption blocks with the display toggle OFF paint nothing.
  if (paint?.caption && extras.showCaptions === false) return;
  const markerStyle = extras.markerStyle;

  // The FIELD BORDER: one light gray rounded box around the block's
  // per-page fragment, pure ink. The canvas-local law: BlockCanvas's
  // bitmap spans exactly the block's line extent — outside coordinates
  // clip to nothing, so the box hugs the inside edge, 0.5px in. Full
  // extent only (a mid-block slice would be garbage); selection-driven
  // (the caret must sit inside).
  if (paint?.reference && extras.referenceBorder && lines.length > 0 && lines[0].rect.y === minY) {
    let bottom = -Infinity;
    for (const line of lines) {
      bottom = Math.max(bottom, line.rect.y + line.rect.height - minY);
    }
    const prevStroke = ctx.strokeStyle;
    const prevWidth = ctx.lineWidth;
    ctx.strokeStyle = REF_BORDER_COLOR;
    ctx.lineWidth = 1;
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(columnLeft + 0.5, 0.5, columnWidth - 1, bottom - 0.5, 4);
      ctx.stroke();
    } else {
      ctx.strokeRect(columnLeft + 0.5, 0.5, columnWidth - 1, bottom - 0.5);
    }
    ctx.strokeStyle = prevStroke;
    ctx.lineWidth = prevWidth;
  }

  for (const line of lines) {
    // #74 — the align container is the COLUMN's (a centered block
    // centers on its column, Word's ruling the engine already keeps).
    const off = alignOffset(align, line.rect.width, columnLeft + columnWidth - line.rect.x);
    const baselineY = line.rect.y - minY + line.baseline;
    const baseX = line.rect.x + off;

    // BLOCK DECOR (before ink, per line); tints span the COLUMN.
    if (paint?.blockquote) {
      const prev = ctx.fillStyle;
      ctx.fillStyle = QUOTE_BG_COLOR;
      ctx.fillRect(columnLeft, line.rect.y - minY, columnWidth, line.rect.height);
      ctx.fillStyle = QUOTE_BORDER_COLOR;
      ctx.fillRect(columnLeft + 4, line.rect.y - minY, 3, line.rect.height);
      ctx.fillStyle = prev;
    }
    if (paint?.code) {
      const prev = ctx.fillStyle;
      ctx.fillStyle = CODE_BG_COLOR;
      ctx.fillRect(columnLeft, line.rect.y - minY, columnWidth, line.rect.height);
      ctx.fillStyle = prev;
    }
    // THE LEADER INK (gap-filling dots): for a leader row, the
    // refLeader span's own text paints via the segment loop below
    // (real text, the user's style); the remaining gap to the page
    // number fills with extra dots at the span's own measured style.
    // No number (unresolved) ⇒ no extra dots.
    if (paint?.reference && extras.referenceEntries && line.segments.length > 1) {
      const segText = (s: (typeof line.segments)[number]) => text.slice(s.start, s.end);
      const tabIdx = line.segments.findIndex((s) => segText(s) === '\t');
      if (tabIdx > 0) {
        // The row containing this line (sidecar tiles the block text).
        const row = extras.referenceEntries.find(
          (e) => line.rangeStart >= e.textStart && line.rangeStart < e.textStart + e.textLen
        );
        const numberSeg = line.segments
          .slice(tabIdx + 1)
          .find((s) => segText(s) !== '' && segText(s) !== '\t');
        if (row && row.leaderLen > 0 && numberSeg) {
          // The leader span's LAST segment (its text ends at the tab).
          const leaderSeg = line.segments[tabIdx - 1]!;
          const leaderRun = runs[leaderSeg.runIndex];
          if (leaderRun && leaderRun.kind !== 'inlineImage') {
            const style = leaderRun.style;
            const dotW = metrics.measure('.', style);
            if (dotW > 0) {
              // NO PADS (round 9 — the user's "one visible space"
              // report): the fill dots start EXACTLY at the seed's
              // last glyph and stop at the number's first — the seam
              // between the real text and the fill ink is invisible.
              const gapStart = baseX + leaderSeg.x + metrics.measure(segText(leaderSeg), style);
              const gapEnd = baseX + numberSeg.x;
              const gap = gapEnd - gapStart;
              const n = Math.max(0, Math.min(Math.floor(gap / dotW), 500));
              if (n > 0) {
                // Paint n dots as ONE string at the span's style — the
                // same font derivation the segment loop uses
                // (fontString of the run's resolved style), and the
                // run's own ink color (runDecor; default black).
                const decor = runDecor[leaderSeg.runIndex] ?? {};
                const prevFont = ctx.font;
                const prevFill = ctx.fillStyle;
                ctx.font = fontString(style);
                ctx.fillStyle = decor.color ?? '#000000';
                ctx.fillText('.'.repeat(n), gapStart, baselineY);
                ctx.fillStyle = prevFill;
                ctx.font = prevFont;
              }
            }
          }
        }
      }
    }

    for (let si = 0; si < line.segments.length; si++) {
      const segment = line.segments[si]!;
      const run = runs[segment.runIndex];
      if (!run) continue;
      // Each segment's x is the ENGINE's placed pen, never accumulated
      // — prefix sums cannot model tab advances.
      const x = baseX + segment.x;
      // The per-page resolution + ink shift: the field's segment text
      // is the measured placeholder; the drawn text is THIS page's
      // resolution, left-anchored, and every following segment shifts
      // by the accumulated slack (fieldShiftBefore — the same
      // derivation the caret/selection/hit consume).
      const shift = fieldShiftBefore(line, { runs, text } as never, metrics, si);
      const fieldResolved =
        run.kind !== 'inlineImage' && run.fieldKind && extras.fieldPage
          ? run.fieldKind === 'pages'
            ? String(extras.fieldPage.total)
            : String(extras.fieldPage.number)
          : null;
      // INLINE OBJECTS: the U+FFFC token paints as the image,
      // baseline-seated; the clamp is the engine's OWN fitDownImage on
      // the same base wrap width; the x advance is the clamped width —
      // exactly what the engine measured.
      if (run.kind === 'inlineImage') {
        const dims = fitDownImage(
          run.width,
          run.height,
          extras.objectMaxWidth ?? contentWidth,
          Infinity
        );
        const sha = run.src.startsWith('media://') ? run.src.slice('media://'.length) : null;
        const bitmap = sha != null ? extras.resolveBitmap?.(sha) : undefined;
        if (bitmap) {
          ctx.drawImage(bitmap, x - shift, baselineY - dims.height, dims.width, dims.height);
        } else if (sha != null && (extras.bitmapFailed?.(sha) ?? false)) {
          // TERMINAL failure: darker tint + cross-hatch.
          // save/restore keeps the hatch's stroke state off the text.
          ctx.save();
          ctx.fillStyle = FAILED_TINT;
          ctx.fillRect(x - shift, baselineY - dims.height, dims.width, dims.height);
          ctx.strokeStyle = FAILED_HATCH;
          ctx.beginPath();
          ctx.moveTo(x - shift, baselineY - dims.height);
          ctx.lineTo(x - shift + dims.width, baselineY);
          ctx.moveTo(x - shift + dims.width, baselineY - dims.height);
          ctx.lineTo(x - shift, baselineY);
          ctx.stroke();
          ctx.restore();
        } else {
          // The PENDING tint (a load is in flight or the media is
          // unresolved) — identical geometry to the future bitmap.
          const prevFill = ctx.fillStyle;
          ctx.fillStyle = PENDING_TINT;
          ctx.fillRect(x - shift, baselineY - dims.height, dims.width, dims.height);
          ctx.fillStyle = prevFill;
        }
        continue;
      }
      const decor = runDecor[segment.runIndex] ?? {};
      const segmentText = text.slice(segment.start, segment.end);
      // A tab paints NOTHING (its advance is the jump the next
      // segment's x already carries) — except under NPC, where the
      // substitute arrow marks the jump's start.
      const isTab = segmentText === '\t';
      if (isTab && !npc) continue;
      const paintText = npc ? npcSubstitute(segmentText) : segmentText;
      const width = metrics.measure(isTab ? npcSubstitute(segmentText) : segmentText, run.style);
      let drawX = x - shift;
      let paintWidth = width;
      let drawn = fieldResolved ?? paintText;
      if (fieldResolved != null) {
        // The number draws at the SHIFTED slot start (drawX above),
        // its width the RESOLVED digits. The shift rule holds for
        // everything after the FIRST field — later fields included:
        // '3 of 10' shifts the '10' flush against the ' of '.
        paintWidth = metrics.measure(fieldResolved, run.style);
      }

      if (decor.highlight) {
        const ascent = metrics.ascent(run.style);
        const descent = metrics.descent(run.style);
        ctx.fillStyle = decor.highlight;
        ctx.fillRect(drawX, baselineY - ascent, paintWidth, ascent + descent);
      }

      // Muted band ink DESATURATES the run's own color (luma kept,
      // hue dropped) — never flat gray.
      ctx.fillStyle = extras.muted
        ? mutedColorOf(decor.color ?? DEFAULT_TEXT_COLOR)
        : decor.color ?? DEFAULT_TEXT_COLOR;
      ctx.font = fontString(run.style);
      // The same applyVariantCaps the metrics singleton measured
      // with — painted advances never diverge from measured widths.
      applyVariantCaps(ctx, run.style);
      ctx.fillText(drawn, drawX, baselineY);

      // Underline/strike metrics are typographic-fraction
      // approximations; proper per-font metrics are future polish.
      // Decorations desaturate with the text.
      const decorationColor = extras.muted
        ? mutedColorOf(decor.color ?? DEFAULT_TEXT_COLOR)
        : decor.color ?? DEFAULT_TEXT_COLOR;
      if (decor.underline || decor.strike) {
        const thickness = Math.max(1, Math.round(run.style.fontSize / 16));
        ctx.fillStyle = decorationColor;
        if (decor.underline) {
          ctx.fillRect(drawX, baselineY + 0.08 * run.style.fontSize, paintWidth, thickness);
        }
        if (decor.strike) {
          ctx.fillRect(drawX, baselineY - 0.3 * run.style.fontSize, paintWidth, thickness);
        }
      }
    }

    // LIST MARKER (the block's first line only — the indent gutter
    // [indent − 32, indent) belongs to the item this block projects).
    // Bullets left-aligned in the gutter; ordered numbers right-aligned
    // into the indent. Style from the block's runs (markerStyle).
    const marker = paint?.marker;
    if (marker && markerStyle && line.lineIndex === 0) {
      const indent = line.rect.x;
      const markerText =
        marker.kind === 'bullet'
          ? bulletMarkerText(marker.styleType)
          : orderedMarkerText(marker.index, marker.styleType);
      const prevFill = ctx.fillStyle;
      const prevFont = ctx.font;
      ctx.font = fontString(markerStyle);
      ctx.fillStyle = DEFAULT_TEXT_COLOR;
      const w = metrics.measure(markerText, markerStyle);
      const markerX =
        marker.kind === 'bullet'
          ? indent - LIST_INDENT_PX + 1
          : indent - 2 - w;
      ctx.fillText(markerText, markerX, baselineY);
      ctx.fillStyle = prevFill;
      ctx.font = prevFont;
    }

    // RULE LINE (horizontalRule, projected as a single-line paragraph):
    // a 1px rule across the (indent-narrowed) content width, drawn at
    // the vertical middle of the line's text band.
    if (paint?.rule) {
      const prev = ctx.fillStyle;
      ctx.fillStyle = RULE_COLOR;
      const ruleY = Math.round(line.rect.y - minY + line.baseline * 0.55);
      // #74 — the rule spans to the COLUMN's right edge.
      ctx.fillRect(line.rect.x, ruleY, columnLeft + columnWidth - line.rect.x, 1);
      ctx.fillStyle = prev;
    }

    // Block-end pilcrow: only the line whose range ends at the
    // block's text end; a split block's earlier fragments stay bare.
    // The glyph renders in the block's PLAIN style — bold/italic
    // stripped (a bold paragraph's ¶ is not bold). Hard-break glyphs
    // have no paginated model (the adapter's sentinel hands such docs
    // to pageless).
    if (npc && line.rangeEnd === text.length) {
      const restore = ctx.fillStyle;
      const restoreFont = ctx.font;
      if (markerStyle) {
        ctx.font = fontString({
          fontFamily: markerStyle.fontFamily,
          fontSize: markerStyle.fontSize,
        });
      }
      ctx.fillStyle = NPC_COLOR;
      // The line-end pen: segments carry their own placed x.
      ctx.fillText('¶', baseX + line.rect.width, baselineY);
      ctx.fillStyle = restore;
      ctx.font = restoreFont;
    }
  }
}

/**
 * Dev-only contiguity assertion: each page's flow items, in y order,
 * must tile the content box with no seams (the walk machine guarantees
 * it; this is the tripwire). The flow track is lines[] + NON-FLOATED
 * placed[] MERGED — an image consumes flow through its synthetic line
 * but emits only its PlacedRect; floats are excluded (zero flow
 * presence); table cell LINES are parallel lanes inside their band
 * (skipped — the tableCell rects carry the flow accounting).
 */
export function assertContiguity(result: LayoutResult): void {
  if (!import.meta.env.DEV) return;
  for (let p = 0; p < result.pages.length; p++) {
    // #74 COLUMNS — the flow track is PER COLUMN: each of the page's
    // column lanes tiles y=0 → h independently (parallel lanes share
    // ys by design, exactly like table-cell lanes). The lane key: the
    // record's column index (absent ≡ 0 — the single-lane page).
    const tracks = new Map<number, { y: number; h: number; what: string }[]>();
    const push = (col: number, item: { y: number; h: number; what: string }) => {
      let track = tracks.get(col);
      if (!track) {
        track = [];
        tracks.set(col, track);
      }
      track.push(item);
    };
    for (const line of result.lines) {
      if (line.pageIndex !== p) continue;
      // Table cell lines: lane content inside their band.
      if (line.tableCell) continue;
      // Band lines sit in the MARGIN strips — never flow-track
      // content.
      if (line.band) continue;
      push(line.column ?? 0, { y: line.rect.y, h: line.rect.height, what: `line(block ${line.blockId})` });
    }
    for (const pr of result.placed) {
      if (pr.pageIndex !== p || pr.z != null) continue;
      push(pr.column ?? 0, { y: pr.rect.y, h: pr.rect.height, what: `placed(${pr.blockId})` });
    }
    for (const [col, items] of tracks) {
      items.sort((a, b) => a.y - b.y);
      let expectedY = 0;
      for (const it of items) {
        if (it.y !== expectedY) {
          console.error(
            `[paginated] contiguity violated on page ${p} column ${col}: ${it.what} y=${it.y}, expected ${expectedY}`
          );
        }
        expectedY = it.y + it.h;
      }
    }
  }
}
