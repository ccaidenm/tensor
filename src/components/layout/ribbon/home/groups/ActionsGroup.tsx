import type { Editor } from '@tiptap/core';
import { RibbonGroup } from '@/components/layout/RibbonGroup';
import { LinkButton } from '../../LinkButton';
import { ClearFormattingButton } from '../ClearFormattingButton';

export function ActionsGroup({ editor }: { editor: Editor }) {
  return (
    <RibbonGroup showSeparator={false}>
      <LinkButton editor={editor} />
      {/* #101 — the stale disabled "Insert Comment" is gone: the LIVE
          one lives in the selection toolbar (comments shipped). */}
      <ClearFormattingButton editor={editor} />
    </RibbonGroup>
  );
}
