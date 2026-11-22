import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { Ribbon } from '@/components/layout/Ribbon';
import { useDocumentStore } from '@/lib/document/store';
import { useConfigStore } from '@/lib/config/store';
import { DEFAULT_MARGINS, PAGE_GAP } from '@/lib/document/pageSetup';
import { useRibbonContextStore } from '@/lib/ribbon/contextStore';
import { CONTEXTUAL_TABS } from '@/lib/ribbon/contextualTabs';
import { selectionInTable } from '@/lib/ribbon/useRibbonContext';
import { renderTensor, settleLayout } from './harness';

// Fixtures

/** A doc with one table (2×2, header row) + a paragraph after it. */
const TABLE_DOC = '<p>before</p><table><tr><th>a</th><th>b</th></tr><tr><td>c</td><td>d</td></tr></table><p>after</p>';

const contextualTrigger = () =>
  document.querySelector('[data-testid="contextual-tab-trigger"]') as HTMLElement | null;

/** The strip trigger for a tab label ('Home', 'Insert', 'Header & Footer', …). */
const stripTriggerFor = (label: string) =>
  Array.from(document.querySelectorAll('[data-slot="tabs-trigger"]')).find(
    (el) => el.textContent === label,
  ) as HTMLElement | null;

const triggerIsActive = (el: HTMLElement | null) =>
  el?.getAttribute('data-active') === 'true' || el?.getAttribute('aria-selected') === 'true';

/** Renders the production <Ribbon/> (needs the editor in the document
 *  store — renderTensor provides the real one). */
function renderRibbon() {
  const utils = render(<Ribbon />);
  return { ...utils, ribbon: document.querySelector('[data-slot="tabs"]') };
}

beforeEach(() => {
  // The document store persists between tests (module singleton) —
  // reset the parts this suite touches.
  useDocumentStore.setState({
    pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP },
    editor: useDocumentStore.getState().editor,
  });
  useRibbonContextStore.setState({ active: null });
  useConfigStore.getState().setReduceMotion('system');
});

afterEach(() => {
  vi.restoreAllMocks();
  useRibbonContextStore.setState({ active: null });
});

// Store contract

describe('contextStore contract', () => {
  it('a. enter appends + focuses the contextual tab and remembers the previous tab', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderTensor('<p>hello</p>');
    renderRibbon();

    // User was on Insert (a normal tab), then the table context enters.
    fireEvent.click(stripTriggerFor('Insert')!);
    act(() => {
      useRibbonContextStore.getState().enter('table');
    });

    // The trigger is in the strip with the accent ink and is focused.
    const trigger = contextualTrigger();
    expect(trigger).not.toBeNull();
    expect(trigger!.className).toContain('text-primary');
    expect(trigger!.textContent).toBe('Table');
    expect(triggerIsActive(trigger)).toBe(true);

    // The contextual panel rendered (registry content — the placeholder
    // group's icon button carries its aria-label).
    expect(document.querySelector('[aria-label="Table tools"]')).not.toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('b. exit removes the tab and restores the previous tab', () => {
    renderTensor('<p>hello</p>');
    renderRibbon();

    fireEvent.click(stripTriggerFor('Insert')!);
    act(() => {
      useRibbonContextStore.getState().enter('image');
    });
    expect(contextualTrigger()?.textContent).toBe('Image');

    act(() => {
      useRibbonContextStore.getState().exit('image');
    });
    expect(contextualTrigger()).toBeNull();
    // The tab the user was on is restored.
    expect(triggerIsActive(stripTriggerFor('Insert'))).toBe(true);
  });

  it('c. mutual exclusion: entering a second context while one is active is a no-op', () => {
    renderTensor('<p>hello</p>');
    renderRibbon();

    act(() => {
      useRibbonContextStore.getState().enter('table');
    });
    act(() => {
      useRibbonContextStore.getState().enter('image');
    });

    expect(useRibbonContextStore.getState().active).toBe('table');
    expect(contextualTrigger()?.textContent).toBe('Table');
  });

  it('d. a stale producer exit never kills a newer context', () => {
    renderTensor('<p>hello</p>');
    renderRibbon();

    act(() => {
      useRibbonContextStore.getState().enter('table');
    });
    act(() => {
      useRibbonContextStore.getState().exit('image'); // stale id
    });
    expect(useRibbonContextStore.getState().active).toBe('table');
  });

  it('e. clicking a NORMAL tab keeps the context active (the trigger lingers)', () => {
    renderTensor('<p>hello</p>');
    renderRibbon();

    act(() => {
      useRibbonContextStore.getState().enter('table');
    });
    // User manually switches to Home.
    fireEvent.click(stripTriggerFor('Home')!);

    expect(useRibbonContextStore.getState().active).toBe('table');
    expect(contextualTrigger()).not.toBeNull(); // lingers in the strip
    expect(triggerIsActive(stripTriggerFor('Home'))).toBe(true);
    // The context exiting restores the tab the user was on before it
    // entered (Home — captured at enter time, not the manual switch).
    act(() => {
      useRibbonContextStore.getState().exit('table');
    });
    expect(contextualTrigger()).toBeNull();
    expect(triggerIsActive(stripTriggerFor('Home'))).toBe(true);
  });
});

// Registry

describe('contextualTabs registry', () => {
  it('every entry is well-formed and uniquely keyed', () => {
    const entries = Object.values(CONTEXTUAL_TABS);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    for (const def of entries) {
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.icon).toBeTruthy();
      expect(def.content).toBeTypeOf('function');
    }
    expect(Object.keys(CONTEXTUAL_TABS)).toEqual(
      expect.arrayContaining(['table', 'image', 'headerFooter']),
    );
  });
});

// Selection producers (end to end)

describe('selection producers', () => {
  it('a table selection enters the table context; leaving it exits + restores', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { editor } = renderTensor(TABLE_DOC);
    await settleLayout();
    renderRibbon();

    // Park the caret inside the first cell (after the 'a' text node).
    expect(selectionInTable(editor)).toBe(false);
    let targetPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (targetPos < 0 && node.isText && node.text === 'a') targetPos = pos + 1;
      return targetPos < 0;
    });
    expect(targetPos).toBeGreaterThan(0);
    act(() => {
      editor.commands.setTextSelection(targetPos);
    });
    expect(selectionInTable(editor)).toBe(true);

    // The producer fired: the Table contextual tab appeared + focused.
    await act(async () => {
      await settleLayout();
    });
    expect(contextualTrigger()?.textContent).toBe('Table');
    expect(triggerIsActive(contextualTrigger())).toBe(true);

    // Move the caret OUT of the table (into the trailing paragraph).
    let afterPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (afterPos < 0 && node.isText && node.text === 'after') afterPos = pos + 1;
      return afterPos < 0;
    });
    act(() => {
      editor.commands.setTextSelection(afterPos);
    });
    await act(async () => {
      await settleLayout();
    });
    expect(contextualTrigger()).toBeNull();
    // The contiguity tripwire noise is the table doc's own paginated
    // behavior (see tables.test.tsx), not this suite's concern — the
    // spy only silences it.
  });

  it('an image node selection enters the image context', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { editor } = renderTensor('<p>before</p>');
    await settleLayout();
    renderRibbon();

    act(() => {
      editor.commands.insertContent({ type: 'image', attrs: { src: 'media://abc', alt: 'pic', width: 100, height: 50 } });
    });
    await act(async () => {
      await settleLayout();
    });
    expect(contextualTrigger()?.textContent).toBe('Image');
    // The unresolved-media-ref warning is the media placeholder's own
    // behavior (see images tests), not this suite's concern.
  });
});

// Accessibility

describe('reduce motion gate', () => {
  it("reduceMotion 'on' suppresses the entrance animation class", () => {
    renderTensor('<p>hello</p>');
    renderRibbon();

    useConfigStore.getState().setReduceMotion('on');
    act(() => {
      useRibbonContextStore.getState().enter('table');
    });
    expect(contextualTrigger()?.className).not.toContain('tensor-contextual-tab-in');

    // And back 'off': the class applies again.
    useConfigStore.getState().setReduceMotion('off');
    act(() => {
      useRibbonContextStore.getState().exit('table');
      useRibbonContextStore.getState().enter('image');
    });
    expect(contextualTrigger()?.className).toContain('tensor-contextual-tab-in');
  });
});