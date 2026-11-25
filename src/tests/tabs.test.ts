import { act, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useDocumentStore } from '@/lib/document/store';
import { useConfigStore } from '@/lib/config/store';
import { DEFAULT_MARGINS, PAGE_GAP } from '@/lib/document/pageSetup';
import { GEOMETRY, renderTensor, renderTensorInScrollContainer, settleLayout, mockRects } from './harness';

// The \t advance rule, end to end through the REAL production editor:
// the engine's breaker places tab jumps (FakeMetrics: 10px/char), the
// painter consumes the segment x (a tab paints NOTHING), Tab inserts a
// REAL tab character whose cursor lands ON the stop, and clicks inside
// a tab span resolve by the midpoint rule.
//
// All x numbers are CANVAS-relative (BlockCanvas sits at the content
// box): an unindented paragraph's line pen starts at 0, so a stop at
// 200 content-relative paints at x 200.
//
// HTML PARSING COLLAPSES TABS — a literal \t in fixture HTML parses as
// a space, so every fixture inserts the tab through PM
// (insertContentAt) after load.

function fillTexts(): Array<{ text: string; x: number }> {
  const ops = (globalThis as unknown as {
    __paintOps: Array<{ op: string; args: unknown[] }>;
  }).__paintOps;
  return ops
    .filter((o) => o.op === 'fillText')
    .map((o) => ({ text: o.args[0] as string, x: o.args[1] as number }));
}

function textAt(x: number): string | undefined {
  return fillTexts().find((t) => t.x === x)?.text;
}

beforeEach(() => {
  useDocumentStore.getState().setPageInfo(1, 1);
  useDocumentStore.setState({
    pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP },
  });
  useConfigStore.setState((state) => ({
    config: {
      ...state.config,
      editor: { ...state.config.editor, zoomLevel: 100 },
    },
  }));
});

/** Loads `html` and inserts real tabs at the given PM positions
 *  (stated in the CURRENT doc's coordinates — each insertion shifts
 *  later positions naturally). Raw tr.insertText: TipTap's
 *  insertContent parses strings and HTML-parsing collapses tabs. The
 *  paint-op buffer clears first so assertions see THIS test's paint. */
async function loadWithTabs(html: string, tabPositions: number[]) {
  const { editor } = renderTensor(html);
  await settleLayout();
  const ops = (globalThis as unknown as {
    __paintOps: Array<{ op: string; args: unknown[] }>;
  }).__paintOps;
  for (const pos of tabPositions) {
    ops.length = 0; // each insert repaints; keep only the latest frame
    act(() => {
      editor.view.dispatch(editor.state.tr.insertText('\t', pos));
    });
  }
  await settleLayout();
  return { editor };
}

describe('tab advance', () => {
  it('a mid-line tab jumps the pen to the next default stop (0.5" grid) and paints nothing', async () => {
    const { editor } = await loadWithTabs('<p>abcd</p>', [3]);
    const ops = (globalThis as unknown as {
      __paintOps: Array<{ op: string; args: unknown[] }>;
    }).__paintOps;
    // 'ab' = 20px → the pen (content 116) jumps to the next 48px
    // multiple (48 canvas-relative) → 'cd' lands there. The tab glyph
    // itself never paints.
    expect(editor.state.doc.child(0).textContent).toBe('ab\tcd');
    expect(textAt(0)).toBe('ab');
    expect(textAt(48)).toBe('cd');
    expect(ops.some((o) => o.op === 'fillText' && (o.args[0] as string).includes('\t'))).toBe(false);
  });

  it('ruler-driven stops drive all three kinds (left / center / right)', async () => {
    await loadWithTabs('<p data-tab-stops="200:left,300:center,400:right">abXYZ</p>', [3, 5, 7]);
    // 'ab' [0,20); left stop 200 → 'X' [200,210); center stop 300 →
    // W('Y')=10 → 'Y' [295,305); right stop 400 → 'Z' [390,400).
    expect(textAt(0)).toBe('ab');
    expect(textAt(200)).toBe('X');
    expect(textAt(295)).toBe('Y');
    expect(textAt(390)).toBe('Z');
  });

  it('the Tab KEY inserts a real tab whose cursor lands ON the ruler\u2019s stop', async () => {
    const { editor } = renderTensor('<p data-tab-stops="200:left">abcdef</p>');
    await settleLayout();
    const ops = (globalThis as unknown as {
      __paintOps: Array<{ op: string; args: unknown[] }>;
    }).__paintOps;
    ops.length = 0;
    // Caret after 'abc' (PM pos 4), then the real key.
    act(() => {
      editor.commands.setTextSelection(4);
    });
    await settleLayout();
    const dom = editor.view.dom as HTMLElement;
    act(() => {
      dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      );
    });
    await settleLayout();
    // The character is real content...
    expect(editor.state.doc.child(0).textContent).toBe('abc\tdef');
    // ...and the pen jumped to the RULER's stop: 'def' paints at 200.
    expect(textAt(200)).toBe('def');
  });

  it('a pen already ON a stop advances to the NEXT one', async () => {
    await loadWithTabs('<p>abcd</p>', [3, 4]);
    // tab 1: pen 20 → grid 48. tab 2: pen 48 — ON the grid multiple →
    // 96 (strictly greater).
    expect(textAt(0)).toBe('ab');
    expect(textAt(96)).toBe('cd');
  });

  it('clicks inside a tab span resolve by the midpoint rule over the jump', async () => {
    const { editor } = renderTensorInScrollContainer('<p>abcd</p>');
    await settleLayout();
    const ops = (globalThis as unknown as {
      __paintOps: Array<{ op: string; args: unknown[] }>;
    }).__paintOps;
    ops.length = 0;
    act(() => {
      editor.view.dispatch(editor.state.tr.insertText('\t', 3));
    });
    await settleLayout();
    mockRects(0, { top: 0, bottom: 800 });
    const wrapEl = document.querySelector(
      '[data-testid="paginated-zoom-wrapper"]',
    ) as HTMLElement;
    // The tab's span (line-relative [20, 48), canvas == content frame
    // for an unindented paragraph) in CLIENT coords: +CB (the stack is
    // mocked at left 0, so client == page px and the content offset is
    // CB). Midpoint 34 − 1 → BEFORE the tab; midpoint + 1 → after it
    // (the next glyph 'c' at 48).
    act(() => {
      fireEvent.mouseDown(wrapEl, { clientX: 129, clientY: GEOMETRY.contentY + 4 });
    });
    expect(editor.state.selection.$from.parentOffset).toBe(2); // before the \t
    act(() => {
      fireEvent.mouseDown(wrapEl, { clientX: 131, clientY: GEOMETRY.contentY + 4 });
    });
    expect(editor.state.selection.$from.parentOffset).toBe(3); // after the \t
  });
});
describe('Shift+Tab backtrack', () => {
  it('backtracks the caret one tab section at a time, non-destructive', async () => {
    // 'ab\tcd\tef': text a0 b1 \t2 c3 d4 \t5 e6 f7.
    const { editor } = await loadWithTabs('<p>abcdef</p>', [3, 6]);
    const dom = editor.view.dom as HTMLElement;
    const shiftTab = () =>
      act(() => {
        dom.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
        );
      });
    act(() => {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1); // the end
    });
    shiftTab();
    // The caret lands at the current section's start — just after the
    // second tab (off 6). The text is untouched.
    expect(editor.state.selection.$from.parentOffset).toBe(6);
    expect(editor.state.doc.child(0).textContent).toBe('ab\tcd\tef');
    shiftTab();
    // Already at a section start → chains back one more stop (off 3).
    expect(editor.state.selection.$from.parentOffset).toBe(3);
    shiftTab();
    // Nothing before the first tab → the no-op.
    expect(editor.state.selection.$from.parentOffset).toBe(3);
  });
});

describe('Enter strips tab stops', () => {
  it('Enter splits AND strips the new block in one transaction (one undo step)', async () => {
    const { editor } = renderTensor('<p data-tab-stops="200:left,300:center">abc</p>');
    await settleLayout();
    // Recorded history baseline (setContent bypasses the undo stack;
    // prosemirror-history merges the rest within its 500ms window).
    editor.commands.setTextSelection(1);
    await new Promise((resolve) => setTimeout(resolve, 550));
    const dom = editor.view.dom as HTMLElement;
    act(() => {
      dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });
    await settleLayout();
    // The split: the head keeps its stops; the NEW block starts clean.
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(0).attrs.tabStops).toEqual([
      { position: 200, alignment: 'left' },
      { position: 300, alignment: 'center' },
    ]);
    expect(editor.state.doc.child(1).attrs.tabStops).toBeNull();
    // ONE transaction: a single undo restores the pre-Enter state
    // (split + strip together — no stop-resurrection half-step).
    act(() => {
      editor.commands.undo();
    });
    await settleLayout();
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.child(0).attrs.tabStops).toEqual([
      { position: 200, alignment: 'left' },
      { position: 300, alignment: 'center' },
    ]);
  });

  it('a mid-text split keeps the head\u2019s stops and strips the tail', async () => {
    const { editor } = renderTensor('<p data-tab-stops="200:left">abXc</p>');
    await settleLayout();
    editor.commands.setTextSelection(1);
    await new Promise((resolve) => setTimeout(resolve, 550));
    const dom = editor.view.dom as HTMLElement;
    act(() => {
      editor.commands.setTextSelection(3); // 'ab|Xc'
      dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });
    await settleLayout();
    expect(editor.state.doc.child(0).textContent).toBe('ab');
    expect(editor.state.doc.child(0).attrs.tabStops).toEqual([{ position: 200, alignment: 'left' }]);
    expect(editor.state.doc.child(1).textContent).toBe('Xc');
    expect(editor.state.doc.child(1).attrs.tabStops).toBeNull();
  });
});
