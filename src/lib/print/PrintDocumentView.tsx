import { memo } from 'react';
import { parseEquation, renderEquation } from '@/lib/equations/render';
import type { PrintElement, PrintPage } from './types';

/**
 * M-PRINT (#43) — THE PRINT DOCUMENT VIEW: one component renders the
 * print walk's pages for BOTH consumers — the preview modal and the
 * window.print() container — so what previews is EXACTLY what prints
 * (the Mark-1 contract: one walk, one view, two mounts).
 *
 * All elements are absolutely positioned in page-relative px; the
 * page divs carry the paper size (the @page size in the print CSS
 * matches them — margins are ZERO because the layout's contentBox
 * already IS the page frame). Images/equations load from the same
 * sources the on-screen view uses.
 */

function elementKey(el: PrintElement, i: number): string {
  return `${el.kind}-${i}-${'text' in el ? el.x : 0}-${'top' in el ? el.top : 0}`;
}

function PrintElementView({ el }: { el: PrintElement }) {
  switch (el.kind) {
    case 'text':
      return (
        <span
          style={{
            position: 'absolute',
            left: `${el.x}px`,
            top: `${el.top}px`,
            width: `${el.width}px`,
            fontFamily: el.style.fontFamily,
            fontSize: `${el.style.fontSize}px`,
            fontWeight: el.style.bold ? 'bold' : undefined,
            fontStyle: el.style.italic ? 'italic' : undefined,
            fontVariant: el.style.fontVariant === 'small-caps' ? 'small-caps' : undefined,
            color: el.color,
            textDecorationLine: el.decoration || undefined,
            lineHeight: 1,
            whiteSpace: 'pre',
            userSelect: 'none',
          }}
        >
          {el.text}
        </span>
      );
    case 'highlight':
      return (
        <div
          style={{
            position: 'absolute',
            left: `${el.x}px`,
            top: `${el.top}px`,
            width: `${el.width}px`,
            height: `${el.height}px`,
            backgroundColor: el.color,
          }}
        />
      );
    case 'rect':
      return (
        <div
          style={{
            position: 'absolute',
            left: `${el.x}px`,
            top: `${el.top}px`,
            width: `${el.width}px`,
            height: `${el.height}px`,
            backgroundColor: el.fill,
          }}
        />
      );
    case 'line':
      return (
        <div
          style={{
            position: 'absolute',
            left: `${el.x}px`,
            top: `${el.top}px`,
            width: `${el.width}px`,
            height: `${el.height}px`,
            backgroundColor: el.color,
          }}
        />
      );
    case 'image':
      return (
        <img
          src={el.src}
          alt={el.alt}
          style={{
            position: 'absolute',
            left: `${el.x}px`,
            top: `${el.top}px`,
            width: `${el.width}px`,
            height: `${el.height}px`,
            zIndex: el.z === 'behind' ? 0 : 2,
          }}
        />
      );
    case 'equation': {
      // THE BROKEN-GLYPH LAW (the node view's): never KaTeX's red
      // error text, never a silent blank. Valid → the KaTeX projection
      // (DOM, shared fonts — crisp in print); invalid/empty → the
      // styled faces with the source visible.
      const empty = el.latex.trim() === '';
      const invalid = !empty && parseEquation(el.latex) !== null;
      const html = empty || invalid ? '' : renderEquation(el.latex);
      return (
        <div
          // .tensor-equation: THE shared class stack (index.css) — the
          // node view, the EquationLayer, AND the measurement probe all
          // render under it, so the measured box is the painted box by
          // construction. Without it KaTeX's own display margins and
          // font sizing mislay the content inside the placed rect (the
          // reported invisible-in-preview bug).
          className="tensor-equation"
          style={{
            position: 'absolute',
            left: `${el.x}px`,
            top: `${el.top}px`,
            width: `${el.width}px`,
            height: `${el.height}px`,
            fontSize: `${el.fontSize}px`,
            color: el.color,
            overflow: 'hidden',
          }}
          // KaTeX HTML (the rendered string) — the print path's math
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    }
    default:
      return null;
  }
}

export const PrintDocumentView = memo(function PrintDocumentView({
  pages,
  visiblePages,
  align = 'start',
}: {
  pages: readonly PrintPage[];
  /** Page-range filter (the preview's option): a set of 0-based indexes,
   *  or null for all. */
  visiblePages?: ReadonlySet<number> | null;
  /** #58 — mixed page widths: the PREVIEW centers sheets (Word's
   *  posture); the print container keeps 'start' (ink at the paper
   *  origin — a centered sheet would shift the print). */
  align?: 'start' | 'center';
}) {
  return (
    <div
      data-testid="print-document"
      className="print-document"
      // THE SHEET GAP (the user's spacing report): the pages stack in
      // a column with a visible gutter — the modal's preview consumer
      // styles the gap (PAGE_GAP in the dialog); the PRINT container
      // (Mark 2) sets gap 0 (the @page breaks separate sheets there).
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--print-page-gap, 24px)',
        alignItems: align === 'center' ? 'center' : undefined,
      }}
    >
      {pages.map((page) => {
        if (visiblePages && !visiblePages.has(page.index)) return null;
        return (
          <div
            key={page.index}
            data-testid="print-page"
            data-page-index={page.index}
            className="print-page-sheet"
            style={{
              position: 'relative',
              width: `${page.width}px`,
              height: `${page.height}px`,
              // One shadow ring per sheet — the gutter reads as pages.
              boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
              backgroundColor: '#fff',
              overflow: 'hidden',
              flex: 'none',
            }}
          >
            {page.elements.map((el, i) => (
              <PrintElementView key={elementKey(el, i)} el={el} />
            ))}
          </div>
        );
      })}
    </div>
  );
});