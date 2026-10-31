import { describe, it, expect } from 'vitest';
import { act } from '@testing-library/react';
import { renderTensor, renderTensorInScrollContainer, settleLayout, dataEvent } from './harness';
import { pmDocToSemantic } from '@/lib/paginated/adapter';
import { paintLines } from '@/lib/paginated/paint';
import type { LineBox, Run } from '@tensor-editor/engine';

/**
 * M-PAGEFIELD (#34) — the page-number field: the PM node is a MARKER
 * (never carrying a resolved value — the M-REFS law); the adapter
 * measures it at the warm total's max-width digits with the fieldKind
 * marker riding the run; the PAINT resolves per page (the pages field
 * draws exactly the placeholder; the page field right-anchors in its
 * slot).
 */

const BASE = { fontFamily: 'system-ui', fontSize: 16 };

function lastBlock(r: ReturnType<typeof pmDocToSemantic>) {
  return r.blocks[r.blocks.length - 1]!;
}

describe('pageField — the adapter (M-PAGEFIELD)', () => {
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

describe('pageField — the paint resolution (M-PAGEFIELD)', () => {
  /** A LineBox + runs shaped like a band line: [text 'Page ', field
   *  '12', text ' of ', field '12'] — the adapter's own emission
   *  shape, hand-built to pin the PAINT contract. */
  function bandLines(): { lines: LineBox[]; runs: Run[] } {
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
      pageIndex: 4, // the FIFTH page — the page field resolves to '5'
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

  function paintedTexts(pageNumber: number, total: number): string[] {
    const calls: string[] = [];
    const ctx = {
      measureText: (t: string) => ({ width: t.length * 6 }),
      fillText: (t: string) => calls.push(t),
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
    const { lines, runs } = bandLines();
    paintLines(ctx, lines, runs, 'Page 12 of 12', 0, { measure: () => ({ width: 0 }), ascent: () => 12, descent: () => 4 } as never, {
      align: 'left',
      contentWidth: 600,
      runDecor: [{}, {}, {}, {}],
      fieldPage: { number: pageNumber, total },
    } as never);
    return calls;
  }

  it('the pages field draws the total exactly; the page field right-anchors its number in the slot', () => {
    const drawn = paintedTexts(5, 12);
    // 'Page ' literal
    expect(drawn[0]).toBe('Page ');
    // the PAGE field on page 5 resolves to '5', RIGHT-ANCHORED in the
    // 2-digit slot — drawn at x + (measured 12w − resolved 1w)
    expect(drawn[1]).toBe('5');
    expect(drawn[2]).toBe(' of ');
    // the PAGES field draws EXACTLY the measured placeholder
    expect(drawn[3]).toBe('12');
  });

  it('every page resolves its own number off the same line', () => {
    expect(paintedTexts(1, 12)[1]).toBe('1');
    expect(paintedTexts(12, 12)[1]).toBe('12'); // the widest — the exact slot
  });
});
