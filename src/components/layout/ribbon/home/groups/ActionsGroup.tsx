import type { Editor } from '@tiptap/core';
import { RibbonGroup } from '@/components/layout/RibbonGroup';
import { LinkButton } from '../../LinkButton';
import { ClearFormattingButton } from '../ClearFormattingButton';

export function ActionsGroup({ editor }: { editor: Editor }) {
  return (
    <RibbonGroup showSeparator={false}>
      <LinkButton editor={editor} />
      {/* #101 — the live Insert Comment lives in the selection toolbar, not here. */}
      <ClearFormattingButton editor={editor} />
    </RibbonGroup>
  );
}
