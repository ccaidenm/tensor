import { Image as ImageIcon } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import { RibbonGroup } from '@/components/layout/RibbonGroup';
import { IconButton } from '../../../IconButton';
import { insertImageFromPicker } from '@/lib/media/insert';
import { TableGridPicker } from '../TableGridPicker';

export function IllustrationsGroup({ editor }: { editor: Editor }) {
  return (
    <RibbonGroup>
      {/* M-IMAGES-1: the Insert > Image path goes live — OS picker →
          binary read → the ONE insertion pipeline. */}
      <IconButton
        label="Image"
        icon={<ImageIcon size={16} />}
        onClick={() => void insertImageFromPicker(editor)}
      />
      {/* M-TABLES: the grid picker replaces the disabled stub — hover to
          size, click to insert; "Insert Table…" opens the exact-dimension
          dialog. */}
      <TableGridPicker />
      {/* #101 — Drawing returns with the drawing canvas. */}

    </RibbonGroup>
  );
}
