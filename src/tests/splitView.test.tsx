import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { Editor } from '@/components/editor/Editor';
import { DisplayModeGroup } from '@/components/layout/ribbon/view/groups/DisplayModeGroup';
import { useConfigStore } from '@/lib/config/store';
import { useDocumentStore } from '@/lib/document/store';
import { DEFAULT_MARGINS, PAGE_GAP } from '@/lib/document/pageSetup';
import { FakeMetrics } from './fakeMetrics';
import { settleLayout } from './harness';

/**
 * #101 — SPLIT VIEW ("Two Pages"): the desk arrangement test. The
 * grid math itself lives in pageStackGrid.test.ts; this suite pins the
 * WIRING: ribbon button → config.editor.pageColumns → the warm relayout
 * → the sheets' frames AND the painted caret (the frame adjustment:
 * the column offset folded into contentBox.x at the ONE layout commit).
 * The repro doc is three hard breaks apart — one paragraph per page,
 * so page 1 (index 1) is deterministic.
 */

const button = (label: string) =>
  document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;

const sheet = (i: number) =>
  document.querySelector(`[data-page-index="${i}"]`) as HTMLElement | null;

const px = (el: HTMLElement, prop: 'left' | 'top' | 'width' | 'height') =>
  parseFloat(el.style[prop]!);

// Letter pages (816×1056), gap 32: three stacked → 3232 tall; split
// two-wide → 1664×2144.
const W = 816;
const H = 1056;
const GAP = 32;

// One paragraph per page: hard breaks stamp the pagination.
const BREAK_DOC =
  '<p>one</p><div data-page-break></div><p>two</p><div data-page-break></div><p>three</p>';

beforeEach(() => {
  useDocumentStore.getState().setPageInfo(1, 1);
  useDocumentStore.setState({
    pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP },
  });
  useConfigStore.setState((state) => ({
    config: {
      ...state.config,
      editor: { ...state.config.editor, pageColumns: 1 },
    },
  }));
});

function harness(initialHTML: string) {
  const utils = render(
    // The desk wrapper: the rulers' portal target (the M-RULER mount
    // law) — the split-view ruler test needs the real desk structure.
    <div data-desk-wrapper className="relative">
      <div data-desk-scroll style={{ overflow: 'auto' }}>
        <Editor metrics={FakeMetrics} />
      </div>
      <DisplayModeGroup />
    </div>,
  );
  const editor = useDocumentStore.getState().editor;
  if (!editor) throw new Error('editor not in store after render');
  act(() => {
    editor.commands.setContent(initialHTML);
  });
  return { editor, ...utils };
}

/** The caret ON PAGE 1 (index 1) — the text 'two' lives there by the
 *  break doc's construction. Focuses first (the caret paints only for
 *  a focused editor). */
async function caretOnPageOne(editor: ReturnType<typeof useDocumentStore.getState>['editor']) {
  let target = -1;
  editor!.state.doc.descendants((node, pos) => {
    if (target < 0 && node.isText && node.text === 'two') target = pos;
    return true;
  });
  act(() => {
    editor!.commands.setTextSelection(target);
    editor!.commands.focus();
  });
  await settleLayout();
  const caret = document.querySelector('[data-testid="synthetic-caret"]') as HTMLElement | null;
  if (!caret) throw new Error('synthetic caret not painted');
  return caret;
}

describe('View > Two Pages (split view)', () => {
  it('flips the desk between the stack and the two-column grid (config + sheets + stack)', async () => {
    harness(BREAK_DOC);
    await settleLayout();

    // THE STACK (default): sheets pile vertically, left = 0 for all.
    expect(document.querySelectorAll('[data-page-index]')).toHaveLength(3);
    const stack = document.querySelector('[data-testid="paginated-stack"]') as HTMLElement;
    expect(px(stack, 'width')).toBe(W);
    expect(px(stack, 'height')).toBe(H * 3 + GAP * 2);
    for (const i of [0, 1, 2]) {
      expect(px(sheet(i)!, 'left')).toBe(0);
    }
    expect(px(sheet(1)!, 'top')).toBe(H + GAP);
    const toggle = button('Two Pages')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    act(() => {
      fireEvent.click(toggle);
    });
    await settleLayout();

    // THE GRID: row-mates share a top; the second column owns its left;
    // the stack doubles wide and halves tall; the config carries it.
    expect(useConfigStore.getState().config.editor.pageColumns).toBe(2);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(px(sheet(0)!, 'top')).toBe(0);
    expect(px(sheet(1)!, 'top')).toBe(0); // row-mates
    expect(px(sheet(1)!, 'left')).toBe(W + GAP);
    expect(px(sheet(2)!, 'top')).toBe(H + GAP); // row 1
    expect(px(sheet(2)!, 'left')).toBe(0);
    expect(px(stack, 'width')).toBe(W * 2 + GAP);
    expect(px(stack, 'height')).toBe(H * 2 + GAP);

    // THE SHEET FRAME (the regression the frame adjustment must never
    // re-break): the text canvases live INSIDE the sheet — sheet-
    // relative — so they carry the page-local margin (96px), never the
    // folded stack coordinate (W/2 + 96 + column). The column offset
    // rides the SHEET's own position, never the canvas.
    const canvasOf = (i: number) => sheet(i)!.querySelector('canvas') as HTMLCanvasElement;
    expect(canvasOf(0).style.left).toBe('96px');
    expect(canvasOf(1).style.left).toBe('96px');
    expect(canvasOf(2).style.left).toBe('96px');

    // BACK TO THE STACK: the classic coordinates return bit-for-bit.
    act(() => {
      fireEvent.click(toggle);
    });
    await settleLayout();
    expect(useConfigStore.getState().config.editor.pageColumns).toBe(1);
    expect(px(sheet(1)!, 'top')).toBe(H + GAP);
    expect(px(sheet(1)!, 'left')).toBe(0);
    expect(px(stack, 'width')).toBe(W);
    expect(px(stack, 'height')).toBe(H * 3 + GAP * 2);
    expect(canvasOf(1).style.left).toBe('96px');
  });

  it('moves the painted caret into its column (the frame adjustment reaches the painter)', async () => {
    const { editor } = harness(BREAK_DOC);
    await settleLayout();
    const caret = await caretOnPageOne(editor);

    // The stack: page 1 sits one page+gap down the vertical; the left
    // is the content margin only.
    const leftBefore = parseFloat(caret.style.left!);
    const topBefore = parseFloat(caret.style.top!);

    act(() => {
      fireEvent.click(button('Two Pages')!);
    });
    await settleLayout();
    // The ribbon click may blur the editor — re-focus so the caret
    // paints again.
    act(() => {
      editor!.commands.focus();
    });
    await settleLayout();

    const caretAfter = document.querySelector('[data-testid="synthetic-caret"]') as HTMLElement;
    const leftAfter = parseFloat(caretAfter.style.left!);
    const topAfter = parseFloat(caretAfter.style.top!);
    // The SAME caret, SAME doc: page 1 left the second stack slot for
    // the first row's second column — the column offset (+W+GAP) folds
    // into its frame's contentBox.x, the row top (-H-GAP) replaces the
    // stack stride. The engine facts (the caret's x/y inside the page)
    // are untouched.
    expect(leftAfter - leftBefore).toBeCloseTo(W + GAP, 5);
    expect(topAfter - topBefore).toBeCloseTo(-(H + GAP), 5);
  });

  it('routes clicks per column: the left page selects its text, the right page selects its own', async () => {
    const { editor } = harness(BREAK_DOC);
    await settleLayout();
    act(() => {
      fireEvent.click(button('Two Pages')!);
    });
    await settleLayout();
    const wrapper = document.querySelector(
      '[data-testid="paginated-zoom-wrapper"]',
    ) as HTMLElement;

    const caretParentText = () => {
      const sel = editor!.state.selection;
      return editor!.state.doc.resolve(sel.from).parent.textContent;
    };

    // LEFT column: stack-local x inside page 0's sheet.
    act(() => {
      fireEvent.mouseDown(wrapper, { clientX: 400, clientY: 400, button: 0 });
      fireEvent.mouseUp(wrapper, { clientX: 400, clientY: 400 });
    });
    await settleLayout();
    expect(caretParentText()).toBe('one');

    // RIGHT column: stack-local x inside page 1's sheet (848..1664) —
    // the SAME y. The point hit must disambiguate by x; the caret lands
    // in the RIGHT page's text.
    act(() => {
      fireEvent.mouseDown(wrapper, { clientX: 1000, clientY: 400, button: 0 });
      fireEvent.mouseUp(wrapper, { clientX: 1000, clientY: 400 });
    });
    await settleLayout();
    expect(caretParentText()).toBe('two');
  });

  it('drag-selects from the left page into the right page (the caret crosses the gutter)', async () => {
    const { editor } = harness(BREAK_DOC);
    await settleLayout();
    act(() => {
      fireEvent.click(button('Two Pages')!);
    });
    await settleLayout();
    const wrapper = document.querySelector(
      '[data-testid="paginated-zoom-wrapper"]',
    ) as HTMLElement;

    // Press on the LEFT page's text, drag into the RIGHT page's, release.
    act(() => {
      fireEvent.mouseDown(wrapper, { clientX: 400, clientY: 400, button: 0 });
    });
    act(() => {
      fireEvent.mouseMove(window, { clientX: 1000, clientY: 408 });
    });
    act(() => {
      fireEvent.mouseUp(window, { clientX: 1000, clientY: 408 });
    });
    await settleLayout();
    const sel = editor!.state.selection;
    // A spanning selection: it starts inside 'one' (left page) and
    // ends inside 'two' (right page) — the drag crossed the gutter.
    expect(editor!.state.doc.resolve(sel.from).parent.textContent).toBe('one');
    expect(editor!.state.doc.resolve(sel.to).parent.textContent).toBe('two');
    expect(sel.from).not.toBe(sel.to);
  });

  it('routes the inter-row gap clicks by column', async () => {
    const { editor } = harness(BREAK_DOC);
    await settleLayout();
    act(() => {
      fireEvent.click(button('Two Pages')!);
    });
    await settleLayout();
    const wrapper = document.querySelector(
      '[data-testid="paginated-zoom-wrapper"]',
    ) as HTMLElement;

    const caretParentText = () => {
      const sel = editor!.state.selection;
      return editor!.state.doc.resolve(sel.from).parent.textContent;
    };

    // The gap's SECOND half (y = 1080 ∈ 1056+gap/2..1088) below the
    // LEFT column → the next row's LEFT page ('three' — the doc's last
    // page sits alone in row 1, so the right column's gap click ALSO
    // clamps to it: the nearest content).
    act(() => {
      fireEvent.mouseDown(wrapper, { clientX: 400, clientY: 1080, button: 0 });
      fireEvent.mouseUp(wrapper, { clientX: 400, clientY: 1080 });
    });
    await settleLayout();
    expect(caretParentText()).toBe('three');

    act(() => {
      fireEvent.mouseDown(wrapper, { clientX: 1000, clientY: 1080, button: 0 });
      fireEvent.mouseUp(wrapper, { clientX: 1000, clientY: 1080 });
    });
    await settleLayout();
    expect(caretParentText()).toBe('three');
  });

  it('mounts one ruler set per column: horizontal strips over both pages, vertical rulers on both desk edges', async () => {
    harness(BREAK_DOC);
    await settleLayout();
    // THE STACK: the classic single rulers.
    expect(document.querySelector('[data-testid="ruler"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="ruler-split"]')).toBeNull();
    expect(document.querySelector('[data-testid="ruler-vertical-right"]')).toBeNull();

    act(() => {
      fireEvent.click(button('Two Pages')!);
    });
    await settleLayout();

    // TWO HORIZONTAL strips: the desk-wide chrome bar keeps its canvas
    // over column 0 (jsdom's zero-width desk puts the stack at pageLeft
    // 0 — the canvas overhangs LABEL_PAD left of it); the transparent
    // split strip's container starts at column 1's left minus the same
    // overhang (848 − 12) and spans the strip plus both overhangs.
    const primaryCanvas = document.querySelector(
      '[data-testid="ruler"] canvas',
    ) as HTMLElement;
    expect(primaryCanvas.style.left).toBe('-12px');
    const splitBar = document.querySelector('[data-testid="ruler-split"]') as HTMLElement;
    expect(splitBar.style.left).toBe('836px');
    expect(splitBar.style.width).toBe('840px'); // pageWz + 2 × LABEL_PAD
    expect(document.querySelectorAll('[data-testid="ruler-split"] canvas')).toHaveLength(1);

    // TWO VERTICAL rulers: the left edge (the classic) + the right
    // edge riding the desk's right side.
    const rightRuler = document.querySelector(
      '[data-testid="ruler-vertical-right"]',
    ) as HTMLElement;
    expect(rightRuler.style.right).toBe('0px');
    expect(rightRuler.style.width).toBe('16px');

    // THE STRIP'S HANDLES anchor to the PAGE-LOCAL frame (the fold's
    // inverse): the margin grabbers sit at the page's own content edges
    // (96px / 720px) INSIDE the 816px inner. The folded geometry
    // (contentBox.x = 944) would push them ~944px into the strip — off
    // the desk entirely — and mute every tick (no body-band two-tone).
    const stripLeftHandle = splitBar.querySelector(
      '[data-testid="ruler-margin-left"]',
    ) as HTMLElement;
    const stripRightHandle = splitBar.querySelector(
      '[data-testid="ruler-margin-right"]',
    ) as HTMLElement;
    expect(stripLeftHandle.style.left).toBe('96px');
    expect(stripRightHandle.style.left).toBe('720px');

    // BACK TO THE STACK: the classic single ruler set returns.
    act(() => {
      fireEvent.click(button('Two Pages')!);
    });
    await settleLayout();
    expect(document.querySelector('[data-testid="ruler-split"]')).toBeNull();
    expect(document.querySelector('[data-testid="ruler-vertical-right"]')).toBeNull();
    expect(document.querySelector('[data-testid="ruler-vertical"]')).not.toBeNull();
  });

  it('paints the drag selection ON the right page and floats the toolbar there', async () => {
    harness(BREAK_DOC);
    await settleLayout();
    act(() => {
      fireEvent.click(button('Two Pages')!);
    });
    await settleLayout();
    const wrapper = document.querySelector(
      '[data-testid="paginated-zoom-wrapper"]',
    ) as HTMLElement;

    // THE REGRESSION (the y-only tops walk): the selection helpers
    // derived their own stack-stride tops — page 1's bands painted one
    // ROW down (into empty desk), so the selection was invisible and
    // the toolbar anchored off-view. The grid's row tops ride the
    // helpers now.
    act(() => {
      fireEvent.mouseDown(wrapper, { clientX: 950, clientY: 104, button: 0 });
      fireEvent.mouseMove(window, { clientX: 968, clientY: 106 });
      fireEvent.mouseUp(window, { clientX: 968, clientY: 106 });
    });
    await settleLayout();

    // A spanning selection IN the right page's text ('two' — one line
    // at content y 0..16, so the band sits at contentBox.y = 96, not
    // the y-only stride's 96 + 1088).
    const rects = document.querySelectorAll('[data-testid="selection-rect"]');
    expect(rects.length).toBeGreaterThan(0);
    for (const r of rects) {
      const top = parseFloat((r as HTMLElement).style.top!);
      expect(top).toBeGreaterThanOrEqual(96);
      expect(top).toBeLessThan(112); // inside row 0's page-1 content top
      const left = parseFloat((r as HTMLElement).style.left!);
      expect(left).toBeGreaterThanOrEqual(944); // the second column's frame
    }

    // The floating toolbar surfaces at the settled selection.
    expect(document.querySelector('[data-testid="floating-toolbar"]')).not.toBeNull();
  });

  it('rides the caret across the page break: a block spanning both pages puts the model on the caret strip', async () => {
    // One paragraph long enough to flow from page 0 onto page 1 — its
    // FIRST line sits on page 0 while the caret sits on page 1. The
    // model (indent markers, tab stops) must key on the CARET'S OWN
    // line, or it pins to the left ruler forever.
    const { editor } = harness(`<p>${'a'.repeat(62 * 60)}</p>`);
    await settleLayout();
    act(() => {
      fireEvent.click(button('Two Pages')!);
    });
    await settleLayout();
    // The doc really spans: page 1's sheet is there with content.
    expect(document.querySelectorAll('[data-page-index]').length).toBeGreaterThanOrEqual(2);

    act(() => {
      editor!.commands.setTextSelection(editor!.state.doc.content.size - 5);
      editor!.commands.focus();
    });
    await settleLayout();

    // The caret is on page 1 (the doc tail) → the STRIP wears the model
    // (its indent markers mount), the primary drops it.
    const stripBar = document.querySelector('[data-testid="ruler-split"]') as HTMLElement;
    const primaryBar = document.querySelector('[data-testid="ruler"]') as HTMLElement;
    expect(stripBar.querySelector('[data-testid="ruler-indent-first"]')).not.toBeNull();
    expect(primaryBar.querySelector('[data-testid="ruler-indent-first"]')).toBeNull();

    // The caret back on page 0 (doc head): the model returns to the
    // primary strip.
    act(() => {
      editor!.commands.setTextSelection(2);
      editor!.commands.focus();
    });
    await settleLayout();
    expect(primaryBar.querySelector('[data-testid="ruler-indent-first"]')).not.toBeNull();
    expect(stripBar.querySelector('[data-testid="ruler-indent-first"]')).toBeNull();
  });

  it('is inert in the pageless view; the config remembers the choice across mode flips', async () => {
    const { editor } = harness(BREAK_DOC);
    await settleLayout();

    // Split first, so the memory assertion bites.
    act(() => {
      fireEvent.click(button('Two Pages')!);
    });
    await settleLayout();

    // PAGELESS: pages don't exist — the toggle goes inert (not hidden:
    // the position stays stable).
    const mode = button('Paginated / Pageless')!;
    act(() => {
      fireEvent.click(mode);
    });
    await settleLayout();
    expect(button('Two Pages')!.disabled).toBe(true);

    // Back to PAGINATED: the config's pageColumns rides — the desk
    // returns to the split arrangement without touching the toggle.
    act(() => {
      fireEvent.click(mode);
    });
    await settleLayout();
    expect(useConfigStore.getState().config.editor.pageColumns).toBe(2);
    expect(px(sheet(1)!, 'left')).toBe(W + GAP);
    expect(px(sheet(0)!, 'top')).toBe(px(sheet(1)!, 'top'));

    // Editor focus back for the next test's store state.
    act(() => {
      editor!.commands.focus();
    });
  });
});
