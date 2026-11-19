import { describe, it, expect, beforeEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { Editor } from '@/components/editor/Editor';
import { DisplayModeGroup } from '@/components/layout/ribbon/view/groups/DisplayModeGroup';
import { PageSetupDialog } from '@/components/dialogs/PageSetupDialog';
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

    // The document's page color paints the strip (the pageColor law).
    act(() => {
      useDocumentStore.getState().setPageSetup({
        ...useDocumentStore.getState().pageSetup,
        pageColor: '#dc2626',
      });
    });
    expect(surface.style.background).toBe('rgb(220, 38, 38)');
  });

  it('the document\'s margins are the strip\'s padding (one margin concept)', async () => {
    harness('<p>margins</p>');
    await goPageless();
    const surface = document.querySelector('[data-testid="pageless-surface"]') as HTMLElement;
    // DEFAULT_MARGINS = 1" = 72pt = 96px on every side (pt→px law).
    expect(surface.style.padding).toBe('96px');
    // The responsive max-width column (the GDocs-pageless ruling).
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

  it('header/footer bands render ONCE, at the flow\'s ends (the chrome is stylesheet-side)', async () => {
    harness(
      '<header-block><p>the header words</p></header-block>' +
      '<p>body text</p>' +
      '<footer-block><p>the footer words</p></footer-block>',
    );
    await goPageless();
    const surface = document.querySelector('[data-testid="pageless-surface"]')!;
    const bands = surface.querySelectorAll('header-block, footer-block');
    // ONCE each — the schema pins their positions, the flow renders
    // them exactly there (the acceptance criterion). The BAND CHROME
    // (the dashed muted band) is stylesheet-side (index.css — the
    // pageless styling source of truth); jsdom runs without stylesheets
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
    // visual divider — the acceptance criterion). Its label chip is
    // stylesheet-side; jsdom runs without stylesheets (vitest css:
    // false) and cannot compute ::after at all.
    expect(marker).not.toBeNull();
    expect(marker.getAttribute('data-page-break')).toBe('true');
  });
});


