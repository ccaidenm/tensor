import { act } from '@testing-library/react';
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
} from '@/lib/paginated/ruler';
import { ptToPx } from '@/lib/document/pageSetup';
import { useConfigStore } from '@/lib/config/store';
import { useDocumentStore } from '@/lib/document/store';
import { GEOMETRY, renderTensor, settleLayout } from './harness';

// The module-level config/document stores leak across suites (the
// ARCHITECTURE.md gotcha) — restore the defaults before every test.
beforeEach(() => {
  useConfigStore.getState().setShowRuler(true);
  useDocumentStore.setState({
    pageSetup: {
      pageSize: 'Letter',
      margins: { top: 72, bottom: 72, left: 72, right: 72 },
      pageGap: 32,
    },
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
    // GEOMETRY: Letter @ 72pt margins → contentX 96, contentR 720.
    const left = document.querySelector('[data-testid="ruler-margin-left"]') as HTMLElement;
    const right = document.querySelector('[data-testid="ruler-margin-right"]') as HTMLElement;
    expect(left).not.toBeNull();
    expect(left.style.left).toBe(`${GEOMETRY.contentX - 4.5}px`);
    expect(right.style.left).toBe(
      `${GEOMETRY.contentX + GEOMETRY.contentWidth - 4.5}px`,
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
    useConfigStore.getState().setShowRuler(false);
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
      useConfigStore.getState().setShowRuler(false);
    });
    act(() => {
      useConfigStore.getState().setShowRuler(true);
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