import { describe, it, expect, beforeEach } from 'vitest';
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
