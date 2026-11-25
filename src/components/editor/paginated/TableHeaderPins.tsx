import { Pin } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * The header-row pin, gutter-mounted: one per table, at its first band
 * on the page. Renders in the line-number's slot (the covered number is
 * hidden via LineNumberGutter's `suppressed`); only on pinned header
 * rows; intentionally interactive, unlike the gutter. Pageless has none.
 */

export interface TableHeaderPin {
  blockId: string;
  pageIndex: number;
  /** The band's top y, content-relative (the row's first line). */
  y: number;
  /** The band's line-box height — the pin centers on the box the number would occupy. */
  height: number;
  pinned: boolean;
}

interface TableHeaderPinsProps {
  geometry: { index: number; contentBox: { x: number; y: number } };
  pins: readonly TableHeaderPin[];
  onToggle: (blockId: string) => void;
}

export function TableHeaderPins({ geometry, pins, onToggle }: TableHeaderPinsProps) {
  const pagePins = pins.filter((p) => p.pinned && p.pageIndex === geometry.index);
  if (pagePins.length === 0) return null;
  return (
    <>
      {pagePins.map((pin) => (
        <Tooltip key={pin.blockId}>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-testid="table-header-pin-on"
                data-block-id={pin.blockId}
                aria-label="Unpin header row"
                className="pointer-events-auto absolute flex items-center justify-end rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                style={{
                  // The number slot: left = contentBox.x − 28 puts the
                  // icon's right edge 8px off the content edge, where the
                  // number's right edge lives; the box spans the band's line height.
                  left: `${geometry.contentBox.x - 28}px`,
                  top: `${geometry.contentBox.y + pin.y}px`,
                  height: `${pin.height}px`,
                  width: '20px',
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => onToggle(pin.blockId)}
              />
            }
          >
            <Pin size={12} fill="currentColor" />
          </TooltipTrigger>
          <TooltipContent>Pinned header row — click to unpin</TooltipContent>
        </Tooltip>
      ))}
    </>
  );
}
