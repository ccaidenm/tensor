import { MessageSquarePlus } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import { RibbonGroup } from '@/components/layout/RibbonGroup';
import { LinkButton } from '../../LinkButton';
import { IconButton } from '../../../IconButton';
import { SymbolButton } from '../SymbolButton';
import { EquationButton } from '../EquationButton';
import { HorizontalRuleButton } from '../HorizontalRuleButton';

/** Insert ▸ Text: link/comment/symbol/equation — plus the horizontal
 *  rule (moved from Pages when Header/Footer split into their own
 *  group; the rule is an inline content object, this is its crowd). */
export function TextGroup({ editor }: { editor: Editor }) {
  return (
    <RibbonGroup showSeparator={false}>
      <LinkButton editor={editor} />
      <IconButton
        label="Comment"
        icon={<MessageSquarePlus size={16} />}
        onClick={() => {}}
        disabled
      />
      <SymbolButton editor={editor} />
      <EquationButton editor={editor} />
      <HorizontalRuleButton editor={editor} />
    </RibbonGroup>
  );
}
