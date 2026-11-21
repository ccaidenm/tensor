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

/**
 * M-MD/M-DOCX — THE export lossy confirm, one gate for every export
 * flow (markdown, DOCX, later PDF): the developer-mode warning's
 * in-app spelling — a shadcn dialog, never a native popup. Store and
 * component share this file (the InsertTableDialog precedent) so the
 * store is discoverable next to the surface it drives.
 *
 * The store is a PROMISE BRIDGE: an export flow awaits
 * requestConfirm({title, lines}); the dialog's buttons settle it. The
 * gate lives in each flow's lib module, so the menu and the palette
 * share the exact same confirmation (the registry one-body law). The
 * lines are pre-built by the flow's loss classifier (markdown's
 * markdownLossyLines, DOCX's docxReportLines) — the dialog renders,
 * it does not classify.
 */

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
      // A request arriving while one is pending declines the old —
      // no dangling promises, last ask wins.
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
        // The POPUP clears its OWN raised overlay (z-[100]) — the same
        // treatment the developer-mode warning uses — so the frosted
        // layer dims/blurs the app, never the card itself.
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
