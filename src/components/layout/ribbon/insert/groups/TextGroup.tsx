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

/** Insert ▸ Text: link/comment/symbol/equation — plus the horizontal
 *  rule (moved from Pages when Header/Footer split into their own
 *  group; the rule is an inline content object, this is its crowd).
 *  M-REFS: "Mark Index Entry" lives here too (the user's grouping —
 *  the line-annotation crowd), riding the SAME command the palette
 *  and context menu run. */
export function TextGroup({ editor }: { editor: Editor }) {
  const canMark = useEditorState({
    editor,
    selector: ({ editor: ctx }) => (ctx ? !ctx.state.selection.empty : false),
  });
  return (
    <RibbonGroup showSeparator={false}>
      <LinkButton editor={editor} />
      {/* #COMMENTS — dispatches the ONE command body (the registry's
          law: the ribbon, the floating toolbar, Ctrl+Alt+M, and the
          palette share EDITOR_COMMAND_MAP.addComment). ALWAYS ENABLED
          (the user's ruling): a bare caret anchors the word it sits
          in — the command body's toasts are the loud fallbacks, not
          disabled states. */}
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
