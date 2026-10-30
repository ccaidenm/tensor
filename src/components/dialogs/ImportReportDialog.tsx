import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { create } from 'zustand';

/**
 * M-MD/M-DOCX — THE import report surface: what an import dropped,
 * converted, or refused — one in-app shadcn dialog (the same family as
 * the export confirm), never a native popup. Informational only: the
 * import already happened; the dialog names what changed so nothing is
 * ever silently lost. Markdown's dropped-image count and the Word
 * import's notices both surface here.
 */

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
        // The raised-overlay treatment the other dialogs use — the
        // frosted layer dims/blurs the app, never the card.
        className="sm:max-w-sm z-[110]"
        overlayClassName="z-[100] bg-black/30 backdrop-blur-lg"
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
