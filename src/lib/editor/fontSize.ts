import type { Editor } from '@tiptap/core';
import { useConfigStore } from '@/lib/config/store';

/**
 * Units: pt at the chrome, px in the core (PM attrs, config, engine,
 * canvas metrics) — only display-facing chrome converts, at the same
 * 96/72 ratio as pageSetup.PX_PER_PT. 16px ⇄ "12" round-trips exactly.
 */

export const PX_PER_PT = 96 / 72;
export const PT_PER_PX = 72 / 96;

/** Display-facing: px → whole pt for the Font Size box. */
export function fontPxToDisplayPt(px: number): number {
  return Math.round(px * PT_PER_PX);
}

/** Chrome commit: entered pt → core px. */
export function fontPtToPx(pt: number): number {
  return Math.round(pt * PX_PER_PT);
}

/** The stepper increment, in chrome pt (Word's Ctrl+Shift+>/< step). */
export const FONT_STEP_PT = 2;

/** Core px of the selection's effective font size: the textStyle
 * mark's fontSize attr ('NNpx'), else the config default. Never a
 * display unit — callers convert at the chrome only. */
export function effectiveFontSizePx(editor: Editor): number {
  const attr = editor.getAttributes('textStyle').fontSize as unknown;
  if (typeof attr === 'string') {
    const px = parseFloat(attr);
    if (Number.isFinite(px) && px > 0) return px;
  }
  if (typeof attr === 'number' && Number.isFinite(attr) && attr > 0) return attr;
  return useConfigStore.getState().config.editor.defaultFontSize;
}

/**
 * Step the selection's font size by ±FONT_STEP_PT (chrome pt), committing
 * px. The pt math rounds both ways, so up-then-down returns the same px.
 */
export function stepFontSize(editor: Editor, direction: 1 | -1): boolean {
  const currentPx = effectiveFontSizePx(editor);
  const nextPt = Math.max(1, fontPxToDisplayPt(currentPx) + direction * FONT_STEP_PT);
  return editor.chain().focus().setFontSize(`${fontPtToPx(nextPt)}px`).run();
}
