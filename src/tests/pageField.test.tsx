import { describe, it, expect } from 'vitest';
import { act } from '@testing-library/react';
import { renderTensor, renderTensorInScrollContainer, settleLayout, dataEvent } from './harness';
import { pmDocToSemantic } from '@/lib/paginated/adapter';
import { paintLines } from '@/lib/paginated/paint';
import { pmPosToBlockOffset, blockOffsetToPmPos } from '@/lib/paginated/positionMap';
import { insertPageField } from '@/lib/editor/PageFieldNode';
import type { LineBox, Run } from '@tensor-editor/engine';

/**
 * #34 — the page-number field: the PM node is a MARKER (never carrying
 * a resolved value); the adapter measures it at the warm total's
 * max-width digits; the PAINT resolves per page (the pages field draws
 * exactly the placeholder; the page field right-anchors in its slot).
 */

const BASE = { fontFamily: 'system-ui', fontSize: 16 };

function lastBlock(r: ReturnType<typeof pmDocToSemantic>) {
  return r.blocks[r.blocks.length - 1]!;
}

describe('pageField — the adapter', () => {
  it('a field in a band paragraph emits a marker run measured at the warm total', () => {
    const { editor } = renderTensor(
      '<div data-header-footer="header"><p>Page </p></div>',
    );
    // Insert the field into the band paragraph (the schema-legal way:
    // at the caret inside the band paragraph).
    const headerPara = editor.state.doc.content.firstChild!.firstChild!;
    const pos = 2; // inside the band paragraph's text end
    editor.chain().focus().insertContentAt(pos, { type: 'pageField', attrs: { kind: 'page' } }).run();

    const adapted = pmDocToSemantic(editor.state.doc, BASE, undefined, undefined, undefined, 12);
    const runs = lastBlock(adapted).runs as Run[];
    const fieldRun = runs.find((r) => (r as { fieldKind?: string }).fieldKind === 'page') as
      | (Run & { fieldKind?: string; text: string })
      | undefined;
    expect(fieldRun).toBeTruthy();
    // the placeholder is the WARM TOTAL's digits (12 → '12')
    expect(fieldRun!.text).toBe('12');
    void headerPara;
  });

  it('the pages field measures the same placeholder with kind=pages', () => {
    const { editor } = renderTensor(
      '<div data-header-footer="footer"><p>of </p></div>',
    );
    editor.chain().focus().insertContentAt(4, { type: 'pageField', attrs: { kind: 'pages' } }).run();

    const adapted = pmDocToSemantic(editor.state.doc, BASE, undefined, undefined, undefined, 12);
    const runs = lastBlock(adapted).runs as Run[];
    const fieldRun = runs.find((r) => (r as { fieldKind?: string }).fieldKind === 'pages') as
      | (Run & { text: string })
      | undefined;
    expect(fieldRun!.text).toBe('12');
  });

  it('cold start (no warm total) measures one digit; the fixpoint widens', () => {
    const { editor } = renderTensor('<div data-header-footer="header"><p></p></div>');
    editor.chain().focus().insertContentAt(2, { type: 'pageField', attrs: { kind: 'page' } }).run();

    const adapted = pmDocToSemantic(editor.state.doc, BASE);
    const runs = lastBlock(adapted).runs as Run[];
    const fieldRun = runs.find((r) => (r as { fieldKind?: string }).fieldKind) as
      | (Run & { text: string })
      | undefined;
    expect(fieldRun!.text).toBe('8');
  });

  it('the field survives copy/paste (PM\u2019s own clipboard handlers)', async () => {
    const { editor } = renderTensorInScrollContainer('<p>Page</p>');
    await settleLayout();
    // PM drops a trailing block-end space at parse, so the inside-end
    // position is 5 (the insert lands before the paragraph close).
    editor.commands.insertContentAt(5, { type: 'pageField', attrs: { kind: 'page' } });
    // select 'Page ' + the field (positions: 1..5 text, 6 the atom)
    editor.commands.setTextSelection({ from: 1, to: 6 });
    console.log('PRECOPY_DOC=' + JSON.stringify(editor.getJSON().content));
    const dom = editor.view.dom as HTMLElement;
    const dt = new DataTransfer();
    act(() => {
      dom.dispatchEvent(dataEvent('copy', { clipboardData: dt }));
    });
    if (!dt.getData('text/html').includes('data-page-field')) {
      throw new Error('HTML=' + dt.getData('text/html'));
    }
    expect(dt.getData('text/plain')).toContain('{PAGE}');

    // paste into a fresh paragraph → the field survives
    editor.commands.setContent('<p>target </p>');
    editor.commands.setTextSelection(8);
    const dt2 = new DataTransfer();
    dt2.setData('text/html', dt.getData('text/html'));
    act(() => {
      dom.dispatchEvent(dataEvent('paste', { clipboardData: dt2 }));
    });
    await settleLayout();
    let found = false;
    editor.state.doc.descendants((n) => {
      if (n.type.name === 'pageField') found = true;
      return true;
    });
    expect(found).toBe(true);
  });
});

describe('pageField — the position mapping (selectability)', () => {
  it('selection maps THROUGH the field (the atom is 1 PM position; the placeholder is N chars)', async () => {
    const { editor } = renderTensor('<div data-header-footer="footer"><p>Page</p></div>');
    await settleLayout();
    // the caret at the paragraph END — the field appends: 'Page' + atom.
    editor.commands.setTextSelection(5);
    insertPageField(editor, 'page');
    await settleLayout();

    // A WARM TOTAL of 12: the placeholder is '12' (2 chars) while the
    // atom is ONE PM position — the divergence the mapping must fold.
    const adapted = pmDocToSemantic(editor.state.doc, BASE, undefined, undefined, undefined, 12);
    let atomPos = 0;
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === 'pageField' && atomPos === 0) atomPos = pos;
      return true;
    });
    // the band paragraph rides BOTH blocks and bandBlocks (pushBand).
    const block = adapted.blocks.find((b) =>
      b.runs.some((r) => (r as { fieldKind?: string }).fieldKind != null)
    )!;
    // block text: 'Page' + '12' (6 chars) — the placeholder rides.
    expect(block.text).toBe('Page12');

    // The atom's PM position maps to the placeholder START and
    // round-trips exactly.
    const atomBo = pmPosToBlockOffset(adapted.blocks, atomPos)!;
    expect(atomBo.offset).toBe(4); // '1' of '12'
    expect(blockOffsetToPmPos(atomBo.block, atomBo.offset)).toBe(atomPos);

    // BEFORE the field: identity (unchanged prefix).
    const before = pmPosToBlockOffset(adapted.blocks, atomPos - 1)!;
    expect(blockOffsetToPmPos(before.block, before.offset)).toBe(atomPos - 1);

    // AFTER the field: the PM position past the atom round-trips
    // exactly (a selection spanning the field reaches the paragraph end).
    const after = atomPos + 1;
    const afterBo = pmPosToBlockOffset(adapted.blocks, after)!;
    expect(afterBo.offset).toBe(6); // past the placeholder — the text end
    expect(blockOffsetToPmPos(afterBo.block, afterBo.offset)).toBe(after);

    // Any offset INSIDE the placeholder folds to the atom.
    expect(blockOffsetToPmPos(block, 5)).toBe(atomPos);
  });
});

describe('pageField — the paint resolution', () => {
  /** A LineBox + runs shaped like a band line — the adapter's own
   *  emission shape, hand-built to pin the PAINT contract. `pageIndex`
   *  is the ECHO's page (BlockCanvas passes page.index+1 — same page). */
  function bandLines(pageIndex: number): { lines: LineBox[]; runs: Run[] } {
    const style = { fontFamily: 'system-ui', fontSize: 16 };
    const runs: Run[] = [
      { text: 'Page ', style },
      { text: '12', style, fieldKind: 'page' },
      { text: ' of ', style },
      { text: '12', style, fieldKind: 'pages' },
    ];
    const seg = (runIndex: number, start: number, end: number, x: number) => ({ runIndex, start, end, x });
    const line = {
      blockId: 'b1',
      lineIndex: 0,
      pageIndex,
      rect: { x: 0, y: 0, width: 200, height: 20 },
      baseline: 16,
      rangeStart: 0,
      rangeEnd: 13,
      // segments carry TEXT OFFSETS into the concatenated run text
      // ('Page 12 of 12') — start/end name the slice each run owns.
      segments: [seg(0, 0, 5, 0), seg(1, 5, 7, 30), seg(2, 7, 11, 42), seg(3, 11, 13, 66)],
      band: 'header' as const,
    } as unknown as LineBox;
    return { lines: [line], runs };
  }

  function painted(pageNumber: number, total: number): Array<{ t: string; x: number }> {
    // the ECHO sits on page `pageNumber` (0-based index pageNumber-1)
    // — fieldPage.number and line.pageIndex+1 are the SAME page.
    const calls: Array<{ t: string; x: number }> = [];
    const ctx = {
      measureText: (t: string) => ({ width: t.length * 6 }),
      fillText: (t: string, x: number) => calls.push({ t, x }),
      fillRect: () => {},
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
      setTransform: () => {},
      clearRect: () => {},
      drawImage: () => {},
      strokeRect: () => {},
    } as unknown as CanvasRenderingContext2D;
    const { lines, runs } = bandLines(pageNumber - 1);
    paintLines(
      ctx, lines, runs, 'Page 12 of 12', 0,
      // REAL widths (t.length × 6) — the shift math must be exercised.
      // measure returns a NUMBER (the TextMetrics port) — an object
      // stub would NaN every shift.
      { measure: (t: string) => t.length * 6, ascent: () => 12, descent: () => 4 } as never,
      {
        align: 'left',
        contentWidth: 600,
        runDecor: [{}, {}, {}, {}],
        fieldPage: { number: pageNumber, total },
      } as never,
    );
    return calls;
  }

  it('the number draws left-anchored and the trailing ink SHIFTS to hug it (Word-exact)', () => {
    const drawn = painted(5, 12);
    // segment xs in the fixture: [0, 30, 42, 66].
    expect(drawn[0]).toEqual({ t: 'Page ', x: 0 });
    // the PAGE field on page 5 resolves to '5', drawn at its SHIFTED
    // slot start (shift 0 — no field before it), width 6.
    expect(drawn[1]).toEqual({ t: '5', x: 30 });
    // ' of ' shifts left by the slack (slot 12 − resolved 6 = 6):
    // 42 − 6 = 36 — hugging the drawn '5' (30 + 6 = 36). Word-exact.
    expect(drawn[2]).toEqual({ t: ' of ', x: 36 });
    // the PAGES field draws '12' shifted too (66 − 6 = 60), and the
    // shifted ' of ' ends exactly there (36 + 24 = 60).
    expect(drawn[3]).toEqual({ t: '12', x: 60 });
  });

  it('the widest page (== the slot) has zero shift — the natural line', () => {
    const drawn = painted(12, 12);
    expect(drawn.map((c) => c.t)).toEqual(['Page ', '12', ' of ', '12']);
    expect(drawn[1]!.x).toBe(30); // no slack anywhere
    expect(drawn[2]!.x).toBe(42);
    expect(drawn[3]!.x).toBe(66);
  });

  it('every page resolves its own number off the same line', () => {
    expect(painted(1, 12)[1]!.t).toBe('1');
    expect(painted(3, 12)[1]!.t).toBe('3');
  });
});
