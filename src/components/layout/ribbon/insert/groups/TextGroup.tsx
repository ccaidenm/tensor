import { MessageSquarePlus, BookmarkPlus } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { RibbonGroup } from '@/components/layout/RibbonGroup';
import { LinkButton } from '../../LinkButton';
import { IconButton } from '../../../IconButton';
import { getCommand } from '@/lib/commands/registry';
import { SymbolButton } from '../SymbolButton';
import { EquationButton } from '../EquationButton';
import { HorizontalRuleButton } from '../HorizontalRuleButton';

/** Insert ▸ Text. The horizontal rule belongs here too (an inline
 *  content object, not a page break). Mark Index Entry rides the same
 *  command the palette and context menu run. */
export function TextGroup({ editor }: { editor: Editor }) {
  const canMark = useEditorState({
    editor,
    selector: ({ editor: ctx }) => (ctx ? !ctx.state.selection.empty : false),
  });
  return (
    <RibbonGroup showSeparator={false}>
      <LinkButton editor={editor} />
      {/* Always enabled: a bare caret anchors the word it sits in —
          toasts are the fallback, not disabled states. */}
      <IconButton
        label="Comment"
        icon={<MessageSquarePlus size={16} />}
        shortcutId="addComment"
        onClick={() => getCommand('addComment')?.run()}
      />
      <IconButton
        label="Mark Index Entry"
        icon={<BookmarkPlus size={16} />}
        disabled={!canMark}
        onClick={() => editor.chain().focus().setIndexEntry().run()}
      />
      <SymbolButton />
      <EquationButton editor={editor} />
      <HorizontalRuleButton editor={editor} />
    </RibbonGroup>
  );
}
