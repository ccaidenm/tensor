import { useEffect } from 'react';
import { PAGE_SIZES, FALLBACK_PAGE_SIZE, type PageSetup } from '@/lib/document/pageSetup';
import { PrintDocumentView } from '@/lib/print/PrintDocumentView';
import { usePrintStore, ptToCssSize } from '@/lib/print/printCss';

/**
 * M-PRINT (#43, Mark 2) — THE PRINT CONTAINER: the preview's Print
 * button arms this with the SAME walk the preview rendered (the
 * one-walk contract: what previews is what prints — no second
 * build), the container mounts the print DOM display:none on
 * screen, two rAFs let the DOM/paints settle, window.print() hands
 * it to the OS dialog (printer/copies/range — the OS's, per #43),
 * and the afterprint disarms.
 *
 * PRINT CSS LAW: @page size derives from the document's OWN
 * pageSetup (pt → CSS pt string), margin 0 — the walk's
 * coordinates are page-frame-absolute (the contentBox rides inside
 * them), so any @page margin would double-apply and shift every
 * element. The screen chrome suppresses itself under @media print
 * (index.css: [data-screen-chrome] display:none), the container
 * reveals. Sheets: --print-page-gap 0 (the @page breaks separate
 * paper pages — no 24px gutters on paper), and each sheet is
 * break-after so pages land on their own physical page.
 */

export function PrintContainer() {
  const pages = usePrintStore((s) => s.pages);
  const visiblePages = usePrintStore((s) => s.visiblePages);
  const cssPageSize = usePrintStore((s) => s.cssPageSize);
  const armed = pages != null && cssPageSize != null;

  // afterprint + Escape disarm (the dialog can be cancelled).
  useEffect(() => {
    if (!armed) return;
    const disarm = () => usePrintStore.getState().disarm();
    window.addEventListener('afterprint', disarm);
    return () => window.removeEventListener('afterprint', disarm);
  }, [armed]);

  return (
    <div
      data-testid="print-container"
      // THE SCREEN/HIDE LAW: display:none on screen; @media print
      // (index.css) reveals it while hiding [data-screen-chrome].
      style={{ display: armed ? 'block' : 'none' }}
      data-print-page-size={cssPageSize ?? undefined}
    >
      {armed && (
        <>
          <style>{`@page { size: ${cssPageSize}; margin: 0; }`}</style>
          <div style={{ ['--print-page-gap' as string]: '0px' }}>
            <PrintDocumentView pages={pages!} visiblePages={visiblePages} />
          </div>
        </>
      )}
    </div>
  );
}

/** The @page CSS size string for a document's pageSetup (the dialog
 *  arms with it; custom sizes ride their pt dims). */
export function printPageSizeOf(pageSetup: PageSetup): string {
  let widthPt: number;
  let heightPt: number;
  if (
    pageSetup.pageSize === 'custom' &&
    pageSetup.customWidth != null &&
    pageSetup.customHeight != null
  ) {
    widthPt = pageSetup.customWidth;
    heightPt = pageSetup.customHeight;
  } else {
    const base = PAGE_SIZES[pageSetup.pageSize] ?? PAGE_SIZES[FALLBACK_PAGE_SIZE]!;
    widthPt = base.width;
    heightPt = base.height;
  }
  return ptToCssSize(widthPt, heightPt, pageSetup.orientation === 'landscape');
}

/** THE PRINT FLOW (the preview's Print button body): arm with the
 *  PREVIEW'S OWN pages (one walk — no rebuild), let the container
 *  mount + paints settle (two rAFs), call window.print(). */
export async function printFromPreview(pages: import('@/lib/print/types').PrintPage[], pageSetup: PageSetup): Promise<void> {
  usePrintStore.getState().arm({
    pages,
    visiblePages: null,
    cssPageSize: printPageSizeOf(pageSetup),
  });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.print();
  // Disarm rides afterprint (the dialog's own close); a same-tick
  // disarm would unmount before some webviews snapshot the DOM.
}

