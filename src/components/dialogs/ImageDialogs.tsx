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
import { useMediaStore } from '@/lib/media/store';
import { create } from 'zustand';
import { useDocumentStore } from '@/lib/document/store';

// The alt-text dialog. Alt text is metadata, not display — it writes the
// node's alt attribute, the a11y surface of the hidden PM view's <img>.

interface AltTextStore {
  isOpen: boolean;
  /** The PM position of the image node being edited. */
  pos: number | null;
  alt: string;
  src: string | null;
  /** The decorative state of the image being edited. */
  decorative: boolean;
  /** decorative defaults to off when omitted — callers opening from the
   * checker's flagged rows have no decorative state in hand. */
  open: (pos: number, alt: string, src: string | null, decorative?: boolean) => void;
  close: () => void;
  setAlt: (alt: string) => void;
  setDecorative: (decorative: boolean) => void;
}

export const useAltTextStore = create<AltTextStore>((set) => ({
  isOpen: false,
  pos: null,
  alt: '',
  src: null,
  decorative: false,
  open: (pos, alt, src, decorative = false) => set({ isOpen: true, pos, alt, src, decorative }),
  close: () => set({ isOpen: false, pos: null, decorative: false }),
  setAlt: (alt) => set({ alt }),
  setDecorative: (decorative) => set({ decorative }),
}));

export function AltTextDialog() {
  const isOpen = useAltTextStore((s) => s.isOpen);
  const pos = useAltTextStore((s) => s.pos);
  const alt = useAltTextStore((s) => s.alt);
  const src = useAltTextStore((s) => s.src);
  const close = useAltTextStore((s) => s.close);
  const setAlt = useAltTextStore((s) => s.setAlt);
  const decorative = useAltTextStore((s) => s.decorative);
  const setDecorative = useAltTextStore((s) => s.setDecorative);

  const entryId = src?.startsWith('media://') ? src.slice('media://'.length) : null;
  const preview = useMediaStore((s) => (entryId ? s.entries.get(entryId) : undefined));

  function save() {
    const editor = useDocumentStore.getState().editor;
    if (editor && pos != null) {
      editor
        .chain()
        .command(({ tr, dispatch }) => {
          if (dispatch) {
            tr.setNodeAttribute(pos, 'alt', alt);
            // Decorative rides the same commit as the alt — one undo step.
            tr.setNodeAttribute(pos, 'decorative', decorative);
          }
          return true;
        })
        .run();
    }
    close();
  }

  return (
    <Dialog open={isOpen} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Alt Text</DialogTitle>
          <DialogDescription>
            Describes the image to screen readers — metadata, not display.
          </DialogDescription>
        </DialogHeader>
        {preview && (
          <img src={preview.url} alt="" className="mx-auto max-h-32 rounded-lg border object-contain" />
        )}
        <Input
          data-testid="alt-text-input"
          value={alt}
          onChange={(e) => setAlt(e.target.value)}
          disabled={decorative}
          autoFocus
        />
        {/* Decorative images need no description — screen readers skip them,
            and decorative/described are mutually exclusive, hence the grey-out. */}
        <label className="flex items-center justify-between gap-3">
          <span className="flex flex-col">
            <span className="text-sm">Mark as decorative</span>
            <span className="text-xs text-muted-foreground">
              Screen readers skip decorative images.
            </span>
          </span>
          <Switch
            size="sm"
            data-testid="alt-text-decorative"
            checked={decorative}
            onCheckedChange={(checked: boolean) => setDecorative(checked)}
          />
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={close}>Cancel</Button>
          <Button data-testid="alt-text-save" onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
