import { PanelBottom, PanelTop } from 'lucide-react';
import { useEditorState } from '@tiptap/react';
import { RibbonGroup } from '@/components/layout/RibbonGroup';
import { IconButton } from '@/components/layout/IconButton';
import { useDocumentStore } from '@/lib/document/store';
import {
  enableRegion,
  hasBandContainer,
} from '@/lib/editor/headerFooterCommands';

/**
 * M-HEADER-FOOTER-2 — Insert ▸ Pages: the Header and Footer entry
 * points. Each button INSERTS its doc-level container (presence IS
 * enablement) and focuses its END — Word's flow: enable → type →
 * click body / Close to leave. Active state = container presence.
 */
export function PagesGroup() {
  const editor = useDocumentStore((s) => s.editor);
  const has = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      header: hasBandContainer(e ?? null, 'header'),
      footer: hasBandContainer(e ?? null, 'footer'),
    }),
  });

  return (
    <RibbonGroup>
      <IconButton
        label="Header"
        icon={<PanelTop size={16} />}
        active={!!has?.header}
        onClick={() => enableRegion(editor, 'header')}
      />
      <IconButton
        label="Footer"
        icon={<PanelBottom size={16} />}
        active={!!has?.footer}
        onClick={() => enableRegion(editor, 'footer')}
      />
    </RibbonGroup>
  );
}