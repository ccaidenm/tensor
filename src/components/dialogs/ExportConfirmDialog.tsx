import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  STACKED_DIALOG_CONTENT,
  STACKED_DIALOG_OVERLAY,
} from '@/components/ui/dialog';
import { create } from 'zustand';

// The export lossy confirm, one gate for every export flow: a flow awaits
// requestConfirm and the dialog's buttons settle it, so menu and palette
// share the same confirmation. Loss lines arrive pre-built; this only renders.

interface PendingConfirm {
  title: string;
  lines: string[];
  resolve: (proceed: boolean) => void;
}

interface ExportConfirmDialogStore {
  pending: PendingConfirm | null;
  requestConfirm: (request: { title: string; lines: string[] }) => Promise<boolean>;
  settle: (proceed: boolean) => void;
}

export const useExportConfirmDialogStore = create<ExportConfirmDialogStore>((set, get) => ({
  pending: null,
  requestConfirm: (request) =>
    new Promise<boolean>((resolve) => {
      // A new request declines any pending one — no dangling promises.
      get().pending?.resolve(false);
      set({ pending: { ...request, resolve } });
    }),
  settle: (proceed) => {
    get().pending?.resolve(proceed);
    set({ pending: null });
  },
}));

export function ExportConfirmDialog() {
  const pending = useExportConfirmDialogStore((s) => s.pending);
  const settle = useExportConfirmDialogStore((s) => s.settle);

  return (
    <Dialog open={pending !== null} onOpenChange={(o) => { if (!o) settle(false); }}>
      <DialogContent
        // Raised overlay (z-[100]): the frosted layer dims/blurs the app, never the card.
        className={`sm:max-w-sm ${STACKED_DIALOG_CONTENT}`}
        overlayClassName={STACKED_DIALOG_OVERLAY}
      >
        <DialogHeader>
          <DialogTitle>{pending?.title ?? ''}</DialogTitle>
          <DialogDescription>
            The exported file may not look exactly like this document.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
          {pending?.lines.map((line) => <li key={line}>• {line}</li>)}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={() => settle(false)}>
            Cancel
          </Button>
          <Button
            data-testid="export-confirm-accept"
            variant="destructive"
            onClick={() => settle(true)}
          >
            Export Anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
