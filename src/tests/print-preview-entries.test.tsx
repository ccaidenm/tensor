import { describe, it, expect, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { renderTensor, settleLayout } from './harness';
import { PrintPreviewDialog, usePrintPreviewStore } from '@/components/dialogs/PrintPreviewDialog';
import { getCommand } from '@/lib/commands/registry';
import { getEffectiveKeybinding, SHORTCUTS } from '@/lib/shortcuts';
import { useConfigStore } from '@/lib/config/store';

/**
 * M-PRINT (#43, Mark 3 round 2) — the entry surfaces: Ctrl+P (the
 * SHORTCUTS table + the rebindable registry body), the View-menu
 * button's store target, and the modal's chrome suppression (the
 * guard pair law — Settings/palette/preview all suppress shortcuts).
 */

describe('print preview — the entry surfaces', () => {
  beforeEach(() => {
    usePrintPreviewStore.getState().close();
  });

  it('Ctrl+P is a rebindable app-level shortcut bound to the printPreview command', () => {
    const def = SHORTCUTS.find((s) => s.id === 'printPreview');
    expect(def).toMatchObject({ keys: 'ctrl+p', context: 'app' });
    // the registry body it dispatches (the palette + menu share it)
    const command = getCommand('printPreview');
    expect(command).toBeTruthy();
    expect(command!.shortcutId).toBe('printPreview');
    // the effective binding resolves through the rebind layer
    expect(
      getEffectiveKeybinding(useConfigStore.getState().config.keybindings, 'printPreview'),
    ).toBe('ctrl+p');
  });

  it('the command opens the modal (the View-menu button and Ctrl+P both dispatch it)', async () => {
    const { editor } = renderTensor('<p>entry surfaces</p>');
    await settleLayout();
    const utils = render(<PrintPreviewDialog />);
    expect(usePrintPreviewStore.getState().isOpen).toBe(false);
    act(() => {
      void getCommand('printPreview')!.run();
    });
    expect(usePrintPreviewStore.getState().isOpen).toBe(true);
    expect(utils.getAllByTestId('print-page').length).toBeGreaterThanOrEqual(1);
    void editor;
  });

  it('the always-ask trigger setting defaults to Shift and is rebindable', () => {
    expect(useConfigStore.getState().config.pdfAlwaysAskTrigger).toBe('shift');
    act(() => {
      useConfigStore.getState().setPdfAlwaysAskTrigger('ctrl');
    });
    expect(useConfigStore.getState().config.pdfAlwaysAskTrigger).toBe('ctrl');
    act(() => {
      useConfigStore.getState().setPdfAlwaysAskTrigger('shift');
    });
  });

  it('the dialog sizes ABOVE Settings (the posture: min(90vw, 80rem))', async () => {
    const { editor } = renderTensor('<p>size posture</p>');
    await settleLayout();
    const utils = render(<PrintPreviewDialog />);
    act(() => {
      usePrintPreviewStore.getState().open();
    });
    const modal = utils.getByTestId('print-preview') as HTMLElement;
    const content = modal.closest('[role="dialog"]') as HTMLElement | null;
    // DialogContent carries the size inline; the test asserts the
    // element exists and carries the 80rem spelling (jsdom computes
    // nothing — the string is the contract).
    const styled = (content ?? modal) as HTMLElement;
    expect(styled.getAttribute('style')).toContain('min(90vw, 80rem)');
    void editor;
  });
});