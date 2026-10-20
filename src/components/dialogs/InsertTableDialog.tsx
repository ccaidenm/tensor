import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { create } from 'zustand';
import { useDocumentStore } from '@/lib/document/store';
import { insertTableAtSelection } from '@/lib/editor/tableInsert';

/**
 * M-TABLES — the "Insert Table…" dialog. Exact rows/cols entry (the
 * grid picker's companion — Word offers both). The insertion is the
 * ONE built-in command path (editor.commands.insertTable), so the
 * dialog, the ribbon grid picker, and the palette all converge on the
 * same schema-level insert.
 */

interface InsertTableStore {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const useInsertTableStore = create<InsertTableStore>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));

function clampDimension(value: string): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return 1;
  return Math.min(50, Math.max(1, n));
}

export function InsertTableDialog() {
  const isOpen = useInsertTableStore((s) => s.isOpen);
  const close = useInsertTableStore((s) => s.close);
  const [rows, setRows] = useState('3');
  const [cols, setCols] = useState('3');
  const [withHeaderRow, setWithHeaderRow] = useState(true);

  // Fresh state each open — a re-open never inherits the previous insert.
  useEffect(() => {
    if (isOpen) {
      setRows('3');
      setCols('3');
      setWithHeaderRow(true);
    }
  }, [isOpen]);

  function insert() {
    const editor = useDocumentStore.getState().editor;
    if (editor) {
      insertTableAtSelection(editor, {
        rows: clampDimension(rows),
        cols: clampDimension(cols),
        withHeaderRow,
      });
    }
    close();
  }

  return (
    <Dialog open={isOpen} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Insert Table</DialogTitle>
          <DialogDescription>
            Choose the starting dimensions — rows and columns can be added later.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-4">
            <div className="flex flex-1 items-center gap-2">
              <label htmlFor="insert-table-rows" className="w-10 text-sm">Rows</label>
              <Input
                id="insert-table-rows"
                data-testid="insert-table-rows"
                type="number"
                min={1}
                max={50}
                value={rows}
                onChange={(e) => setRows(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') insert(); }}
              />
            </div>
            <div className="flex flex-1 items-center gap-2">
              <label htmlFor="insert-table-cols" className="w-10 text-sm">Columns</label>
              <Input
                id="insert-table-cols"
                data-testid="insert-table-cols"
                type="number"
                min={1}
                max={50}
                value={cols}
                onChange={(e) => setCols(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') insert(); }}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch
              data-testid="insert-table-header"
              checked={withHeaderRow}
              onCheckedChange={setWithHeaderRow}
            />
            Header row
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>Cancel</Button>
          <Button data-testid="insert-table-confirm" onClick={insert}>Insert</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
