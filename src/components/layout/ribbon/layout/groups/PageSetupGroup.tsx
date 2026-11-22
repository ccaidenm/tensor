import { RectangleHorizontal, RectangleVertical, PaintBucket, Proportions } from 'lucide-react';
import { RibbonGroup } from '../../../RibbonGroup';
import { IconButton } from '../../../IconButton';
import { ColorPickerButton } from '../../ColorPickerButton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDocumentStore } from '@/lib/document/store';
import { useDocumentPropertiesStore } from '@/lib/document/propertiesStore';
import { useViewMode } from '@/lib/document/useViewMode';
import { PAGE_SIZES } from '@/lib/document/pageSetup';
import { applyPageSetup } from '@/lib/editor/sections';

/**
 * #58 — the scoped Page Setup dialog entrance plus document-wide quick
 * controls; writes merge into every section + the store in one commit.
 * In pageless mode only the paginated quick controls disable.
 */
export function PageSetupGroup() {
  const pageSetup = useDocumentStore((s) => s.pageSetup);
  const isLandscape = pageSetup.orientation === 'landscape';
  const isPageless = useViewMode() !== 'Pages';

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
      {/* #58 — the Page Setup entrance: paper, orientation, margins with an Apply-to scope. */}
      <IconButton
        label="Page Setup"
        icon={<Proportions size={16} />}
        onClick={() => useDocumentPropertiesStore.getState().openPageSetup()}
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
                {/* The label renders from the store's value (base-ui's
                    Select.Value re-resolution quirk). */}
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

      {/* #58 — document-wide: the color merges into every section +
          the store; per-section colors live in the dialog. */}
      <ColorPickerButton
        label="Page Background (whole document)"
        icon={<PaintBucket size={16} />}
        resetLabel="Default"
        resetColor="#ffffff"
        defaultColor={pageSetup.pageColor || '#ffffff'}
        onChange={(color) =>
          applyPageSetup(
            'document',
            { ...pageSetup, pageColor: color ?? '' },
            { pageColor: color ?? '' },
          )
        }
      />
    </RibbonGroup>
  );
}
