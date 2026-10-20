import { describe, it, expect, beforeEach } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import type { Editor, JSONContent } from '@tiptap/core';
import { CellSelection } from '@tiptap/pm/tables';
import { createLayoutEngine } from '@tensor-editor/engine';
import { useDocumentStore } from '@/lib/document/store';
import { useConfigStore } from '@/lib/config/store';
import { renderTensor, settleLayout, GEOMETRY } from './harness';
import { FakeMetrics } from './fakeMetrics';
import { pmDocToSemantic } from '@/lib/paginated/adapter';
import { resolveNormalBase } from '@/lib/styles/resolve';
import { useStyleRegistryStore } from '@/lib/styles/registry';
import { assembleDocumentFile } from '@/lib/document/fileOperations';
import { DocumentFileSchema, CURRENT_DOCUMENT_VERSION } from '@/lib/document/schema';
import { DEFAULT_MARGINS, PAGE_GAP } from '@/lib/document/pageSetup';

/**
 * M-TABLES — the pageless-mode table layer. The document model is the
 * TipTap table family (TableKit) plus Tensor's borderStyle /
 * backgroundColor attrs; these tests pin the behaviors the issue's
 * acceptance criteria name for M-T1 (the paginated engine's TableBlock
 * is M-T2 — until then a table doc in Pages mode falls back to the
 * pageless render with the banner).
 */

function setPageless() {
  const state = useConfigStore.getState();
  useConfigStore.setState({
    config: { ...state.config, editor: { ...state.config.editor, defaultPageLayout: 'Pageless' } },
  });
}

beforeEach(() => {
  setPageless();
  useDocumentStore.setState({
    pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP },
    isDirty: false,
    filePath: null,
    lineNumbers: null,
    coreProperties: {},
  });
});

/** Doc-order positions of every cell node (td/th) in the document. */
function cellPositions(editor: Editor, type?: string): number[] {
  const positions: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === (type ?? 'tableCell')) positions.push(pos);
  });
  return positions;
}

/** The v3 typed getJSON unions node/text shapes at every level; tests
 *  walk the tree blindly — cast to the loose JSON shape. */
function looseJSON(editor: Editor): JSONContent {
  return editor.getJSON() as unknown as JSONContent;
}

describe('M-TABLES: model + pageless', () => {
  it('insertTable creates the schema shape (header row + body rows) and blockId is minted on the table node', async () => {
    const { editor } = renderTensor();
    await act(async () => {
      editor.commands.insertTable({ rows: 3, cols: 3, withHeaderRow: true });
    });
    const table = looseJSON(editor).content?.find((n) => n.type === 'table');
    expect(table).toBeTruthy();
    // createTable: rowsCount rows TOTAL, the first is the header when
    // withHeaderRow — 3 rows = 1 header + 2 body.
    expect(table!.content).toHaveLength(3);
    expect(table!.content![0].type).toBe('tableRow');
    expect(table!.content![0].content![0].type).toBe('tableHeader');
    expect(table!.content![1].content![0].type).toBe('tableCell');
    // Engine identity: the table node is blockId-bearing (M-TABLES —
    // one engine TableBlock, one id at the table node).
    expect(typeof table!.attrs!.blockId).toBe('string');
    expect((table!.attrs!.blockId as string).length).toBeGreaterThan(0);
    // Inner paragraphs are ID-bearing too.
    const firstBodyCell = table!.content![1].content![0];
    expect(firstBodyCell.content![0].type).toBe('paragraph');
    expect(typeof firstBodyCell.content![0].attrs!.blockId).toBe('string');
  });

  it('cell shading: setCellBackground writes the attr under a bare caret and renderHTML emits the markers', async () => {
    const { editor } = renderTensor();
    await act(async () => {
      editor.commands.setContent(
        '<table><tr><td>p0</td><td>p1</td></tr><tr><td>p2</td><td>p3</td></tr></table>',
      );
    });
    // Park the caret in the first cell (blockId mint pass ran on setContent).
    const [firstCell] = cellPositions(editor);
    await act(async () => {
      editor.commands.focus();
      editor.commands.setTextSelection(firstCell + 2);
    });
    await act(async () => {
      editor.commands.setCellBackground('#ff8800');
    });
    const cell = looseJSON(editor).content![0].content![0].content![0];
    expect(cell.attrs!.backgroundColor).toBe('#ff8800');
    // Pageless DOM: the td renders BOTH the style (display) and the
    // data marker (clipboard round-trip + test hook).
    const td = document.querySelector('.ProseMirror td') as HTMLElement;
    expect(td.getAttribute('data-cell-background')).toBe('#ff8800');
    expect(td.style.backgroundColor).toBe('rgb(255, 136, 0)');
    // null clears back to transparent.
    await act(async () => {
      editor.commands.setCellBackground(null);
    });
    expect(looseJSON(editor).content![0].content![0].content![0].attrs!.backgroundColor).toBe(null);
    const tdAfter = document.querySelector('.ProseMirror td') as HTMLElement;
    expect(tdAfter.getAttribute('data-cell-background')).toBe(null);
    expect(tdAfter.style.backgroundColor).toBe('');
  });

  it('merge two selected cells into one (colspan), then split restores the original cells', async () => {
    const { editor } = renderTensor();
    await act(async () => {
      editor.commands.setContent(
        '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>',
      );
    });
    const cells = cellPositions(editor);
    expect(cells).toHaveLength(4);
    // CellSelection across the top row's two cells, then merge.
    await act(async () => {
      editor.commands.setCellSelection({ anchorCell: cells[0], headCell: cells[1] });
    });
    expect(editor.state.selection instanceof CellSelection).toBe(true);
    await act(async () => {
      editor.commands.mergeCells();
    });
    const row0 = looseJSON(editor).content![0].content![0].content!;
    expect(row0).toHaveLength(1);
    expect(row0[0].attrs!.colspan).toBe(2);
    // mergeCells APPENDS each cell's content as blocks — the two
    // paragraphs survive as two paragraphs inside the merged cell
    // (prosemirror-tables merges the FRAGMENTS; it never concatenates
    // text runs mid-paragraph).
    expect(row0[0].content).toHaveLength(2);
    expect(row0[0].content![0].content![0].text).toBe('a');
    expect(row0[0].content![1].content![0].text).toBe('b');
    // Split back into the original two-cell structure. splitCell keeps
    // the merged content in the first cell and fills the companions
    // with empty paragraphs — the STRUCTURE is what restores.
    await act(async () => {
      editor.commands.splitCell();
    });
    const afterSplit = looseJSON(editor).content![0];
    expect(afterSplit.content![0].content!).toHaveLength(2);
    expect(afterSplit.content![0].content![0].attrs!.colspan).toBe(1);
    expect(afterSplit.content![0].content![0].content![0].content![0].text).toBe('a');
    expect(afterSplit.content![0].content![0].content![1].content![0].text).toBe('b');
    // The restored companion: an empty paragraph (no content array).
    expect(afterSplit.content![0].content![1].content![0].content).toBeUndefined();
  });

  it('add/remove rows and columns after creation', async () => {
    const { editor } = renderTensor();
    await act(async () => {
      editor.commands.setContent(
        '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>',
      );
    });
    await act(async () => {
      editor.commands.setTextSelection(cellPositions(editor)[0] + 2);
    });
    await act(async () => {
      editor.commands.addRowAfter();
    });
    expect(looseJSON(editor).content![0].content).toHaveLength(3);
    await act(async () => {
      editor.commands.addColumnAfter();
    });
    expect(looseJSON(editor).content![0].content![0].content).toHaveLength(3);
    await act(async () => {
      editor.commands.deleteRow();
    });
    expect(looseJSON(editor).content![0].content).toHaveLength(2);
    await act(async () => {
      editor.commands.deleteColumn();
    });
    expect(looseJSON(editor).content![0].content![0].content).toHaveLength(2);
  });

  it('borderStyle: the preset writes the table attr and the render marker', async () => {
    const { editor } = renderTensor();
    await act(async () => {
      editor.commands.setContent(
        '<table><tr><td>a</td></tr></table>',
      );
    });
    await act(async () => {
      editor.commands.setTextSelection(cellPositions(editor)[0] + 2);
    });
    await act(async () => {
      editor.commands.setTableBorderPreset('none');
    });
    const table = looseJSON(editor).content![0];
    expect(table.attrs!.borderStyle).toBe('none');
    // The NodeView re-stamps the marker on every attrs change (the
    // stock resizable TableView never re-applies node attrs — the
    // subclass exists for exactly this).
    const el = document.querySelector('.ProseMirror table') as HTMLElement;
    expect(el.getAttribute('data-table-border')).toBe('none');
    // Default is 'all'.
    await act(async () => {
      editor.commands.setTableBorderPreset('all');
    });
    expect(looseJSON(editor).content![0].attrs!.borderStyle).toBe('all');
  });

  it('Pages mode (M-T2): a table doc lays out in the paginated view — no fallback, engine-painted lines', async () => {
    const state = useConfigStore.getState();
    useConfigStore.setState({
      config: { ...state.config, editor: { ...state.config.editor, defaultPageLayout: 'Pages' } },
    });
    const { editor } = renderTensor();
    await act(async () => {
      editor.commands.setContent(
        '<p>before the table</p><table><tr><td>first cell</td><td>second cell</td></tr><tr><td>a</td><td>b</td></tr></table><p>after the table</p>',
      );
    });
    await settleLayout();
    // No pageless fallback: the engine handles the table.
    expect(document.querySelector('[data-testid="paginated-fallback"]')).toBeNull();
    expect(document.querySelector('[data-testid="paginated-stack"]')).toBeTruthy();
    // The painted cell lines: the block canvases exist for the table
    // (one per page) — the deepest render assertion the jsdom harness
    // supports; geometry correctness is pinned engine-side
    // (engine/tests/table.test.ts).
    const canvases = document.querySelectorAll('[data-testid="paginated-stack"] canvas');
    expect(canvases.length).toBeGreaterThan(0);
    // The doc model is untouched (the .wpdoc surface rides PM).
    expect(editor.getJSON().content?.some((n) => n.type === 'table')).toBe(true);
  });
});

describe('M-TABLES: Pages mode interactions', () => {
  /** The engine's content-relative rect of a cell line, resolved
   *  against the LIVE editor's doc (the same pmDocToSemantic the view
   *  runs — one projection, no test fork). */
  function cellLineRect(editor: Editor, col: number, lineOrdinal = 0) {
    const cfg = useConfigStore.getState().config.editor;
    const baseStyle = resolveNormalBase(cfg.defaultFontFamily, cfg.defaultFontSize, useStyleRegistryStore.getState().merged);
    const adapted = pmDocToSemantic(editor.state.doc, baseStyle);
    const engine = createLayoutEngine({ metrics: FakeMetrics });
    const result = engine.layout(adapted.doc, {
      page: { width: GEOMETRY.pageWidth, height: GEOMETRY.pageHeight },
      margins: { top: GEOMETRY.contentY, left: GEOMETRY.contentX, right: 96, bottom: 96 },
    });
    const lines = result.lines.filter(
      (l) => l.tableCell && l.tableCell.col === col && l.tableCell.row === 0,
    );
    const line = lines[lineOrdinal];
    if (!line) throw new Error(`no cell line at col ${col}`);
    return { line, contentX: result.pages[0].contentBox.x, contentY: result.pages[0].contentBox.y };
  }

  /** The engine's content-relative rect of a cell by GRID identity
   *  (row/col) — empty cells included (they emit rects even where no
   *  line box exists; the empty-cell click targets the rect). */
  function cellRect(editor: Editor, row: number, col: number) {
    const cfg = useConfigStore.getState().config.editor;
    const baseStyle = resolveNormalBase(cfg.defaultFontFamily, cfg.defaultFontSize, useStyleRegistryStore.getState().merged);
    const adapted = pmDocToSemantic(editor.state.doc, baseStyle);
    const engine = createLayoutEngine({ metrics: FakeMetrics });
    const result = engine.layout(adapted.doc, {
      page: { width: GEOMETRY.pageWidth, height: GEOMETRY.pageHeight },
      margins: { top: GEOMETRY.contentY, left: GEOMETRY.contentX, right: 96, bottom: 96 },
    });
    const rect = result.placed.find((p) => p.kind === 'tableCell' && p.cell?.row === row && p.cell?.col === col);
    if (!rect) throw new Error(`no cell rect at row ${row}, col ${col}`);
    return { rect: rect.rect, contentX: result.pages[0].contentBox.x, contentY: result.pages[0].contentBox.y };
  }

  it('a click inside a cell routes the caret to THAT cell (the cell-first hit rule)', async () => {
    const state = useConfigStore.getState();
    useConfigStore.setState({
      config: { ...state.config, editor: { ...state.config.editor, defaultPageLayout: 'Pages' } },
    });
    const { editor } = renderTensor();
    await act(async () => {
      editor.commands.setContent(
        '<p>before</p><table><tr><td>first cell</td><td>second cell</td></tr><tr><td>a</td><td>b</td></tr></table>',
      );
    });
    await settleLayout();
    const { line, contentX, contentY } = cellLineRect(editor, 1);
    // Click a few px inside the second cell's first line's text band.
    const stack = document.querySelector('[data-testid="paginated-stack"]') as HTMLElement;
    fireEvent.mouseDown(stack, {
      button: 0,
      clientX: contentX + line.rect.x + 30,
      clientY: contentY + line.rect.y + 5,
    });
    const head = editor.state.selection.head;
    const $head = editor.state.doc.resolve(head);
    // The caret's parent paragraph carries the SECOND cell's text.
    expect($head.parent.textContent).toBe('second cell');
  });

  it('dragging a column handle live-dispatches the column width into every cell of the column', async () => {
    const state = useConfigStore.getState();
    useConfigStore.setState({
      config: { ...state.config, editor: { ...state.config.editor, defaultPageLayout: 'Pages' } },
    });
    const { editor } = renderTensor();
    await act(async () => {
      editor.commands.setContent(
        '<table><tr><td>a0</td><td>b0</td></tr><tr><td>a1</td><td>b1</td></tr></table>',
      );
    });
    await settleLayout();
    const handles = document.querySelectorAll('[data-testid="table-col-handle"]');
    expect(handles.length).toBeGreaterThanOrEqual(1);
    const first = handles[0] as HTMLElement;
    // The table node + the column's cells' current widths.
    const tableJson = looseJSON(editor).content!.find((n) => n.type === 'table')!;
    const before = tableJson.content!.map((row) => row.content![0].attrs!.colwidth);
    fireEvent.pointerDown(first, { clientX: 500, button: 0 });
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 550 }));
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 550 }));
    await act(async () => {
      await Promise.resolve();
    });
    const after = looseJSON(editor).content!.find((n) => n.type === 'table')!.content!.map(
      (row) => row.content![0].attrs!.colwidth,
    );
    // Column 0's cells (a0/a1 — first cell of each row) grew by 50px;
    // the OTHER column's cells (b0/b1 — second cell of each row) keep
    // their flexible share (re-absorbed engine-side on relayout).
    const beforeA = before.map((cw) => (Array.isArray(cw) ? cw[0] : null));
    const afterA = after.map((cw) => (Array.isArray(cw) ? cw[0] : null));
    expect(afterA.every((w, i) => (beforeA[i] ?? 312) + 50 === w)).toBe(true);
  });

  it('M-T2 fixes: a click in an EMPTY cell routes the caret to THAT cell (the separator-law round trip)', async () => {
    const state = useConfigStore.getState();
    useConfigStore.setState({
      config: { ...state.config, editor: { ...state.config.editor, defaultPageLayout: 'Pages' } },
    });
    const { editor } = renderTensor();
    await act(async () => {
      editor.commands.setContent('<table><tr><td></td><td></td></tr><tr><td></td><td></td></tr></table>');
    });
    await settleLayout();
    const { rect, contentX, contentY } = cellRect(editor, 1, 0);
    const stack = document.querySelector('[data-testid="paginated-stack"]') as HTMLElement;
    fireEvent.mouseDown(stack, {
      button: 0,
      clientX: contentX + rect.x + 30,
      clientY: contentY + rect.y + 5,
    });
    // The caret's cell: the SECOND cell of column 0 — NOT the first.
    const head = editor.state.selection.head;
    let ownerCell: number | null = null;
    const positions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'tableCell') return;
      positions.push(pos);
      if (pos < head && head <= pos + node.nodeSize - 1) ownerCell = pos;
    });
    expect(ownerCell).not.toBeNull();
    expect(ownerCell).toBe(positions[2]);
  });

  it('M-T2 fixes: a multi-cell selection over EMPTY cells paints the cell-selection overlay', async () => {
    const state = useConfigStore.getState();
    useConfigStore.setState({
      config: { ...state.config, editor: { ...state.config.editor, defaultPageLayout: 'Pages' } },
    });
    const { editor } = renderTensor();
    await act(async () => {
      editor.commands.setContent('<table><tr><td></td><td></td></tr><tr><td></td><td></td></tr></table>');
    });
    await settleLayout();
    const positions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tableCell') positions.push(pos);
    });
    await act(async () => {
      editor.commands.setCellSelection({ anchorCell: positions[0], headCell: positions[1] });
    });
    await settleLayout();
    expect(document.querySelectorAll('[data-testid="selection-rect"]').length).toBeGreaterThanOrEqual(2);
  });

  it('M-T2 fixes: merging empty cells removes the inner boundary (one union rect, no double stroke)', async () => {
    const state = useConfigStore.getState();
    useConfigStore.setState({
      config: { ...state.config, editor: { ...state.config.editor, defaultPageLayout: 'Pageless' } },
    });
    const { editor } = renderTensor();
    await act(async () => {
      editor.commands.setContent('<table><tr><td></td><td></td></tr><tr><td>x</td><td>y</td></tr></table>');
    });
    const positions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tableCell') positions.push(pos);
    });
    await act(async () => {
      editor.commands.setCellSelection({ anchorCell: positions[0], headCell: positions[1] });
      editor.commands.mergeCells();
    });
    // The merged cell: colspan 2.
    const row0 = looseJSON(editor).content![0].content![0].content!;
    expect(row0).toHaveLength(1);
    expect(row0[0].attrs!.colspan).toBe(2);
    // Engine: the merged row's band emits ONE rect for the row-0 cell
    // (the union lane) — the inner boundary is gone.
    const baseStyle = resolveNormalBase(
      useConfigStore.getState().config.editor.defaultFontFamily,
      useConfigStore.getState().config.editor.defaultFontSize,
      useStyleRegistryStore.getState().merged,
    );
    const adapted = pmDocToSemantic(editor.state.doc, baseStyle);
    const result = createLayoutEngine({ metrics: FakeMetrics }).layout(adapted.doc, {
      page: { width: GEOMETRY.pageWidth, height: GEOMETRY.pageHeight },
      margins: { top: GEOMETRY.contentY, right: 96, bottom: 96, left: GEOMETRY.contentX },
    });
    const row0Rects = result.placed.filter(
      (p) => p.kind === 'tableCell' && p.cell?.row === 0,
    );
    expect(row0Rects).toHaveLength(1);
    expect(row0Rects[0].rect.width).toBe(GEOMETRY.contentWidth);
  });

  it('M-T2 fixes: borders stroke every boundary exactly once (no per-cell double draw)', async () => {
    const state = useConfigStore.getState();
    useConfigStore.setState({
      config: { ...state.config, editor: { ...state.config.editor, defaultPageLayout: 'Pages' } },
    });
    const { editor } = renderTensor();
    ((globalThis as { __paintOps?: unknown[] }).__paintOps as unknown as { length: number }[]).length = 0;
    await act(async () => {
      editor.commands.setContent('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>');
    });
    await settleLayout();
    const ops = ((globalThis as { __paintOps?: { op: string; args: unknown[]; fillStyle?: string }[] }).__paintOps ?? []);
    // The cell layer's strokes only: the border hairline color (caret
    // and selection rects paint in other colors), 1px on one axis.
    // The paint harness ACCUMULATES ops across repaint runs, so the
    // strokes are DEDUPED by the exact rect — identical re-paints
    // collapse; a genuine per-cell double draw would leave DISTINCT
    // rects at the same boundary (row-sized fragments instead of one
    // full-span stroke) — the regression this pins.
    const strokes = ops.filter(
      (o) =>
        o.op === 'fillRect' &&
        o.fillStyle === '#d4d4d8' &&
        ((o.args[2] as number) === 1 || (o.args[3] as number) === 1),
    );
    // Collapse the repaint runs (each identical full repaint is
    // legitimate), then assert the UNIQUE stroke set: every boundary
    // is ONE full-span rect — all verticals share the same y/height,
    // all horizontals the same x/width. A per-cell double draw would
    // leave row/column-sized FRAGMENTS at the inner boundaries (the
    // "1px thicker" symptom) — fragment sets fail this.
    const unique = new Map<string, { op: string; args: unknown[] }>();
    for (const o of strokes) unique.set(o.args.join(','), o);
    const v = [...unique.values()].filter((o) => (o.args[2] as number) === 1);
    const h = [...unique.values()].filter((o) => (o.args[3] as number) === 1);
    expect(v.length).toBe(3); // the left edge + the inner boundary + the right edge
    expect(h.length).toBe(3); // the top edge + the inner boundary + the bottom edge
    expect(new Set(v.map((o) => `${o.args[1]},${o.args[3]}`)).size).toBe(1);
    expect(new Set(h.map((o) => `${o.args[0]},${o.args[2]}`)).size).toBe(1);
  });

  it('inserting a table while the caret is inside a table exits and inserts AFTER it (no nesting)', async () => {
    const state = useConfigStore.getState();
    useConfigStore.setState({
      config: { ...state.config, editor: { ...state.config.editor, defaultPageLayout: 'Pageless' } },
    });
    const { editor } = renderTensor();
    await act(async () => {
      editor.commands.setContent(
        '<p>before</p><table><tr><td>a</td><td>b</td></tr></table><p>after</p>',
      );
    });
    // Park the caret inside the table's first cell.
    const positions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tableCell') positions.push(pos);
    });
    await act(async () => {
      editor.commands.setTextSelection(positions[0] + 2);
    });
    const { insertTableAtSelection } = await import('@/lib/editor/tableInsert');
    await act(async () => {
      insertTableAtSelection(editor, { rows: 2, cols: 2, withHeaderRow: false });
    });
    // The doc: p, table, table, p — TWO top-level tables, never nested.
    const kinds = editor.getJSON().content!.map((n) => n.type);
    expect(kinds).toEqual(['paragraph', 'table', 'table', 'paragraph']);
    const first = looseJSON(editor).content![1];
    const second = looseJSON(editor).content![2];
    expect(first.content![0].content![0].content![0].content![0].text).toBe('a');
    expect(second.content!.length).toBe(2);
  });

  it('a table splitting across pages paints cell layers on every page it touches', async () => {
    const state = useConfigStore.getState();
    useConfigStore.setState({
      config: { ...state.config, editor: { ...state.config.editor, defaultPageLayout: 'Pages' } },
    });
    const { editor } = renderTensor();
    // Each body row: ONE cell holding 30 paragraphs (~528px tall) — the
    // table fragments across pages; the header repeats on each.
    const row = (t: string) => `<tr><td>${Array.from({ length: 30 }, () => `<p>${t}</p>`).join('')}</td></tr>`;
    await act(async () => {
      editor.commands.setContent(
        `<table><tr><td>head</td></tr>${row('a')}${row('b')}</table>`,
      );
    });
    await settleLayout();
    // The stack must be the paginated render (no fallback).
    expect(document.querySelector('[data-testid="paginated-fallback"]')).toBeNull();
    // Cell layers on ≥ 2 pages (the table fragments).
    const layers = document.querySelectorAll('[data-testid="table-cell-layer"]');
    expect(layers.length).toBeGreaterThanOrEqual(2);
    // A cell selection paints its cells' slices.
    await act(async () => {
      const positions: number[] = [];
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'tableCell') positions.push(pos);
      });
      editor.commands.setCellSelection({ anchorCell: positions[0], headCell: positions[1] });
    });
    await settleLayout();
    expect(document.querySelectorAll('[data-testid="selection-rect"]').length).toBeGreaterThanOrEqual(2);
  });
});

describe('M-TABLES: .wpdoc round-trip', () => {
  it('a table docJSON (merged cells, colwidths, shading, borderStyle) validates against the schema and round-trips through assembleDocumentFile unchanged', async () => {
    const { editor } = renderTensor();
    await act(async () => {
      editor.commands.setContent(
        '<table><tr><td colspan="2">wide</td></tr><tr><td>x</td><td>y</td></tr></table>',
      );
    });
    const cells = cellPositions(editor);
    await act(async () => {
      editor.chain().setCellSelection({ anchorCell: cells[1], headCell: cells[2] }).run();
      editor.commands.setCellBackground('#e2f0d9');
      editor.commands.setTableBorderPreset('outer');
    });
    // Give the wide cell an explicit colwidth (the resizable table's
    // stored geometry — the M-T2 engine reads it as track data).
    const wideCell = cellPositions(editor)[0];
    await act(async () => {
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(wideCell, undefined, {
          ...editor.state.doc.nodeAt(wideCell)!.attrs,
          colwidth: [200, 100],
        }),
      );
    });

    const docJSON = looseJSON(editor);
    const table = docJSON.content![0];
    expect(table.type).toBe('table');
    expect(table.attrs!.borderStyle).toBe('outer');
    expect(table.content![0].content![0].attrs!.colspan).toBe(2);
    expect(table.content![0].content![0].attrs!.colwidth).toEqual([200, 100]);
    expect(table.content![1].content![0].attrs!.backgroundColor).toBe('#e2f0d9');

    // The zod document schema accepts the table docJSON (docJSON is
    // z.any() — pinned so a future tightening doesn't silently break
    // table files).
    const file = assembleDocumentFile(editor, { pageSetup: useDocumentStore.getState().pageSetup });
    expect(file.version).toBe(CURRENT_DOCUMENT_VERSION);
    const parsed = DocumentFileSchema.parse(JSON.parse(JSON.stringify(file)));
    expect(parsed.docJSON).toEqual(docJSON);
  });
});
