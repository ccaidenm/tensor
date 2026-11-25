import type { CSSProperties } from 'react';
import type { PageGeometry } from '@tensor-editor/engine';
import { useConfigStore } from '@/lib/config/store';
import { useDocumentStore } from '@/lib/document/store';
import { enableRegion } from '@/lib/editor/headerFooterCommands';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';

/**
 * The band CLICK SLOTS — the only DOM the bands own (band content is
 * canvas paint; interaction rides the hidden input view). A slot mounts
 * only where a region has NO container (dblclick to insert); absent
 * means live — clicks fall through to the body machinery. Slots carry
 * `data-hf-which`, never `data-page-index` (pageSheets()' test contract).
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
  /** #58: the page's section's tag (null = unsectioned/uniform). The
   *  slot resolves the RESOLVED band (this section's override ?? the
   *  doc default) — a section inheriting a live default has NO slot,
   *  and dblclick enables the SECTION's own container. */
  sectionId?: string | null;
}) {
  const show = useConfigStore((s) => s.config.editor.showHeadersFooters);
  const settings = useDocumentStore((s) => s.headerFooter);
  if (!show || !editor) return null;

  const differentFirst = settings?.differentFirstPage ?? false;
  const isFirst = pageIndex === 0;
  // The region this page paints. #58: the first class is section 0's
  // alone (the doc's page 0); sections > 0 always paint the default class.
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
      // RESOLUTION: this section's override OR the doc default — an
      // untagged container paints for every inheriting section (the
      // final section's reserved id included).
      if (tag === sectionId || tag === null) found = true;
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