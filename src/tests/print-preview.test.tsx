import { describe, it, expect, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { renderTensor, settleLayout } from './harness';
import { parsePageRange } from '@/lib/print/buildDocument';
import { buildPrintDocument } from '@/lib/print/buildDocument';
import { usePrintPreviewStore } from '@/components/dialogs/PrintPreviewDialog';
import { PrintPreviewDialog } from '@/components/dialogs/PrintPreviewDialog';
import { getCommand } from '@/lib/commands/registry';
import { useDocumentStore } from '@/lib/document/store';

/**
 * M-PRINT (#43, Mark 3) — the preview suite: the page-range parser
 * (pure), the BUILD against the real editor (the walk consumes the
 * real adapter output — the Mark-1 contract end to end), and the
 * modal shell (open via the palette command, the options render, the
 * range filters what renders).
 */

describe('parsePageRange', () => {
  it('parses singles, ranges, and mixtures to 0-based sets', () => {
    expect(parsePageRange('3', 10)).toEqual(new Set([2]));
    expect(parsePageRange('1-3', 10)).toEqual(new Set([0, 1, 2]));
    expect(parsePageRange('1-3, 7', 10)).toEqual(new Set([0, 1, 2, 6]));
    // whitespace tolerance
    expect(parsePageRange(' 2 - 4 , 9 ', 10)).toEqual(new Set([1, 2, 3, 8]));
  });

  it('clamps out-of-bounds, skips garbage, and empty means all (null)', () => {
    expect(parsePageRange('', 10)).toBeNull();
    expect(parsePageRange('0', 10)).toBeNull();          // below 1 → nothing
    expect(parsePageRange('99', 10)).toBeNull();          // above total → nothing
    expect(parsePageRange('1-99', 10)).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(parsePageRange('x, 2', 10)).toEqual(new Set([1])); // garbage skipped
  });
});

describe('buildPrintDocument (the real editor → the walk)', () => {
  it('builds pages matching the on-screen pagination from the real doc', async () => {
    const { editor } = renderTensor('<p>one</p><p>two</p><p>three</p>');
    await settleLayout();
    const build = buildPrintDocument(editor);
    // The BUILD's total == the document store's page count (the walk
    // consumed the same engine layout the view laid out).
    expect(build.total).toBe(useDocumentStore.getState().pageCount);
    expect(build.pages).toHaveLength(build.total);
    // the text spans carry the real content
    const texts = build.pages.flatMap((p) =>
      p.elements.filter((e) => e.kind === 'text').map((e) => e.text),
    );
    expect(texts.join('')).toContain('one');
    expect(texts.join('')).toContain('three');
  });

  it('a multi-page document splits at the same page as the view', async () => {
    // A page break forces two pages.
    const { editor } = renderTensor('<p>first page</p><div data-page-break="true"></div><p>second</p>');
    await settleLayout();
    const build = buildPrintDocument(editor);
    expect(build.total).toBeGreaterThanOrEqual(2);
    const page0 = build.pages[0]!;
    const page1 = build.pages[1]!;
    const textsOf = (p: { elements: import('@/lib/print/types').PrintElement[] }) =>
      p.elements.flatMap((e) => (e.kind === 'text' ? [e.text] : [])).join('');
    const p0Text = textsOf(page0);
    const p1Text = textsOf(page1);
    expect(p0Text).toContain('first');
    expect(p1Text).toContain('second');
  });
});

describe('the preview modal shell', () => {
  beforeEach(() => {
    usePrintPreviewStore.getState().close();
  });

  it('the palette command opens it; the pages and options render', async () => {
    const { editor } = renderTensor('<p>preview me</p>');
    await settleLayout();
    const utils = render(<PrintPreviewDialog />);
    const command = getCommand('printPreview');
    expect(command).toBeTruthy();

    act(() => {
      void command!.run();
    });
    const modal = utils.getByTestId('print-preview');
    expect(modal).toBeTruthy();
    // the page sheets rendered (the walk's output through the view)
    const sheets = utils.getAllByTestId('print-page');
    expect(sheets.length).toBeGreaterThanOrEqual(1);
    // the options column
    expect(utils.getByTestId('print-preview-total')).toBeTruthy();
    expect(utils.getByTestId('print-preview-range-input')).toBeTruthy();
    // Mark 2: Print is LIVE (the flow's suite pins it); Mark 4 (PDF)
    // stays the disabled placeholder.
    const printBtn = utils.getByTestId('print-preview-print') as HTMLButtonElement;
    expect(printBtn.disabled).toBe(false);
    void editor;
  });
});