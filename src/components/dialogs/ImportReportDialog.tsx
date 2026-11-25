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

// The import report: what an import dropped, converted, or refused.
// Informational only — the import already happened; this names what
// changed so nothing is silently lost.

interface ImportReportDialogStore {
  pending: { title: string; lines: string[] } | null;
  show: (request: { title: string; lines: string[] }) => void;
  dismiss: () => void;
}

export const useImportReportDialogStore = create<ImportReportDialogStore>((set) => ({
  pending: null,
  show: (request) => set({ pending: request }),
  dismiss: () => set({ pending: null }),
}));

export function ImportReportDialog() {
  const pending = useImportReportDialogStore((s) => s.pending);
  const dismiss = useImportReportDialogStore((s) => s.dismiss);

  return (
    <Dialog open={pending !== null} onOpenChange={(o) => { if (!o) dismiss(); }}>
      <DialogContent
        // Raised overlay: the frosted layer dims/blurs the app, never the card.
        className={`sm:max-w-sm ${STACKED_DIALOG_CONTENT}`}
        overlayClassName={STACKED_DIALOG_OVERLAY}
      >
        <DialogHeader>
          <DialogTitle>{pending?.title ?? ''}</DialogTitle>
          <DialogDescription>
            What changed during the import — nothing was silently lost.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
          {pending?.lines.map((line) => <li key={line}>• {line}</li>)}
        </ul>
        <DialogFooter>
          <Button data-testid="import-report-ok" onClick={dismiss}>
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
