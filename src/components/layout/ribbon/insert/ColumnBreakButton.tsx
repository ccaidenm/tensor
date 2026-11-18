import { SquareSplitHorizontal } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import { IconButton } from '../../IconButton';

/** #74 COLUMNS — the manual column break (the pageBreak button's
 *  twin): forces the following content to open the next flow slot
 *  (the next column, else the next page). */
export function ColumnBreakButton({ editor }: { editor: Editor }) {
  return (
    <IconButton
      label="Column Break"
      icon={<SquareSplitHorizontal size={16} />}
      onClick={() => editor.commands.insertColumnBreak()}
      shortcutId="insertColumnBreak"
    />
  );
}
