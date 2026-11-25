import { Columns2, FileStack, Maximize, ScrollText } from 'lucide-react';
import { RibbonGroup } from '../../../RibbonGroup';
import { IconButton } from '../../../IconButton';
import { useDocumentStore } from '@/lib/document/store';
import { useViewMode } from '@/lib/document/useViewMode';
import { useFocusStore } from '@/lib/layout/focusStore';
import { useConfigStore } from '@/lib/config/store';
import { getCommand } from '@/lib/commands/registry';

/**
 * View ▸ Display Mode: writes pageSetup.viewMode per document (rides
 * .wpdoc); resolved mode = document choice ?? config default. #101 —
 * "Two Pages" is a config view preference, remembered across flips.
 */
export function DisplayModeGroup() {
  const mode = useViewMode();
  const isPaginated = mode === 'Pages';
  const setPageSetup = useDocumentStore((s) => s.setPageSetup);
  const currentPageSetup = useDocumentStore((s) => s.pageSetup);
  const focusActive = useFocusStore((s) => s.active);
  const pageColumns = useConfigStore((s) => s.config.editor.pageColumns);
  const setPageColumns = useConfigStore((s) => s.setPageColumns);
  const twoPages = pageColumns === 2;

  function toggle() {
    const next = isPaginated ? 'pageless' : 'pages';
    setPageSetup({ ...currentPageSetup, viewMode: next });
  }

  return (
    <RibbonGroup>
      <IconButton
        label="Paginated / Pageless"
        icon={isPaginated ? <FileStack size={16} /> : <ScrollText size={16} />}
        active={isPaginated}
        onClick={toggle}
      />
      <IconButton
        label="Two Pages"
        icon={<Columns2 size={16} />}
        active={twoPages}
        disabled={!isPaginated}
        onClick={() => setPageColumns(twoPages ? 1 : 2)}
      />
      {/* The command re-focuses the editor on exit — the caret survives the toggle. */}
      <IconButton
        label="Focus Mode"
        icon={<Maximize size={16} />}
        active={focusActive}
        onClick={() => {
          void getCommand('toggleFocusMode')?.run();
        }}
      />
      {/* #101 — Reading Mode returns with the reading experience. */}

    </RibbonGroup>
  );
}
