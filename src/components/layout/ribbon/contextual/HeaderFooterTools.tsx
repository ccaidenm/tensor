import { ArrowDownToLine, ArrowUpToLine, Hash, Numbers, PanelTop, X } from 'lucide-react';
import { useEditorState } from '@tiptap/react';
import { RibbonGroup } from '@/components/layout/RibbonGroup';
import { IconButton } from '@/components/layout/IconButton';
import { useDocumentStore } from '@/lib/document/store';
import {
  blurToBody,
  findBandContainer,
  focusBand,
  setDifferentFirstPage,
} from '@/lib/editor/headerFooterCommands';
import { insertPageField } from '@/lib/editor/PageFieldNode';

/**
 * M-HEADER-FOOTER-2 — the Header & Footer contextual tab's groups
 * (surfaced while the selection sits in a band container). Formatting
 * is DELIBERATELY absent: the Home tab's groups work on band content
 * unchanged — ONE editor, one formatting system.
 */
export function HeaderFooterTools() {
  const editor = useDocumentStore((s) => s.editor);
  const settings = useDocumentStore((s) => s.headerFooter);
  const inBand = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) return { inBand: false, first: false };
      const { $from } = e.state.selection;
      let inBand = false;
      let variant: 'default' | 'first' = 'default';
      for (let d = $from.depth; d > 0; d--) {
        const name = $from.node(d).type.name;
        if (name === 'headerBlock' || name === 'footerBlock') {
          inBand = true;
          variant = $from.node(d).attrs.variant === 'first' ? 'first' : 'default';
        }
      }
      return { inBand, first: inBand && variant === 'first' };
    },
  });

  const differentFirstPage = settings?.differentFirstPage ?? false;

  const goTo = (which: 'header' | 'footer') => {
    if (!editor) return;
    const first = differentFirstPage;
    // Under differentFirstPage, focus the FIRST-page region when
    // possible (falling back to whatever exists) — Word's flow.
    const target =
      (findBandContainer(editor, which, first ? 'first' : 'default') ??
        findBandContainer(editor, which, first ? 'default' : 'first')) ??
      null;
    if (target) {
      const variant = target.node.attrs.variant === 'first' ? 'first' : 'default';
      focusBand(editor, which, variant);
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
      {/* M-PAGEFIELD: the page-number fields — enabled while the
          selection sits in a band (the caret is the insertion point). */}
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
