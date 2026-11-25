import { memo } from 'react';
import { parseEquation, renderEquation } from '@/lib/equations/render';
import type { PrintElement, PrintPage, PrintWatermark } from './types';

/**
 * #43 — one component renders the walk's pages for both consumers (the
 * preview modal and window.print()), so what previews is what prints.
 * Elements are page-relative px; margins 0 (the contentBox is the frame).
 */

function elementKey(el: PrintElement, i: number): string {
  return `${el.kind}-${i}-${'text' in el ? el.x : 0}-${'top' in el ? el.top : 0}`;
}

/**
 * The page's overlay, painted before the elements (mount order = paint
 * order). resolveWatermark resolved everything at build time; this only
 * positions (the on-screen WatermarkLayer's transform math).
 */
function PrintWatermarkView({ wm }: { wm: PrintWatermark }) {
  const centered: React.CSSProperties = {
    position: 'absolute',
    left: '50%',
    top: '50%',
    transform: `translate(-50%, -50%) rotate(${wm.rotation}deg)`,
    opacity: wm.opacity,
  };
  if (wm.kind === 'text') {
    return (
      <div
        data-testid="print-watermark"
        style={{
          ...centered,
          fontFamily: wm.fontFamily,
          fontSize: `${wm.fontSize}px`,
          fontWeight: 'bold',
          color: wm.color,
          whiteSpace: 'nowrap',
        }}
      >
        {wm.text}
      </div>
    );
  }
  return (
    <img
      data-testid="print-watermark"
      src={wm.src}
      alt=""
      style={{ ...centered, width: `${wm.width}px`, height: `${wm.height}px` }}
    />
  );
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
      // Never KaTeX's red error text, never a silent blank: valid →
      // the KaTeX projection (DOM, shared fonts — crisp in print);
      // invalid/empty → the styled faces with the source visible.
      const empty = el.latex.trim() === '';
      const invalid = !empty && parseEquation(el.latex) !== null;
      const html = empty || invalid ? '' : renderEquation(el.latex);
      return (
        <div
          // .tensor-equation: the shared class stack — the node view,
          // EquationLayer, and measurement probe all render under it,
          // so the measured box is the painted box; without it
          // KaTeX's margins/font sizing mislay the content.
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
      // The sheet gap: the preview styles a visible gutter (PAGE_GAP
      // in the dialog); the print container sets gap 0 (the @page
      // breaks separate sheets there).
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
              // #48 — the page's own background fill (unset = white).
              // The print-time color-adjust lives on the .print-page-
              // sheet CSS (browsers strip inline-adjust spellings at
              // snapshot time).
              backgroundColor: page.background ?? '#fff',
              overflow: 'hidden',
              flex: 'none',
            }}
          >
            {page.watermark && <PrintWatermarkView wm={page.watermark} />}
            {page.elements.map((el, i) => (
              <PrintElementView key={elementKey(el, i)} el={el} />
            ))}
          </div>
        );
      })}
    </div>
  );
});