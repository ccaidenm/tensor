import type { EditorState } from '@tiptap/pm/state';
import type { TabStop } from '@tensor-editor/engine';
import {
  MEASUREMENT_UNITS,
  PX_PER_PT,
  formatPt,
  ptToPx,
  type MeasurementUnit,
} from '@/lib/document/pageSetup';
import { currentIndentLeft, normalizeTabStops } from '@/lib/editor/ParagraphExtensions';

/**
 * M-RULER — pure ruler math. No DOM, no React, no canvas: everything
 * here is a function of (engine px geometry, display unit). The Ruler
 * component multiplies by zoom at paint time; nothing here knows zoom
 * exists.
 *
 * UNITS (the pageSetup.ts law): the document store holds POINTS, the
 * engine holds CSS px. Ruler tick positions are ENGINE px (the same
 * frame as PageGeometry.size/contentBox — L1: engine-issued facts),
 * generated from per-unit tick steps in pt and converted once.
 */

/** The ruler bar's height in CSS px. Deliberately THIN UI chrome (the
 * FloatingToolbar law: the bar is chrome at 100%, content scales) —
 * major ticks run the FULL height with their number overlaid,
 * vertically centered on a transparent background. */
export const RULER_HEIGHT = 18;

/** The VERTICAL ruler bar's width (Phase 5): a touch thinner than the
 * horizontal bar's height — the rotated numbers + full-width majors
 * read heavier at the same size, so the vertical trims 2px. */
export const RULER_WIDTH = 16;

/** Per-unit tick steps in POINTS. Ratios major/minor are integers by
 * construction (pinned by ruler.test.ts) so tick generation walks the
 * minor step and hits every medium/major exactly. */
export interface TickSpec {
  /** The numbered step. Inches: 1"; cm/mm: 1cm; points: 1"; picas: 1pc. */
  major: number;
  /** The half-step. Inches: 0.5"; cm/mm: 5mm; points: 0.5"; picas: 6pt. */
  medium: number;
  /** The finest step. Inches: 1/8"; cm/mm: 1mm; points: 6pt; picas: 3pt. */
  minor: number;
}

export const TICK_SPECS: Record<MeasurementUnit, TickSpec> = {
  inches:       { major: 72,        medium: 36,          minor: 9 },
  centimeters:  { major: 72 / 2.54, medium: 36 / 2.54,   minor: 72 / 25.4 },
  millimeters:  { major: 10 * (72 / 25.4), medium: 5 * (72 / 25.4), minor: 72 / 25.4 },
  points:       { major: 72,        medium: 36,          minor: 6 },
  picas:        { major: 12,        medium: 6,           minor: 3 },
};

export type TickKind = 'major' | 'medium' | 'minor';

/** Rounded integer step counts of a unit's tick hierarchy. */
export function stepCounts(unit: MeasurementUnit): { perMedium: number; perMajor: number } {
  const spec = TICK_SPECS[unit];
  return {
    perMedium: Math.round(spec.medium / spec.minor),
    perMajor: Math.round(spec.major / spec.minor),
  };
}

/** Engine-px spacing of the minor grid at zoom 1 (rounded — snapping
 * and paint quantize to this). */
export function minorStepPx(unit: MeasurementUnit): number {
  return ptToPx(TICK_SPECS[unit].minor);
}

/**
 * Engine px of minor-grid index k — the per-tick ptToPx rounding
 * generateTicks uses, so a uniform-multiplication shortcut can never
 * put cm majors on a 4px grid instead of the true 37.795px positions.
 * Valid for negative k too: the grid extends LEFT of the page.
 */
export function tickXForStep(k: number, unit: MeasurementUnit): number {
  return ptToPx(k * TICK_SPECS[unit].minor);
}

/** A tick's kind for minor-grid index k — phase-locked and
 * negative-safe (the grid extends beyond the page's left edge). */
export function tickKindForStep(k: number, unit: MeasurementUnit): TickKind {
  const { perMedium, perMajor } = stepCounts(unit);
  if (((k % perMajor) + perMajor) % perMajor === 0) return 'major';
  if (((k % perMedium) + perMedium) % perMedium === 0) return 'medium';
  return 'minor';
}

/** A major tick's 0-based label (0 at the page's left edge). Only
 * meaningful when tickKindForStep(k) is 'major'. */
export function majorLabelForStep(k: number, unit: MeasurementUnit): number {
  return k / stepCounts(unit).perMajor;
}

export interface RulerTick {
  /** ENGINE px from the page's left edge (pre-zoom). */
  x: number;
  kind: TickKind;
  /** Majors only: the 0-based label index (0 at the page's left edge —
   * the Word/GDocs numbering convention). */
  label?: number;
}

/**
 * Ticks across the page width, majors numbered from 0 at the page's
 * left edge. A finer step that would land on the same px as a coarser
 * one is DROPPED (the coarser tick wins) — no doubled ticks. The
 * Ruler component paints the SAME grid through tickXForStep/
 * tickKindForStep, extended across the whole window — one phase logic,
 * two spans.
 */
export function generateTicks(pageWidthPx: number, unit: MeasurementUnit): RulerTick[] {
  const ticks: RulerTick[] = [];
  for (let k = 0; ; k++) {
    const x = tickXForStep(k, unit);
    if (x > pageWidthPx) break;
    const kind = tickKindForStep(k, unit);
    ticks.push(
      kind === 'major'
        ? { x, kind, label: majorLabelForStep(k, unit) }
        : { x, kind },
    );
  }
  return ticks;
}

/** Snap an engine-px position to the nearest minor tick (the drag
 * default; fine control skips the call entirely). */
export function snapToMinor(px: number, unit: MeasurementUnit): number {
  const step = minorStepPx(unit);
  if (step <= 0) return px;
  return Math.round(px / step) * step;
}

/** The narrowest text column a margin drag may produce (0.5", Word's
 * own floor). Points at the data boundary like every other limit. */
export const MIN_CONTENT_WIDTH_PT = 36;

/**
 * Clamp a [left, right] margin pair (engine px) so both stay inside the
 * page and the content span never falls under MIN_CONTENT_WIDTH_PT.
 * Resolving the span floor by pushing the RIGHT edge first keeps the
 * dragged-left edge authoritative — the marker under the pointer wins.
 */
export function clampMarginSpan(
  leftPx: number,
  rightPx: number,
  pageWidthPx: number,
): [number, number] {
  const minSpan = ptToPx(MIN_CONTENT_WIDTH_PT);
  const left = Math.max(0, Math.min(leftPx, pageWidthPx - minSpan));
  const right = Math.max(left + minSpan, Math.min(rightPx, pageWidthPx));
  return [left, right];
}

/** Engine px → the user's display unit, via the shared formatter.
 * Uses the UNROUNDED pt value (pxToPt's rounding is for the store
 * boundary; display wants the true length). */
export function formatPxAsUnit(px: number, unit: MeasurementUnit): string {
  return formatPt(px / PX_PER_PT, unit);
}

/** A unit's input suffix ("in", "cm", …) for tooltips and labels. */
export function unitSuffix(unit: MeasurementUnit): string {
  return MEASUREMENT_UNITS[unit].suffix;
}

/**
 * The indent model the ruler projects for the caret's block — the
 * paragraph attr family in ENGINE px (the same numbers the engine's
 * indent geometry consumes). null = the ruler shows margins only:
 * headings carry no indent attrs (HeadingWithExtras adds lineHeight
 * alone), and a LIST's indent is structural (the adapter derives
 * depth × 32) — dragging the attr would fight the list machinery.
 */
export interface RulerModel {
  indentLeft: number;
  indentRight: number;
  firstLineIndent: number;
  /** The block's tab stops — px, CONTENT-BOX-relative (margin-relative:
   *  indent edits never move them), ascending, normalized, each with
   *  its alignment kind. Empty when the block has none. */
  tabStops: TabStop[];
}

/**
 * The caret block's indent attrs, straight from PM state. `node(1)` is
 * the caret's TOP-LEVEL block (the adapter's unit of flow) — a caret
 * inside a list/codeBlock resolves to the container, not a paragraph,
 * and falls out as null. Read at render time from the immutable PM
 * state: selection and doc changes always re-render the view through
 * the projection setStates, so this never goes stale.
 */
export function deriveRulerModel(state: EditorState): RulerModel | null {
  const { $from } = state.selection;
  if ($from.depth < 1) return null;
  const block = $from.node(1);
  if (!block || block.type.name !== 'paragraph') return null;
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return {
    indentLeft: currentIndentLeft(block),
    indentRight: num(block.attrs.indentRight),
    firstLineIndent: num(block.attrs.firstLineIndent),
    tabStops: normalizeTabStops(block.attrs.tabStops) ?? [],
  };
}