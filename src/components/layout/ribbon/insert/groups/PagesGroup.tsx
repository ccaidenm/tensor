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
 * Insert ▸ Pages. Each button inserts its doc-level container (presence
 * IS enablement) and focuses its end. Active state = container presence.
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