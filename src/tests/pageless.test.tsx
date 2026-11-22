import { describe, it, expect, beforeEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { Editor } from '@/components/editor/Editor';
import { DisplayModeGroup } from '@/components/layout/ribbon/view/groups/DisplayModeGroup';
import { PageSetupDialog } from '@/components/dialogs/PageSetupDialog';
import { measureRulerGeo } from '@/components/editor/PagelessRuler';
import { useDocumentPropertiesStore } from '@/lib/document/propertiesStore';
import { useConfigStore } from '@/lib/config/store';
import { useDocumentStore } from '@/lib/document/store';
import { DEFAULT_MARGINS, PAGE_GAP } from '@/lib/document/pageSetup';
import { FakeMetrics } from './fakeMetrics';
import { settleLayout } from './harness';

/**
 * PAGELESS — the strip refinements: the continuous sheet (centered
 * max-width column, the document's margins as padding, page color
 * WHITE default), the header/footer band chrome (once-only, dashed),
 * the break divider on the sheet, and the read-only pageless ruler.
 */

const button = (label: string) =>
  document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;

beforeEach(() => {
  useDocumentStore.getState().setPageInfo(1, 1);
  useDocumentStore.setState({
    pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP },
  });
  useConfigStore.setState((state) => ({
    config: {
      ...state.config,
      editor: { ...state.config.editor, defaultPageLayout: 'Pages' },
    },
  }));
});

function harness(initialHTML?: string) {
  const utils = render(
    <>
      <div data-desk-wrapper className="relative">
        <div data-desk-scroll style={{ overflow: 'auto' }}>
          <Editor metrics={FakeMetrics} />
        </div>
      </div>
      <DisplayModeGroup />
      <PageSetupDialog />
    </>,
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

async function goPageless() {
  act(() => {
    fireEvent.click(button('Paginated / Pageless')!);
  });
  await settleLayout();
}

describe('the pageless strip', () => {
  it('the sheet paints WHITE by default, the page color when set', async () => {
    harness('<p>sheet</p>');
    await goPageless();
    const surface = document.querySelector('[data-testid="pageless-surface"]') as HTMLElement;
    // WHITE DEFAULT (the strip IS the page now) — never the desk gray.
    expect(surface.style.background).toBe('rgb(255, 255, 255)');
    expect(surface.className).toContain('pageless-strip');

    // The document's page color paints the strip.
    act(() => {
      useDocumentStore.getState().setPageSetup({
        ...useDocumentStore.getState().pageSetup,
        pageColor: '#dc2626',
      });
    });
    expect(surface.style.background).toBe('rgb(220, 38, 38)');
  });

  it("the document's margins are the strip's padding (one margin concept)", async () => {
    harness('<p>margins</p>');
    await goPageless();
    const surface = document.querySelector('[data-testid="pageless-surface"]') as HTMLElement;
    // DEFAULT_MARGINS = 1" = 72pt = 96px on every side.
    expect(surface.style.padding).toBe('96px');
    // The responsive max-width column.
    expect(surface.style.maxWidth).toBe('960px');

    // A margin change rides the strip (one concept, two surfaces).
    act(() => {
      useDocumentStore.getState().setPageSetup({
        ...useDocumentStore.getState().pageSetup,
        margins: { top: 36, bottom: 36, left: 36, right: 36 },
      });
    });
    expect(surface.style.padding).toBe('48px');
  });

  it("header/footer bands render ONCE, at the flow's ends (the chrome is stylesheet-side)", async () => {
    harness(
      '<header-block><p>the header words</p></header-block>' +
      '<p>body text</p>' +
      '<footer-block><p>the footer words</p></footer-block>',
    );
    await goPageless();
    const surface = document.querySelector('[data-testid="pageless-surface"]')!;
    const bands = surface.querySelectorAll('header-block, footer-block');
    // ONCE each — the schema pins their positions, the flow renders
    // them exactly there. The BAND CHROME (the dashed muted band) is
    // stylesheet-side (index.css); jsdom runs without stylesheets
    // (vitest css: false), so the test pins the STRUCTURE the chrome
    // decorates.
    expect(bands.length).toBe(2);
    expect(bands[0]!.tagName.toLowerCase()).toBe('header-block');
    expect(bands[1]!.tagName.toLowerCase()).toBe('footer-block');
    expect(bands[0]!.textContent).toContain('the header words');
    expect(bands[1]!.textContent).toContain('the footer words');
  });

  it('the break divider rides the sheet (structure; the label chip is stylesheet-side)', async () => {
    harness('<p>before</p><div data-page-break="true" class="page-break-marker"></div><p>after</p>');
    await goPageless();
    const surface = document.querySelector('[data-testid="pageless-surface"]')!;
    const marker = surface.querySelector('.page-break-marker') as HTMLElement;
    // The manual break renders INSIDE the continuous sheet (a simple
    // visual divider). Its label chip is stylesheet-side; jsdom runs
    // without stylesheets (vitest css: false) and cannot compute
    // ::after at all.
    expect(marker).not.toBeNull();
    expect(marker.getAttribute('data-page-break')).toBe('true');
  });
});

describe('the pageless sheet lifecycle', () => {
  it('the strip fills the desk height (the sheet law — full-height white)', async () => {
    harness('<p>full height</p>');
    await goPageless();
    const surface = document.querySelector('[data-testid="pageless-surface"]') as HTMLElement;
    // jsdom's zero-height desk floors at the 200px fallback; the REAL
    // behavior (desk-height fill, zoom-divided) is pinned here as "the
    // component sets an explicit min-height" (never unstyled).
    expect(surface.style.minHeight).not.toBe('');
    expect(parseInt(surface.style.minHeight, 10)).toBeGreaterThanOrEqual(200);
  });

  it('CLICK ANYWHERE TO FOCUS — a click in the gutters/tail drops the caret at the end', async () => {
    const { editor } = harness('<p>the only words</p>');
    await goPageless();
    // The caret starts wherever the mount left it; a click on the
    // STRIP itself (outside .ProseMirror — the gutters or the
    // full-height tail) focuses the editor, caret at the doc end.
    const surface = document.querySelector('[data-testid="pageless-surface"]') as HTMLElement;
    act(() => {
      fireEvent.click(surface);
    });
    // The caret lands at the DOCUMENT'S END (GDocs' click-below-
    // content behavior). jsdom's isFocused tracking is unreliable —
    // the caret position is the real behavior.
    const end = editor.state.doc.content.size - 1;
    expect(editor.state.selection.from).toBe(end);
  });

  it('the configured selection color rides the sheet (the paginated parity)', async () => {
    const cfg = useConfigStore.getState();
    useConfigStore.setState({
      config: {
        ...cfg.config,
        editor: { ...cfg.config.editor, selectionColor: '#dc2626' },
      },
    });
    harness('<p>selection tint</p>');
    await goPageless();
    const surface = document.querySelector('[data-testid="pageless-surface"]') as HTMLElement;
    // The var carries the color at SELECTION_ALPHA (0.35 — the
    // paginated SelectionHighlights' alpha); the stylesheet's
    // ::selection rule consumes it.
    expect(surface.style.getPropertyValue('--pageless-selection-bg')).toBe('rgba(220, 38, 38, 0.35)');
  });

  it("the Page Setup dialog's layout toggle switches the document mode instantly", async () => {
    const { editor } = harness('<p>dialog toggle</p>');
    await goPageless();
    // Open the dialog (pageless).
    act(() => {
      useDocumentPropertiesStore.getState().openPageSetup();
    });
    const dialog = document.querySelector('[data-testid="page-setup-mode-toggle"]')!;
    expect(dialog.textContent).toContain('Paginated');
    expect(dialog.textContent).toContain('Pageless');
    const buttons = [...dialog.querySelectorAll('button')];
    const pagelessBtn = buttons.find((b) => b.textContent === 'Pageless')!;
    const paginatedBtn = buttons.find((b) => b.textContent === 'Paginated')!;
    expect(pagelessBtn.getAttribute('aria-pressed')).toBe('true');
    // Toggle INSIDE the dialog — the document's mode flips instantly
    // (a mode switch is not a drafted field).
    act(() => {
      fireEvent.click(paginatedBtn);
    });
    expect(useDocumentStore.getState().pageSetup.viewMode).toBe('pages');
    expect(useDocumentStore.getState().isDirty).toBe(true);
    expect(paginatedBtn.getAttribute('aria-pressed')).toBe('true');
    void editor;
  });
});

describe('the pageless ruler geometry (the pure math)', () => {
  it('the content box = computed padding × the rendered/layout scale; left tracks the strip', () => {
    const geo = measureRulerGeo(
      { left: 240, width: 960 }, 960, 200, 96, 96,
    );
    expect(geo.left).toBe(40);
    expect(geo.width).toBe(960);
    expect(geo.scale).toBe(1);
    expect(geo.contentL).toBeCloseTo(96, 0);
    expect(geo.contentR).toBeCloseTo(864, 0);
  });

  it('zoom scales the content box with the strip (rect/offset ratio)', () => {
    const geo = measureRulerGeo(
      { left: 320, width: 480 }, 960, 300, 96, 96,
    );
    expect(geo.left).toBe(20);
    expect(geo.width).toBe(480);
    expect(geo.scale).toBeCloseTo(0.5, 4);
    expect(geo.contentL).toBeCloseTo(48, 0);
    expect(geo.contentR).toBeCloseTo(432, 0);
  });
});

describe('the pageless ruler (read-only)', () => {
  it('renders into the desk wrapper with the canvas tick field (structure; the ink is the paint effect)', async () => {
    harness('<p>ruler</p>');
    await goPageless();
    const wrapper = document.querySelector('[data-desk-wrapper]')!;
    const ruler = wrapper.querySelector('[data-testid="pageless-ruler"]') as HTMLElement;
    expect(ruler).not.toBeNull();
    // THE MIMICRY: the paginated bar's canvas discipline — the tick
    // field paints on a DPR-scaled canvas over the strip (the overhang
    // included); jsdom can't rasterize, so the test pins the structure.
    const canvas = wrapper.querySelector('[data-testid="pageless-ruler-canvas"]') as HTMLCanvasElement;
    expect(canvas).not.toBeNull();
    expect(ruler.className).toContain('border-b border-border/60');
    expect(ruler.className).toContain('bg-card');
  });

  it('the config toggle hides it (the showHorizontalRuler gate)', async () => {
    harness('<p>ruler off</p>');
    act(() => {
      const cfg = useConfigStore.getState();
      useConfigStore.setState({
        config: { ...cfg.config, editor: { ...cfg.config.editor, showHorizontalRuler: false } },
      });
    });
    await goPageless();
    expect(document.querySelector('[data-testid="pageless-ruler"]')).toBeNull();
  });
});
