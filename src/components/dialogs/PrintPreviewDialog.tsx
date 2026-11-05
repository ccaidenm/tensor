import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Printer, Save, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useDocumentStore } from '@/lib/document/store';
import { buildPrintDocument, parsePageRange } from '@/lib/print/buildDocument';
import { PrintDocumentView } from '@/lib/print/PrintDocumentView';
import { create } from 'zustand';

/**
 * M-PRINT (#43, Mark 3) — THE PREVIEW MODAL: the Settings dialog's
 * shape (shadcn Dialog + Content, min(85vw, 72rem), an inner two-pane
 * flex — NOT a bespoke fixed overlay), Chromium's layout: LEFT the
 * document (the Mark-1 walk through the shared PrintDocumentView —
 * WHAT PREVIEWS IS EXACTLY WHAT PRINTS), RIGHT the options (zoom,
 * page range, paper summary, the Mark 2/4 action placeholders).
 *
 * OPTIONS (honest inventory): zoom (fit-width default + steps), page
 * range ("1-3, 7" — previews AND prints), the doc's OWN pageSetup
 * (never a preview-local override — one geometry source). Print/Save
 * PDF render DISABLED until Marks 2/4 land (a silent no-op button
 * would be a lie).
 *
 * The build SNAPSHOTS on open (Word's print-preview posture): a heavy
 * walk per keystroke buys nothing. Close + reopen to re-preview.
 */

interface PrintPreviewStore {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const usePrintPreviewStore = create<PrintPreviewStore>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));

const ZOOM_STEPS = [50, 75, 100, 125, 150, 200];
/** The sheet gutter BETWEEN preview pages (px, pre-zoom — scales). */
const PAGE_GAP = 24;

export function PrintPreviewDialog() {
  const isOpen = usePrintPreviewStore((s) => s.isOpen);
  const close = usePrintPreviewStore((s) => s.close);
  const editor = useDocumentStore((s) => s.editor);
  const pageSetup = useDocumentStore((s) => s.pageSetup);

  // THE SNAPSHOT: build once per open (the walk + engine layout are
  // heavy; live re-preview per keystroke buys nothing).
  const build = useMemo(
    () => (isOpen && editor ? buildPrintDocument(editor) : null),
    // pageSetup changes while CLOSED re-build on the next open (isOpen
    // in the deps re-runs this on open); while OPEN the snapshot stands.
    [isOpen, editor],
  );

  const [rangeRaw, setRangeRaw] = useState('');
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [fitScale, setFitScale] = useState(1);

  // Fit-width scale: the first page's width against the scroll area.
  // THE SCROLLBAR FIX: a multi-page doc's vertical scrollbar steals
  // content width AFTER the first compute — the observer must watch
  // the CONTENT box (the default border-box never fires on scrollbar
  // appearance), or fit pages would overflow horizontally and force
  // the scroll the user reported.
  const firstPage = build?.pages[0];
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !firstPage) return;
    const compute = () => {
      const avail = el.clientWidth - 48; // the sheet side gutters
      if (firstPage.width > 0) setFitScale(Math.min(1, avail / firstPage.width));
    };
    compute();
    // Post-animation settle (the dialog's zoom-in): one deferred pass.
    const raf = requestAnimationFrame(compute);
    const ro = new ResizeObserver(compute);
    ro.observe(el, { box: 'content-box' });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [firstPage, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setRangeRaw('');
      setZoom('fit');
    }
  }, [isOpen]);

  if (!isOpen || !build || !editor) return null;

  const scale = zoom === 'fit' ? fitScale : zoom / 100;
  const visiblePages = parsePageRange(rangeRaw, build.total);

  const pageW = build.pages[0]?.width ?? 0;
  const paperLabel = `${pageSetup.pageSize}${pageSetup.orientation === 'landscape' ? ' (landscape)' : ''}`;
  const marginsLabel = `${pageSetup.margins.top}/${pageSetup.margins.bottom}/${pageSetup.margins.left}/${pageSetup.margins.right} pt margins`;

  const zoomPct = Math.round(scale * 100);
  const zoomIn = () => {
    const idx = ZOOM_STEPS.findIndex((z) => z > zoomPct);
    setZoom(ZOOM_STEPS[idx === -1 ? ZOOM_STEPS.length - 1 : idx]);
  };
  const zoomOut = () => {
    const idx = ZOOM_STEPS.findIndex((z) => z >= zoomPct);
    setZoom(ZOOM_STEPS[Math.max(0, (idx === -1 ? ZOOM_STEPS.length : idx) - 1)]);
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        showCloseButton
        data-testid="print-preview"
        // Larger than Settings (min(85vw,72rem) — its own posture): a
        // preview wants the extra room.
        style={{ width: 'min(90vw, 80rem)', maxWidth: 'min(90vw, 80rem)' }}
      >
        <DialogDescription className="sr-only">
          Print preview — what previews is exactly what prints
        </DialogDescription>

        <div className="-m-4 flex flex-col overflow-hidden rounded-xl" style={{ height: 'min(85vh, 50rem)' }}>
          <div className="flex-none border-b border-border px-4 py-3 pr-10">
            <DialogTitle className="font-heading text-base font-semibold">Print Preview</DialogTitle>
          </div>

          <div className="flex flex-1 overflow-hidden">
            {/* LEFT — the document */}
            <div
              ref={scrollRef}
              className="flex-1 overflow-auto bg-neutral-200 p-6 dark:bg-neutral-800"
            >
              <div
                style={{
                  width: pageW * scale > 0 ? pageW * scale : undefined,
                  margin: '0 auto',
                  position: 'relative',
                }}
              >
                <div
                  style={{
                    transform: `scale(${scale})`,
                    transformOrigin: 'top left',
                    position: 'absolute',
                    top: 0,
                    left: 0,
                  }}
                >
                  {/* The view's own column + --print-page-gap sets the
                      sheet gutter; the Mark-2 print container overrides
                      it to 0 (@page breaks separate sheets). */}
                  <div style={{ ['--print-page-gap' as string]: `${PAGE_GAP}px` }}>
                    <PrintDocumentView pages={build.pages} visiblePages={visiblePages} />
                  </div>
                </div>
              </div>
            </div>

            {/* RIGHT — the options */}
            <div className="flex w-72 flex-none flex-col gap-4 overflow-auto border-l border-border p-4">
              <div className="text-sm text-muted-foreground">
                <div data-testid="print-preview-total">
                  {build.total} page{build.total === 1 ? '' : 's'}
                </div>
                <div>{paperLabel}</div>
                <div className="text-xs">{marginsLabel}</div>
                {visiblePages && (
                  <div className="text-xs" data-testid="print-preview-range">
                    Previewing {visiblePages.size} of {build.total}
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium" htmlFor="print-preview-range">
                  Pages
                </label>
                <Input
                  id="print-preview-range"
                  data-testid="print-preview-range-input"
                  placeholder={`All (e.g. 1-${build.total})`}
                  value={rangeRaw}
                  onChange={(e) => setRangeRaw(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  e.g. &ldquo;1-3, {build.total}&rdquo; — the range previews and prints.
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Zoom</span>
                  <span className="text-xs text-muted-foreground">{zoomPct}%</span>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="sm" aria-label="Zoom out" onClick={zoomOut}>
                    <ZoomOut className="h-4 w-4" />
                  </Button>
                  <Button
                    variant={zoom === 'fit' ? 'secondary' : 'ghost'}
                    size="sm"
                    onClick={() => setZoom('fit')}
                  >
                    Fit
                  </Button>
                  <Button variant="outline" size="sm" aria-label="Zoom in" onClick={zoomIn}>
                    <ZoomIn className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="mt-auto flex flex-col gap-2">
                {/* MARKS 2/4: the actions land with their marks — disabled
                    placeholders, never silent no-ops. */}
                <Button disabled data-testid="print-preview-print">
                  <Printer className="h-4 w-4" />
                  Print…
                </Button>
                <Button disabled data-testid="print-preview-pdf">
                  <Save className="h-4 w-4" />
                  Save as PDF…
                </Button>
                <p className="text-xs text-muted-foreground">
                  Print and PDF export arrive with their milestone slices — the preview
                  shows exactly what they will produce.
                </p>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

