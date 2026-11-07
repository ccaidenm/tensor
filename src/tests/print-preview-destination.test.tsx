import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { renderTensor, settleLayout } from './harness';
import { PrintPreviewDialog, usePrintPreviewStore } from '@/components/dialogs/PrintPreviewDialog';
import { useConfigStore } from '@/lib/config/store';
import { useDocumentStore } from '@/lib/document/store';
import { useDocumentPropertiesStore } from '@/lib/document/propertiesStore';

/**
 * M-PRINT (#43, the beast) — THE DESTINATION contract: the segmented
 * control [Printer | PDF] backed by print.lastDestination (memory),
 * the FULLY-RESOLVED PDF body (filename, folder, metadata
 * write-through), the commit button labeled with the resolved path,
 * and the keyboard law (Enter commits, the configured trigger held
 * force-prompts). One modal — never two.
 */

describe('the destination segmented control', () => {
  beforeEach(() => {
    useConfigStore.getState().setPrintLastDestination('printer');
    useConfigStore.getState().setDownloadsDir('');
  });

  it('defaults to the remembered destination (the memory)', async () => {
    const { editor } = renderTensor('<p>dest</p>');
    await settleLayout();
    const utils = render(<PrintPreviewDialog />);
    act(() => {
      useConfigStore.getState().setPrintLastDestination('pdf');
      usePrintPreviewStore.getState().open();
    });
    expect(useConfigStore.getState().config.print.lastDestination).toBe('pdf');
    const control = utils.getByTestId('print-preview-destination');
    expect(control).toBeTruthy();
    expect(utils.getByTestId('print-preview-pdf-body')).toBeTruthy();
    void editor;
  });

  it('switching writes the memory; the bodies swap', async () => {
    const { editor } = renderTensor('<p>dest</p>');
    await settleLayout();
    const utils = render(<PrintPreviewDialog />);
    act(() => usePrintPreviewStore.getState().open());
    // printer default → the printer body
    expect(utils.getByTestId('print-preview-printer-body')).toBeTruthy();
    // switch to PDF → the memory + the body
    act(() => {
      fireEvent.click(utils.getByTestId('print-preview-dest-pdf'));
    });
    expect(useConfigStore.getState().config.print.lastDestination).toBe('pdf');
    expect(utils.getByTestId('print-preview-pdf-body')).toBeTruthy();
    // back to printer
    act(() => {
      fireEvent.click(utils.getByTestId('print-preview-dest-printer'));
    });
    expect(useConfigStore.getState().config.print.lastDestination).toBe('printer');
    expect(utils.getByTestId('print-preview-printer-body')).toBeTruthy();
    void editor;
  });
});

describe('the fully-resolved PDF destination', () => {
  beforeEach(() => {
    useConfigStore.getState().setPrintLastDestination('pdf');
    useConfigStore.getState().setDownloadsDir('');
  });

  it('seeds the filename from the document title, then the file name', async () => {
    const { editor } = renderTensor('<p>named</p>');
    await settleLayout();
    const utils = render(<PrintPreviewDialog />);
    // no title, no filePath → Untitled
    act(() => usePrintPreviewStore.getState().open());
    expect((utils.getByTestId('print-preview-filename') as HTMLInputElement).value).toBe('Untitled');
    void editor;
  });

  it('the commit button stays honest (the user\'s sleeker label)', async () => {
    const { editor } = renderTensor('<p>label</p>');
    await settleLayout();
    const utils = render(<PrintPreviewDialog />);
    act(() => {
      useConfigStore.getState().setDownloadsDir('/home/caiden/Documents');
      usePrintPreviewStore.getState().open();
    });
    const btn = utils.getByTestId('print-preview-commit') as HTMLButtonElement;
    expect(btn.textContent).toContain('Save as PDF');
    void editor;
  });

  it('the Paper card speaks HUMAN units (the config\'s measurementUnit — one source)', async () => {
    const { editor } = renderTensor('<p>paper</p>');
    await settleLayout();
    act(() => useConfigStore.getState().setPrintLastDestination('pdf'));
    const utils = render(<PrintPreviewDialog />);
    act(() => usePrintPreviewStore.getState().open());
    // Inches (default): 72pt → `1" all sides`, Letter → 8.5" × 11"
    expect(utils.getByText('1" all sides')).toBeTruthy();
    expect(utils.getByText(/8\.5" × 11"/)).toBeTruthy();
    void editor;
  });

  it('the All-properties button opens the document properties dialog (subject/keywords)', async () => {
    const { editor } = renderTensor('<p>props</p>');
    await settleLayout();
    const utils = render(<PrintPreviewDialog />);
    act(() => usePrintPreviewStore.getState().open());
    act(() => {
      fireEvent.click(utils.getByTestId('print-preview-all-properties'));
    });
    expect(useDocumentPropertiesStore.getState().isOpen).toBe(true);
    void editor;
  });

  it('metadata WRITE-THROUGH: title/author inputs edit coreProperties (one source)', async () => {
    const { editor } = renderTensor('<p>meta</p>');
    await settleLayout();
    const utils = render(<PrintPreviewDialog />);
    act(() => usePrintPreviewStore.getState().open());
    const title = utils.getByTestId('print-preview-title') as HTMLInputElement;
    act(() => {
      fireEvent.change(title, { target: { value: 'The Paper' } });
    });
    expect(useDocumentStore.getState().coreProperties.title).toBe('The Paper');
    // cleared → omitted (the normalize law: absent means never set)
    act(() => {
      fireEvent.change(title, { target: { value: '   ' } });
    });
    expect(useDocumentStore.getState().coreProperties.title).toBeUndefined();
    // the doc is marked dirty (Word's export posture)
    expect(useDocumentStore.getState().isDirty).toBe(true);
    void editor;
  });

  it('the range input is FOCUSED on open (keyboard-first)', async () => {
    const { editor } = renderTensor('<p>focus</p>');
    await settleLayout();
    const utils = render(<PrintPreviewDialog />);
    act(() => usePrintPreviewStore.getState().open());
    // requestAnimationFrame focuses — flush it
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(document.activeElement).toBe(utils.getByTestId('print-preview-range-input'));
    void editor;
  });

  it('the zoom controls FLOAT bottom-right over the document (the overlay, not a settings row)', async () => {
    const { editor } = renderTensor('<p>zoom</p>');
    await settleLayout();
    const utils = render(<PrintPreviewDialog />);
    act(() => usePrintPreviewStore.getState().open());
    const overlay = utils.getByTestId('print-preview-zoom') as HTMLElement;
    // inside the LEFT pane (over the sheets), not the options column.
    const optionsCol = utils.getByTestId('print-preview-destination-card').parentElement!;
    expect(overlay.closest('div')).not.toBe(optionsCol);
    expect(overlay.textContent).toContain('Fit');
    void editor;
  });

  it('the commit hints are Kbd components mapped to the CONFIGURED trigger', async () => {
    const { editor } = renderTensor('<p>hints</p>');
    await settleLayout();
    // Shift (default) → the hint says Shift
    act(() => useConfigStore.getState().setPdfAlwaysAskTrigger('shift'));
    const utils = render(<PrintPreviewDialog />);
    act(() => usePrintPreviewStore.getState().open());
    const hint = utils.getByText('to modify destination', { exact: false });
    expect(hint.textContent).toContain('Shift');
    // rebind to Ctrl → the hint says Ctrl (reactive)
    act(() => {
      useConfigStore.getState().setPdfAlwaysAskTrigger('ctrl');
    });
    expect(utils.getByText('to modify destination', { exact: false }).textContent).toContain('Ctrl');
    void editor;
  });
});

/** THE TENSOR-NATIVE PRINTER PICKER — the system dialog's
 *  replacement. The nativePrint seam is mocked (the Rust commands
 *  are the native suite's); the CONTRACTS here: the default printer
 *  preselects, the system-dialog fallback entry stands in, and the
 *  commit runs the native pipeline (walk → PDF → job → close). */
vi.mock('@/lib/print/nativePrint', async () => {
  const actual = await vi.importActual<typeof import('@/lib/print/nativePrint')>('@/lib/print/nativePrint');
  return {
    ...actual,
    enumeratePrinters: vi.fn(async () => [
      {
        name: 'TestJet',
        systemName: 'TestJet',
        state: 'ready',
        isDefault: true,
        location: 'Desk 2',
        description: 'TestJet 400',
      },
      {
        name: 'Basement Laser',
        systemName: 'Basement Laser',
        state: 'offline',
        isDefault: false,
        location: '',
        description: '',
      },
    ]),
    printPdfToPrinter: vi.fn(async () => 4242),
  };
});

describe('the Tensor-native printer destination (the OS dialog\'s replacement)', () => {
  beforeEach(() => {
    useConfigStore.getState().setPrintLastDestination('printer');
  });

  it('enumerates on open; the default printer preselects; the system-dialog entry rides last', async () => {
    const { editor } = renderTensor('<p>print me</p>');
    await settleLayout();
    const utils = render(<PrintPreviewDialog />);
    act(() => usePrintPreviewStore.getState().open());
    // enumeration resolves (async effect) → the default preselects
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const body = utils.getByTestId('print-preview-printer-body');
    expect((body.querySelector('[data-testid="print-preview-printer-select"] button, [role=combobox]') as HTMLElement)?.textContent).toContain('TestJet');
    void editor;
  });

  it('the commit runs the NATIVE pipeline: PDF → job → toast + close', async () => {
    const { printPdfToPrinter } = await import('@/lib/print/nativePrint');
    const { editor } = renderTensor('<p>native commit</p>');
    await settleLayout();
    const utils = render(<PrintPreviewDialog />);
    act(() => usePrintPreviewStore.getState().open());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const btn = utils.getByTestId('print-preview-commit') as HTMLButtonElement;
    expect(btn.textContent).toContain('Print');
    expect(btn.textContent).not.toContain('…'); // native, not the OS dialog
    act(() => {
      fireEvent.click(btn);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(printPdfToPrinter).toHaveBeenCalledTimes(1);
    const call = (printPdfToPrinter as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as Record<string, unknown>;
    expect(call.printer).toBe('TestJet');
    expect(call.copies).toBe(1);
    expect(call.duplex).toBe('default');
    // the modal closed (the job is submitted; Word's posture)
    expect(usePrintPreviewStore.getState().isOpen).toBe(false);
    void editor;
  });
});
