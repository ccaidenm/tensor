import { describe, it, expect } from 'vitest';
import { act } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { createLayoutEngine } from '@tensor-editor/engine';
import { DEFAULT_MARGINS, PAGE_GAP, toLayoutOptions } from '@/lib/document/pageSetup';
import { pmDocToSemantic } from '@/lib/paginated/adapter';
import { flowSelectionState } from '@/lib/editor/ParagraphExtensions';
import { setRowCantSplit } from '@/lib/editor/tableResize';
import { buildPrintDocument } from '@/lib/print/buildDocument';
import { renderTensor, renderTensorInScrollContainer, settleLayout } from './harness';
import { FakeMetrics } from './fakeMetrics';

/**
 * The pagination-flags MODEL suite: schema attrs (clipboard spellings),
 * the setFlowAttrs writer, the flowSelectionState mixed-state reader,
 * adapter projection (attr-over-style cascade, the pageBreak stamp
 * merge, the float pass-through), the builtin heading bond (Word's
 * Heading 1–3 default), table cantSplit, the document widow default,
 * break badges, the print ride-along, and end-to-end reflow through
 * the real engine. (The popover/dialog UI suite lives in
 * flowPopover.test.tsx.) FakeMetrics: line height == fontSize (16px at
 * 16pt, 54 lines/page), 62 chars/line at 16pt, width scales with
 * fontSize.
 */

const BASE = { fontFamily: 'fake', fontSize: 16 };
const PAGE_SETUP = { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP };

function directLayout(editor: Editor) {
  const adapted = pmDocToSemantic(editor.state.doc, BASE);
  const engine = createLayoutEngine({ metrics: FakeMetrics });
  return {
    adapted,
    result: engine.layout({ baseStyle: BASE, blocks: adapted.doc.blocks }, toLayoutOptions(PAGE_SETUP)),
  };
}

describe('writer + reader', () => {
  it('setFlowAttrs writes the flags on the caret paragraph (and on headings); untouched flags stay unset', async () => {
    const { editor } = renderTensorInScrollContainer('<p>one</p><h2>head</h2>');
    await settleLayout();
    act(() => {
      editor.commands.setTextSelection(3);
      editor.commands.setFlowAttrs({ keepNext: true, keepLines: true, widowControl: false, breakAfter: 'page' });
    });
    const para = editor.state.doc.child(0);
    expect(para.attrs.keepNext).toBe(true);
    expect(para.attrs.keepLines).toBe(true);
    expect(para.attrs.widowControl).toBe(false);
    expect(para.attrs.breakAfter).toBe('page');
    expect(para.attrs.keepPrevious).toBe(null);
    expect(para.attrs.breakBefore).toBe(null);
    // The same writer reaches headings (the heading is the flagship use).
    act(() => {
      editor.commands.setTextSelection(8); // inside 'head'
      editor.commands.setFlowAttrs({ keepPrevious: true });
    });
    expect(editor.state.doc.child(1).attrs.keepPrevious).toBe(true);
  });

  it('a range selection applies to EVERY overlapped paragraph (Word dialog semantics)', async () => {
    const { editor } = renderTensorInScrollContainer('<p>one</p><p>two</p>');
    await settleLayout();
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 9 });
      editor.commands.setFlowAttrs({ keepLines: true });
    });
    expect(editor.state.doc.child(0).attrs.keepLines).toBe(true);
    expect(editor.state.doc.child(1).attrs.keepLines).toBe(true);
  });

  it('flowSelectionState: default-off flags + default-on widowControl, uniform, and mixed', async () => {
    const { editor } = renderTensorInScrollContainer('<p>one</p><p>two</p>');
    await settleLayout();
    act(() => editor.commands.setTextSelection(2));
    let state = flowSelectionState(editor);
    expect(state.keepNext).toBe(false);
    expect(state.keepLines).toBe(false);
    expect(state.widowControl).toBe(true); // the DEFAULT-ON family
    expect(state.breakBefore).toBe(false);
    // Uniform true across both paragraphs:
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 9 });
      editor.commands.setFlowAttrs({ keepNext: true });
    });
    state = flowSelectionState(editor);
    expect(state.keepNext).toBe(true);
    // Mixed: unset the second paragraph only, then read the whole range.
    act(() => {
      editor.commands.setTextSelection({ from: 6, to: 9 });
      editor.commands.setFlowAttrs({ keepNext: null });
    });
    act(() => editor.commands.setTextSelection({ from: 1, to: 9 }));
    state = flowSelectionState(editor);
    expect(state.keepNext).toBe('mixed');
    expect(state.widowControl).toBe(true);
  });

  it('the data-* clipboard spellings round-trip (parseHTML/renderHTML)', async () => {
    const { editor } = renderTensorInScrollContainer(
      '<p data-keep-next="true" data-widow-control="false" data-break-before="page">one</p>'
    );
    await settleLayout();
    const para = editor.state.doc.child(0);
    expect(para.attrs.keepNext).toBe(true);
    expect(para.attrs.widowControl).toBe(false);
    expect(para.attrs.breakBefore).toBe('page');
    const html = editor.getHTML();
    expect(html).toContain('data-keep-next="true"');
    expect(html).toContain('data-widow-control="false"');
    expect(html).toContain('data-break-before="page"');
  });

  it('clearFormatting resets the pagination flags (Word rule: they are paragraph formatting)', async () => {
    const { editor } = renderTensorInScrollContainer('<p>one</p>');
    await settleLayout();
    act(() => {
      editor.commands.setTextSelection(3);
      editor.commands.setFlowAttrs({ keepNext: true, breakBefore: 'page' });
    });
    act(() => {
      editor.commands.clearFormatting();
    });
    const para = editor.state.doc.child(0);
    expect(para.attrs.keepNext).toBe(null);
    expect(para.attrs.breakBefore).toBe(null);
  });
});

describe('adapter projection', () => {
  it('all-unset paragraphs emit NO flow field; a full attr set projects verbatim', async () => {
    const { editor } = renderTensorInScrollContainer('<p>plain</p>');
    await settleLayout();
    expect(pmDocToSemantic(editor.state.doc, BASE).doc.blocks[0].flow).toBeUndefined();
    act(() => {
      editor.commands.setTextSelection(3);
      editor.commands.setFlowAttrs({
        keepNext: true,
        keepPrevious: true,
        keepLines: true,
        widowControl: false,
        breakBefore: 'page',
        breakAfter: 'page',
      });
    });
    expect(pmDocToSemantic(editor.state.doc, BASE).doc.blocks[0].flow).toEqual({
      keepNext: true,
      keepPrevious: true,
      keepLines: true,
      widowControl: false,
      breakBefore: 'page',
      breakAfter: 'page',
    });
  });

  it('the builtin heading styles resolve keepNext: true; a direct attr overrides the style tier', async () => {
    const { editor } = renderTensorInScrollContainer('<h1>Title</h1>');
    await settleLayout();
    expect(pmDocToSemantic(editor.state.doc, BASE).doc.blocks[0].flow).toEqual({ keepNext: true });
    act(() => {
      editor.commands.setTextSelection(2);
      editor.commands.setFlowAttrs({ keepNext: false });
    });
    expect(pmDocToSemantic(editor.state.doc, BASE).doc.blocks[0].flow).toEqual({ keepNext: false });
  });

  it("the pageBreak node's stamp MERGES with the paragraph's own flow", async () => {
    const { editor } = renderTensorInScrollContainer(
      '<p>first</p><div data-page-break="true"></div><p>second</p>'
    );
    await settleLayout();
    act(() => {
      editor.commands.setTextSelection(10); // inside 'second'
      editor.commands.setFlowAttrs({ keepNext: true });
    });
    const a = pmDocToSemantic(editor.state.doc, BASE);
    expect(a.doc.blocks[1].flow).toEqual({ keepNext: true, breakBefore: 'page' });
  });

  it('a pending forced break passes THROUGH a floated image to the next in-flow block', async () => {
    // The unconditional stamp once landed breakBefore on the float —
    // validateFloatFlow's THROW at layout. The pass-through is the
    // engine's own ruled spelling ("put the forced break on the
    // following text block").
    const { editor } = renderTensorInScrollContainer(
      '<p>before</p><div data-page-break="true"></div><p>after</p>'
    );
    await settleLayout();
    act(() => {
      const tr = editor.state.tr;
      const img = editor.state.schema.nodes.image.create({
        src: 'media://x',
        width: 100,
        height: 50,
        alt: 'pic',
        float: { dx: 0, dy: 0, z: 'front' },
      });
      tr.insert(8, img);
      editor.view.dispatch(tr);
    });
    const a = pmDocToSemantic(editor.state.doc, BASE);
    expect(a.doc.blocks[1].kind).toBe('image');
    expect(a.doc.blocks[1].flow).toBeUndefined();
    expect(a.doc.blocks[2].flow).toEqual({ breakBefore: 'page' });
    // The engine accepts the doc (no validateFloatFlow throw) and the
    // float places.
    const { result } = directLayout(editor);
    expect(result.placed.length).toBeGreaterThan(0);
  });
});

describe('tables', () => {
  it('the table-level flow attrs project (the five-flag subset); all-unset emits no flow', async () => {
    const { editor } = renderTensorInScrollContainer('<table><tr><td>a</td></tr></table>');
    await settleLayout();
    expect(pmDocToSemantic(editor.state.doc, BASE).doc.blocks[0].flow).toBeUndefined();
    act(() => {
      editor.commands.updateAttributes('table', { keepNext: true, keepLines: true });
    });
    expect(pmDocToSemantic(editor.state.doc, BASE).doc.blocks[0].flow).toEqual({
      keepNext: true,
      keepLines: true,
    });
  });

  it('row cantSplit projects to TableRowData: default splits at the line grid, cantSplit moves wholly', async () => {
    // 52 filler lines = 832px; a 3-line row (56px) straddles page 0's
    // 32px remainder. Default (unset = Word/GDocs): bands that fit
    // stay — the row splits at the line grid. cantSplit: the row is
    // one atomic band, moves wholly to page 1, NO FragmentBreak.
    const filler = 'x'.repeat(52 * 62);
    const cellText = 'x'.repeat(180); // 3 lines at 60 chars in the 608px lane
    const { editor } = renderTensorInScrollContainer(
      `<p>${filler}</p><table><tr><td>${cellText}</td></tr></table>`
    );
    await settleLayout();
    let { adapted, result } = directLayout(editor);
    const table = adapted.doc.blocks[1] as { id: string; rows: { cantSplit?: boolean | null }[] };
    expect(table.rows[0].cantSplit).toBeUndefined();
    const cellLines = result.lines.filter((l) => l.tableCell);
    expect(new Set(cellLines.map((l) => l.pageIndex)).size).toBe(2);
    const breaks = result.breaks.filter((b) => b.blockId === table.id);
    expect(breaks).toHaveLength(1);
    expect(breaks[0].atLine).toBe(1); // the split lands before cell line 1

    let tablePos = -1;
    editor.state.doc.descendants((n, p) => {
      if (n.type.name === 'table' && tablePos < 0) tablePos = p;
    });
    act(() => {
      setRowCantSplit(editor, tablePos, 0, true);
    });
    ({ adapted, result } = directLayout(editor));
    const table2 = adapted.doc.blocks[1] as { id: string; rows: { cantSplit?: boolean | null }[] };
    expect(table2.rows[0].cantSplit).toBe(true);
    const cellLines2 = result.lines.filter((l) => l.tableCell);
    expect(new Set(cellLines2.map((l) => l.pageIndex))).toEqual(new Set([1]));
    // A whole-row move is NOT a mid-block split.
    expect(result.breaks.filter((b) => b.blockId === table2.id)).toHaveLength(0);
  });
});

describe('end-to-end reflow (the real engine)', () => {
  it('a builtin heading at a page bottom keeps with its paragraph; keepNext:false opts out', async () => {
    // 52 filler lines = 832px; the h1 (fontSize 32 via the heading-1
    // style) is one 32px line → 832+32 = 864 fills page 0 EXACTLY, so
    // the body line cannot follow. The builtin keepNext bond moves the
    // heading fresh to page 1 with the body — Word's Heading default.
    // With keepNext:false the heading STRANDS at page 0's bottom edge.
    const filler = 'x'.repeat(52 * 62);
    const { editor } = renderTensor(`<p>${filler}</p><h1>Title</h1><p>body text</p>`);
    await settleLayout();
    let { adapted, result } = directLayout(editor);
    const headingId = adapted.doc.blocks[1].id;
    const bodyId = adapted.doc.blocks[2].id;
    expect(result.lines.filter((l) => l.blockId === headingId).map((l) => l.pageIndex)).toEqual([1]);
    expect(result.lines.filter((l) => l.blockId === bodyId).map((l) => l.pageIndex)).toEqual([1]);
    expect(result.lines.filter((l) => l.blockId === adapted.doc.blocks[0].id).every((l) => l.pageIndex === 0)).toBe(true);

    // The opt-out (Word's checkbox off): the heading stays at page 0's
    // bottom, the body opens page 1 alone.
    act(() => {
      editor.commands.setTextSelection(filler.length + 4); // inside 'Title'
      editor.commands.setFlowAttrs({ keepNext: false });
    });
    ({ adapted, result } = directLayout(editor));
    const headingId2 = adapted.doc.blocks[1].id;
    expect(result.lines.filter((l) => l.blockId === headingId2).map((l) => l.pageIndex)).toEqual([0]);
    expect(result.lines.filter((l) => l.blockId === bodyId).map((l) => l.pageIndex)).toEqual([1]);
  });

  it('page-break-before on a paragraph forces the page (the attr spelling, end-to-end)', async () => {
    const { editor } = renderTensorInScrollContainer('<p>first</p><p>second</p>');
    await settleLayout();
    act(() => {
      editor.commands.setTextSelection(8); // inside 'second'
      editor.commands.setFlowAttrs({ breakBefore: 'page' });
    });
    const { adapted, result } = directLayout(editor);
    expect(result.lines.filter((l) => l.blockId === adapted.doc.blocks[0].id).every((l) => l.pageIndex === 0)).toBe(true);
    expect(result.lines.filter((l) => l.blockId === adapted.doc.blocks[1].id).every((l) => l.pageIndex === 1)).toBe(true);
    // A forced break is NOT a mid-block split: no FragmentBreak.
    expect(result.breaks).toHaveLength(0);
  });
});

describe('document-level widow control, break badges, print ride-along', () => {
  it('toLayoutOptions carries the document-level widow default (absent = ON)', () => {
    expect(toLayoutOptions(PAGE_SETUP).preventWidowsAndOrphans).toBe(true);
    expect(toLayoutOptions({ ...PAGE_SETUP, widowControl: false }).preventWidowsAndOrphans).toBe(false);
  });

  it('widowControl off: the straddling paragraph splits NATURALLY (no widow adjustment)', async () => {
    // 47 filler lines = 752px; a 4-line 32px paragraph enters the
    // 112px remainder: control ON adjusts the split to 2/2 (R3 fixes
    // the widow); OFF splits 3/1 naturally — the widow case itself
    // (Word's checkbox unchecked). Numbers probed empirically against
    // the exact float fuzz (16px slack either side of every boundary).
    const filler = 'x'.repeat(47 * 62);
    const tail = 'y'.repeat(4 * 31); // 31 chars/line at 32px
    const { editor } = renderTensor(`<p>${filler}</p><p>${tail}</p>`);
    await settleLayout();
    act(() => {
      editor.commands.setTextSelection({ from: filler.length + 3, to: filler.length + 3 + tail.length });
      editor.commands.setFontSize('32px');
    });
    const adapted = pmDocToSemantic(editor.state.doc, BASE);
    const tailId = adapted.doc.blocks[1].id;
    const on = createLayoutEngine({ metrics: FakeMetrics }).layout(adapted.doc, toLayoutOptions(PAGE_SETUP));
    const off = createLayoutEngine({ metrics: FakeMetrics }).layout(adapted.doc, {
      ...toLayoutOptions(PAGE_SETUP),
      preventWidowsAndOrphans: false,
    });
    expect(on.lines.filter((l) => l.blockId === tailId).map((l) => l.pageIndex)).toEqual([0, 0, 1, 1]);
    expect(off.lines.filter((l) => l.blockId === tailId).map((l) => l.pageIndex)).toEqual([0, 0, 0, 1]);
  });

  it('attr-based forced breaks paint the SAME break badges (the two spellings, one ink)', async () => {
    const { editor } = renderTensor('<p>first</p><p>second</p>');
    await settleLayout();
    act(() => {
      editor.commands.setTextSelection(8); // inside 'second'
      editor.commands.setFlowAttrs({ breakBefore: 'page' });
    });
    await settleLayout();
    const marks = Array.from(document.querySelectorAll('[data-testid^="break-mark-"]'));
    expect(marks.length).toBeGreaterThanOrEqual(1);
    expect(marks.some((m) => (m.textContent ?? '').includes('Page Break'))).toBe(true);
  });

  it('the PRINT build consumes the same flow flags (the keepNext bond in the print layout)', async () => {
    // #43's core AC is "breaks match the paginated view" — the flags
    // ride the shared adapter + engine, so print/PDF paginate
    // identically with zero print-side code.
    const filler = 'x'.repeat(52 * 62);
    const { editor } = renderTensor(`<p>${filler}</p><h1>Title</h1><p>body text</p>`);
    await settleLayout();
    const build = buildPrintDocument(editor);
    const headingId = build.blocks[1].id;
    expect(build.layout.lines.filter((l) => l.blockId === headingId).map((l) => l.pageIndex)).toEqual([1]);
  });
});

