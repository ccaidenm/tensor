import { create } from 'zustand';

/**
 * #43 — the print arm/disarm state: the preview arms with its
 * already-built pages (what previews is what prints — no second
 * build); the container calls window.print(); afterprint disarms.
 */

import type { PrintPage } from './types';

interface PrintStore {
  pages: PrintPage[] | null;
  visiblePages: ReadonlySet<number> | null;
  cssPageSize: string | null;
  arm: (request: { pages: PrintPage[]; visiblePages?: ReadonlySet<number> | null; cssPageSize: string }) => void;
  disarm: () => void;
}

export const usePrintStore = create<PrintStore>((set) => ({
  pages: null,
  visiblePages: null,
  cssPageSize: null,
  arm: ({ pages, visiblePages, cssPageSize }) =>
    set({ pages, visiblePages: visiblePages ?? null, cssPageSize }),
  disarm: () => set({ pages: null, visiblePages: null, cssPageSize: null }),
}));

/** The pageSetup → the @page CSS size string (pt → CSS pt). Margin
 *  is always 0: the walk's coordinates are page-frame-absolute —
 *  any @page margin would double-apply and shift every element. */
export function ptToCssSize(widthPt: number, heightPt: number, landscape: boolean): string {
  const w = landscape ? heightPt : widthPt;
  const h = landscape ? widthPt : heightPt;
  return `${Math.round(w)}pt ${Math.round(h)}pt`;
}