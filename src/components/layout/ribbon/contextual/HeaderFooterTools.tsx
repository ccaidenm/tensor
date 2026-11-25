import { ArrowDownToLine, ArrowUpToLine, Hash, Link2, Link2Off, Numbers, PanelTop, X } from 'lucide-react';
import { useEditorState } from '@tiptap/react';
import { RibbonGroup } from '@/components/layout/RibbonGroup';
import { IconButton } from '@/components/layout/IconButton';
import { useDocumentStore } from '@/lib/document/store';
import {
  blurToBody,
  relinkBand,
  findBandContainer,
  focusBand,
  setDifferentFirstPage,
} from '@/lib/editor/headerFooterCommands';
import { insertPageField } from '@/lib/editor/PageFieldNode';

/**
 * The Header & Footer contextual tab. Formatting is deliberately absent:
 * the Home tab's groups work on band content unchanged.
 */
export function HeaderFooterTools() {
  const editor = useDocumentStore((s) => s.editor);
  const settings = useDocumentStore((s) => s.headerFooter);
  const inBand = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) return { inBand: false, first: false, sectionId: null, which: null };
      const { $from } = e.state.selection;
      let inBand = false;
      let variant: 'default' | 'first' = 'default';
      let sectionId: string | null = null;
      let which: 'header' | 'footer' | null = null;
      for (let d = $from.depth; d > 0; d--) {
        const name = $from.node(d).type.name;
        if (name === 'headerBlock' || name === 'footerBlock') {
          inBand = true;
          variant = $from.node(d).attrs.variant === 'first' ? 'first' : 'default';
          which = name === 'headerBlock' ? 'header' : 'footer';
          // #58 — the working section: the tag rides with the selection
          // (Go to Header/Footer stays in it).
          const tag = $from.node(d).attrs.sectionId;
          sectionId = typeof tag === 'string' && tag ? tag : null;
        }
      }
      return { inBand, first: inBand && variant === 'first', sectionId, which };
    },
  });
  const sectionId = inBand?.sectionId ?? null;

  const differentFirstPage = settings?.differentFirstPage ?? false;

  const goTo = (which: 'header' | 'footer') => {
    if (!editor) return;
    const first = differentFirstPage;
    // #58: the working section's containers come first (jumping to the
    // doc default would yank the user out of their section).
    const workingSection = sectionId ?? undefined;
    const target =
      (workingSection
        ? findBandContainer(editor, which, first ? 'first' : 'default', workingSection) ??
          findBandContainer(editor, which, first ? 'default' : 'first', workingSection)
        : null) ??
      (findBandContainer(editor, which, first ? 'first' : 'default') ??
        findBandContainer(editor, which, first ? 'default' : 'first')) ??
      null;
    if (target) {
      const variant = target.node.attrs.variant === 'first' ? 'first' : 'default';
      const tag = typeof target.node.attrs.sectionId === 'string' ? target.node.attrs.sectionId : null;
      focusBand(editor, which, variant, tag ?? undefined);
    }
  };

  return (
    <>
      <RibbonGroup>
        <IconButton
          label="Different First Page"
          icon={<PanelTop size={16} />}
          active={differentFirstPage}
          onClick={() => setDifferentFirstPage(!differentFirstPage)}
        />
      </RibbonGroup>
      <RibbonGroup>
        {/* #58 — Word's "Link to Previous": the caret in a section's own
            override means unlinked; re-linking deletes the override (its
            custom content is lost — one undo restores it). */}
        {inBand?.inBand && inBand.sectionId != null && inBand.which && editor && (
          <IconButton
            label="Link to Previous (inherit the document's header/footer)"
            icon={<Link2 size={16} />}
            active={false}
            onClick={() =>
              relinkBand(editor, inBand.which!, inBand.first ? 'first' : 'default', inBand.sectionId!)
            }
          />
        )}
        {inBand?.inBand && inBand.sectionId == null && inBand.which && (
          <IconButton
            label="This is the document's header/footer (every inheriting section) — double-click a section's strip to give it its own"
            icon={<Link2Off size={16} />}
            active
            disabled
            onClick={() => {}}
          />
        )}
        <IconButton
          label="Go to Header"
          icon={<ArrowUpToLine size={16} />}
          onClick={() => goTo('header')}
        />
        <IconButton
          label="Go to Footer"
          icon={<ArrowDownToLine size={16} />}
          onClick={() => goTo('footer')}
        />
      </RibbonGroup>
      {/* Page-number fields — enabled only in a band (the caret is the insertion point). */}
      <RibbonGroup>
        <IconButton
          label="Insert Page Number"
          icon={<Hash size={16} />}
          disabled={!inBand?.inBand}
          onClick={() => editor && insertPageField(editor, 'page')}
        />
        <IconButton
          label="Insert Total Pages"
          icon={<Numbers size={16} />}
          disabled={!inBand?.inBand}
          onClick={() => editor && insertPageField(editor, 'pages')}
        />
      </RibbonGroup>
      <RibbonGroup>
        <IconButton
          label="Close Header & Footer"
          icon={<X size={16} />}
          active={!!inBand?.inBand}
          onClick={() => blurToBody(editor)}
        />
      </RibbonGroup>
    </>
  );
}
