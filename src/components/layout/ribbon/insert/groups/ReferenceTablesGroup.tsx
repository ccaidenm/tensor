import { List, BookOpen, Image as ImageIcon } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import { RibbonGroup } from '@/components/layout/RibbonGroup';
import { IconButton } from '../../../IconButton';
import { insertReferenceTableAtSelection } from '@/lib/editor/ReferenceTableNode';
import { useInsertReferenceTableStore } from '@/components/dialogs/InsertReferenceTableDialog';

/**
 * #31 — the three shipped collection kinds: ToC opens the depth
 * dialog; Table of Figures / Index insert directly.
 */
export function ReferenceTablesGroup({ editor }: { editor: Editor }) {
  const openTocDialog = useInsertReferenceTableStore((s) => s.open);

  return (
    <RibbonGroup>
      <IconButton
        label="Table of Contents"
        icon={<List size={16} />}
        onClick={openTocDialog}
      />
      <IconButton
        label="Table of Figures"
        icon={<ImageIcon size={16} />}
        onClick={() => insertReferenceTableAtSelection(editor, 'figures')}
      />
      <IconButton
        label="Index"
        icon={<BookOpen size={16} />}
        onClick={() => insertReferenceTableAtSelection(editor, 'index')}
      />
      {/* #101 — the unshipped kinds (Tables/Authorities/References) return with their scanners. */}    </RibbonGroup>
  );
}
