import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { SidebarHost } from '@/lib/layout/sidebar/SidebarHost';
import { StatisticsPanel } from '@/components/editor/StatisticsPanel';
import { StatusBar } from '@/components/layout/StatusBar';
import { getCommand } from '@/lib/commands/registry';
import { useSidebarStore } from '@/lib/layout/sidebarStore';
import { renderTensor } from './harness';

/**
 * THE STATISTICS UI — the dashboard cards + the region list, opened
 * through the real command, live-updating under the debounce, rows
 * navigating to their headings; the STATUS BAR's counts region opens
 * the dashboard (the bar is the entry affordance for its own numbers).
 */

beforeEach(() => {
  useSidebarStore.getState().close();
});

/** The mount pattern (a11yCheck's mountPanel): the docked host + the
 *  panel, opened through the real command. */
function mountPanel() {
  render(
    <div className="relative">
      <SidebarHost id="statistics" anchor="right">
        <StatisticsPanel />
      </SidebarHost>
    </div>,
  );
  void getCommand('statisticsSidebar')?.run();
  expect(useSidebarStore.getState().active?.id).toBe('statistics');
}

describe('the statistics dashboard', () => {
  it('the command opens the panel; the cards + region list show the fixture', async () => {
    renderTensor(
      '<p>Intro text here.</p>' +
      '<h1>Chapter One</h1>' +
      '<p>First paragraph of chapter one.</p>' +
      '<h2>Section 1.1</h2>' +
      '<p>Deep content.</p>',
    );
    mountPanel();
    expect(document.querySelector('[data-testid="stat-words"]')).not.toBeNull();

    // After the debounce the cards carry the walk's numbers: Intro 3 +
    // Chapter One 2+5 + Section 1.1 2+2 = 14 words.
    await waitFor(() => {
      expect(document.querySelector('[data-testid="stat-words"]')!.textContent).toContain('14');
    });
    expect(document.querySelector('[data-testid="stat-reading-time"]')!.textContent).toContain('min');
    expect(document.querySelector('[data-testid="stat-readability-ease"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="stat-readability-grade"]')!.textContent).toContain('English');

    // The region list: three rows in order, the Preamble italic-prefixed.
    const rows = [...document.querySelectorAll('[data-testid^="stat-region-"]')];
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Preamble'),
      expect.stringContaining('Chapter One'),
      expect.stringContaining('Section 1.1'),
    ]);
  });

  it('an empty document shows the honest zeros', async () => {
    renderTensor('<p></p>');
    mountPanel();
    await waitFor(() => {
      expect(document.querySelector('[data-testid="stat-words"]')!.textContent).toContain('0');
    });
    expect(document.querySelector('[data-testid="stat-readability-none"]')).not.toBeNull();
    // An empty paragraph still forms the Preamble region — honest, at
    // zero words (the no-regions branch only guards a doc with no
    // blocks at all, which Tiptap never produces).
    const rows = [...document.querySelectorAll('[data-testid^="stat-region-"]')];
    expect(rows.length).toBe(1);
    expect(rows[0]!.textContent).toContain('Preamble');
    expect(rows[0]!.textContent).toContain('0 w');
  });

  it('updates live as the document is edited (debounced, then fresh)', async () => {
    const { editor } = renderTensor('<p>One two.</p>');
    mountPanel();
    await waitFor(() => {
      expect(document.querySelector('[data-testid="stat-words"]')!.textContent).toContain('2');
    });
    // A whole-document edit — the dashboard follows after the debounce.
    editor.commands.setContent('<p>One two three four five six seven.</p>');
    await waitFor(() => {
      expect(document.querySelector('[data-testid="stat-words"]')!.textContent).toContain('7');
    });
  });

  it('a region row navigates: the caret lands in the clicked heading', async () => {
    const { editor } = renderTensor('<p>Intro text.</p><h1>Chapter One</h1><p>Body words.</p>');
    mountPanel();
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid^="stat-region-"]').length).toBe(2);
    });
    const rows = [...document.querySelectorAll('[data-testid^="stat-region-"]')];
    // Click the Chapter One row — the selection must move to the h1.
    fireEvent.click(rows[1]!);
    const sel = editor.state.selection;
    const $pos = editor.state.doc.resolve(sel.from);
    expect($pos.node().type.name).toBe('heading');
    expect($pos.node().textContent).toBe('Chapter One');
  });

  it('the cards carry their marks (the dashboard look)', async () => {
    renderTensor('<p>Words on a page.</p>');
    mountPanel();
    // Wait for the debounced report before asserting card details.
    await waitFor(() => {
      expect(document.querySelector('[data-testid="stat-words"]')!.textContent).toContain('4');
    });
    for (const card of ['stat-words', 'stat-reading-time', 'stat-characters', 'stat-sentences']) {
      expect(document.querySelector(`[data-testid="${card}"]`)!.querySelector('svg')).not.toBeNull();
    }
    // Sentences carries the same-height sub line (avg words each).
    expect(document.querySelector('[data-testid="stat-sentences"]')!.textContent).toContain('words each');
  });

  it('the readability band is colored by its tone (green for easy text)', async () => {
    renderTensor('<p>The quick brown fox jumps over the lazy dog.</p>');
    mountPanel();
    await waitFor(() => {
      expect(document.querySelector('[data-testid="stat-readability-band"]')!.className).toContain('text-green-600');
    });
    // The band label itself carries the meaning (color only reinforces).
    expect(document.querySelector('[data-testid="stat-readability-band"]')!.textContent).toContain('Very easy');
  });
});

describe('the status bar', () => {
  it('the counts region opens the Statistics dashboard', () => {
    renderTensor('<p>One two.</p>');
    render(<StatusBar />);
    expect(useSidebarStore.getState().active).toBeNull();
    fireEvent.click(document.querySelector('[data-testid="statusbar-counts"]')!);
    expect(useSidebarStore.getState().active?.id).toBe('statistics');
  });
});
