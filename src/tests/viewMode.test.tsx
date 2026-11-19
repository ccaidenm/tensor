import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { Editor } from '@/components/editor/Editor';
import { DisplayModeGroup } from '@/components/layout/ribbon/view/groups/DisplayModeGroup';
import { PageSetupGroup } from '@/components/layout/ribbon/layout/groups/PageSetupGroup';
import { PageSetupDialog } from '@/components/dialogs/PageSetupDialog';
import { useConfigStore } from '@/lib/config/store';
import { useDocumentStore } from '@/lib/document/store';
import { useDocumentPropertiesStore } from '@/lib/document/propertiesStore';
import { DEFAULT_MARGINS, PAGE_GAP, MARGIN_PRESETS, PAGELESS_MARGIN_PRESETS, summarizeMarginPreset, resolveViewMode } from '@/lib/document/pageSetup';
import { FakeMetrics } from './fakeMetrics';
import { settleLayout } from './harness';

// The mode toggle + its Layout-tab consequences. The ribbon groups are
// rendered DIRECTLY (they are store-driven and propless): tab-chrome
// activation is Base UI pointer-event machinery jsdom can't fire, and
// the wiring under test is button -> config store -> Editor routing
// and button disabled states — none of which the Tabs add.

const button = (label: string) =>
  document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;

beforeEach(() => {
  useDocumentStore.getState().setPageInfo(1, 1);
  useDocumentStore.setState({
    pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP },
  });
  useDocumentPropertiesStore.setState({ pageSetupIsOpen: false, customSizeIsOpen: false });
  useConfigStore.setState((state) => ({
    config: {
      ...state.config,
      editor: { ...state.config.editor, defaultPageLayout: 'Pages' },
    },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function settle() {
  await settleLayout();
}

/** The editor + the two ribbon groups whose interaction is under test. */
function harness(initialHTML?: string) {
  const utils = render(
    <>
      <Editor metrics={FakeMetrics} />
      <DisplayModeGroup />
      <PageSetupGroup />
      <PageSetupDialog />
    </>
  );
  const editor = useDocumentStore.getState().editor;
  if (!editor) throw new Error('editor not in store after render');
  if (initialHTML) {
    act(() => {
      editor.commands.setContent(initialHTML);
    });
  }
  return { editor, ...utils };
}

describe('View > Paginated / Pageless toggle', () => {
  it('flips the mode: paginated surface -> pageless surface -> back (PER-DOCUMENT)', async () => {
    const { editor } = harness('<p>hello world</p>');
    await settle();

    // PAGINATED (default): the engine-driven surface with sheets.
    expect(document.querySelector('[data-testid="paginated-root"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="pageless-surface"]')).toBeNull();

    const toggle = button('Paginated / Pageless')!;
    expect(toggle).not.toBeNull();
    // Active when paginated (GDocs' Print Layout convention).
    expect(toggle.getAttribute('aria-pressed')).toBe('true');

    act(() => {
      fireEvent.click(toggle);
    });
    await settle();

    // THE PER-DOCUMENT LAW: the toggle writes pageSetup.viewMode (the
    // setting rides .wpdoc like the rest of pageSetup) and marks the
    // document dirty — the config field stays the NEW-DOCUMENT default.
    expect(useDocumentStore.getState().pageSetup.viewMode).toBe('pageless');
    expect(useDocumentStore.getState().isDirty).toBe(true);
    expect(useConfigStore.getState().config.editor.defaultPageLayout).toBe('Pages');
    expect(document.querySelector('[data-testid="paginated-root"]')).toBeNull();
    expect(document.querySelector('[data-testid="pageless-surface"]')).not.toBeNull();

    act(() => {
      fireEvent.click(button('Paginated / Pageless')!);
    });
    await settle();

    expect(useDocumentStore.getState().pageSetup.viewMode).toBe('pages');
    expect(useConfigStore.getState().config.editor.defaultPageLayout).toBe('Pages');
    expect(document.querySelector('[data-testid="paginated-root"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="pageless-surface"]')).toBeNull();
    void editor;
  });

  it('the DOCUMENT choice wins over the config default (the resolver law)', async () => {
    // A doc carrying viewMode: 'pageless' opens pageless EVEN while the
    // config default says Pages (the per-document law).
    useDocumentStore.setState({
      pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP, viewMode: 'pageless' },
    });
    harness('<p>doc-owned mode</p>');
    await settle();
    expect(document.querySelector('[data-testid="pageless-surface"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="paginated-root"]')).toBeNull();

    // The doc's absent viewMode falls back to the config default.
    useDocumentStore.setState({
      pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP, viewMode: 'pages' },
    });
    act(() => {
      useDocumentStore.getState().setPageInfo(1, 1);
    });
    harness('<p>fallback doc</p>');
    await settle();
    expect(document.querySelector('[data-testid="paginated-root"]')).not.toBeNull();
  });

  it('the document survives the mode flip (one PM instance, content intact)', async () => {
    const { editor } = harness('<p>the words stay</p>');
    await settle();
    const before = editor.state.doc;

    act(() => {
      fireEvent.click(button('Paginated / Pageless')!);
    });
    await settle();

    // Same editor instance (the mode routes the VIEW, never rebuilds
    // the document), and pageless shows the content.
    expect(useDocumentStore.getState().editor).toBe(editor);
    expect(document.querySelector('.ProseMirror')!.textContent).toContain('the words stay');
    expect(before.textContent).toContain('the words stay');

    // Typing still works in pageless (the visible surface is the
    // editing surface).
    act(() => {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      editor.commands.insertContent('!');
    });
    expect(document.querySelector('.ProseMirror')!.textContent).toContain('the words stay!');
  });
});

describe('Layout tab page-geometry controls in pageless mode', () => {
  it('pageless: Page Setup OPENS the dialog (the layout toggle lives there); Orientation/Paper Size stay disabled', async () => {
    harness('<p>hello world</p>');
    await settle();

    // Paginated: everything live.
    expect(button('Page Setup')!.disabled).toBe(false);
    expect(button('Orientation (whole document)')!.disabled).toBe(false);
    expect(button('Paper Size (whole document)')).not.toBeNull();

    act(() => {
      fireEvent.click(button('Paginated / Pageless')!);
    });
    await settle();

    // Pageless: the Page Setup button stays LIVE (the dialog's layout
    // toggle + margins carry the strip); the Orientation and Paper
    // Size quick controls remain disabled (paginated facts). Page
    // Background stays live in both.
    expect(button('Page Setup')!.disabled).toBe(false);
    expect(button('Orientation (whole document)')!.disabled).toBe(true);
    expect(button('Paper Size (whole document)')!.disabled).toBe(true);
    expect(button('Page Background (whole document)')!.disabled).toBe(false);
    expect(button('Page Background (whole document) options')!.disabled).toBe(false);

    // The dialog opens; its layout toggle is armed on Pageless (the
    // document's own mode) and the PAGINATED-ONLY controls inside are
    // DISABLED — never hidden (the dialog holds its size).
    button('Page Setup')!.click();
    await settle();
    const toggle = document.querySelector('[data-testid="page-setup-mode-toggle"]');
    expect(toggle).not.toBeNull();
    const paginatedBtn = [...toggle!.querySelectorAll('button')].find((b) => b.textContent === 'Paginated')!;
    const pagelessBtn = [...toggle!.querySelectorAll('button')].find((b) => b.textContent === 'Pageless')!;
    expect(pagelessBtn.getAttribute('aria-pressed')).toBe('true');
    // Paper size: disabled in pageless.
    const paperSelect = document.querySelector('[aria-label="Paper size"]') as HTMLButtonElement;
    expect(paperSelect.disabled).toBe(true);
    // The margins row stays live (the strip's fields).
    expect(document.querySelector('[aria-label="Margin presets"]')).not.toBeNull();
    void paginatedBtn;
  });
});

describe('resolveViewMode (the one view-mode resolver) + the Full preset', () => {
  it('the document choice wins; absent falls back to the config default', () => {
    expect(resolveViewMode('pageless', 'Pages')).toBe('Pageless');
    expect(resolveViewMode('pages', 'Pageless')).toBe('Pages');
    expect(resolveViewMode(undefined, 'Pageless')).toBe('Pageless');
    expect(resolveViewMode(undefined, 'Pages')).toBe('Pages');
    // Garbage (a speculative-build config) falls to the config default.
    expect(resolveViewMode('Full', 'Pages')).toBe('Pages');
  });

  it('Full zeroes every side and summarizes as zero margins', () => {
    // THE PRESET SPLIT: paginated keeps the original four; pageless
    // gets its own row (Narrow/Normal/Wide/Full — Moderate drops).
    expect(Object.keys(MARGIN_PRESETS)).toEqual(['Narrow', 'Normal', 'Moderate', 'Wide']);
    expect(Object.keys(PAGELESS_MARGIN_PRESETS)).toEqual(['Narrow', 'Normal', 'Wide', 'Full']);
    expect(PAGELESS_MARGIN_PRESETS.Full).toBeDefined();
    expect(PAGELESS_MARGIN_PRESETS.Full.margins).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
    expect(summarizeMarginPreset(PAGELESS_MARGIN_PRESETS.Full.margins, 'inches')).toContain('0');
  });
});

describe('Page Background in pageless mode', () => {
  it('picking a color through the Layout button paints the pageless surface', async () => {
    harness('<p>hello world</p>');
    await settle();

    act(() => {
      fireEvent.click(button('Paginated / Pageless')!);
    });
    await settle();

    const surface = document.querySelector('[data-testid="pageless-surface"]') as HTMLElement;
    expect(surface).not.toBeNull();
    // THE STRIP LAW: the sheet paints WHITE by default (the strip IS
    // the page now); a picked color replaces it on both surfaces.
    expect(surface.style.background).toBe('rgb(255, 255, 255)');

    // Open the palette (the chevron) and pick a swatch — the real
    // user path in pageless mode.
    act(() => {
      fireEvent.click(button('Page Background (whole document) options')!);
    });
    const swatch = document.querySelector('button[aria-label="#dc2626"]') as HTMLElement;
    expect(swatch).not.toBeNull();
    act(() => {
      fireEvent.click(swatch);
    });
    await settle();

    // ONE setting, TWO surfaces: the store holds the color, and the
    // pageless surface paints it (paginated sheets paint the same
    // value — pinned in carryovers.test.tsx).
    expect(useDocumentStore.getState().pageSetup.pageColor).toBe('#dc2626');
    expect(surface.style.background).toBe('rgb(220, 38, 38)');

    // Reset ("Default") clears it back to no background.
    act(() => {
      fireEvent.click(button('Page Background (whole document) options')!);
    });
    const reset = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Default'
    )!;
    act(() => {
      fireEvent.click(reset);
    });
    await settle();
    expect(useDocumentStore.getState().pageSetup.pageColor).toBe('');
    // THE STRIP LAW: cleared = back to the white sheet (never an
    // empty style — the strip is the page now).
    expect((document.querySelector('[data-testid="pageless-surface"]') as HTMLElement).style.background).toBe('rgb(255, 255, 255)');
  });
});
