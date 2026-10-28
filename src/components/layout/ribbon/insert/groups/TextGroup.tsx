import { MessageSquarePlus, BookmarkPlus } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { RibbonGroup } from '@/components/layout/RibbonGroup';
import { LinkButton } from '../../LinkButton';
import { IconButton } from '../../../IconButton';
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
      <IconButton
        label="Comment"
        icon={<MessageSquarePlus size={16} />}
        onClick={() => {}}
        disabled
      />
      <IconButton
        label="Mark Index Entry"
        icon={<BookmarkPlus size={16} />}
        disabled={!canMark}
        onClick={() => editor.chain().focus().setIndexEntry().run()}
      />
      <SymbolButton editor={editor} />
      <EquationButton editor={editor} />
      <HorizontalRuleButton editor={editor} />
    </RibbonGroup>
  );
}
