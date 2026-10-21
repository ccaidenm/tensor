import { useEffect, useState } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Frame,
  Pin,
  Plus,
  Minus,
  PaintBucket,
  TableCellsMerge,
  TableCellsSplit,
  X,
} from 'lucide-react';
import { useEditorState } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { CellSelection } from '@tiptap/pm/tables';
import { useDocumentStore } from '@/lib/document/store';
import { useSidebarStore } from '@/lib/layout/sidebarStore';
import {
  findTableUnderSelection,
  selectionHasMergedCells,
  type TableBorderPreset,
} from '@/lib/editor/TableExtensions';
import { clearAllColumnWidths, setColumnWidth, setRowMinHeight } from '@/lib/editor/tableResize';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { IconButton } from '@/components/layout/IconButton';
import { ColorPickerButton } from '@/components/layout/ribbon/ColorPickerButton';
import { cn } from 'cn';

/**
 * M-T3c — the TABLE side panel: the power-user surface over the
 * table's dimensions and flow (the user's spec: "a dedicated side panel
 * (like the Find/Replace panel) for power users to fine tune the
 * dimensions of cells and the table flow"). Docked through the SAME
 * SidebarHost/sidebarStore infrastructure as Find/Replace — the
 * multi-panel/draggable future upgrades once, and every panel rides.
 *
 * DIMENSIONS-PRIMARY, alternate-route-complete: the floating toolbar
 * can be turned off entirely, so the panel also carries the essential
 * table ops (structure, merge⇄split, header pin, shading via the SAME
 * ColorPickerButton, border presets). Everything dispatches through
 * editor commands/attrs — no second source of truth.
 *
 * The panel derives wholly from PM state (useEditorState — the
 * FloatingToolbar precedent): the table under the SELECTION is the
 * panel's subject; no table → the empty hint. Widths read the cells'
 * colwidth attrs (null = AUTO — the engine's flexible share); row
 * heights read the M-T3c minHeight attr (Word's "at least").
 */

/** The table under the selection, parsed for the panel. */
interface TablePanelModel {
  pos: number;
  node: PMNode;
  rowCount: number;
  colCount: number;
  /** Per-column fixed px widths (null = auto/flexible). */
  colWidths: (number | null)[];
  /** Per-row minimum heights (null = auto) + header flag. */
  rows: { minHeight: number | null; isHeader: boolean }[];
  border: TableBorderPreset;
  align: 'left' | 'center' | 'right';
  headerPinned: boolean;
  hasMerged: boolean;
  /** M-T4 — the table's outer margins attr (null = never set → 0). */
  margin: { top: number | null; right: number | null; bottom: number | null; left: number | null } | null;
  /** M-T4 — the table's default cell padding attr (null = engine constants). */
  cellPadding: { top: number | null; right: number | null; bottom: number | null; left: number | null } | null;
  /** M-T4 — the current cell's OWN padding override (null sides inherit). */
  cellPaddingOverride: { top: number | null; right: number | null; bottom: number | null; left: number | null } | null;
}

function tablePanelModel(editor: Editor): TablePanelModel | null {
  const found = findTableUnderSelection(editor.state);
  if (!found) return null;
  const { node, pos } = found;
  const firstRow = node.firstChild;
  if (!firstRow) return null;
  // Column widths from the first row's cells (the writer keeps the
  // column cells in sync; conflicts throw engine-side).
  const colWidths: (number | null)[] = [];
  firstRow.forEach((cell) => {
    const cw = (cell.attrs.colwidth as (number | null)[] | null) ?? [];
    for (let j = 0; j < (cell.attrs.colspan as number); j++) {
      colWidths.push(typeof cw[j] === 'number' ? (cw[j] as number) : null);
    }
  });
  const rows: TablePanelModel['rows'] = [];
  node.forEach((row) => {
    const min = row.attrs?.minHeight;
    // A header row = ALL its cells are tableHeader (the adapter's
    // allHeader semantics — what toggleHeaderRow produces).
    let allHeader = row.childCount > 0;
    row.forEach((cell) => {
      if (cell.type.name !== 'tableHeader') allHeader = false;
    });
    rows.push({
      minHeight: typeof min === 'number' && min > 0 ? min : null,
      isHeader: allHeader,
    });
  });
  // The row the selection is in — toggleHeaderRow's subject (the same
  // command the FloatingToolbar runs; the panel's active state reads
  // THIS row, not row 0).
  const { $from } = editor.state.selection;
  let currentRowIndex = 0;
  let rowCursor = pos + 1;
  node.forEach((row, i) => {
    if ($from.pos >= rowCursor && $from.pos < rowCursor + row.nodeSize) currentRowIndex = i;
    rowCursor += row.nodeSize;
  });
  // M-T4 — the current cell's OWN padding override (a bare caret's
  // cell; a CellSelection's anchor cell — Word's selection semantics).
  const selection = editor.state.selection;
  const cellPos = selection instanceof CellSelection ? selection.$anchorCell.pos : $from.pos;
  const cellNode = editor.state.doc.nodeAt(Math.max(cellPos, 0));
  const cellPaddingOverride =
    cellNode && (cellNode.type.name === 'tableCell' || cellNode.type.name === 'tableHeader')
      ? ((cellNode.attrs.padding as TablePanelModel['cellPaddingOverride']) ?? null)
      : null;
  return {
    pos,
    node,
    rowCount: node.childCount,
    colCount: colWidths.length,
    colWidths,
    rows,
    border: node.attrs.borderStyle === 'none' || node.attrs.borderStyle === 'outer' ? node.attrs.borderStyle : 'all',
    align: node.attrs.align === 'center' || node.attrs.align === 'right' ? node.attrs.align : 'left',
    headerPinned: rows[currentRowIndex]?.isHeader ?? false,
    hasMerged: selectionHasMergedCells(editor.state),
    margin: (node.attrs.margin as TablePanelModel['margin']) ?? null,
    cellPadding: (node.attrs.cellPadding as TablePanelModel['cellPadding']) ?? null,
    cellPaddingOverride,
  };
}

/**
 * The panel's numeric field with an AUTO mode: empty (or "auto")
 * commits null; a number commits clamped px. Commit on Enter/blur;
 * Escape reverts (the RibbonIconInput commit semantics, + auto).
 */
function AutoNumberInput({
  testId,
  value,
  min,
  max,
  onCommit,
  width = 'w-20',
  placeholder = 'auto',
}: {
  testId: string;
  value: number | null;
  min: number;
  max: number;
  onCommit: (v: number | null) => void;
  width?: string;
  placeholder?: string;
}) {
  const [local, setLocal] = useState(value == null ? '' : String(value));
  useEffect(() => {
    setLocal(value == null ? '' : String(value));
  }, [value]);

  function commit() {
    const t = local.trim().toLowerCase();
    if (t === '' || t === 'auto') {
      if (value !== null) onCommit(null);
      return;
    }
    const n = Number(t);
    if (Number.isNaN(n)) {
      setLocal(value == null ? '' : String(value));
      return;
    }
    onCommit(Math.min(max, Math.max(min, n)));
  }

  return (
    <input
      data-testid={testId}
      type="number"
      min={min}
      max={max}
      value={local}
      placeholder={placeholder}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setLocal(value == null ? '' : String(value));
          e.currentTarget.blur();
        }
      }}
      className={`h-7 ${width} rounded-md border border-input bg-transparent px-2 text-right text-sm [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none focus:outline-none focus:ring-1 focus:ring-ring`}
    />
  );
}

function SectionHeader({ label, action }: { label: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-3 pb-1 pt-3">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      {action}
    </div>
  );
}

/** M-T4 — one T/R/B/L edges row (margins or padding). */
function EdgesRow({
  label,
  testPrefix,
  values,
  placeholder,
  onCommit,
}: {
  label: string;
  testPrefix: string;
  /** [top, right, bottom, left] — null renders the placeholder. */
  values: [number | null, number | null, number | null, number | null];
  placeholder: string;
  onCommit: (side: 'top' | 'right' | 'bottom' | 'left', v: number | null) => void;
}) {
  const sides = [
    ['top', 'T'],
    ['right', 'R'],
    ['bottom', 'B'],
    ['left', 'L'],
  ] as const;
  return (
    <div className="flex items-center gap-2 px-3 py-0.5 text-sm">
      <span className="w-28 shrink-0 truncate text-muted-foreground" title={label}>
        {label}
      </span>
      <div className="grid flex-1 grid-cols-4 gap-1">
        {sides.map(([side, short]) => (
          <label key={side} className="flex items-center gap-0.5">
            <span className="w-2 text-[10px] text-muted-foreground">{short}</span>
            <AutoNumberInput
              testId={`${testPrefix}-${side}`}
              value={values[sides.findIndex((s) => s[0] === side)]}
              min={0}
              max={500}
              width="w-12"
              placeholder={placeholder}
              onCommit={(v) => onCommit(side, v)}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

export function TablePanel() {
  const editor = useDocumentStore((s) => s.editor);
  if (!editor) return null;
  return <TablePanelInner editor={editor} />;
}

function TablePanelInner({ editor }: { editor: Editor }) {
  const isOpen = useSidebarStore((s) => s.active?.id === 'table');
  const model = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? tablePanelModel(e) : null),
  });

  const close = () => {
    useSidebarStore.getState().close();
    editor.commands.focus();
  };

  return (
    <TooltipProvider>
      <div data-testid="table-panel" className={cn('flex h-full flex-col', !isOpen && 'pointer-events-none')}>
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-medium">Table Properties</span>
          <IconButton label="Close" icon={<X className="h-4 w-4" />} onClick={close} />
        </div>

        {!model ? (
          <div data-testid="table-panel-empty" className="p-3 text-sm text-muted-foreground">
            Place the caret inside a table to inspect and fine-tune it here.
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto pb-4">
            {/* ── Structure ── */}
            <SectionHeader label={`Table — ${model.rowCount} rows × ${model.colCount} columns`} />
            <div className="flex flex-wrap items-center gap-1 px-3">
              <Button
                data-testid="tp-add-row"
                variant="ghost"
                size="sm"
                className="h-7"
                onClick={() => editor.chain().focus().addRowAfter().run()}
              >
                <Plus size={12} /> Row
              </Button>
              <Button
                data-testid="tp-delete-row"
                variant="ghost"
                size="sm"
                className="h-7"
                onClick={() => editor.chain().focus().deleteRow().run()}
              >
                <Minus size={12} /> Row
              </Button>
              <Button
                data-testid="tp-add-col"
                variant="ghost"
                size="sm"
                className="h-7"
                onClick={() => editor.chain().focus().addColumnAfter().run()}
              >
                <Plus size={12} /> Column
              </Button>
              <Button
                data-testid="tp-delete-col"
                variant="ghost"
                size="sm"
                className="h-7"
                onClick={() => editor.chain().focus().deleteColumn().run()}
              >
                <Minus size={12} /> Column
              </Button>
            </div>

            {/* ── Flow: alignment + borders + header ── */}
            <SectionHeader label="Table flow" />
            <div className="flex flex-wrap items-center gap-3 px-3">
              <div className="flex items-center gap-0.5">
                <IconButton
                  label="Align table left"
                  data-testid="tp-align-left"
                  icon={<AlignLeft size={14} />}
                  active={model.align === 'left'}
                  onClick={() => editor.chain().focus().setTableAlign('left').run()}
                />
                <IconButton
                  label="Align table center"
                  data-testid="tp-align-center"
                  icon={<AlignCenter size={14} />}
                  active={model.align === 'center'}
                  onClick={() => editor.chain().focus().setTableAlign('center').run()}
                />
                <IconButton
                  label="Align table right"
                  data-testid="tp-align-right"
                  icon={<AlignRight size={14} />}
                  active={model.align === 'right'}
                  onClick={() => editor.chain().focus().setTableAlign('right').run()}
                />
              </div>
              <div className="flex items-center gap-0.5">
                {(['all', 'outer', 'none'] as TableBorderPreset[]).map((preset) => (
                  <IconButton
                    key={preset}
                    label={`Borders: ${preset}`}
                    data-testid={`tp-border-${preset}`}
                    icon={<Frame size={14} />}
                    active={model.border === preset}
                    onClick={() => editor.chain().focus().setTableBorderPreset(preset).run()}
                  />
                ))}
              </div>
              <IconButton
                label={model.headerPinned ? 'Unpin header row' : 'Make header row'}
                data-testid="tp-header-pin"
                icon={<Pin size={14} fill={model.headerPinned ? 'currentColor' : 'none'} />}
                active={model.headerPinned}
                onClick={() => editor.chain().focus().toggleHeaderRow().run()}
              />
            </div>

            {/* ── Columns ── */}
            <SectionHeader
              label="Columns"
              action={
                <Button
                  data-testid="tp-distribute"
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs"
                  onClick={() => clearAllColumnWidths(editor, model.pos)}
                >
                  Distribute evenly
                </Button>
              }
            />
            <div className="flex flex-col gap-1 px-3">
              {model.colWidths.map((w, i) => (
                <div key={i} className="flex items-center justify-between gap-2 text-sm">
                  <span className="w-20 text-muted-foreground">Column {i + 1}</span>
                  <div className="flex items-center gap-1">
                    <AutoNumberInput
                      testId={`tp-col-input-${i}`}
                      value={w}
                      min={25}
                      max={2000}
                      onCommit={(v) => setColumnWidth(editor, model.pos, i, v)}
                    />
                    <span className="w-4 text-xs text-muted-foreground">px</span>
                  </div>
                </div>
              ))}
            </div>

            {/* ── Rows ── */}
            <SectionHeader label="Rows — minimum height" />
            <div className="flex flex-col gap-1 px-3">
              {model.rows.map((row, i) => (
                <div key={i} className="flex items-center justify-between gap-2 text-sm">
                  <span className="w-20 text-muted-foreground">
                    Row {i + 1}
                    {row.isHeader ? ' · header' : ''}
                  </span>
                  <div className="flex items-center gap-1">
                    <AutoNumberInput
                      testId={`tp-row-input-${i}`}
                      value={row.minHeight}
                      min={0}
                      max={2000}
                      onCommit={(v) => setRowMinHeight(editor, model.pos, i, v)}
                    />
                    <span className="w-4 text-xs text-muted-foreground">px</span>
                  </div>
                </div>
              ))}
            </div>

            {/* ── M-T4: Spacing (margins + padding) ── */}
            <SectionHeader label="Spacing" />
            <div className="flex flex-col gap-0.5">
              <EdgesRow
                label="Table margins"
                testPrefix="tp-margin"
                values={[
                  model.margin?.top ?? 0,
                  model.margin?.right ?? 0,
                  model.margin?.bottom ?? 0,
                  model.margin?.left ?? 0,
                ]}
                placeholder="0"
                onCommit={(side, v) => editor.chain().focus().setTableMargin(side, v).run()}
              />
              <EdgesRow
                label="Default cell padding"
                testPrefix="tp-cellpad"
                values={[
                  model.cellPadding?.top ?? null,
                  model.cellPadding?.right ?? null,
                  model.cellPadding?.bottom ?? null,
                  model.cellPadding?.left ?? null,
                ]}
                placeholder="auto"
                onCommit={(side, v) => editor.chain().focus().setTableCellPadding(side, v).run()}
              />
              <EdgesRow
                label="Cell padding (current)"
                testPrefix="tp-cellpad-own"
                values={[
                  model.cellPaddingOverride?.top ?? null,
                  model.cellPaddingOverride?.right ?? null,
                  model.cellPaddingOverride?.bottom ?? null,
                  model.cellPaddingOverride?.left ?? null,
                ]}
                placeholder="auto"
                onCommit={(side, v) => editor.chain().focus().setCellPadding(side, v).run()}
              />
            </div>

            {/* ── Cells (the floating-toolbar alternate route) ── */}
            <SectionHeader label="Cells" />
            <div className="flex flex-wrap items-center gap-2 px-3">
              <IconButton
                label={model.hasMerged ? 'Split cell' : 'Merge cells'}
                data-testid="tp-merge"
                icon={model.hasMerged ? <TableCellsSplit size={14} /> : <TableCellsMerge size={14} />}
                onClick={() =>
                  model.hasMerged
                    ? editor.chain().focus().splitCell().run()
                    : editor.chain().focus().mergeCells().run()
                }
              />
              <ColorPickerButton
                label="Cell Shading"
                icon={<PaintBucket size={14} />}
                resetLabel="No Fill"
                onChange={(color) => editor.chain().focus().setCellBackground(color).run()}
              />
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
