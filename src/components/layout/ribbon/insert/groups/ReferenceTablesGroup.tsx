import { List, BookOpen, Image as ImageIcon, Table2, ScrollText, Library } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import { RibbonGroup } from '@/components/layout/RibbonGroup';
import { IconButton } from '../../../IconButton';
import { insertReferenceTableAtSelection } from '@/lib/editor/ReferenceTableNode';
import { useInsertReferenceTableStore } from '@/components/dialogs/InsertReferenceTableDialog';

/**
 * M-REFS — the Reference Tables group goes LIVE (issue #31): the
 * three shipped collection kinds (ToC opens the depth dialog — the
 * locked ruling; ToF/Index insert directly). "Mark Index Entry" moved
 * to the Insert ▸ Text group (the user's grouping — the line-annotation
 * crowd: link/comment/symbol). The M3 kinds (Tables / Authorities /
 * References) stay disabled — the stub receipt until their scanners
 * exist.
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
      {/* M3 stubs — disabled until their scanners ship. */}
      <IconButton label="Table of Tables" icon={<Table2 size={16} />} onClick={() => {}} disabled />
      <IconButton label="Table of Authorities" icon={<ScrollText size={16} />} onClick={() => { }} disabled />
      <IconButton label="References" icon={<Library size={16} />} onClick={() => {}} disabled />
    </RibbonGroup>
  );
}
