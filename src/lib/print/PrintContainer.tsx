import { useEffect } from 'react';
import { PAGE_SIZES, FALLBACK_PAGE_SIZE, type PageSetup } from '@/lib/document/pageSetup';
import { PrintDocumentView } from '@/lib/print/PrintDocumentView';
import { usePrintStore, ptToCssSize } from '@/lib/print/printCss';

/**
 * #43 — the preview's Print button arms this with the same walk the
 * preview rendered (what previews is what prints). @page margin is 0:
 * the walk's coordinates are page-frame-absolute.
 */

export function PrintContainer() {
  const pages = usePrintStore((s) => s.pages);
  const visiblePages = usePrintStore((s) => s.visiblePages);
  const cssPageSize = usePrintStore((s) => s.cssPageSize);
  const armed = pages != null && cssPageSize != null;

  // afterprint disarm (the dialog can be cancelled).
  useEffect(() => {
    if (!armed) return;
    const disarm = () => usePrintStore.getState().disarm();
    window.addEventListener('afterprint', disarm);
    return () => window.removeEventListener('afterprint', disarm);
  }, [armed]);

  return (
    <div
      data-testid="print-container"
      // display:none on screen; @media print (index.css) reveals it
      // while hiding [data-screen-chrome].
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

/** The preview's Print button body: arm with the preview's own pages
 *  (one walk — no rebuild), settle two rAFs, then window.print(). */
export async function printFromPreview(pages: import('@/lib/print/types').PrintPage[], pageSetup: PageSetup): Promise<void> {
  usePrintStore.getState().arm({
    pages,
    visiblePages: null,
    cssPageSize: printPageSizeOf(pageSetup),
  });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.print();
  // Disarm rides afterprint; a same-tick disarm would unmount before
  // some webviews snapshot the DOM.
}

