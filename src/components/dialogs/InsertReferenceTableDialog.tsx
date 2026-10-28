import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { insertReferenceTableAtSelection } from '@/lib/editor/ReferenceTableNode';

/**
 * M-REFS — the "Insert Table of Contents" dialog (the
 * InsertTableDialog pattern — the ruling locked with the user): the
 * ToC's one option at insert time is the heading DEPTH (1–6, default
 * 3 = H1–H3, the issue's minimum). Table of Figures and Index insert
 * DIRECTLY (no dialog — they have no options), so this dialog is
 * ToC-only by design. The depth rides the node attr: re-inserting with
 * another depth is the M3 "options" affordance — never a migration.
 */

interface InsertReferenceTableStore {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const useInsertReferenceTableStore = create<InsertReferenceTableStore>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));

function clampDepth(value: string): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return 3;
  return Math.min(6, Math.max(1, n));
}

export function InsertReferenceTableDialog() {
  const isOpen = useInsertReferenceTableStore((s) => s.isOpen);
  const close = useInsertReferenceTableStore((s) => s.close);
  const [depth, setDepth] = useState('3');

  // Fresh state each open — a re-open never inherits the previous insert.
  useEffect(() => {
    if (isOpen) setDepth('3');
  }, [isOpen]);

  function insert() {
    const editor = useDocumentStore.getState().editor;
    if (editor) insertReferenceTableAtSelection(editor, 'toc', clampDepth(depth));
    close();
  }

  return (
    <Dialog open={isOpen} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Insert Table of Contents</DialogTitle>
          <DialogDescription>
            The table lists your document's headings and updates automatically
            as they change. Click an entry (Ctrl+click) to jump to it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <label htmlFor="insert-toc-depth" className="flex-1 text-sm">
              Include headings up to level
            </label>
            <Input
              id="insert-toc-depth"
              data-testid="insert-toc-depth"
              className="w-20"
              type="number"
              min={1}
              max={6}
              value={depth}
              onChange={(e) => setDepth(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') insert(); }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Level 1 is the largest heading; 3 includes H1–H3. This can be
            changed later by inserting a new table.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>Cancel</Button>
          <Button data-testid="insert-toc-confirm" onClick={insert}>Insert</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
