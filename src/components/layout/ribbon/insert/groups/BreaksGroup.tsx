import { RibbonGroup } from '../../../RibbonGroup';
import { PageBreakButton } from '../PageBreakButton';
import { ColumnBreakButton } from '../ColumnBreakButton';
import { SectionBreakButton } from '../SectionBreakButton';
import type { Editor } from '@tiptap/core';

export function BreaksGroup({ editor }: { editor: Editor }) {
  return (
    <RibbonGroup>
      <PageBreakButton editor={editor} />
      {/* #74 COLUMNS — live: the manual column break (the pageBreak
          button's twin). */}
      <ColumnBreakButton editor={editor} />
      {/* #58 — live (was the milestone's placeholder). */}
      <SectionBreakButton editor={editor} />
    </RibbonGroup>
  );
}
