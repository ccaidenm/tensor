import { describe, it, expect } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { LineSpacingButton } from '@/components/layout/ribbon/home/LineSpacingButton';
import { StyleDialog } from '@/components/dialogs/StyleDialog';
import { PageSetupDialog } from '@/components/dialogs/PageSetupDialog';
import { useStyleRegistryStore } from '@/lib/styles/registry';
import { useDocumentStore } from '@/lib/document/store';
import { useDocumentPropertiesStore } from '@/lib/document/propertiesStore';
import { DEFAULT_MARGINS, PAGE_GAP, toLayoutOptions } from '@/lib/document/pageSetup';
import { renderTensorInScrollContainer, settleLayout } from './harness';

/**
 * M-FLOW — the paragraph popover UI suite (the reworked Line Spacing
 * dropdown): the FLUID single trigger, the Line Spacing radio group
 * (reflecting the selection's always-present effective multiplier),
 * the Line & Page Breaks checkboxes (mixed-state aware, style-tier
 * resolved, live + stay-open), and the StyleDialog's Pagination
 * section. Base UI controls assert through aria-checked. The model
 * suite lives in flowAttrs.test.tsx.
 */

/** The trigger is ONE fluid button: icon + chevron inside, no seam. */
function openPopover(editor: Editor) {
  render(<LineSpacingButton editor={editor} />);
  const trigger = document.querySelector('[data-testid="line-spacing-trigger"]') as HTMLElement;
  expect(trigger).not.toBeNull();
  expect(trigger.querySelectorAll('svg').length).toBe(2); // the icon + the chevron
  act(() => {
    fireEvent.click(trigger);
  });
}

/** Base UI checkbox/radio state reads aria-checked ('mixed' included). */
function ariaChecked(testId: string): string | null {
  const el = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  return el?.getAttribute('aria-checked') ?? null;
}

describe('M-FLOW: the Line Spacing & Page Breaks popover', () => {
  it('both sections render: the radio group + custom above, the six break toggles below', async () => {
    const { editor } = renderTensorInScrollContainer('<p>one</p>');
    await settleLayout();
    openPopover(editor);
    expect(document.body.textContent).toContain('Line Spacing');
    expect(document.body.textContent).toContain('Line & Page Breaks');
    expect(document.querySelector('input[placeholder="Custom"]')).not.toBeNull();
    // The radio group: Single checks by default (every paragraph always
    // has a spacing attribute — unset resolves to 1.0).
    expect(ariaChecked('spacing-radio-1')).toBe('true');
    expect(ariaChecked('spacing-radio-1.5')).toBe('false');
    // The six flags: widow/orphan ON (the default-on family), rest OFF.
    for (const label of ['keep-with-next', 'keep-lines-together', 'keep-with-previous', 'page-break-before', 'page-break-after']) {
      expect(ariaChecked(`flow-toggle-${label}`)).toBe('false');
    }
    expect(ariaChecked('flow-toggle-widow-orphan-control')).toBe('true');
  });

  it('the line-spacing radio reflects the selection\'s EFFECTIVE multiplier (uniform → checked, mixed → none)', async () => {
    const { editor } = renderTensorInScrollContainer('<p>one</p><p>two</p>');
    await settleLayout();
    openPopover(editor);
    // Uniform 1.5 across both paragraphs → the 1.5 radio checks.
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 9 });
      editor.commands.setLineHeight('1.5');
    });
    expect(ariaChecked('spacing-radio-1.5')).toBe('true');
    expect(ariaChecked('spacing-radio-1')).toBe('false');
    // Mixed (1.5 + 2) → no radio checks — re-select the pair first so
    // the popover reads the WHOLE selection again.
    act(() => {
      editor.commands.setTextSelection({ from: 6, to: 9 });
      editor.commands.setLineHeight('2');
    });
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 9 });
    });
    expect(ariaChecked('spacing-radio-1.5')).toBe('false');
    expect(ariaChecked('spacing-radio-2')).toBe('false');
  });

  it('picking a radio applies the spacing and closes the popover', async () => {
    const { editor } = renderTensorInScrollContainer('<p>one</p>');
    await settleLayout();
    openPopover(editor);
    const double = document.querySelector('[data-testid="spacing-radio-2"]') as HTMLElement;
    act(() => {
      fireEvent.click(double);
    });
    expect(editor.state.doc.child(0).attrs.lineHeight).toBe('2');
    // Menu semantics: a pick applies AND closes.
    expect(document.querySelector('[data-testid="spacing-radio-2"]')).toBeNull();
  });

  it('break toggles apply LIVE and stay open; the state re-reads through the style tier', async () => {
    const { editor } = renderTensorInScrollContainer('<p>one</p><h2>head word</h2>');
    await settleLayout();
    openPopover(editor);
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 13 });
    });
    const keepNext = document.querySelector('[data-testid="flow-toggle-keep-with-next"]') as HTMLElement;
    act(() => {
      fireEvent.click(keepNext);
    });
    expect(editor.state.doc.child(0).attrs.keepNext).toBe(true);
    expect(editor.state.doc.child(1).attrs.keepNext).toBe(true);
    // The popover is still open (stay-open toggles) and the checkbox
    // re-reads ON.
    expect(ariaChecked('flow-toggle-keep-with-next')).toBe('true');
    // Uncheck writes the explicit OFF that beats the style tier.
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="flow-toggle-keep-with-next"]')!);
    });
    expect(editor.state.doc.child(0).attrs.keepNext).toBe(false);
    expect(editor.state.doc.child(1).attrs.keepNext).toBe(false);
    expect(ariaChecked('flow-toggle-keep-with-next')).toBe('false');
  });

  it('a heading reflects its STYLE-tier keepNext as checked (the registry cascade)', async () => {
    const { editor } = renderTensorInScrollContainer('<h2>head word</h2>');
    await settleLayout();
    openPopover(editor);
    // heading-2's builtin carries keepNext: true; the attr is null —
    // the checkbox shows the EFFECTIVE (style-resolved) state.
    expect(editor.state.doc.child(0).attrs.keepNext).toBe(null);
    expect(ariaChecked('flow-toggle-keep-with-next')).toBe('true');
    // Unchecking writes the explicit override off (attr false).
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="flow-toggle-keep-with-next"]')!);
    });
    expect(editor.state.doc.child(0).attrs.keepNext).toBe(false);
    expect(ariaChecked('flow-toggle-keep-with-next')).toBe('false');
  });

  it('a mixed selection renders the indeterminate checkbox', async () => {
    const { editor } = renderTensorInScrollContainer('<p>one</p><p>two</p>');
    await settleLayout();
    act(() => {
      editor.commands.setTextSelection({ from: 6, to: 9 });
      editor.commands.setFlowAttrs({ keepLines: true });
    });
    openPopover(editor);
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 9 });
    });
    expect(ariaChecked('flow-toggle-keep-lines-together')).toBe('mixed');
  });
});

describe('M-FLOW: the StyleDialog Pagination section (the style tier)', () => {
  it("editing heading-1 shows the builtin keepNext checked; unchecking + save rewrites the definition (and restores)", async () => {
    renderTensorInScrollContainer('<p>x</p>');
    await settleLayout();
    render(<StyleDialog state={{ open: true, editingId: 'heading-1', kind: 'paragraph' }} onClose={() => {}} />);
    const keepNext = document.querySelector('[data-testid="style-flow-keepNext"]') as HTMLElement;
    expect(keepNext).not.toBeNull();
    expect(keepNext.getAttribute('aria-checked')).toBe('true'); // the heading-1 builtin (Word's default)
    // Uncheck → save: the definition drops the property (absent ≡ unset).
    act(() => {
      fireEvent.click(keepNext);
    });
    expect(keepNext.getAttribute('aria-checked')).toBe('false');
    const save = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save Style')!;
    act(() => {
      fireEvent.click(save);
    });
    expect(useStyleRegistryStore.getState().merged['heading-1']!.properties.keepNext).toBeUndefined();
    // Restore the builtin for the rest of the suite.
    act(() => {
      useStyleRegistryStore.getState().updateDefinition('heading-1', {
        ...useStyleRegistryStore.getState().merged['heading-1']!,
        properties: {
          ...useStyleRegistryStore.getState().merged['heading-1']!.properties,
          keepNext: true,
        },
      });
    });
    expect(useStyleRegistryStore.getState().merged['heading-1']!.properties.keepNext).toBe(true);
  });
});

describe('M-FLOW: the Page Setup widow/orphan switch (the document default)', () => {
  it('toggling off + Apply writes the store default; toLayoutOptions feeds the engine', async () => {
    renderTensorInScrollContainer('<p>x</p>');
    await settleLayout();
    act(() => {
      useDocumentStore.getState().setPageSetup({
        pageSize: 'Letter',
        margins: DEFAULT_MARGINS,
        pageGap: PAGE_GAP,
      });
      useDocumentPropertiesStore.getState().openPageSetup();
    });
    render(<PageSetupDialog />);
    const widowSwitch = document.querySelector('[data-testid="page-setup-widow-control"]') as HTMLElement;
    expect(widowSwitch.getAttribute('aria-checked')).toBe('true'); // absent = ON (the engine default)
    act(() => {
      fireEvent.click(widowSwitch);
    });
    const apply = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Done')!;
    act(() => {
      fireEvent.click(apply);
    });
    // ONE commit: the store's document default is off, and the layout
    // options the engine receives follow.
    expect(useDocumentStore.getState().pageSetup.widowControl).toBe(false);
    expect(toLayoutOptions(useDocumentStore.getState().pageSetup).preventWidowsAndOrphans).toBe(false);
  });
});
