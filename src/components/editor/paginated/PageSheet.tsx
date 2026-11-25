import type { ReactNode } from 'react';
import type { PageGeometry } from '@tensor-editor/engine';

interface PageSheetProps {
  geometry: PageGeometry;
  /** Stack-local top offset, logical (pre-zoom) px. */
  top: number;
  /** #101: stack-local left (column offset; 0 single-column). */
  left?: number;
  /** IntersectionObserver registration for virtualization. */
  observeRef?: (el: HTMLDivElement | null) => void;
  /** Per-document page background color; absent = white. */
  background?: string;
  children: ReactNode;
}

/** One absolutely-positioned sheet per PageGeometry. All painted
 * children live inside the scaled stack — no zoom compensation.
 * Styling only; every dimension comes from engine geometry. */
export function PageSheet({ geometry, top, left = 0, observeRef, background, children }: PageSheetProps) {
  return (
    <div
      ref={observeRef}
      data-page-index={geometry.index}
      data-testid="page-sheet"
      role="presentation"
      className={`absolute rounded-[6px] border border-border shadow-lg ${background ? '' : 'bg-white'}`}
      style={{
        top: `${top}px`,
        left: `${left}px`,
        width: `${geometry.size.width}px`,
        height: `${geometry.size.height}px`,
        ...(background ? { backgroundColor: background } : {}),
      }}
    >
      {children}
    </div>
  );
}