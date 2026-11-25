import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RibbonIconInput } from '@/components/layout/ribbon/RibbonIconInput';
import { useDocumentPropertiesStore } from '@/lib/document/propertiesStore';
import { useDocumentStore } from '@/lib/document/store';
import { useConfigStore } from '@/lib/config/store';
import { applyPageSetup } from '@/lib/editor/sections';
import {
  MEASUREMENT_UNITS,
  PAGE_SIZES,
  FALLBACK_PAGE_SIZE,
  findMatchingPreset,
  formatPt,
  parseUnitToPt,
  type MeasurementUnit,
} from '@/lib/document/pageSetup';

// 2"–52" in points — the acceptable custom page range.
const MIN_PT = 2 * 72;
const MAX_PT = 52 * 72;

// Custom page size — the store holds POINTS; this dialog converts at the
// boundary. A matching preset wins over 'custom'. #58: the 'document'
// target applies Done document-wide; 'draft' hands the pick back via
// customSizeOnPick (Cancel changes nothing).
export function CustomPageSizeDialog() {
  const isOpen = useDocumentPropertiesStore((s) => s.customSizeIsOpen);
  const closeCustomSize = useDocumentPropertiesStore((s) => s.closeCustomSize);
  const target = useDocumentPropertiesStore((s) => s.customSizeTarget);
  const seed = useDocumentPropertiesStore((s) => s.customSizeSeed);
  const onPick = useDocumentPropertiesStore((s) => s.customSizeOnPick);
  const pageSetup = useDocumentStore((s) => s.pageSetup);
  const unit = useConfigStore((s) => s.config.editor.measurementUnit);
  const setMeasurementUnit = useConfigStore((s) => s.setMeasurementUnit);

  const [draft, setDraft] = useState({ width: '', height: '' });

  useEffect(() => {
    if (!isOpen) return;
    // The draft target seeds from the caller's pick (possibly a custom
    // size mid-edit); the document target seeds from the store.
    const source = (target === 'draft' && seed) || pageSetup;
    const preset = PAGE_SIZES[source.pageSize] ?? PAGE_SIZES[FALLBACK_PAGE_SIZE];
    const widthPt = source.customWidth ?? preset.width;
    const heightPt = source.customHeight ?? preset.height;
    setDraft({ width: formatPt(widthPt, unit), height: formatPt(heightPt, unit) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  function handleUnitChange(next: MeasurementUnit) {
    setDraft((d) => {
      const wPt = parseUnitToPt(d.width, unit);
      const hPt = parseUnitToPt(d.height, unit);
      return {
        width: wPt != null ? formatPt(wPt, next) : d.width,
        height: hPt != null ? formatPt(hPt, next) : d.height,
      };
    });
    setMeasurementUnit(next);
  }

  function handleDone() {
    const wPt = parseUnitToPt(draft.width, unit);
    const hPt = parseUnitToPt(draft.height, unit);
    const valid = wPt != null && hPt != null && wPt >= MIN_PT && wPt <= MAX_PT && hPt >= MIN_PT && hPt <= MAX_PT;
    if (target === 'draft' && onPick) {
      // The Page Setup dialog's draft: hand the pick back (invalid
      // entries keep the seeded values — the caller re-renders them).
      if (valid) {
        const preset = findMatchingPreset(wPt!, hPt!);
        onPick(
          preset
            ? { pageSize: preset }
            : { pageSize: 'custom', customWidth: wPt!, customHeight: hPt! },
        );
      }
      closeCustomSize();
      return;
    }
    if (valid) {
      const preset = findMatchingPreset(wPt!, hPt!);
      // #58 — document-wide: the size merges into every section + the store in one commit.
      if (preset) {
        applyPageSetup('document', { ...pageSetup, pageSize: preset }, { pageSize: preset });
      } else {
        applyPageSetup(
          'document',
          { ...pageSetup, pageSize: 'custom', customWidth: wPt!, customHeight: hPt! },
          { pageSize: 'custom', customWidth: wPt!, customHeight: hPt! },
        );
      }
    }
    closeCustomSize();
  }

  const suffix = MEASUREMENT_UNITS[unit].suffix;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) closeCustomSize(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Custom Page Size</DialogTitle>
          <DialogDescription>
            Page dimensions in {MEASUREMENT_UNITS[unit].label.toLowerCase()}.
          </DialogDescription>
        </DialogHeader>

        {/* One TooltipProvider so the tooltips carry between the two fields. */}
        <TooltipProvider delay={300} closeDelay={0}>
          <div className="flex items-end justify-between gap-1.5">
            <RibbonIconInput
              label="Width"
              ariaLabel="Page width"
              icon={<span className="text-[10px] font-medium">W</span>}
              value={Number(draft.width) || 0}
              onCommit={(n) => setDraft((d) => ({ ...d, width: String(n) }))}
              min={2}
              showSteppers
              stepAmount={0.25}
              width="w-full"
              suffix={suffix}
            />
            <RibbonIconInput
              label="Height"
              ariaLabel="Page height"
              icon={<span className="text-[10px] font-medium">H</span>}
              value={Number(draft.height) || 0}
              onCommit={(n) => setDraft((d) => ({ ...d, height: String(n) }))}
              min={2}
              showSteppers
              stepAmount={0.25}
              width="w-full"
              suffix={suffix}
            />
          </div>
        </TooltipProvider>

        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Units</span>
          <Select value={unit} onValueChange={(v) => { if (v != null) handleUnitChange(v); }}>
            <SelectTrigger className="h-8 w-40 text-sm" aria-label="Measurement units">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(MEASUREMENT_UNITS).map(([key, meta]) => (
                <SelectItem key={key} value={key}>{meta.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <DialogFooter>
          <Button size="sm" variant="outline" onClick={closeCustomSize}>Cancel</Button>
          <Button size="sm" onClick={handleDone}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
