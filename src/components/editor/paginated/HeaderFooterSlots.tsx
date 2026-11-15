import type { CSSProperties } from 'react';
import type { PageGeometry } from '@tensor-editor/engine';
import { useConfigStore } from '@/lib/config/store';
import { useDocumentStore } from '@/lib/document/store';
import { enableRegion } from '@/lib/editor/headerFooterCommands';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';

/**
 * M-HEADER-FOOTER-2 — the band CLICK SLOTS: the only DOM the bands
 * still own. The band CONTENT is canvas paint (engine band lines —
 * the unified pipeline), interaction rides the ONE hidden input view
 * (hitTest's band-strip rule), so this component mounts a slot ONLY
 * where a region has NO container (dblclick to insert — Word: "double
 * -click in the header area to add one"). Slots carry
 * `data-hf-which` — never `data-page-index` (that attribute is
 * `pageSheets()`'s test contract).
 *
 * An ABSENT slot means the region is live: clicks pass through to
 * the stack (hitTest routes them), dblclick selects words — all of
 * it the standard body machinery, one PM doc.
 */
export function HeaderFooterSlots({
  pageIndex,
  geometry,
  editor,
  sectionId = null,
}: {
  pageIndex: number;
  geometry: PageGeometry;
  editor: Editor | null;
  /** #58 — the page's section's tag (null = unsectioned/uniform): the
   *  slot resolves the RESOLVED band (this section's override ?? the
   *  doc default) — a section inheriting a live default has NO slot
   *  (its strip is live), and dblclick enables the SECTION's own
   *  container (Word: editing an inherited header unlinks it). */
  sectionId?: string | null;
}) {
  const show = useConfigStore((s) => s.config.editor.showHeadersFooters);
  const settings = useDocumentStore((s) => s.headerFooter);
  if (!show || !editor) return null;

  const differentFirst = settings?.differentFirstPage ?? false;
  const isFirst = pageIndex === 0;
  // The region this page paints (first vs default containers). #58:
  // the first class is section 0's alone (the doc's page 0); sections
  // > 0 always paint the default class.
  const wants: ('header' | 'footer')[] = [];
  const variantFor = (which: 'header' | 'footer'): 'default' | 'first' => {
    void which;
    // The class depends only on the PAGE (the doc's page 0 under
    // differentFirstPage) — a section 0 override can tag EITHER class.
    return isFirst && differentFirst ? 'first' : 'default';
  };
  const hasResolvedBand = (which: 'header' | 'footer'): boolean => {
    const name = which === 'header' ? 'headerBlock' : 'footerBlock';
    const variant = variantFor(which);
    let found = false;
    editor.state.doc.forEach((node: PMNode) => {
      if (found || node.type.name !== name) return;
      const v = node.attrs.variant === 'first' ? 'first' : 'default';
      if (v !== variant) return;
      const tag = typeof node.attrs.sectionId === 'string' ? node.attrs.sectionId : null;
      // The RESOLUTION: this section's override OR the doc default.
      if (sectionId ? tag === sectionId : tag === null) found = true;
    });
    return found;
  };
  if (!hasResolvedBand('header')) wants.push('header');
  if (!hasResolvedBand('footer')) wants.push('footer');
  if (wants.length === 0) return null;

  const stripStyle = (which: 'header' | 'footer'): CSSProperties =>
    which === 'header'
      ? { top: 0, height: Math.max(geometry.contentBox.y, 1) }
      : {
          top: geometry.contentBox.y + geometry.contentBox.height,
          height: Math.max(
            geometry.size.height - (geometry.contentBox.y + geometry.contentBox.height),
            1,
          ),
        };

  return (
    <>
      {wants.map((which) => (
        <div
          key={which}
          data-testid={`hf-slot-${which}`}
          data-hf-which={which}
          className="absolute z-20 cursor-text"
          style={{
            left: geometry.contentBox.x,
            width: geometry.contentBox.width,
            ...stripStyle(which),
          }}
          onDoubleClick={() => enableRegion(editor, which, variantFor(which), sectionId)}
        />
      ))}
    </>
  );
}