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

// Per-import choice for Word fonts outside the bundled catalog: keep the
// original names (fallback rendering, exact round-trip) or substitute the
// closest bundled family. No cancel — the file is already chosen.

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
