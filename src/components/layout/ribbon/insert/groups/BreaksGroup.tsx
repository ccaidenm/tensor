import { RibbonGroup } from '../../../RibbonGroup';
import { PageBreakButton } from '../PageBreakButton';
import { ColumnBreakButton } from '../ColumnBreakButton';
import { SectionBreakButton } from '../SectionBreakButton';
import type { Editor } from '@tiptap/core';

export function BreaksGroup({ editor }: { editor: Editor }) {
  return (
    <RibbonGroup>
      <PageBreakButton editor={editor} />
      <ColumnBreakButton editor={editor} />
      <SectionBreakButton editor={editor} />
    </RibbonGroup>
  );
}
