import { Printer } from 'lucide-react';
import { RibbonGroup } from '../../../RibbonGroup';
import { IconButton } from '../../../IconButton';
import { usePrintPreviewStore } from '@/components/dialogs/PrintPreviewDialog';

export function WindowGroup() {
  return (
    <RibbonGroup showSeparator={false}>
      {/* #101 — Split View returns with multi-window support. */}

      <IconButton
        label="Print Preview"
        icon={<Printer size={16} />}
        onClick={() => usePrintPreviewStore.getState().open()}
        shortcutId='printPreview'
      />
    </RibbonGroup>
  );
}
