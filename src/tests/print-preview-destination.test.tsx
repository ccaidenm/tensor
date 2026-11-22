import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { renderTensor, settleLayout } from './harness';
import { PrintPreviewDialog, usePrintPreviewStore } from '@/components/dialogs/PrintPreviewDialog';
import { useConfigStore } from '@/lib/config/store';
import { useDocumentStore } from '@/lib/document/store';
import { useDocumentPropertiesStore } from '@/lib/document/propertiesStore';

/**
 * #43 — the destination contract: the segmented [Printer | PDF]
 * control backed by print.lastDestination (memory), the resolved PDF
 * body (filename, folder, metadata write-through), the commit button
 * labeled with the path, and the keyboard arm (Enter commits, the
 * configured trigger held force-prompts). One modal — never two.
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
    // cleared → omitted (absent means never set)
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
    // restore the default (no pollution into the later suites)
    act(() => {
      useConfigStore.getState().setPdfAlwaysAskTrigger('shift');
    });
    void editor;
  });
});

/** The tensor-native printer picker (replaces the system dialog). The
 *  nativePrint seam is mocked: the default preselects, the trigger-
 *  modifier owns the system dialog, the commit runs the pipeline. */
// The destination suite's own dialog/fs mocks (the PDF commit path's
// seams — save/exists/writeFile must not touch the OS in tests).
const pdfIo = vi.hoisted(() => ({
  savePath: null as string | null,
  existsResult: false,
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(async () => pdfIo.savePath),
  open: vi.fn(async () => null),
  ask: vi.fn(async () => true),
  message: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(async () => pdfIo.existsResult),
  writeFile: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
}));

vi.mock('@/lib/print/PrintContainer', () => ({
  printFromPreview: vi.fn(async () => undefined),
  printPageSizeOf: () => 'Letter',
}));
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

  it('enumerates on open; the default printer preselects; NO system-dialog entry (the trigger owns it)', async () => {
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
    // NO system-dialog entry: opening the picker lists exactly the
    // enumerated printers (the trigger modifier owns the OS dialog path).
    const trigger = utils.getByTestId('print-preview-printer-select') as HTMLElement;
    act(() => {
      fireEvent.click(trigger);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const options = [...document.querySelectorAll('[role=option]')];
    expect(options.length).toBe(2); // TestJet + Basement Laser — never a system entry
    expect(options.every((o) => !(o.textContent ?? '').includes('System print dialog'))).toBe(true);
    // Close the picker (the popup must not linger into the next test).
    act(() => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    void editor;
  });

  it('the TRIGGER-click commits to the SYSTEM dialog (printFromPreview), not the native pipeline', async () => {
    const { printPdfToPrinter } = await import('@/lib/print/nativePrint');
    const { printFromPreview } = await import('@/lib/print/PrintContainer');
    const { editor } = renderTensor('<p>trigger print</p>');
    await settleLayout();
    const utils = render(<PrintPreviewDialog />);
    act(() => usePrintPreviewStore.getState().open());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const btn = utils.getByTestId('print-preview-commit') as HTMLButtonElement;
    // The configured trigger held (Shift default) → the OS dialog.
    act(() => {
      useConfigStore.getState().setPdfAlwaysAskTrigger('shift');
    });
    act(() => {
      fireEvent.click(btn, { shiftKey: true });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(printFromPreview).toHaveBeenCalledTimes(1);
    expect(printPdfToPrinter).not.toHaveBeenCalled();
    void editor;
  });

  it('the duplex pick PERSISTS as the last-used setting (the picker\'s seed)', async () => {
    const { editor } = renderTensor('<p>duplex</p>');
    await settleLayout();
    const utils = render(<PrintPreviewDialog />);
    act(() => usePrintPreviewStore.getState().open());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    // The default seed: one-sided (print.lastDuplex's default).
    const duplexTrigger = utils.getByTestId('print-preview-duplex-select') as HTMLElement;
    expect(duplexTrigger.textContent).toContain('One-sided');
    expect(useConfigStore.getState().config.print.lastDuplex).toBe('one-sided');
    void editor;
  });

  it('the COPIES ticker steps both directions (the FontSizeInput pattern)', async () => {
    const { editor } = renderTensor('<p>copies</p>');
    await settleLayout();
    const utils = render(<PrintPreviewDialog />);
    act(() => usePrintPreviewStore.getState().open());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const input = utils.getByTestId('print-preview-copies') as HTMLInputElement;
    expect(input.value).toBe('1');
    const more = utils.getByLabelText('More copies') as HTMLButtonElement;
    act(() => {
      fireEvent.click(more);
      fireEvent.click(more);
    });
    expect((utils.getByTestId('print-preview-copies') as HTMLInputElement).value).toBe('3');
    const less = utils.getByLabelText('Fewer copies') as HTMLButtonElement;
    act(() => {
      fireEvent.click(less);
    });
    expect((utils.getByTestId('print-preview-copies') as HTMLInputElement).value).toBe('2');
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
    expect(call.duplex).toBe('one-sided'); // the last-used seed (no 'default' option)
    // the modal closed (the job is submitted; Word's posture)
    expect(usePrintPreviewStore.getState().isOpen).toBe(false);
    void editor;
  });
});

describe('THE CLOSE LAW (both destinations): success closes, error stays', () => {
  it('a PDF export SUCCESS toasts and CLOSES the modal', async () => {
    // The fs save path is the real seam: mock the plugin so the
    // export writes "successfully" without an OS dialog.
    pdfIo.savePath = '/tmp/opencode/test-export.pdf';
    pdfIo.existsResult = false;
    const { editor } = renderTensor('<p>pdf close</p>');
    await settleLayout();
    const utils = render(<PrintPreviewDialog />);
    act(() => {
      useConfigStore.getState().setPrintLastDestination('pdf');
      useConfigStore.getState().setDownloadsDir('');
      usePrintPreviewStore.getState().open();
    });
    const btn = utils.getByTestId('print-preview-commit') as HTMLButtonElement;
    act(() => {
      fireEvent.click(btn);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(usePrintPreviewStore.getState().isOpen).toBe(false);
    void editor;
  });

  it('a PDF export FAILURE toasts and the modal STAYS (fix + retry)', async () => {
    pdfIo.savePath = null; // the cancel path stays open too (nothing lost)
    const { editor } = renderTensor('<p>pdf stay</p>');
    await settleLayout();
    const utils = render(<PrintPreviewDialog />);
    act(() => {
      useConfigStore.getState().setPrintLastDestination('pdf');
      useConfigStore.getState().setDownloadsDir('');
      usePrintPreviewStore.getState().open();
    });
    const btn = utils.getByTestId('print-preview-commit') as HTMLButtonElement;
    act(() => {
      fireEvent.click(btn);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(usePrintPreviewStore.getState().isOpen).toBe(true);
    void editor;
  });

  it('the hover-ellipsis tracks the LIVE modifier (pointer-move sync — never sticky)', async () => {
    const { editor } = renderTensor('<p>ellipsis</p>');
    await settleLayout();
    const utils = render(<PrintPreviewDialog />);
    act(() => usePrintPreviewStore.getState().open());
    const btn = utils.getByTestId('print-preview-commit') as HTMLButtonElement;
    expect(btn.textContent).not.toContain('…');
    // A swallowed keyup (focus elsewhere) leaves window key-state
    // stale — the pointer events must self-correct: press → hover →
    // release → move → the ellipsis leaves.
    act(() => {
      fireEvent.pointerEnter(btn, { shiftKey: true });
    });
    expect(btn.textContent).toContain('…');
    act(() => {
      // shift RELEASED, pointer still over: the move event corrects
      fireEvent.pointerMove(btn, { shiftKey: false });
    });
    expect(btn.textContent).not.toContain('…');
    void editor;
  });
});
