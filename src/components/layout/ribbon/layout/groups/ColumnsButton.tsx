import { useState } from 'react';
import { ChevronDown, Columns3, SlidersHorizontal } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDocumentStore } from '@/lib/document/store';
import { useDocumentPropertiesStore } from '@/lib/document/propertiesStore';
import { useViewMode } from '@/lib/document/useViewMode';
import { applyPageSetup } from '@/lib/editor/sections';
import type { ColumnSetup } from '@/lib/document/pageSetup';

/**
 * #74 COLUMNS — the Layout tab's Columns entrance: the QUICK PRESET
 * popover (Word's preset row — One/Two/Three/Left/Right) over the
 * "More columns…" dialog opening. The presets are DOCUMENT-WIDE (the
 * PageSetupGroup quick-controls law: the Layout tab's row reads as
 * "this document flows like this"; predictability beats cleverness —
 * the dialog is the scoped surface). One preset = ONE
 * applyPageSetup('document') commit = one undo step.
 *
 * PAGELESS MODE disables (never hides — the geometry controls'
 * treatment): columns are paginated facts with no pageless meaning.
 */

/** The preset's setup spelling (widths in pt — the engine consumes
 *  them as relative weights; Left = narrow left 1:2, Right = 2:1). */
const PRESETS: { label: string; columns: () => ColumnSetup | null }[] = [
  { label: 'One', columns: () => null },
  { label: 'Two', columns: () => ({ count: 2 }) },
  { label: 'Three', columns: () => ({ count: 3 }) },
  { label: 'Left', columns: () => ({ count: 2, widths: [1, 2] }) },
  { label: 'Right', columns: () => ({ count: 2, widths: [2, 1] }) },
];

export function ColumnsButton() {
  const pageSetup = useDocumentStore((s) => s.pageSetup);
  const isPageless = useViewMode() !== 'Pages';
  const [open, setOpen] = useState(false);
  // The ACTIVE preset highlight (a uniform spec matches One/Two/Three;
  // unequal two-column matches Left/Right; anything else matches none).
  const active = (() => {
    const spec = pageSetup.columns;
    if (!spec) return 'One';
    if (spec.widths && spec.count === 2) {
      const w = spec.widths;
      if (w[0]! < w[1]!) return 'Left';
      if (w[0]! > w[1]!) return 'Right';
      return null;
    }
    if (spec.count === 2) return 'Two';
    if (spec.count === 3) return 'Three';
    return null;
  })();

  function applyPreset(columns: ColumnSetup | null) {
    // Document-wide: the spec merges into every section + the store in
    // ONE commit (the quick-controls law; null clears — one column).
    applyPageSetup('document', { ...pageSetup, columns }, { columns });
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* The Line Spacing button's shape (the Home tab's dropdown
          trigger): icon + chevron in one ghost button, the tooltip
          riding the same element. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="columns-button"
                  disabled={isPageless}
                  className="h-8 gap-0.5 rounded-md px-1.5"
                >
                  <Columns3 size={16} />
                  <span className="flex h-4 w-4 items-center justify-center text-muted-foreground">
                    <ChevronDown size={12} />
                  </span>
                </Button>
              }
            />
          }
        />
        <TooltipContent>Columns</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-44 p-1">
        <div className="flex flex-col" role="group" aria-label="Column presets">
          {PRESETS.map((preset) => (
            <Button
              key={preset.label}
              size="sm"
              variant={active === preset.label ? 'secondary' : 'ghost'}
              className="h-7 justify-start"
              aria-pressed={active === preset.label}
              onClick={() => applyPreset(preset.columns())}
            >
              {preset.label}
            </Button>
          ))}
        </div>
        <div className="my-1 h-px bg-border" />
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-full justify-start"
          data-testid="more-columns"
          onClick={() => {
            setOpen(false);
            useDocumentPropertiesStore.getState().openColumns();
          }}
        >
          <SlidersHorizontal size={12} />
          More columns…
        </Button>
      </PopoverContent>
    </Popover>
  );
}
