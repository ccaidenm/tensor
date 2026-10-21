import { act, fireEvent } from '@testing-library/react';
import { TextSelection } from '@tiptap/pm/state';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clampMarginSpan,
  formatPxAsUnit,
  generateTicks,
  majorLabelForStep,
  snapToMinor,
  tickKindForStep,
  TICK_SPECS,
  MIN_CONTENT_WIDTH_PT,
  RULER_HEIGHT,
  RULER_WIDTH,
} from '@/lib/paginated/ruler';
import { ptToPx } from '@/lib/document/pageSetup';
import { useConfigStore } from '@/lib/config/store';
import { useDocumentStore } from '@/lib/document/store';
import { useDocumentPropertiesStore } from '@/lib/document/propertiesStore';
import { pmDocToSemantic } from '@/lib/paginated/adapter';
import { GEOMETRY, renderTensor, settleLayout } from './harness';

// The module-level config/document stores leak across suites (the
// ARCHITECTURE.md gotcha) — restore the defaults before every test.
beforeEach(() => {
  useConfigStore.getState().setBothRulers(true);
  useDocumentStore.setState({
    pageSetup: {
      pageSize: 'Letter',
      margins: { top: 72, bottom: 72, left: 72, right: 72 },
      pageGap: 32,
    },
  });
  useDocumentPropertiesStore.setState({
    isOpen: false,
    marginsIsOpen: false,
    statsIsOpen: false,
    customSizeIsOpen: false,
  });
});

describe('TICK_SPECS', () => {
  it('major/medium/minor ratios are integers (the tick walk must hit them exactly)', () => {
    for (const spec of Object.values(TICK_SPECS)) {
      const perMajor = spec.major / spec.minor;
      const perMedium = spec.medium / spec.minor;
      expect(Math.abs(perMajor - Math.round(perMajor))).toBeLessThan(1e-9);
      expect(Math.abs(perMedium - Math.round(perMedium))).toBeLessThan(1e-9);
    }
  });
});

describe('generateTicks (inches, Letter 816px)', () => {
  const ticks = generateTicks(816, 'inches');

  it('majors land on whole inches, labeled 0..8 from the page edge', () => {
    const majors = ticks.filter((t) => t.kind === 'major');
    expect(majors.map((t) => t.x)).toEqual([0, 96, 192, 288, 384, 480, 576, 672, 768]);
    expect(majors.map((t) => t.label)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('mediums at half inches, minors every 1/8 inch — no doubled ticks', () => {
    const mediums = ticks.filter((t) => t.kind === 'medium').map((t) => t.x);
    expect(mediums).toEqual([48, 144, 240, 336, 432, 528, 624, 720, 816]);
    for (const tick of ticks.filter((t) => t.kind === 'minor')) {
      expect(tick.x % 12).toBe(0); // 1/8" = 12px exactly
      expect(tick.x % 48).not.toBe(0); // a 48-multiple would be medium/major
    }
  });

  it('no tick beyond the page width; the right edge gets a boundary tick', () => {
    expect(ticks.every((t) => t.x <= 816)).toBe(true);
    expect(ticks[ticks.length - 1]!.x).toBe(816);
  });

  it('x=0 is the first major with label 0 (Word/GDocs numbering)', () => {
    expect(ticks[0]).toEqual({ x: 0, kind: 'major', label: 0 });
  });
});

describe('generateTicks (centimeters, Letter 816px)', () => {
  const ticks = generateTicks(816, 'centimeters');

  it('majors land on rounded cm positions with sequential labels', () => {
    const majors = ticks.filter((t) => t.kind === 'major');
    // 1cm = 28.35pt = 37.795px → ptToPx rounds each major independently.
    expect(majors.slice(0, 4).map((t) => t.x)).toEqual([0, 38, 76, 113]);
    expect(majors.map((t) => t.label)).toEqual(majors.map((_, i) => i));
  });

  it('minors (1mm) are monotonic and never collide with coarser ticks', () => {
    const coarse = new Set(
      ticks.filter((t) => t.kind !== 'minor').map((t) => t.x),
    );
    const minors = ticks.filter((t) => t.kind === 'minor');
    expect(minors.length).toBeGreaterThan(50);
    for (const tick of minors) {
      expect(coarse.has(tick.x)).toBe(false);
    }
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!.x).toBeGreaterThan(ticks[i - 1]!.x);
    }
  });
});

describe('generateTicks (millimeters and picas)', () => {
  it('mm majors number centimeters; pica majors number picas', () => {
    const mmMajors = generateTicks(816, 'millimeters').filter((t) => t.kind === 'major');
    expect(mmMajors[1]!.x).toBe(38); // 1cm
    expect(mmMajors[1]!.label).toBe(1);
    const pcMajors = generateTicks(816, 'picas').filter((t) => t.kind === 'major');
    expect(pcMajors[1]!.x).toBe(ptToPx(12)); // 1pc = 12pt = 16px
    expect(pcMajors[1]!.label).toBe(1);
  });
});

describe('tickKindForStep (negative-safe phase)', () => {
  it('classifies minor-grid indices across the whole cycle', () => {
    expect(tickKindForStep(0, 'inches')).toBe('major');
    expect(tickKindForStep(4, 'inches')).toBe('medium');
    expect(tickKindForStep(6, 'inches')).toBe('minor');
    expect(tickKindForStep(8, 'inches')).toBe('major');
  });

  it('stays phased for negative k — the grid extends LEFT of the page', () => {
    expect(tickKindForStep(-8, 'inches')).toBe('major');
    expect(tickKindForStep(-4, 'inches')).toBe('medium');
    expect(tickKindForStep(-1, 'inches')).toBe('minor');
  });
});

describe('majorLabelForStep', () => {
  it('labels majors 0-based from the page edge, negative-safe', () => {
    expect(majorLabelForStep(0, 'inches')).toBe(0);
    expect(majorLabelForStep(8, 'inches')).toBe(1);
    expect(majorLabelForStep(-8, 'inches')).toBe(-1);
  });
});

describe('snapToMinor', () => {
  it('snaps to the nearest 1/8-inch minor tick (12px steps)', () => {
    expect(snapToMinor(50, 'inches')).toBe(48);
    expect(snapToMinor(55, 'inches')).toBe(60);
    expect(snapToMinor(52, 'inches')).toBe(48);
    expect(snapToMinor(0, 'inches')).toBe(0);
  });

  it('snaps in the unit\u2019s own minor step', () => {
    expect(snapToMinor(9, 'centimeters')).toBe(8); // 1mm rounds to 4px steps
    expect(snapToMinor(30, 'picas')).toBe(32); // 3pt = 4px steps
  });
});

describe('clampMarginSpan', () => {
  const W = 816;
  const MIN = ptToPx(MIN_CONTENT_WIDTH_PT); // 48px = 0.5"

  it('leaves a healthy span untouched', () => {
    expect(clampMarginSpan(0, W, W)).toEqual([0, W]);
    expect(clampMarginSpan(96, 720, W)).toEqual([96, 720]);
  });

  it('clamps edges into the page', () => {
    expect(clampMarginSpan(-20, 400, W)).toEqual([0, 400]);
    expect(clampMarginSpan(100, W + 44, W)).toEqual([100, W]);
  });

  it('enforces the minimum content width, dragged edge winning', () => {
    // Left dragged onto right: right yields to the span floor.
    expect(clampMarginSpan(400, 400, W)).toEqual([400, 400 + MIN]);
    // Left pushed to the far right: left yields to the page.
    expect(clampMarginSpan(790, 800, W)).toEqual([W - MIN, W]);
  });
});

describe('formatPxAsUnit', () => {
  it('renders engine px in the display unit via the shared formatter', () => {
    expect(formatPxAsUnit(96, 'inches')).toBe('1');
    expect(formatPxAsUnit(48, 'inches')).toBe('0.5');
    expect(formatPxAsUnit(37.795, 'centimeters')).toBe('1');
    expect(formatPxAsUnit(72, 'points')).toBe('54');
  });
});

describe('Ruler (integration, FakeMetrics geometry)', () => {
  it('renders the bar with margin markers at the real content box', async () => {
    renderTensor();
    await settleLayout();
    // GEOMETRY: Letter @ 72pt margins → contentX 96, contentR 720. The
    // margin handles are FULL bar-height columns centered on the edges.
    const left = document.querySelector('[data-testid="ruler-margin-left"]') as HTMLElement;
    const right = document.querySelector('[data-testid="ruler-margin-right"]') as HTMLElement;
    expect(left).not.toBeNull();
    expect(left.style.left).toBe(`${GEOMETRY.contentX}px`);
    expect(right.style.left).toBe(
      `${GEOMETRY.contentX + GEOMETRY.contentWidth}px`,
    );
  });

  it('mounts as static overlay chrome pinned to the desk wrapper', async () => {
    renderTensor();
    await settleLayout();
    const bar = document.querySelector('[data-testid="ruler"]') as HTMLElement;
    expect(bar.style.height).toBe(`${RULER_HEIGHT}px`);
    expect(bar.className).toContain('absolute');
    expect(bar.className).toContain('top-0');
    // The portal lands the bar INSIDE the desk wrapper — outside the
    // scroll flow, flush under the ribbon by construction.
    expect(bar.parentElement?.hasAttribute('data-desk-wrapper')).toBe(true);
    const inner = document.querySelector('[data-testid="ruler-inner"]') as HTMLElement;
    expect(inner.style.width).toBe(`${GEOMETRY.pageWidth}px`);
    // jsdom's scroller clientWidth is 0 → the page strip sits at left 0.
    expect(inner.style.left).toBe('0px');
  });

  it('projects the caret paragraph\u2019s indent attrs onto the markers', async () => {
    const { editor } = renderTensor(
      '<p style="padding-left: 64px; text-indent: 32px">Indented prose.</p>',
    );
    await settleLayout();
    editor.commands.setTextSelection(1); // deterministically inside the paragraph
    await settleLayout();
    const box = document.querySelector('[data-testid="ruler-indent-left"]') as HTMLElement;
    const first = document.querySelector('[data-testid="ruler-indent-first"]') as HTMLElement;
    const right = document.querySelector('[data-testid="ruler-indent-right"]') as HTMLElement;
    // indentLeft 64px → box at 96+64=160; first-line +32 → apex at 192;
    // indentRight 0 → apex at the content right edge (720).
    expect(box.style.left).toBe(`${GEOMETRY.contentX + 64}px`);
    expect(first.style.left).toBe(`${GEOMETRY.contentX + 64 + 32 - 6}px`);
    expect(right.style.left).toBe(`${GEOMETRY.contentX + GEOMETRY.contentWidth - 6}px`);
  });

  it('drops indent markers when the caret block carries none (heading)', async () => {
    const { editor } = renderTensor('<h1>Heading</h1><p>Body text.</p>');
    await settleLayout();
    editor.commands.setTextSelection(1); // inside the heading
    await settleLayout();
    expect(document.querySelector('[data-testid="ruler-indent-left"]')).toBeNull();
    expect(document.querySelector('[data-testid="ruler-indent-first"]')).toBeNull();
    // Margins are never model-dependent.
    expect(document.querySelector('[data-testid="ruler-margin-left"]')).not.toBeNull();
  });

  it('follows selection moves between paragraphs of different indents', async () => {
    const { editor } = renderTensor(
      '<p>First.</p><p style="padding-left: 64px">Second.</p>',
    );
    await settleLayout();
    // setContent leaves the caret at the END of the content (inside the
    // indented paragraph) — anchor it in paragraph 1 deterministically.
    editor.commands.setTextSelection(1);
    await settleLayout();
    // Caret in paragraph 1: no indent → box at the content edge.
    let box = document.querySelector('[data-testid="ruler-indent-left"]') as HTMLElement;
    expect(box.style.left).toBe(`${GEOMETRY.contentX}px`);
    // Move into paragraph 2 → the box follows in the same commit.
    const pos = editor.state.doc.child(0).nodeSize + 1;
    act(() => {
      editor.view.dispatch(
        editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)),
      );
    });
    box = document.querySelector('[data-testid="ruler-indent-left"]') as HTMLElement;
    expect(box.style.left).toBe(`${GEOMETRY.contentX + 64}px`);
  });

  it('respects the Show Ruler toggle (off → no ruler at all)', async () => {
    useConfigStore.getState().setBothRulers(false);
    renderTensor();
    await settleLayout();
    expect(document.querySelector('[data-testid="ruler"]')).toBeNull();
  });

  it('paints ticks and labels on the canvas (recorded ops)', async () => {
    renderTensor();
    await settleLayout();
    const ops = (globalThis as unknown as {
      __paintOps: Array<{ op: string; args: unknown[] }>;
    }).__paintOps;
    ops.length = 0;
    // Force a repaint by cycling the ruler off and back on.
    act(() => {
      useConfigStore.getState().setBothRulers(false);
    });
    act(() => {
      useConfigStore.getState().setBothRulers(true);
    });
    await settleLayout();
    const texts = ops.filter((o) => o.op === 'fillText').map((o) => o.args[0]);
    // Major labels 0..8 for Letter in inches.
    for (const label of ['0', '1', '2', '3', '4', '5', '6', '7', '8']) {
      expect(texts).toContain(label);
    }
    // Ticks + the muted texture ride fillRect.
    expect(ops.some((o) => o.op === 'fillRect')).toBe(true);
    // Label knockouts: a ruler-background box (12px tall) sits behind
    // every number so the tick lines stop around the digits.
    expect(ops.some((o) => o.op === 'fillRect' && o.args[3] === 12)).toBe(true);
  });

  it('repaints when the theme flips (canvas colors are paint-time reads)', async () => {
    renderTensor();
    await settleLayout();
    const ops = (globalThis as unknown as {
      __paintOps: Array<{ op: string; args: unknown[] }>;
    }).__paintOps;
    ops.length = 0;
    // The bar subscribes to the theme: a light/dark flip must re-run the
    // paint (canvas fillStyle can't follow live CSS by itself).
    act(() => {
      useConfigStore.getState().setTheme('dark');
    });
    await settleLayout();
    expect(ops.some((o) => o.op === 'fillText')).toBe(true);
    act(() => {
      useConfigStore.getState().setTheme('light');
    });
  });
});

// ─── Phase 2: margin dragging (two write modes on Reduce Motion) ─────

describe('margin dragging', () => {
  // This suite pins the PREVIEW mode (Reduce Motion on); the live-mode
  // test below overrides to 'off'.
  beforeEach(() => {
    useConfigStore.getState().setReduceMotion('on');
  });

  async function flushFrame() {
    await act(async () => {
      await new Promise<void>((resolve) => {
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => resolve());
        } else {
          resolve();
        }
      });
    });
  }

  function grabber(side: 'left' | 'right'): HTMLElement {
    const el = document.querySelector(
      `[data-testid="ruler-margin-${side}"]`,
    ) as HTMLElement;
    if (!el) throw new Error(`missing ruler-margin-${side} grabber`);
    return el;
  }

  it('drags the left margin: snapped preview, ONE commit on release', async () => {
    renderTensor('<p>Prose.</p>');
    await settleLayout();
    // Count pageSetup writes directly — setContent already marked the
    // doc dirty, so isDirty can't pin "no write mid-gesture".
    let writes = 0;
    let prev = useDocumentStore.getState().pageSetup;
    const unsub = useDocumentStore.subscribe((s) => {
      if (s.pageSetup !== prev) {
        writes++;
        prev = s.pageSetup;
      }
    });
    const el = grabber('left');
    act(() => {
      fireEvent.pointerDown(el, { clientX: 100, button: 0 });
      fireEvent.pointerMove(el, { clientX: 148 }); // +48px = 4 minor steps
    });
    // PREVIEW: the store is untouched mid-gesture; the grabber rides the
    // draft edge and the badge shows the live value in the unit.
    expect(useDocumentStore.getState().pageSetup.margins.left).toBe(72);
    expect(writes).toBe(0);
    expect(el.style.left).toBe('144px'); // 96 + 48 = 144 (on-grid)
    const badge = document.querySelector('[data-testid="ruler-drag-badge"]');
    expect(badge?.textContent).toContain('1.5 in'); // 144px = 1.5"
    // COMMIT: exactly one write, at release.
    act(() => {
      fireEvent.pointerUp(el, { clientX: 148 });
    });
    expect(writes).toBe(1);
    expect(useDocumentStore.getState().pageSetup.margins.left).toBe(108); // 144px = 108pt
    unsub();
    await settleLayout();
    // Post-commit: fresh geometry drives the handle; no badge residue.
    expect(grabber('left').style.left).toBe('144px');
    expect(document.querySelector('[data-testid="ruler-drag-badge"]')).toBeNull();
  });

  it('clamps drags to the minimum content span and the page', async () => {
    renderTensor('<p>Prose.</p>');
    await settleLayout();
    const el = grabber('left');
    act(() => {
      fireEvent.pointerDown(el, { clientX: 100, button: 0 });
      fireEvent.pointerMove(el, { clientX: 1100 }); // way past the page
      fireEvent.pointerUp(el, { clientX: 1100 });
    });
    const { margins } = useDocumentStore.getState().pageSetup;
    // 768px = 576pt: the 0.5" content floor (page 816px − 48px).
    expect(margins.left).toBe(576);
    expect(margins.right).toBe(72); // the other edge untouched
  });

  it('Alt-held moves skip tick snapping (fine drag)', async () => {
    renderTensor('<p>Prose.</p>');
    await settleLayout();
    const el = grabber('left');
    act(() => {
      fireEvent.pointerDown(el, { clientX: 100, button: 0 });
      // +47px → 143px: off the 12px grid — commits as-is (rounded pt).
      fireEvent.pointerMove(el, { clientX: 147, altKey: true });
      fireEvent.pointerUp(el, { clientX: 147 });
    });
    expect(useDocumentStore.getState().pageSetup.margins.left).toBe(107); // 143px = 107.25pt
  });

  it('drags the right margin symmetrically', async () => {
    renderTensor('<p>Prose.</p>');
    await settleLayout();
    const el = grabber('right');
    act(() => {
      fireEvent.pointerDown(el, { clientX: 100, button: 0 });
      fireEvent.pointerMove(el, { clientX: 52 }); // −48px → 672
      fireEvent.pointerUp(el, { clientX: 52 });
    });
    const { margins } = useDocumentStore.getState().pageSetup;
    expect(margins.right).toBe(108); // 816 − 672 = 144px = 108pt
    expect(margins.left).toBe(72); // untouched
  });

  it('double-click over a margin region opens the MarginsDialog; the content area does not', async () => {
    renderTensor('<p>Prose.</p>');
    await settleLayout();
    const bar = document.querySelector('[data-testid="ruler"]') as HTMLElement;
    act(() => {
      fireEvent.doubleClick(bar, { clientX: 40 }); // the left margin span (0..96)
    });
    expect(useDocumentPropertiesStore.getState().marginsIsOpen).toBe(true);
    act(() => {
      useDocumentPropertiesStore.getState().closeMargins();
      fireEvent.doubleClick(bar, { clientX: 300 }); // inside the content box
    });
    expect(useDocumentPropertiesStore.getState().marginsIsOpen).toBe(false);
  });

  it('Reduce Motion OFF: the document reflows under the drag (live commits)', async () => {
    useConfigStore.getState().setReduceMotion('off');
    renderTensor('<p>Prose.</p>');
    await settleLayout();
    let writes = 0;
    let prev = useDocumentStore.getState().pageSetup;
    const unsub = useDocumentStore.subscribe((s) => {
      if (s.pageSetup !== prev) {
        writes++;
        prev = s.pageSetup;
      }
    });
    const el = grabber('left');
    act(() => {
      fireEvent.pointerDown(el, { clientX: 100, button: 0 });
      fireEvent.pointerMove(el, { clientX: 148 }); // +48px = 4 minor steps
    });
    await flushFrame();
    // Mid-gesture: the document ALREADY holds the draft (live mode).
    expect(useDocumentStore.getState().pageSetup.margins.left).toBe(108);
    expect(writes).toBe(1); // rAF-coalesced: ≤ one write per frame
    act(() => {
      fireEvent.pointerUp(el, { clientX: 148 });
    });
    // The release commit is idempotent — no redundant dirty churn.
    expect(writes).toBe(1);
    unsub();
  });

  it('reflects dialog-driven margin changes (the MarginsDialog Apply path)', async () => {
    renderTensor('<p>Prose.</p>');
    await settleLayout();
    // Exactly what MarginsDialog.apply() does: ONE setPageSetup call.
    act(() => {
      const ps = useDocumentStore.getState().pageSetup;
      useDocumentStore.getState().setPageSetup({
        ...ps,
        margins: { ...ps.margins, left: 144 }, // 2"
      });
    });
    await settleLayout();
    // The page reflows (contentX 96 → ptToPx(144) = 192) and the handle
    // follows in the same commit — one writer, two readers.
    expect(grabber('left').style.left).toBe(`${ptToPx(144)}px`);
    expect(grabber('right').style.left).toBe('720px'); // untouched
  });
});

// ─── Phase 3: tab stops (attr + ruler UI) ─────────────────────────────

describe('tab stops', () => {
  function tabStopsOf(editor: { state: { doc: import('@tiptap/pm/model').Node } }): number[] | null {
    const node = editor.state.doc.child(0);
    const stops = node.attrs.tabStops;
    return Array.isArray(stops) ? stops : null;
  }

  function tabMarkers(): HTMLElement[] {
    return [...document.querySelectorAll('[data-testid="ruler-tab-stop"]')] as HTMLElement[];
  }

  /** The click-add default: a left-aligned stop at `position`. */
  const leftStop = (position: number) => ({ position, alignment: 'left' as const });

  /** prosemirror-history merges adjacent transactions within its 500ms
   *  newGroupDelay — a test's rapid-fire chain (setContent included)
   *  would collapse into ONE undo step. A quiet gap splits the loaded
   *  document from the gesture, so one undo restores the loaded state
   *  (real sessions never hit the merge — minutes between load and
   *  drag). */
  async function undoBarrier() {
    await new Promise((resolve) => setTimeout(resolve, 550));
  }

  it('round-trips the attr through data-tab-stops (sorted, deduped, kinds kept)', async () => {
    const { editor } = renderTensor('<p data-tab-stops="192:center,96:right,96:left">A</p>');
    await settleLayout();
    expect(tabStopsOf(editor)).toEqual([
      { position: 96, alignment: 'right' },
      { position: 192, alignment: 'center' },
    ]);
    expect(editor.getHTML()).toContain('data-tab-stops="96:right,192:center"');
  });

  it('projects tabStops onto the semantic block (normalized; absent when empty)', async () => {
    const { editor } = renderTensor('<p data-tab-stops="192:center,96:right">A</p><p>B</p>');
    await settleLayout();
    // The SEMANTIC blocks (doc.blocks) carry it; the AdapterBlock
    // sidecar (blocks) doesn't. tabStops lives on the ParagraphBlock
    // arm of the Block union — narrow before reading.
    const { doc } = pmDocToSemantic(editor.state.doc, {
      fontFamily: 'system-ui',
      fontSize: 16,
    });
    expect(doc.blocks[0]!.kind).toBe('paragraph');
    expect((doc.blocks[0] as import('@tensor-editor/engine').ParagraphBlock).tabStops).toEqual([
      { position: 96, alignment: 'right' },
      { position: 192, alignment: 'center' },
    ]);
    expect((doc.blocks[1] as import('@tensor-editor/engine').ParagraphBlock).tabStops).toBeUndefined();
  });

  it('renders the caret block\u2019s stops at contentX + stop', async () => {
    const { editor } = renderTensor('<p data-tab-stops="96,192">A</p>');
    await settleLayout();
    editor.commands.setTextSelection(1); // inside paragraph A
    await settleLayout();
    const markers = tabMarkers();
    expect(markers).toHaveLength(2);
    expect(markers[0]!.style.left).toBe(`${GEOMETRY.contentX + 96}px`);
    expect(markers[1]!.style.left).toBe(`${GEOMETRY.contentX + 192}px`);
  });

  it('swaps the displayed stops when the caret moves between blocks', async () => {
    const { editor } = renderTensor('<p data-tab-stops="96">A</p><p>B</p>');
    await settleLayout();
    // setContent leaves the caret at the END — inside paragraph B (no stops).
    expect(tabMarkers()).toHaveLength(0);
    act(() => {
      editor.commands.setTextSelection(1); // paragraph A
    });
    await settleLayout();
    expect(tabMarkers()).toHaveLength(1);
  });

  it('adds a stop on a band click (snapped) — undoable', async () => {
    const { editor } = renderTensor('<p data-tab-stops="96,192">A</p>');
    await settleLayout();
    // Recorded history baseline (see undoBarrier).
    editor.commands.setTextSelection(1);
    await undoBarrier();
    const inner = document.querySelector('[data-testid="ruler-inner"]') as HTMLElement;
    // clientX 340 → page x 340 → raw stop 244 → snap(340) = 336 → stop 240.
    act(() => {
      fireEvent.pointerDown(inner, { clientX: 340, button: 0 });
      fireEvent.pointerUp(inner, { clientX: 340, button: 0 });
    });
    await settleLayout();
    expect(tabStopsOf(editor)).toEqual([leftStop(96), leftStop(192), leftStop(240)]);
    expect(tabMarkers()).toHaveLength(3);
    // PM transaction → undo restores the exact prior state.
    act(() => {
      editor.commands.undo();
    });
    await settleLayout();
    expect(tabStopsOf(editor)).toEqual([leftStop(96), leftStop(192)]);
    expect(tabMarkers()).toHaveLength(2);
  });

  it('ignores margin-span band clicks', async () => {
    const { editor } = renderTensor('<p data-tab-stops="96">A</p>');
    await settleLayout();
    const inner = document.querySelector('[data-testid="ruler-inner"]') as HTMLElement;
    act(() => {
      // x 40 → the left margin span; x 760 → beyond contentR (720).
      fireEvent.pointerDown(inner, { clientX: 40, button: 0 });
      fireEvent.pointerUp(inner, { clientX: 40, button: 0 });
      fireEvent.pointerDown(inner, { clientX: 760, button: 0 });
      fireEvent.pointerUp(inner, { clientX: 760, button: 0 });
    });
    expect(tabStopsOf(editor)).toEqual([leftStop(96)]);
  });

  it('drags a stop with preview and commits ONE undoable transaction', async () => {
    const { editor } = renderTensor('<p data-tab-stops="96,192">A</p>');
    await settleLayout();
    // Recorded history baseline (see undoBarrier).
    editor.commands.setTextSelection(1);
    await undoBarrier();
    const markers = tabMarkers();
    act(() => {
      fireEvent.pointerDown(markers[1]!, { clientX: 500, button: 0 });
      fireEvent.pointerMove(markers[1]!, { clientX: 548 }); // +48 → 240
    });
    // Preview: the doc is untouched mid-gesture; the marker rides the draft.
    expect(tabStopsOf(editor)).toEqual([leftStop(96), leftStop(192)]);
    expect(markers[1]!.style.left).toBe(`${GEOMETRY.contentX + 240}px`);
    act(() => {
      fireEvent.pointerUp(markers[1]!, { clientX: 548 });
    });
    await settleLayout();
    expect(tabStopsOf(editor)).toEqual([leftStop(96), leftStop(240)]);
    act(() => {
      editor.commands.undo();
    });
    await settleLayout();
    expect(tabStopsOf(editor)).toEqual([leftStop(96), leftStop(192)]);
  });

  it('dragging preserves the alignment kind', async () => {
    const { editor } = renderTensor('<p data-tab-stops="192:center">A</p>');
    await settleLayout();
    editor.commands.setTextSelection(1);
    await undoBarrier();
    const markers = tabMarkers();
    act(() => {
      fireEvent.pointerDown(markers[0]!, { clientX: 500, button: 0 });
      fireEvent.pointerMove(markers[0]!, { clientX: 548 }); // +48 → 240
      fireEvent.pointerUp(markers[0]!, { clientX: 548 });
    });
    await settleLayout();
    expect(tabStopsOf(editor)).toEqual([{ position: 240, alignment: 'center' }]);
  });

  it('the band context menu adds a stop with a chosen alignment', async () => {
    const { editor } = renderTensor('<p data-tab-stops="96">A</p>');
    await settleLayout();
    const inner = document.querySelector('[data-testid="ruler-inner"]') as HTMLElement;
    // Right-click at page x 340 → raw stop 244 → snap → 240.
    act(() => {
      fireEvent.contextMenu(inner, { clientX: 340, button: 2 });
    });
    const menu = document.querySelector('[data-testid="ruler-tab-menu"]');
    expect(menu).not.toBeNull();
    act(() => {
      fireEvent.click(
        document.querySelector('[data-testid="ruler-tab-menu-center"]')!,
      );
    });
    await settleLayout();
    expect(tabStopsOf(editor)).toEqual([
      leftStop(96),
      { position: 240, alignment: 'center' },
    ]);
    // The menu closes after acting.
    expect(document.querySelector('[data-testid="ruler-tab-menu"]')).toBeNull();
  });

  it('M-T4: the band context menu does NOT also open the app context menu (portal-bubble isolation)', async () => {
    renderTensor('<p data-tab-stops="96">A</p>');
    await settleLayout();
    const inner = document.querySelector('[data-testid="ruler-inner"]') as HTMLElement;
    act(() => {
      fireEvent.contextMenu(inner, { clientX: 340, button: 2 });
    });
    // The ruler's own menu opened…
    expect(document.querySelector('[data-testid="ruler-tab-menu"]')).not.toBeNull();
    // …and the DOCUMENT context menu did NOT co-open (the ruler portals
    // out of PaginatedView, so its synthetic contextmenu bubbles through
    // the React tree into the app menu's trigger — the band handler's
    // stopPropagation is the seam).
    expect(document.querySelector('[data-testid="ctx-select-all"]')).toBeNull();
    expect(document.querySelector('[data-testid="ctx-paste"]')).toBeNull();
  });

  it('the stop context menu re-aligns and removes', async () => {
    const { editor } = renderTensor('<p data-tab-stops="96:left,192:right">A</p>');
    await settleLayout();
    const marker = tabMarkers()[0]!;
    act(() => {
      fireEvent.contextMenu(marker, { button: 2 });
    });
    act(() => {
      fireEvent.click(
        document.querySelector('[data-testid="ruler-tab-menu-right"]')!,
      );
    });
    await settleLayout();
    expect(tabStopsOf(editor)).toEqual([
      { position: 96, alignment: 'right' },
      { position: 192, alignment: 'right' },
    ]);
    // Remove the other one via its own menu (separate act blocks: the menu
    // renders after the contextMenu's state commit).
    act(() => {
      fireEvent.contextMenu(tabMarkers()[1]!, { button: 2 });
    });
    act(() => {
      fireEvent.click(
        document.querySelector('[data-testid="ruler-tab-menu-remove"]')!,
      );
    });
    await settleLayout();
    expect(tabStopsOf(editor)).toEqual([{ position: 96, alignment: 'right' }]);
  });

  it('removes a stop dragged out of the content band', async () => {
    const { editor } = renderTensor('<p data-tab-stops="96,192">A</p>');
    await settleLayout();
    // Recorded history baseline (see undoBarrier).
    editor.commands.setTextSelection(1);
    await undoBarrier();
    const markers = tabMarkers();
    act(() => {
      fireEvent.pointerDown(markers[0]!, { clientX: 500, button: 0 });
      fireEvent.pointerMove(markers[0]!, { clientX: 250 }); // raw −250 < 0
      fireEvent.pointerUp(markers[0]!, { clientX: 250 });
    });
    await settleLayout();
    expect(tabStopsOf(editor)).toEqual([leftStop(192)]);
    act(() => {
      editor.commands.undo();
    });
    await settleLayout();
    expect(tabStopsOf(editor)).toEqual([leftStop(96), leftStop(192)]);
  });

  it('applies to every selected paragraph (Word semantics)', async () => {
    const { editor } = renderTensor('<p>A</p><p>B</p>');
    await settleLayout();
    act(() => {
      editor.commands.setTextSelection({
        from: 1,
        to: editor.state.doc.content.size - 1,
      });
    });
    const inner = document.querySelector('[data-testid="ruler-inner"]') as HTMLElement;
    act(() => {
      fireEvent.pointerDown(inner, { clientX: 192, button: 0 }); // stop 96
      fireEvent.pointerUp(inner, { clientX: 192, button: 0 });
    });
    await settleLayout();
    expect(editor.state.doc.child(0).attrs.tabStops).toEqual([leftStop(96)]);
    expect(editor.state.doc.child(1).attrs.tabStops).toEqual([leftStop(96)]);
  });
});
// ─── Phase 5: the vertical ruler ──────────────────────────────────────

describe('vertical ruler', () => {
  beforeEach(() => {
    // The drag pins PREVIEW mode (the Reduce Motion ruling).
    useConfigStore.getState().setReduceMotion('on');
  });

  it('mounts INSIDE the paginated root as page-attached chrome (scrolls with the doc)', async () => {
    renderTensor('<p>hello world</p>');
    await settleLayout();
    const bar = document.querySelector('[data-testid="ruler-vertical"]') as HTMLElement;
    expect(bar).not.toBeNull();
    // Wrapper-FIXED law: the bar is viewport chrome in the desk wrapper
    // (the same overlay the horizontal portals into) — inset-y-0, so
    // the background spans the container at every scroll position.
    expect(bar.closest('[data-desk-wrapper]')).not.toBeNull();
    expect(bar.className).toContain('inset-y-0');
    expect(bar.style.width).toBe(`${RULER_WIDTH}px`);
    // Window-anchored left edge (scrollLeft 0 in jsdom).
    expect(bar.style.left).toBe('0px');
  });

  it('the scale translates with scroll (viewport-fixed bar, page-attached ticks)', async () => {
    // Two page-filling paragraphs → 2 pages (the interaction suite's
    // fixture shape).
    const fill = GEOMETRY.charsPerLine * GEOMETRY.linesPerPage;
    renderTensor(`<p>${'a'.repeat(fill)}</p><p>${'b'.repeat(fill)}</p>`);
    await settleLayout();
    const ops = (globalThis as unknown as {
      __paintOps: Array<{ op: string; args: unknown[] }>;
    }).__paintOps;
    ops.length = 0;
    // jsdom has no layout: pin the scroll position the listener reads,
    // then dispatch the scroll the scroller would emit.
    const scroller = document.querySelector('[data-desk-scroll]') as HTMLElement;
    Object.defineProperty(scroller, 'scrollTop', { value: 500, configurable: true });
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    await settleLayout();
    // Page 1's top rail (stack y 1088 + content 96) paints at
    // padTop(0) + 1184 − 500 = 684 — the tick field moved WITH the
    // pages while the bar stayed fixed.
    const rail = ops.find(
      (o) => o.op === 'fillRect' && o.args[1] === 684 && o.args[3] === 1,
    );
    expect(rail).toBeTruthy();
  });

  it('renders per-page margin handles at the real content box', async () => {
    renderTensor('<p>hello world</p>');
    await settleLayout();
    const top = document.querySelector('[data-testid="ruler-vertical-top"]') as HTMLElement;
    const bottom = document.querySelector('[data-testid="ruler-vertical-bottom"]') as HTMLElement;
    // contentY 96 / contentB 960 (canvas-relative == page-relative).
    expect(top.style.top).toBe('96px');
    expect(bottom.style.top).toBe(`${GEOMETRY.contentY + GEOMETRY.contentHeight}px`);
  });

  it('paints the vertical rails on the canvas (recorded ops)', async () => {
    renderTensor('<p>hello world</p>');
    await settleLayout();
    const ops = (globalThis as unknown as {
      __paintOps: Array<{ op: string; args: unknown[] }>;
    }).__paintOps;
    ops.length = 0;
    act(() => {
      useConfigStore.getState().setBothRulers(false);
    });
    act(() => {
      useConfigStore.getState().setBothRulers(true);
    });
    await settleLayout();
    // The top rail: a 1px-tall full-width line at the content edge (96).
    const rail = ops.find(
      (o) => o.op === 'fillRect' && o.args[1] === 96 && o.args[3] === 1,
    );
    expect(rail).toBeTruthy();
    // The number knockouts: 12px-tall bar-background boxes behind the
    // upright labels (the horizontal's treatment).
    expect(ops.some((o) => o.op === 'fillRect' && o.args[3] === 12)).toBe(true);
  });

  it('drags the top margin with snapping and commits on release', async () => {
    renderTensor('<p>hello world</p>');
    await settleLayout();
    let writes = 0;
    let prev = useDocumentStore.getState().pageSetup;
    const unsub = useDocumentStore.subscribe((s) => {
      if (s.pageSetup !== prev) {
        writes++;
        prev = s.pageSetup;
      }
    });
    const handle = document.querySelector('[data-testid="ruler-vertical-top"]') as HTMLElement;
    act(() => {
      fireEvent.pointerDown(handle, { clientY: 200, button: 0 });
      fireEvent.pointerMove(handle, { clientY: 248 }); // +48px = 4 minor steps
    });
    // PREVIEW: no store write mid-gesture; the handle rides the draft.
    expect(useDocumentStore.getState().pageSetup.margins.top).toBe(72);
    expect(writes).toBe(0);
    expect(handle.style.top).toBe('144px'); // 96 + 48
    act(() => {
      fireEvent.pointerUp(handle, { clientY: 248 });
    });
    expect(writes).toBe(1);
    expect(useDocumentStore.getState().pageSetup.margins.top).toBe(108); // 144px = 108pt
    expect(useDocumentStore.getState().pageSetup.margins.bottom).toBe(72); // untouched
    unsub();
    await settleLayout();
    expect(
      (document.querySelector('[data-testid="ruler-vertical-top"]') as HTMLElement).style.top,
    ).toBe('144px');
  });

  it('reflects dialog-driven top-margin changes', async () => {
    renderTensor('<p>hello world</p>');
    await settleLayout();
    act(() => {
      const ps = useDocumentStore.getState().pageSetup;
      useDocumentStore.getState().setPageSetup({
        ...ps,
        margins: { ...ps.margins, top: 144 }, // 2"
      });
    });
    await settleLayout();
    const top = document.querySelector('[data-testid="ruler-vertical-top"]') as HTMLElement;
    expect(top.style.top).toBe(`${ptToPx(144)}px`);
  });
});

// ─── indent dragging (the markers' handles) ───────────────────────────

describe('indent dragging', () => {
  beforeEach(() => {
    // PM attrs: ALWAYS preview + commit (the tab-stop ruling).
  });

  function indentMarker(which: 'first' | 'left' | 'right'): HTMLElement {
    const el = document.querySelector(
      `[data-testid="ruler-indent-${which}"]`,
    ) as HTMLElement;
    if (!el) throw new Error(`missing ruler-indent-${which}`);
    return el;
  }

  it('drags the left box +48 → indentLeft (undoable, one step)', async () => {
    const { editor } = renderTensor('<p>hello world</p>');
    await settleLayout();
    editor.commands.setTextSelection(1);
    await new Promise((resolve) => setTimeout(resolve, 550)); // undoBarrier
    const el = indentMarker('left');
    act(() => {
      fireEvent.pointerDown(el, { clientX: 100, button: 0 });
      fireEvent.pointerMove(el, { clientX: 148 }); // +48 → marker at 144
    });
    // PREVIEW: the attr is untouched mid-gesture; the marker rides the draft.
    expect(editor.getAttributes('paragraph').indentLeft).toBe(0);
    expect(el.style.left).toBe(`${GEOMETRY.contentX + 48}px`);
    act(() => {
      fireEvent.pointerUp(el, { clientX: 148 });
    });
    await settleLayout();
    expect(editor.getAttributes('paragraph').indentLeft).toBe(48);
    act(() => {
      editor.commands.undo();
    });
    await settleLayout();
    expect(editor.getAttributes('paragraph').indentLeft).toBe(0);
  });

  it('drags the first-line triangle; the hanging limit clamps at \u2212indentLeft', async () => {
    const { editor } = renderTensor('<p>hello world</p>');
    await settleLayout();
    editor.commands.setTextSelection(1);
    await new Promise((resolve) => setTimeout(resolve, 550));
    const el = indentMarker('first');
    // +36 lands on the tick grid (96 + 36 = 132 = 11 × 12).
    act(() => {
      fireEvent.pointerDown(el, { clientX: 100, button: 0 });
      fireEvent.pointerMove(el, { clientX: 136 });
      fireEvent.pointerUp(el, { clientX: 136 });
    });
    await settleLayout();
    expect(editor.getAttributes('paragraph').firstLineIndent).toBe(36);
    // Now drag LEFT far past the content edge: the hanging limit is
    // −indentLeft (0) — the engine's negative-left-edge guard.
    act(() => {
      fireEvent.pointerDown(el, { clientX: 100, button: 0 });
      fireEvent.pointerMove(el, { clientX: -500 });
      fireEvent.pointerUp(el, { clientX: -500 });
    });
    await settleLayout();
    expect(editor.getAttributes('paragraph').firstLineIndent).toBe(0);
  });

  it('drags the right marker symmetrically (inverted delta)', async () => {
    const { editor } = renderTensor('<p>hello world</p>');
    await settleLayout();
    editor.commands.setTextSelection(1);
    await new Promise((resolve) => setTimeout(resolve, 550));
    const el = indentMarker('right');
    // The marker sits at contentR (720) — dragging LEFT by 48 grows
    // indentRight to 48 (the delta inverts).
    act(() => {
      fireEvent.pointerDown(el, { clientX: 100, button: 0 });
      fireEvent.pointerMove(el, { clientX: 52 });
      fireEvent.pointerUp(el, { clientX: 52 });
    });
    await settleLayout();
    expect(editor.getAttributes('paragraph').indentRight).toBe(48);
    expect(editor.getAttributes('paragraph').indentLeft).toBe(0); // untouched
  });

  it('applies to every selected paragraph (Word semantics)', async () => {
    const { editor } = renderTensor('<p>A</p><p>B</p>');
    await settleLayout();
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });
    });
    const el = indentMarker('left');
    act(() => {
      fireEvent.pointerDown(el, { clientX: 100, button: 0 });
      fireEvent.pointerMove(el, { clientX: 148 });
      fireEvent.pointerUp(el, { clientX: 148 });
    });
    await settleLayout();
    expect(editor.state.doc.child(0).attrs.indentLeft).toBe(48);
    expect(editor.state.doc.child(1).attrs.indentLeft).toBe(48);
  });
});
