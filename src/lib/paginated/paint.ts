import type { LayoutResult, LineBox, Run, TextMetrics, TextStyle } from '@tensor-editor/engine';
import type { BlockPaint, RunDecor, TextAlign } from './adapter';
import { applyVariantCaps, fontString } from './metrics';
import { alignOffset } from './positionMap';
import { fitDownImage } from '@tensor-editor/engine';
import { FAILED_HATCH, FAILED_TINT, PENDING_TINT } from '@/lib/media/bitmapCache';

/**
 * Painting LineBox[] onto a per-block-per-page canvas.
 * L1: the shell paints, never computes — every coordinate here comes from
 * the engine's positioned facts (LineBox.rect/baseline/segments); nothing
 * is re-derived or re-measured except glyph advances, which go through
 * the SAME metrics instance the engine measured with (widths painted ==
 * widths measured, by construction).
 *
 * Text color, highlight, underline, and strike ride the segments'
 * run decor (adapter RunDecor); alignment rides the same shared
 * alignOffset the caret and hitTest use. ctx.font comes from the one
 * shared fontString (metrics.ts).
 *
 * BLOCK DECOR (M6.1, paint-only — the engine ignores the hints):
 * block backgrounds/borders/rule draw per line so fragments tile
 * seamlessly across pages; list markers draw on the block's first
 * line only (this canvas holds the block start iff lines[0].lineIndex
 * is 0), in the indent gutter [indent − 32, indent) — bullets
 * left-aligned in the gutter, ordered numbers right-aligned into it.
 */

const DEFAULT_TEXT_COLOR = '#000';

/** Muted ink for non-printing-character glyphs (canvas has no theme). */
const NPC_COLOR = 'rgba(0, 0, 0, 0.45)';

/** Block-decor constants (canvas has no theme access — pageless-look
 * approximations of the prose classes). */
const QUOTE_BORDER_COLOR = '#d4d4d8';
const QUOTE_BG_COLOR = 'rgba(0, 0, 0, 0.04)';
const CODE_BG_COLOR = '#f4f4f5';
/** M-REFS: the GDocs-style field border — light gray, 1px, rounded.
 * Concrete hex by law (canvas cannot resolve theme variables — the
 * hyperlink-seed ruling family). */
const REF_BORDER_COLOR = '#d4d4d8';
const RULE_COLOR = '#a1a1aa';
const LIST_INDENT_PX = 32;

/** M-HEADER-FOOTER-2: muted ink for INACTIVE band text (canvas has no
 * theme — the muted-foreground prose look's pageless-look
 * approximation, the NPC precedent's opacity family). */
const MUTED_TEXT_COLOR = 'rgba(0, 0, 0, 0.55)';

/**
 * M-HEADER-FOOTER-3 — the DESATURATE ruling: an inactive band's ink
 * keeps its LUMA and loses its HUE (grayscale at 55% opacity), never
 * a flat gray. A colored header stays recognizable as the author's
 * color choice; default black text desaturates to exactly the old
 * MUTED_TEXT_COLOR. (The debate's answer: flat gray erases author
 * intent — desaturation is honest "inactive" while preserving the
 * document's color identity.) Unparseable colors fall back to the
 * flat gray.
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
  runDecor: readonly RunDecor[];
  /**
   * NON-PRINTING CHARACTERS (M6, paint-only v1): ¶ at every block
   * end (from the block's text boundary — an empty block paints it at
   * the line start), middle-dot for non-breaking spaces, arrow for
   * tabs. OFF unless explicitly set: the on-screen painter passes the
   * user's config toggle (config.editor.showNonPrintingChars); NO
   * print/export path passes it (none exists today — .wpdoc export
   * serializes document JSON, never pixels). Glyph substitution is
   * INK only: x still advances by the MEASURED layout widths, so
   * painted positions never move. Hard breaks have no paginated model
   * (the adapter throws loudly and falls back to pageless, whose CSS
   * trick keeps showing them); list-marker glyphs are M6-proper scope.
   */
  npc?: boolean;
  /** Block paint hints (adapter BlockPaint): list marker, blockquote
   * border/tint, rule line. Absent = plain block, nothing extra. */
  paint?: BlockPaint;
  /**
   * M-REFS — the reference-table FIELD BORDER is SELECTION-DRIVEN (the
   * user's ruling: the gray outline shows only while the caret sits
   * inside the table). `paint.reference` is the KIND fact; this flag
   * is the SELECTION fact the shell computes per projection — the
   * border paints only when BOTH hold. Rides BlockCanvas's boxKey (a
   * flip repaints the block once).
   */
  referenceBorder?: boolean;
  /**
   * M-REFS-8 — the container's sidecar entries (leaderLen per row):
   * the LEADER INK's tag. For each line belonging to a leader row,
   * extra dots are drawn after the row's refLeader span — at the
   * SPAN'S OWN MEASURED STYLE (a smaller font ⇒ narrower dots ⇒ MORE
   * of them fill the same gap — the user's "always 100% of the gap,
   * responding to formatting" ruling) — up to the page number. Pure
   * ink: the block-text contract holds (the engine never rewrites
   * run text — the round-8 stretch revert).
   */
  referenceEntries?: import('@/lib/paginated/adapter').ReferenceSidecarEntry[];
  /** The marker's font — resolved by the caller from the block's first
   *  run, falling back to the document default for empty items
   *  ("style from the block's runs"). */
  markerStyle?: TextStyle;
  /** M-IMAGES-1: caption DISPLAY toggle — false = skip this block's
   *  text ink entirely (the space stays: presentation-only, the NPC
   *  precedent; the model and layout are untouched). */
  showCaptions?: boolean;
  /** M-IMAGES-2: the block's BASE wrap width — the inline-object
   *  clamp's input (the engine's breakLines maxWidth, layout.ts:392).
   *  The paint clamp calls the SAME fitDownImage primitive on the
   *  SAME value; dims are never re-derived. */
  objectMaxWidth?: number;
  /** M-IMAGES-2: resolve a decoded bitmap for an inline image's sha
   *  (media/bitmapCache). Absent bitmap → the tinted placeholder;
   *  TERMINAL failure (getBitmapFailed) → the failed box. */
  resolveBitmap?: (sha: string) => HTMLImageElement | undefined;
  /**
   * M-HEADER-FOOTER-2: MUTED ink — the INACTIVE header/footer band
   * look (grayed when not being edited). When true, text ink takes
   * MUTED_TEXT_COLOR over decor color (decor.highlight/underline stay:
   * they're the user's own content). Layout ink is untouched.
   */
  muted?: boolean;
  /** M-IMAGES-2.2: terminal-failure probe for the placeholder split
   *  (pending tint vs failed box) — same module as resolveBitmap. */
  bitmapFailed?: (sha: string) => boolean;
}

/** Paint-only glyph substitution: nbsp → middle-dot, tab → arrow. */
function npcSubstitute(s: string): string {
  return s.replace(/\u00A0/g, '·').replace(/\t/g, '→');
}

/** Ordered-number spelling per CSS list-style-type (the extensions'
 * value set — the M6.1 receipt). */
function orderedMarkerText(index: number, styleType: string): string {
  switch (styleType) {
    case 'lower-alpha':
      return `${toAlpha(index).toLowerCase()}.`;
    case 'upper-alpha':
      return `${toAlpha(index)}.`;
    case 'lower-roman':
      return `${toRoman(index).toLowerCase()}.`;
    case 'upper-roman':
      return `${toRoman(index)}.`;
    default:
      return `${index}.`;
  }
}

/** Bullet-glyph spelling per CSS list-style-type. */
function bulletMarkerText(styleType: string): string {
  switch (styleType) {
    case 'circle':
      return '○';
    case 'square':
      return '▪';
    default:
      return '•';
  }
}

function toAlpha(n: number): string {
  // 1-based spreadsheet spelling: 27 → AA.
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s || 'A';
}

function toRoman(n: number): string {
  const table: Array<[number, string]> = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
    [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let s = '';
  for (const [value, glyph] of table) {
    while (n >= value) {
      s += glyph;
      n -= value;
    }
  }
  return s || 'I';
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
  const runDecor = extras.runDecor;
  const npc = extras.npc === true;
  const paint = extras.paint;
  // M-IMAGES-1: caption blocks with the display toggle OFF paint
  // nothing — blank space, layout intact (display-only ink).
  if (paint?.caption && extras.showCaptions === false) return;
  const markerStyle = extras.markerStyle;

  // M-REFS — the FIELD BORDER (GDocs-style): one light gray rounded box
  // around the block's per-page fragment, pure ink behind the text. A
  // table fragmenting across pages gets one box per page. CANVAS-LOCAL
  // LAW: BlockCanvas's bitmap spans exactly [0, width] × [0, height]
  // of the block's line extent — coordinates outside that (the first
  // version's −6.5/−4 padding) CLIP to nothing, which is why the
  // border never showed (the reported bug). The box hugs the INSIDE
  // edge, 0.5px in for a crisp 1px stroke. FULL EXTENT ONLY: the
  // damage path passes a mid-block SLICE (lines starting below the
  // block's first line) — a box around a slice would be garbage; the
  // slice's cleared region doesn't touch the border pixels anyway.
  // SELECTION-DRIVEN: only while the caret sits inside (the
  // referenceBorder fact — the user's GDocs ruling).
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
      ctx.roundRect(0.5, 0.5, contentWidth - 1, bottom - 0.5, 4);
      ctx.stroke();
    } else {
      ctx.strokeRect(0.5, 0.5, contentWidth - 1, bottom - 0.5);
    }
    ctx.strokeStyle = prevStroke;
    ctx.lineWidth = prevWidth;
  }

  for (const line of lines) {
    const off = alignOffset(align, line.rect.width, contentWidth - line.rect.x);
    const baselineY = line.rect.y - minY + line.baseline;
    const baseX = line.rect.x + off;

    // BLOCK DECOR (before ink, per line — fragments tile seamlessly):
    if (paint?.blockquote) {
      const prev = ctx.fillStyle;
      ctx.fillStyle = QUOTE_BG_COLOR;
      ctx.fillRect(0, line.rect.y - minY, contentWidth, line.rect.height);
      ctx.fillStyle = QUOTE_BORDER_COLOR;
      ctx.fillRect(4, line.rect.y - minY, 3, line.rect.height);
      ctx.fillStyle = prev;
    }
    if (paint?.code) {
      const prev = ctx.fillStyle;
      ctx.fillStyle = CODE_BG_COLOR;
      ctx.fillRect(0, line.rect.y - minY, contentWidth, line.rect.height);
      ctx.fillStyle = prev;
    }
    // M-REFS-8 — THE LEADER INK (gap-filling dots): for a leader row
    // (sidecar leaderLen > 0), the refLeader span's own text paints
    // via the segment loop below (real text, the user's style); the
    // REMAINING gap to the page number is filled with EXTRA dots at
    // the span's own measured style — a smaller font ⇒ narrower dots
    // ⇒ MORE dots fill the same gap (the user's ruling: the leader is
    // always ~100% of the gap, responding to formatting). Pure ink:
    // found from the line's OWN placed segments (the span's last
    // segment = the one ending at the tab; the number = the first
    // non-empty segment after the tab). No number (unresolved) ⇒ no
    // extra dots (the seed stands alone).
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
    // M-REFS-5 — THE LEADER IS REAL TEXT NOW (round 5): the dots are a
    // real run in the entry (refLeader-marked, user-formattable,
    // normal ink) that the ENGINE stretches to fill the gap at the
    // run's own style — painted by the ordinary segment path below.
    // The old painted-leader ink (muted gray, unselectable) is GONE.

    for (const segment of line.segments) {
      const run = runs[segment.runIndex];
      if (!run) continue;
      // M-RULER Phase 4: each segment's x is the ENGINE's placed pen,
      // seeded per segment — never accumulated. Prefix sums cannot
      // model tab advances (a \t's jump is pen-dependent; center/right
      // stops reposition their text).
      const x = baseX + segment.x;
      // M-IMAGES-2 — INLINE OBJECTS (E-IMG-2): the U+FFFC token paints
      // as the image itself, BASELINE-SEATED (bottom at the baseline;
      // the engine grew the line's ascent for it — the shell fills the
      // engine's box, never computes one). The clamp is the engine's
      // OWN fitDownImage on the SAME base wrap width (never
      // re-derived); the x advance is the CLAMPED width — exactly the
      // advance the engine measured for the token.
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
          ctx.drawImage(bitmap, x, baselineY - dims.height, dims.width, dims.height);
        } else if (sha != null && (extras.bitmapFailed?.(sha) ?? false)) {
          // TERMINAL failure (M-IMAGES-2.2): darker tint + cross-hatch.
          // save/restore keeps the hatch's stroke state off the text.
          ctx.save();
          ctx.fillStyle = FAILED_TINT;
          ctx.fillRect(x, baselineY - dims.height, dims.width, dims.height);
          ctx.strokeStyle = FAILED_HATCH;
          ctx.beginPath();
          ctx.moveTo(x, baselineY - dims.height);
          ctx.lineTo(x + dims.width, baselineY);
          ctx.moveTo(x + dims.width, baselineY - dims.height);
          ctx.lineTo(x, baselineY);
          ctx.stroke();
          ctx.restore();
        } else {
          // The PENDING tint (a load is in flight or the media is
          // unresolved) — identical geometry to the future bitmap.
          const prevFill = ctx.fillStyle;
          ctx.fillStyle = PENDING_TINT;
          ctx.fillRect(x, baselineY - dims.height, dims.width, dims.height);
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

      if (decor.highlight) {
        const ascent = metrics.ascent(run.style);
        const descent = metrics.descent(run.style);
        ctx.fillStyle = decor.highlight;
        ctx.fillRect(x, baselineY - ascent, width, ascent + descent);
      }

      // M-HEADER-FOOTER-3: muted band ink DESATURATES the run's own
      // color (luma kept, hue dropped, 55% opacity) — never a flat
      // gray that erases the author's color choice.
      ctx.fillStyle = extras.muted
        ? mutedColorOf(decor.color ?? DEFAULT_TEXT_COLOR)
        : decor.color ?? DEFAULT_TEXT_COLOR;
      ctx.font = fontString(run.style);
      // SMALL-CAPS (M-STYLES): the same applyVariantCaps the metrics
      // singleton used to MEASURE this run — painted advances can
      // never diverge from measured widths (the one-ruler rule).
      applyVariantCaps(ctx, run.style);
      ctx.fillText(paintText, x, baselineY);

      // TODO(typographic polish): proper underline/strike metrics per
      // font (nskipping ink gaps, weight-scaled thickness) — the
      // typographic-fraction approximations below are the honest
      // starting point.
      // M-HEADER-FOOTER-3: decorations desaturate with the text (the
      // one muted-ink ruling, applied consistently).
      const decorationColor = extras.muted
        ? mutedColorOf(decor.color ?? DEFAULT_TEXT_COLOR)
        : decor.color ?? DEFAULT_TEXT_COLOR;
      if (decor.underline || decor.strike) {
        const thickness = Math.max(1, Math.round(run.style.fontSize / 16));
        ctx.fillStyle = decorationColor;
        if (decor.underline) {
          ctx.fillRect(x, baselineY + 0.08 * run.style.fontSize, width, thickness);
        }
        if (decor.strike) {
          ctx.fillRect(x, baselineY - 0.3 * run.style.fontSize, width, thickness);
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
      ctx.fillRect(line.rect.x, ruleY, contentWidth - line.rect.x, 1);
      ctx.fillStyle = prev;
    }

    // Block-end pilcrow, from the block boundary: only the line whose
    // range ends at the block's text end (an empty block's zero-length
    // range qualifies — its ¶ sits at the line start). A split block's
    // earlier fragments stay bare; the final one paints it. P1: the
    // glyph renders in the block's PLAIN style — bold/italic stripped
    // (a bold paragraph's ¶ is not bold), size/family from the block's
    // effective style (markerStyle; the P1 empty-textblock projection
    // guarantees a run even for empty blocks). Hard-break glyphs have
    // no paginated model (the adapter's sentinel hands such docs to
    // the pageless CSS trick) — noted for whenever the engine grows
    // an inline-break model.
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
      // The line-end pen: the loop's per-segment x's end at the placed
      // width (M-RULER Phase 4 — segments carry their own x).
      ctx.fillText('¶', baseX + line.rect.width, baselineY);
      ctx.fillStyle = restore;
      ctx.font = restoreFont;
    }
  }
}

/**
 * Dev-only contiguity assertion: the FLOW TRACK must tile the page
 * content box with no seams — each page's flow items, in y order, run
 * y=0, y+height, y+height+height... The walk machine guarantees this
 * by construction (the y cursor only resets at a page close); this
 * assert is the tripwire if that invariant ever breaks. Runs under
 * vitest too (import.meta.env.DEV is true there) — test (a) pins it.
 *
 * M-IMAGES-2.1 RECIPT — the flow track is lines[] + NON-FLOATED
 * placed[] MERGED: an image block consumes flow through its internal
 * synthetic "line" (getLines, layout.ts) but emits ONLY its PlacedRect
 * — lines[] alone have a y-gap exactly where an image sits (the false
 * "contiguity violated" this assert reported on every image doc,
 * pre-2.1). FLOATS are excluded: placeFloat has ZERO flow presence
 * (the anchor block's space is never reserved — floats may overlap
 * text by design; z is paint order).
 *
 * M-TABLES RECIPT — the flow track is BAND-wise where tables are
 * concerned. A table's cell LINES are parallel lanes INSIDE their band
 * (inset by the cell padding, shared y) — they are lane content, not
 * flow items, and are skipped. The tableCell rects ARE the bands'
 * flow representatives (each covers [bandTop, bandTop + bandHeight)
 * exactly — the walk's y advance per band) and participate in the
 * tiling like any placed[] item.
 */
export function assertContiguity(result: LayoutResult): void {
  if (!import.meta.env.DEV) return;
  for (let p = 0; p < result.pages.length; p++) {
    const items: { y: number; h: number; what: string }[] = [];
    for (const line of result.lines) {
      if (line.pageIndex !== p) continue;
      // Table cell lines: lane content inside their band — the band's
      // rects carry the flow accounting below.
      if (line.tableCell) continue;
      // M-HEADER-FOOTER-2: band lines sit in the MARGIN strips — never
      // flow-track content (the body track starts at the content box,
      // which the engine already inset by the band reservation).
      if (line.band) continue;
      items.push({ y: line.rect.y, h: line.rect.height, what: `line(block ${line.blockId})` });
    }
    for (const pr of result.placed) {
      if (pr.pageIndex !== p || pr.z != null) continue;
      items.push({ y: pr.rect.y, h: pr.rect.height, what: `placed(${pr.blockId})` });
    }
    items.sort((a, b) => a.y - b.y);
    let expectedY = 0;
    for (const it of items) {
      if (it.y !== expectedY) {
        console.error(
          `[paginated] contiguity violated on page ${p}: ${it.what} y=${it.y}, expected ${expectedY}`
        );
      }
      expectedY = it.y + it.h;
    }
  }
}
