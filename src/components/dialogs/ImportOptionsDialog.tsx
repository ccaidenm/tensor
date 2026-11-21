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
 * M-DOCX — the import options surface (ruling 4). When an imported
 * Word file references fonts outside Tensor's bundled catalog, the
 * user chooses — per import — what lands in the document:
 *
 *  - KEEP ORIGINAL (default): the Word font names ride the document
 *    data, the webview renders them through its fallback chain, and a
 *    round-trip back to Word is pixel-true.
 *  - SUBSTITUTE: names rewrite to the closest bundled family, so
 *    rendering is exactly what Tensor ships (at the cost of the
 *    original name).
 *
 * Promise bridge, same shape as the export confirm dialog. No cancel:
 * the file is already chosen — the choice is which fidelity wins.
 */

type FontPolicy = 'keep' | 'substitute';

interface PendingFonts {
  fonts: string[];
  resolve: (policy: FontPolicy) => void;
}

interface ImportOptionsDialogStore {
  pending: PendingFonts | null;
  requestFontPolicy: (fonts: string[]) => Promise<FontPolicy>;
  settle: (policy: FontPolicy) => void;
}

export const useImportOptionsDialogStore = create<ImportOptionsDialogStore>((set, get) => ({
  pending: null,
  requestFontPolicy: (fonts) =>
    new Promise<FontPolicy>((resolve) => {
      get().pending?.resolve('keep'); // a superseded ask falls back to the default
      set({ pending: { fonts, resolve } });
    }),
  settle: (policy) => {
    get().pending?.resolve(policy);
    set({ pending: null });
  },
}));

export function ImportOptionsDialog() {
  const pending = useImportOptionsDialogStore((s) => s.pending);
  const settle = useImportOptionsDialogStore((s) => s.settle);

  return (
    <Dialog open={pending !== null} onOpenChange={(o) => { if (!o) settle('keep'); }}>
      <DialogContent
        className={`sm:max-w-sm ${STACKED_DIALOG_CONTENT}`}
        overlayClassName={STACKED_DIALOG_OVERLAY}
      >
        <DialogHeader>
          <DialogTitle>Fonts not in Tensor</DialogTitle>
          <DialogDescription>
            This document uses fonts Tensor doesn&apos;t ship:
            {' '}{pending?.fonts.join(', ')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1 text-sm text-muted-foreground">
          <p>
            <span className="text-foreground font-medium">Keep original</span> stores the Word font
            names — the text renders with a close fallback here, and a round-trip back to Word is
            exact.
          </p>
          <p>
            <span className="text-foreground font-medium">Substitute</span> rewrites the names to the
            closest bundled family, so what you see is exactly what Tensor renders.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => settle('substitute')}>
            Substitute bundled fonts
          </Button>
          <Button data-testid="import-fonts-keep" onClick={() => settle('keep')}>
            Keep original fonts
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
