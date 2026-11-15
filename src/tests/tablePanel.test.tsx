import { describe, it, expect, beforeEach } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { useDocumentStore } from '@/lib/document/store';
import { useConfigStore } from '@/lib/config/store';
import { useSidebarStore } from '@/lib/layout/sidebarStore';
import { getCommand } from '@/lib/commands/registry';
import { renderTensor, settleLayout, GEOMETRY } from './harness';
import { FakeMetrics } from './fakeMetrics';
import { SidebarHost } from '@/lib/layout/sidebar/SidebarHost';
import { TablePanel } from '@/components/editor/TablePanel';
import { pmDocToSemantic } from '@/lib/paginated/adapter';
import { resolveNormalBase } from '@/lib/styles/resolve';
import { useStyleRegistryStore } from '@/lib/styles/registry';
import { createLayoutEngine } from '@tensor-editor/engine';
import { DEFAULT_MARGINS, PAGE_GAP } from '@/lib/document/pageSetup';

/**
 * M-T3c — the Table side panel: the Find/Replace-pattern docked panel
 * over the table's dimensions + flow (and the alternate route for the
 * table ops when the floating toolbar is off). The panel derives wholly
 * from PM state and dispatches only commands/attr writes — these tests
 * pin that contract end to end: panel ⇄ doc ⇄ engine.
 */

beforeEach(() => {
  useSidebarStore.getState().close();
  const state = useConfigStore.getState();
  useConfigStore.setState({
    config: { ...state.config, editor: { ...state.config.editor, defaultPageLayout: 'Pages' } },
  });
  useDocumentStore.setState({
    pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP },
    isDirty: false,
    filePath: null,
    lineNumbers: null,
    coreProperties: {},
  });
});

/** Mounts the panel in the sidebar chrome (App mounts it the same way). */
function mountPanel() {
  const utils = render(
    <div className="relative">
      <SidebarHost id="table" anchor="right">
        <TablePanel />
      </SidebarHost>
    </div>,
  );
  // M-T4 regression pin: docked panels clear the ruler (z-30) — the
  // ruler portal mounts after the SidebarHosts, so same-layer DOM
  // order painted it over the Find/Replace panel.
  expect(utils.container.firstElementChild!.firstElementChild!.className).toContain('z-40');
  return utils;
}

/** Parks the caret inside the table's first cell. */
function caretIntoFirstCell(editor: Editor) {
  const positions: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') positions.push(pos);
  });
  act(() => {
    editor.commands.setTextSelection(positions[0]! + 2);
  });
}

/** The engine's layout of the LIVE doc (the same pmDocToSemantic the
 *  view runs — one projection, no test fork). */
function layoutOf(editor: Editor) {
  const cfg = useConfigStore.getState().config.editor;
  const baseStyle = resolveNormalBase(cfg.defaultFontFamily, cfg.defaultFontSize, useStyleRegistryStore.getState().merged);
  const adapted = pmDocToSemantic(editor.state.doc, baseStyle);
  return createLayoutEngine({ metrics: FakeMetrics }).layout(adapted.doc, {
    page: { width: GEOMETRY.pageWidth, height: GEOMETRY.pageHeight },
    margins: { top: GEOMETRY.contentY, left: GEOMETRY.contentX, right: 96, bottom: 96 },
  });
}

function commitInput(input: HTMLInputElement, value: string) {
  act(() => {
    fireEvent.change(input, { target: { value } });
  });
  act(() => {
    fireEvent.keyDown(input, { key: 'Enter' });
  });
}

describe('M-T3c: Table side panel', () => {
  it('the palette command opens the panel; the empty state shows outside a table', async () => {
    renderTensor('<p>no table here</p>');
    await settleLayout();
    mountPanel();
    // SidebarHost keeps children mounted (hidden via CSS when closed) —
    // the SearchResultsSidebar contract.
    expect(document.querySelector('[data-testid="table-panel"]')).toBeTruthy();
    act(() => {
      void getCommand('tableSidebar')?.run();
    });
    expect(useSidebarStore.getState().active?.id).toBe('table');
    expect(document.querySelector('[data-testid="table-panel-empty"]')).toBeTruthy();
  });

  it('inside a table: structure readout, dimension fields, and live writes', async () => {
    const { editor } = renderTensor(
      '<p>lead</p><table><tr><th>h1</th><th>h2</th></tr><tr><td>a</td><td>b</td></tr></table>',
    );
    await settleLayout();
    mountPanel();
    act(() => {
      void getCommand('tableSidebar')?.run();
    });
    caretIntoFirstCell(editor);
    // The readout: 2 rows × 2 columns.
    expect(document.body.textContent).toContain('2 rows × 2 columns');
    // Column 1's width field: auto (no colwidths).
    const col0 = document.querySelector('[data-testid="tp-col-input-0"]') as HTMLInputElement;
    expect(col0.value).toBe('');
    // Commit 200px → every cell COVERING column 0 carries the colwidth
    // (column 1's cells stay untouched — the engine's sync invariant).
    commitInput(col0, '200');
    const widths: (number | null)[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
        widths.push((node.attrs.colwidth as (number | null)[] | null)?.[0] ?? null);
      }
    });
    expect(widths).toEqual([200, null, 200, null]);
    // The field re-reads the doc: 200.
    expect((document.querySelector('[data-testid="tp-col-input-0"]') as HTMLInputElement).value).toBe('200');
    // Clear back to auto (empty commit) → colwidths gone.
    commitInput(document.querySelector('[data-testid="tp-col-input-0"]') as HTMLInputElement, '');
    const after: (number | null)[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
        after.push((node.attrs.colwidth as (number | null)[] | null)?.[0] ?? null);
      }
    });
    expect(after).toEqual([null, null, null, null]);
  });

  it('row minimum height floors the row in the engine layout (Word "at least")', async () => {
    const { editor } = renderTensor(
      '<table><tr><td>a</td></tr><tr><td>b</td></tr></table>',
    );
    await settleLayout();
    mountPanel();
    act(() => {
      useSidebarStore.getState().open('table', 'right');
    });
    caretIntoFirstCell(editor);
    const row0 = document.querySelector('[data-testid="tp-row-input-0"]') as HTMLInputElement;
    expect(row0.value).toBe('');
    commitInput(row0, '200');
    // The doc: row 0 carries minHeight 200.
    const tableNode = editor.state.doc.content.firstChild!;
    expect(tableNode.firstChild!.attrs.minHeight).toBe(200);
    // The engine: row 0's band is 200 tall (content is ~25.6 — floored).
    const result = layoutOf(editor);
    const row0Rect = result.placed.find((p) => p.kind === 'tableCell' && p.cell?.row === 0)!;
    expect(row0Rect.rect.height).toBe(200);
    // Row 1 stays content-sized (below the floor).
    const row1Rect = result.placed.find((p) => p.kind === 'tableCell' && p.cell?.row === 1)!;
    expect(row1Rect.rect.height).toBeLessThan(100);
    // The field re-reads: 200; empty commit clears back to auto.
    expect((document.querySelector('[data-testid="tp-row-input-0"]') as HTMLInputElement).value).toBe('200');
    commitInput(document.querySelector('[data-testid="tp-row-input-0"]') as HTMLInputElement, '');
    expect(editor.state.doc.content.firstChild!.firstChild!.attrs.minHeight).toBeNull();
  });

  it('M-FLOW: the row "break" switch — default splits the straddling row, off (cantSplit) moves it wholly', async () => {
    // 52 filler lines = 832px; a 3-line row (56px) straddles page 0's
    // 32px remainder. The switch ON (default, Word/GDocs) = the row
    // splits at the cell line grid; OFF = cantSplit, the whole row
    // opens page 1.
    const filler = 'x'.repeat(52 * 62);
    const cellText = 'x'.repeat(180); // 3 lines at 60 chars in the 608px lane
    const { editor } = renderTensor(
      `<p>${filler}</p><table><tr><td>${cellText}</td></tr></table>`
    );
    await settleLayout();
    mountPanel();
    act(() => {
      useSidebarStore.getState().open('table', 'right');
    });
    caretIntoFirstCell(editor);
    const splitSwitch = () => document.querySelector('[data-testid="tp-row-split-0"]') as HTMLElement;
    // ON by default (null attrs — the Word/GDocs default is may-split).
    expect(splitSwitch().getAttribute('aria-checked')).toBe('true');
    let result = layoutOf(editor);
    const cellLines = result.lines.filter((l) => l.tableCell);
    expect(new Set(cellLines.map((l) => l.pageIndex)).size).toBe(2); // split
    // OFF: the row attr becomes cantSplit, the row moves wholly.
    act(() => {
      fireEvent.click(splitSwitch());
    });
    expect(editor.state.doc.child(1).firstChild!.attrs.cantSplit).toBe(true);
    result = layoutOf(editor);
    expect(new Set(result.lines.filter((l) => l.tableCell).map((l) => l.pageIndex))).toEqual(
      new Set([1])
    );
    expect(splitSwitch().getAttribute('aria-checked')).toBe('false');
    // Back ON: the write normalizes to null (never a literal false).
    act(() => {
      fireEvent.click(splitSwitch());
    });
    expect(editor.state.doc.child(1).firstChild!.attrs.cantSplit).toBeNull();
  });

  it('M-FLOW: the table-level keep switches write the table attrs and reach the engine', async () => {
    const { editor } = renderTensor(
      '<table><tr><td>a</td></tr></table>',
    );
    await settleLayout();
    mountPanel();
    act(() => {
      useSidebarStore.getState().open('table', 'right');
    });
    caretIntoFirstCell(editor);
    const keepNext = () => document.querySelector('[data-testid="tp-table-keep-next"]') as HTMLElement;
    expect(keepNext().getAttribute('aria-checked')).toBe('false');
    act(() => {
      fireEvent.click(keepNext());
    });
    expect(editor.state.doc.content.firstChild!.attrs.keepNext).toBe(true);
    const adapted = pmDocToSemantic(editor.state.doc, resolveNormalBase('fake', 16, useStyleRegistryStore.getState().merged));
    expect(adapted.doc.blocks[0].flow).toEqual({ keepNext: true });
    // Off again: the write normalizes to null.
    act(() => {
      fireEvent.click(keepNext());
    });
    expect(editor.state.doc.content.firstChild!.attrs.keepNext).toBeNull();
  });

  it('Distribute evenly clears every colwidth (the flexible equal share)', async () => {
    const { editor } = renderTensor(
      '<table><tr><td colspan="2" colwidth="[200,100]">wide</td></tr><tr><td>x</td><td>y</td></tr></table>',
    );
    await settleLayout();
    mountPanel();
    act(() => {
      useSidebarStore.getState().open('table', 'right');
    });
    caretIntoFirstCell(editor);
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="tp-distribute"]')!);
    });
    let sawColwidth = false;
    editor.state.doc.descendants((node) => {
      if ((node.type.name === 'tableCell' || node.type.name === 'tableHeader') && node.attrs.colwidth != null) {
        sawColwidth = true;
      }
    });
    expect(sawColwidth).toBe(false);
  });

  it('table flow: the align buttons write the attr and the engine places the table', async () => {
    // colwidth's serialized HTML form is comma-separated ("100") — the
    // JSON-ish "[100]" spelling does NOT parse (unparsed widths = the
    // flexible fill-the-box look, where centering is a no-op).
    const { editor } = renderTensor(
      '<table><tr><td colwidth="100">a</td><td colwidth="100">b</td></tr></table>',
    );
    await settleLayout();
    mountPanel();
    act(() => {
      useSidebarStore.getState().open('table', 'right');
    });
    caretIntoFirstCell(editor);
    // Fully fixed 200px table in a 624px box: left-aligned at x 0
    // (content-relative).
    expect(layoutOf(editor).placed[0]!.rect.x).toBe(0);
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="tp-align-center"]')!);
    });
    expect(editor.state.doc.content.firstChild!.attrs.align).toBe('center');
    // Centered: (624 − 200) / 2 = 212 content-relative.
    const centered = layoutOf(editor).placed[0]!.rect;
    expect(centered.x).toBeCloseTo((GEOMETRY.contentWidth - 200) / 2, 6);
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="tp-align-right"]')!);
    });
    expect(layoutOf(editor).placed[0]!.rect.x).toBeCloseTo(GEOMETRY.contentWidth - 200, 6);
  });

  it('the alternate route: structure ops and merge⇄split work from the panel', async () => {
    const { editor } = renderTensor(
      '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>',
    );
    await settleLayout();
    mountPanel();
    act(() => {
      useSidebarStore.getState().open('table', 'right');
    });
    caretIntoFirstCell(editor);
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="tp-add-row"]')!);
    });
    expect(editor.state.doc.content.firstChild!.childCount).toBe(3);
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="tp-delete-col"]')!);
    });
    expect(editor.state.doc.content.firstChild!.firstChild!.childCount).toBe(1);
    // Merge: after the column delete the table is single-column — the
    // two selected cells (rows 0 and 1 of column 0) merge VERTICALLY
    // (rowspan 2), via the SAME command the toolbar runs.
    const positions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tableCell') positions.push(pos);
    });
    act(() => {
      editor.commands.setCellSelection({ anchorCell: positions[0]!, headCell: positions[1]! });
    });
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="tp-merge"]')!);
    });
    const row0 = editor.state.doc.content.firstChild!.firstChild!;
    expect(row0.childCount).toBe(1);
    expect(row0.firstChild!.attrs.rowspan).toBe(2);
  });

  it('the header toggle from the panel flips the current row', async () => {
    const { editor } = renderTensor('<table><tr><td>a</td><td>b</td></tr></table>');
    await settleLayout();
    mountPanel();
    act(() => {
      useSidebarStore.getState().open('table', 'right');
    });
    caretIntoFirstCell(editor);
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="tp-header-pin"]')!);
    });
    const row0 = editor.state.doc.content.firstChild!.firstChild!;
    expect(row0.firstChild!.type.name).toBe('tableHeader');
    // The panel's pin shows active for the current (now header) row.
    expect((document.querySelector('[data-testid="tp-header-pin"]') as HTMLElement).getAttribute('aria-pressed')).toBe('true');
  });

  it('M-T4: table margins — left narrows the box and shifts x; top becomes block spacing', async () => {
    const { editor } = renderTensor('<table><tr><td>a</td><td>b</td></tr></table>');
    await settleLayout();
    mountPanel();
    act(() => {
      useSidebarStore.getState().open('table', 'right');
    });
    caretIntoFirstCell(editor);
    // Baseline: full box, x 0.
    expect(layoutOf(editor).placed[0]!.rect.x).toBe(0);
    commitInput(document.querySelector('[data-testid="tp-margin-left"]') as HTMLInputElement, '50');
    // Doc: the margin attr carries the side (nulls read as never-set).
    const tableNode = editor.state.doc.content.firstChild!;
    expect(tableNode.attrs.margin).toEqual({ top: null, right: null, bottom: null, left: 50 });
    // Engine: box 624−50=574 (cols 287 each); the first rect shifts to x 50.
    const after = layoutOf(editor).placed;
    expect(after[0]!.rect.x).toBe(50);
    expect(after[0]!.rect.width).toBe(287);
    // Top margin → the ADAPTER's spaceBefore (block spacing): y shifts.
    commitInput(document.querySelector('[data-testid="tp-margin-top"]') as HTMLInputElement, '30');
    expect(layoutOf(editor).placed[0]!.rect.y).toBe(30);
  });

  it('M-T4: default cell padding narrows the lane (60 chars rewrap at 20px sides)', async () => {
    const { editor } = renderTensor(
      '<table><tr><td>xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx</td></tr></table>',
    );
    await settleLayout();
    mountPanel();
    act(() => {
      useSidebarStore.getState().open('table', 'right');
    });
    caretIntoFirstCell(editor);
    // 60 chars at the default lane 624−16=608 → one line.
    expect(layoutOf(editor).lines.filter((l) => l.tableCell)).toHaveLength(1);
    commitInput(document.querySelector('[data-testid="tp-cellpad-left"]') as HTMLInputElement, '20');
    commitInput(document.querySelector('[data-testid="tp-cellpad-right"]') as HTMLInputElement, '20');
    expect(editor.state.doc.content.firstChild!.attrs.cellPadding).toEqual({
      top: null, right: 20, bottom: null, left: 20,
    });
    // Lane 624−40=584 → 58 chars fit → the 60-char cell wraps to 2 lines.
    expect(layoutOf(editor).lines.filter((l) => l.tableCell)).toHaveLength(2);
  });

  it('M-T4: per-cell padding overrides the table default (null sides inherit)', async () => {
    const { editor } = renderTensor(
      '<table><tr><td>one</td><td>two</td></tr></table>',
    );
    await settleLayout();
    mountPanel();
    act(() => {
      useSidebarStore.getState().open('table', 'right');
    });
    caretIntoFirstCell(editor);
    // Table default left 20; the CURRENT cell overrides to 40.
    commitInput(document.querySelector('[data-testid="tp-cellpad-left"]') as HTMLInputElement, '20');
    commitInput(document.querySelector('[data-testid="tp-cellpad-own-left"]') as HTMLInputElement, '40');
    const cell0 = editor.state.doc.content.firstChild!.firstChild!.firstChild!;
    expect(cell0.attrs.padding).toEqual({ top: null, right: null, bottom: null, left: 40 });
    // Engine: cell 0's lane content = 312 − 40 − 8(right inherits the
    // engine constant) = 264; cell 1 keeps the table default
    // (312 − 20 − 8 = 284).
    const result = layoutOf(editor);
    const lane0 = result.lines.find((l) => l.tableCell?.col === 0)!;
    const lane1 = result.lines.find((l) => l.tableCell?.col === 1)!;
    expect(lane0.tableCell!.width).toBe(264);
    expect(lane1.tableCell!.width).toBe(284);
  });

  it('M-T4: margin/padding attrs round-trip through the doc JSON (the .wpdoc surface)', async () => {
    const { editor } = renderTensor('<table><tr><td>a</td></tr></table>');
    await settleLayout();
    mountPanel();
    act(() => {
      useSidebarStore.getState().open('table', 'right');
    });
    caretIntoFirstCell(editor);
    commitInput(document.querySelector('[data-testid="tp-margin-left"]') as HTMLInputElement, '12');
    commitInput(document.querySelector('[data-testid="tp-cellpad-top"]') as HTMLInputElement, '6');
    commitInput(document.querySelector('[data-testid="tp-cellpad-own-bottom"]') as HTMLInputElement, '9');
    const json = JSON.parse(JSON.stringify(editor.getJSON()));
    const table = json.content.find((n: { type: string }) => n.type === 'table');
    expect(table.attrs.margin.left).toBe(12);
    expect(table.attrs.cellPadding.top).toBe(6);
    expect(table.content[0].content[0].attrs.padding.bottom).toBe(9);
  });
});
