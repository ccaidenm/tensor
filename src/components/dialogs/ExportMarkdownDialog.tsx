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
import type { MarkdownLossyReport } from '@/lib/markdown/lossy';
import { markdownLossyLines } from '@/lib/markdown/lossy';

/**
 * M-MD — the export lossy confirm, the developer-mode warning's
 * in-app spelling: a shadcn dialog, never a native popup. Store and
 * component share this file (the InsertTableDialog precedent) so the
 * store is discoverable next to the surface it drives.
 *
 * The store is a PROMISE BRIDGE: exportMarkdownFile (lib) awaits
 * requestConfirm(report); the dialog's buttons settle it. The gate
 * lives in the lib flow, so the menu and the palette share the exact
 * same confirmation (the registry one-body law).
 */

interface PendingConfirm {
  report: MarkdownLossyReport;
  resolve: (proceed: boolean) => void;
}

interface ExportMarkdownDialogStore {
  pending: PendingConfirm | null;
  requestConfirm: (report: MarkdownLossyReport) => Promise<boolean>;
  settle: (proceed: boolean) => void;
}

export const useExportMarkdownDialogStore = create<ExportMarkdownDialogStore>((set, get) => ({
  pending: null,
  requestConfirm: (report) =>
    new Promise<boolean>((resolve) => {
      // A request arriving while one is pending declines the old —
      // no dangling promises, last ask wins.
      get().pending?.resolve(false);
      set({ pending: { report, resolve } });
    }),
  settle: (proceed) => {
    get().pending?.resolve(proceed);
    set({ pending: null });
  },
}));

export function ExportMarkdownDialog() {
  const pending = useExportMarkdownDialogStore((s) => s.pending);
  const settle = useExportMarkdownDialogStore((s) => s.settle);

  return (
    <Dialog open={pending !== null} onOpenChange={(o) => { if (!o) settle(false); }}>
      <DialogContent
        // The POPUP clears its OWN raised overlay (z-[100]) — the same
        // treatment the developer-mode warning uses — so the frosted
        // layer dims/blurs the app, never the card itself.
        className="sm:max-w-sm z-[110]"
        overlayClassName="z-[100] bg-black/30 backdrop-blur-lg"
      >
        <DialogHeader>
          <DialogTitle>Export Markdown?</DialogTitle>
          <DialogDescription>
            This document uses content that Markdown cannot represent — the exported file may not
            look like this document.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
          {pending?.report &&
            markdownLossyLines(pending.report).map((line) => <li key={line}>• {line}</li>)}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={() => settle(false)}>
            Cancel
          </Button>
          <Button
            data-testid="export-markdown-accept"
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
