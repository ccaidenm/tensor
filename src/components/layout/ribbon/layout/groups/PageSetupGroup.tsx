import { RectangleHorizontal, RectangleVertical, PaintBucket, Proportions } from 'lucide-react';
import { RibbonGroup } from '../../../RibbonGroup';
import { IconButton } from '../../../IconButton';
import { ColorPickerButton } from '../../ColorPickerButton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDocumentStore } from '@/lib/document/store';
import { useDocumentPropertiesStore } from '@/lib/document/propertiesStore';
import { useConfigStore } from '@/lib/config/store';
import { PAGE_SIZES } from '@/lib/document/pageSetup';
import { applyPageSetup } from '@/lib/editor/sections';

/**
 * Layout tab > Page Setup: the ONE dialog entrance (paper/orientation/
 * margins with an Apply-to scope — #58), plus the DOCUMENT-WIDE quick
 * controls (orientation toggle, paper size) and the document-level page
 * background.
 *
 * #58 THE RIBBON'S SCOPE: the quick controls are DOCUMENT-WIDE — a
 * size dropdown at the top of the Layout tab reads as "the paper this
 * document prints on", and predictability beats cleverness (the dialog
 * is the scoped surface: this section / this point forward). The write
 * merges a PARTIAL into every section's setup + the store in ONE
 * commit (applyPageSetup('document', …)).
 *
 * PAGELESS MODE disables — but never removes — the PAGE GEOMETRY
 * controls: they are paginated facts with no pageless meaning. Page
 * Background stays LIVE in both modes (one setting, two surfaces).
 */
export function PageSetupGroup() {
  const pageSetup = useDocumentStore((s) => s.pageSetup);
  const isLandscape = pageSetup.orientation === 'landscape';
  const isPageless = useConfigStore((s) => s.config.editor.defaultPageLayout) !== 'Pages';

  function handlePageSizeChange(value: string) {
    if (isPageless) return;
    if (value === 'custom') {
      useDocumentPropertiesStore.getState().openCustomSize();
      return;
    }
    // Document-wide: the preset merges into every section + the store.
    applyPageSetup('document', { ...pageSetup, pageSize: value }, { pageSize: value });
  }

  function toggleOrientation() {
    if (isPageless) return;
    const orientation = isLandscape ? 'portrait' : 'landscape';
    applyPageSetup('document', { ...pageSetup, orientation }, { orientation });
  }

  return (
    <RibbonGroup>
      {/* THE ONE Page Setup entrance (#58): paper, orientation, and
          margins with an Apply-to scope (whole document / this section
          / this point forward) — the commit-gated dialog. */}
      <IconButton
        label="Page Setup"
        icon={<Proportions size={16} />}
        onClick={() => useDocumentPropertiesStore.getState().openPageSetup()}
        disabled={isPageless}
      />

      {/* DOCUMENT-WIDE quick controls. */}
      <IconButton
        label="Orientation (whole document)"
        icon={isLandscape ? <RectangleHorizontal size={16} /> : <RectangleVertical size={16} />}
        onClick={toggleOrientation}
        disabled={isPageless}
      />

      <Tooltip>
        <TooltipTrigger
          render={
            <Select
              value={pageSetup.pageSize}
              disabled={isPageless}
              onValueChange={(value) => {
                if (value != null) handlePageSizeChange(value);
              }}
            >
              <SelectTrigger aria-label="Paper Size (whole document)" className="mx-1.5 h-8 w-32 gap-1.5 text-sm">
                <Proportions size={14} className="shrink-0 text-muted-foreground" />
                {/* The label renders from the store's value (the
                    base-ui Select.Value re-resolution quirk — the
                    dialog's lesson). */}
                <SelectValue>
                  {pageSetup.pageSize === 'custom'
                    ? 'Custom…'
                    : pageSetup.pageSize}
                </SelectValue>
              </SelectTrigger>
              <SelectContent
                alignItemWithTrigger={false}
                className="w-64"
                >
                {Object.entries(PAGE_SIZES).map(([key, preset]) => (
                  <SelectItem key={key} value={key}>
                    {key} <span className="text-muted-foreground">({preset.inches})</span>
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom…</SelectItem>
              </SelectContent>
            </Select>
          }
        />
        <TooltipContent>Paper Size (whole document)</TooltipContent>
      </Tooltip>

      <ColorPickerButton
        label="Page Background"
        icon={<PaintBucket size={16} />}
        resetLabel="Default"
        resetColor="#ffffff"
        defaultColor={pageSetup.pageColor || '#ffffff'}
        onChange={(color) => useDocumentStore.getState().setPageSetup({ ...pageSetup, pageColor: color ?? '' })}
      />
    </RibbonGroup>
  );
}
