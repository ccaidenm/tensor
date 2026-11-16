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

/**
 * M-IMAGES-1.5 — the image dialogs. The external-URL DOWNLOAD dialog
 * is GONE (the dead code path removed): an http(s) image paste is
 * refused with a toast, zero network calls (the fonts privacy
 * precedent, hardened). What remains:
 *  - ALT TEXT: metadata, not display — writes the node's alt attr
 *    (the hidden PM view's <img alt> is the a11y surface).
 */

interface AltTextStore {
  isOpen: boolean;
  /** The PM position of the image node being edited. */
  pos: number | null;
  alt: string;
  src: string | null;
  /** M-A11Y — the decorative state of the image being edited. */
  decorative: boolean;
  /** The decorative state is OPTIONAL at open (default off): callers
   * without an image in hand (the checker's flagged rows — flagged
   * images are never decorative by definition) open the dialog with
   * the toggle off. */
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
            // M-A11Y — the decorative marking rides the SAME commit as
            // the alt (one undo step for the whole decision).
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
        {/* M-A11Y — DECORATIVE (Word's own alt-text pane pattern): the
            explicit intent spelling — a divider or mood shot needs no
            description, screen readers skip it by design, and the
            checker's list stops asking. The description field greys
            out: decorative and described are mutually exclusive. */}
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
