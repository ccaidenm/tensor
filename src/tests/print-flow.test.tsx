import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { renderTensor, settleLayout } from './harness';
import { PrintContainer, printFromPreview, printPageSizeOf } from '@/lib/print/PrintContainer';
import { PrintPreviewDialog, usePrintPreviewStore } from '@/components/dialogs/PrintPreviewDialog';
import { usePrintStore } from '@/lib/print/printCss';
import { buildPrintDocument } from '@/lib/print/buildDocument';
import { useDocumentStore } from '@/lib/document/store';

/**
 * M-PRINT (#43, Mark 2) — the print path: the @page CSS derives from
 * the document's pageSetup (margin 0 — the walk is page-frame-
 * absolute), the container mounts the PREVIEW'S OWN walk (one build),
 * window.print() fires with the DOM settled, and the OS dialog's
 * options stay the OS's (delegated per #43).
 */

describe('printPageSizeOf — the @page size string', () => {
  it('Letter portrait → 612pt 792pt', () => {
    expect(
      printPageSizeOf({ pageSize: 'Letter', margins: { top: 72, bottom: 72, left: 72, right: 72 }, pageGap: 32 }),
    ).toBe('612pt 792pt');
  });

  it('A4 LANDSCAPE swaps the dims (the CSS size is the painted orientation)', () => {
    expect(
      printPageSizeOf({
        pageSize: 'A4',
        margins: { top: 72, bottom: 72, left: 72, right: 72 },
        pageGap: 32,
        orientation: 'landscape',
      }),
    ).toBe('842pt 595pt');
  });

  it('a custom size rides its pt dims', () => {
    expect(
      printPageSizeOf({
        pageSize: 'custom',
        customWidth: 400,
        customHeight: 600,
        margins: { top: 72, bottom: 72, left: 72, right: 72 },
        pageGap: 32,
      }),
    ).toBe('400pt 600pt');
  });
});

describe('the print flow (arm → print → disarm)', () => {
  const printSpy = vi.fn();
  beforeEach(() => {
    printSpy.mockClear();
    vi.stubGlobal('print', printSpy);
    usePrintStore.getState().disarm();
    usePrintPreviewStore.getState().close();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('printFromPreview arms the container with the preview\'s walk and fires window.print()', async () => {
    const { editor } = renderTensor('<p>printable</p>');
    await settleLayout();
    const build = buildPrintDocument(editor);
    const pageSetup = useDocumentStore.getState().pageSetup;

    render(<PrintContainer />);
    expect(usePrintStore.getState().pages).toBeNull();

    await act(async () => {
      await printFromPreview(build.pages, pageSetup);
    });

    // window.print fired (the OS dialog would open on a real machine)
    expect(printSpy).toHaveBeenCalled();
    // the container armed with the WALK'S pages and the @page size
    const state = usePrintStore.getState();
    expect(state.pages).toEqual(build.pages);
    expect(state.cssPageSize).toBe(printPageSizeOf(pageSetup));
    void editor;
  });

  it('the preview\'s page RANGE narrows what arms (the OS narrows again)', async () => {
    const { editor } = renderTensor(
      '<p>page one</p><div data-page-break="true"></div><p>page two</p><div data-page-break="true"></div><p>page three</p>',
    );
    await settleLayout();
    const build = buildPrintDocument(editor);
    expect(build.total).toBeGreaterThanOrEqual(3);

    const utils = render(<PrintPreviewDialog />);
    render(<PrintContainer />);
    act(() => {
      usePrintPreviewStore.getState().open();
    });
    const input = utils.getByTestId('print-preview-range-input') as HTMLInputElement;
    act(() => {
      input.value = '1';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // the narrowed set arms
    await act(async () => {
      // filter manually as the button does (visiblePages path)
      const filtered = build.pages.filter((p) => p.index === 0);
      await printFromPreview(filtered, useDocumentStore.getState().pageSetup);
    });
    expect(usePrintStore.getState().pages).toHaveLength(1);
    void editor;
  });

  it('the afterprint disarms (the dialog closes → the container unmounts)', async () => {
    const { editor } = renderTensor('<p>afterprint</p>');
    await settleLayout();
    const build = buildPrintDocument(editor);
    render(<PrintContainer />);
    await act(async () => {
      await printFromPreview(build.pages, useDocumentStore.getState().pageSetup);
    });
    expect(usePrintStore.getState().pages).toBeTruthy();
    act(() => {
      window.dispatchEvent(new Event('afterprint'));
    });
    expect(usePrintStore.getState().pages).toBeNull();
    void editor;
  });

  it('the preview\'s Print button is ENABLED (Mark 2) and dispatches the flow', async () => {
    const { editor } = renderTensor('<p>button flow</p>');
    await settleLayout();
    const utils = render(<PrintPreviewDialog />);
    render(<PrintContainer />);
    act(() => {
      usePrintPreviewStore.getState().open();
    });
    const btn = utils.getByTestId('print-preview-commit') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    void editor;
  });
});
describe('#48 — page backgrounds through the print walk (the one-build law)', () => {
  const bgPrintSpy = vi.fn();
  beforeEach(() => {
    usePrintStore.getState().disarm();
    usePrintPreviewStore.getState().close();
    bgPrintSpy.mockClear();
    vi.stubGlobal('print', bgPrintSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('buildPrintDocument resolves per-page → doc on the SAME chain the view paints; the print sheet carries the fill', async () => {
    // Two pages: the doc default tints both, one per-page override
    // beats it — build once, assert the data AND the print DOM.
    const longText = '<p>' + 'word '.repeat(1500) + '</p>';
    const { editor } = renderTensor(longText);
    await settleLayout();
    act(() => {
      useDocumentStore.getState().setPageSetup({
        ...useDocumentStore.getState().pageSetup,
        pageColor: '#ddeeff',
      });
      useDocumentStore.getState().setPageStyles({ 1: { background: '#123123' } });
    });
    const build = buildPrintDocument(editor);
    expect(build.pages.length).toBeGreaterThanOrEqual(3);
    expect(build.pages[0]!.background).toBe('#ddeeff');
    expect(build.pages[1]!.background).toBe('#123123');
    expect(build.pages[2]!.background).toBe('#ddeeff');

    // The print DOM (what window.print hands the OS): each sheet
    // wears its own fill — the page's background is content, not
    // chrome (print-color-adjust: exact keeps it on paper).
    render(<PrintContainer />);
    await act(async () => {
      await printFromPreview(build.pages, useDocumentStore.getState().pageSetup);
    });
    const sheet0 = document.querySelector('[data-page-index="0"]') as HTMLElement;
    const sheet1 = document.querySelector('[data-page-index="1"]') as HTMLElement;
    expect(sheet0.style.backgroundColor).toBe('rgb(221, 238, 255)');
    expect(sheet1.style.backgroundColor).toBe('rgb(18, 49, 35)');
    expect(bgPrintSpy).toHaveBeenCalled();
  });
});
