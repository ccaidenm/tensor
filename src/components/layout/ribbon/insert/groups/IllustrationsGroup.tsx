import { Image as ImageIcon } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import { RibbonGroup } from '@/components/layout/RibbonGroup';
import { IconButton } from '../../../IconButton';
import { insertImageFromPicker } from '@/lib/media/insert';
import { TableGridPicker } from '../TableGridPicker';

export function IllustrationsGroup({ editor }: { editor: Editor }) {
  return (
    <RibbonGroup>
      {/* OS picker → binary read → the one insertion pipeline. */}
      <IconButton
        label="Image"
        icon={<ImageIcon size={16} />}
        onClick={() => void insertImageFromPicker(editor)}
      />
      <TableGridPicker />
      {/* #101 — Drawing returns with the drawing canvas. */}

    </RibbonGroup>
  );
}
