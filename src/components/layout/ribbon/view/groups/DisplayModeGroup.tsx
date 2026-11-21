import { FileStack, Maximize, ScrollText } from 'lucide-react';
import { RibbonGroup } from '../../../RibbonGroup';
import { IconButton } from '../../../IconButton';
import { useDocumentStore } from '@/lib/document/store';
import { useViewMode } from '@/lib/document/useViewMode';
import { useFocusStore } from '@/lib/layout/focusStore';
import { getCommand } from '@/lib/commands/registry';

/**
 * View > Display Mode: the Paginated/Pageless toggle — the ONE switch
 * for the editor's rendering mode. PER-DOCUMENT (the pageless law):
 * the toggle writes pageSetup.viewMode (marking the document dirty —
 * the setting rides .wpdoc like the rest of pageSetup); the resolved
 * mode (document choice ?? config default) drives both the button's
 * active state and the Editor's routing seam. Paginated is Tensor's
 * default and identity: the button shows ACTIVE when paginated, like
 * GDocs' Print Layout toggle. */
export function DisplayModeGroup() {
  const mode = useViewMode();
  const isPaginated = mode === 'Pages';
  const setPageSetup = useDocumentStore((s) => s.setPageSetup);
  const currentPageSetup = useDocumentStore((s) => s.pageSetup);
  const focusActive = useFocusStore((s) => s.active);

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
      {/* FOCUS MODE — born a disabled stub with the View tab; now wired
          to the ONE command body (the registry's law: the ribbon, F11,
          and the palette share it). The command re-focuses the editor
          on exit — the caret survives the toggle. */}
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
