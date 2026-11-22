import { useEditorState } from '@tiptap/react';
import { Link2 } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import { IconButton } from '@/components/layout/IconButton';
import { useLinkEditorStore } from '@/lib/editor/linkEditorStore';

/**
 * A thin trigger: opens the shared link editor (LinkBubble) rather than
 * maintaining its own popover; if the cursor is on an existing link it
 * opens the rich edit view instead (see useLinkBubble.ts).
 */
export function LinkButton({ editor }: { editor: Editor }) {
  const isActive = useEditorState({
    editor,
    selector: (ctx) => ctx.editor?.isActive('link') ?? false,
  });

  return (
    <IconButton
      label="Hyperlink"
      icon={<Link2 size={16} />}
      active={isActive}
      onClick={() => useLinkEditorStore.getState().requestInsert()}
      shortcutId="insertLink"
    />
  );
}
