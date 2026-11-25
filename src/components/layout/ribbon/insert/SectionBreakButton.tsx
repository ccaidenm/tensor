import { SeparatorHorizontal } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import { IconButton } from '../../IconButton';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

/**
 * #58 — the Section Break insert. Continuous sections share the page,
 * upgrading to a page start when geometry differs; the command seeds
 * the new break with the store's pageSetup (insert changes nothing visually).
 */
export function SectionBreakButton({ editor }: { editor: Editor }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <IconButton
            label="Section Break"
            icon={<SeparatorHorizontal size={16} />}
            shortcutId="insertSectionBreak"
            onClick={() => {}}
          />
        }
      />
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuItem
          onClick={() => editor.commands.insertSectionBreak(undefined, 'nextPage')}
        >
          <div className="flex flex-col">
            <span>Next Page</span>
            <span className="text-xs text-muted-foreground">
              The next section starts on a fresh page.
            </span>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => editor.commands.insertSectionBreak(undefined, 'continuous')}
        >
          <div className="flex flex-col">
            <span>Continuous (same page)</span>
            <span className="text-xs text-muted-foreground">
              The sections share the page — same page setup keeps the flow.
            </span>
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
