import { useState } from 'react';
import { Table } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { IconButton } from '../../IconButton';
import { useDocumentStore } from '@/lib/document/store';
import { useInsertTableStore } from '@/components/dialogs/InsertTableDialog';
import { insertTableAtSelection } from '@/lib/editor/tableInsert';

/**
 * M-TABLES — the Word-style insertion grid: hover to size (cells light
 * up as an rows×cols preview), click to insert. "Insert Table…" hands
 * off to the exact-dimension dialog. All three entry points (grid,
 * dialog, palette) converge on editor.commands.insertTable.
 */

const MAX_GRID = 8;

export function TableGridPicker() {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState<{ rows: number; cols: number } | null>(null);

  function insert(rows: number, cols: number) {
    const editor = useDocumentStore.getState().editor;
    if (editor) insertTableAtSelection(editor, { rows, cols, withHeaderRow: true });
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <IconButton
            label="Table"
            data-testid="ribbon-table-button"
            icon={<Table size={16} />}
            onClick={() => {}}
          />
        }
      />
      <PopoverContent className="w-auto p-3" align="start">
        <div
          data-testid="table-grid-picker"
          onMouseLeave={() => setHovered(null)}
          className="flex flex-col gap-2"
        >
          <div
            className="grid gap-0.5"
            style={{ gridTemplateColumns: `repeat(${MAX_GRID}, 18px)` }}
            role="grid"
            aria-label="Insert table"
          >
            {Array.from({ length: MAX_GRID * MAX_GRID }, (_, i) => {
              const r = Math.floor(i / MAX_GRID) + 1;
              const c = (i % MAX_GRID) + 1;
              const active = hovered != null && r <= hovered.rows && c <= hovered.cols;
              return (
                <button
                  key={i}
                  data-testid={`table-grid-cell-${r}-${c}`}
                  role="gridcell"
                  aria-label={`${r} by ${c} table`}
                  className={`h-[18px] w-[18px] rounded-[2px] border transition-colors ${
                    active
                      ? 'border-primary bg-primary/25'
                      : 'border-border/60 bg-transparent'
                  }`}
                  onMouseEnter={() => setHovered({ rows: r, cols: c })}
                  onClick={() => insert(r, c)}
                />
              );
            })}
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground" data-testid="table-grid-preview">
              {hovered ? `${hovered.rows} × ${hovered.cols} Table` : 'Insert Table'}
            </span>
            <button
              data-testid="table-grid-dialog"
              className="text-xs text-primary hover:underline"
              onClick={() => {
                setOpen(false);
                useInsertTableStore.getState().open();
              }}
            >
              Insert Table…
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
