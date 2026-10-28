import { Pin } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * M-T3 — the header-row PIN, gutter-mounted (the user's spec: "the
 * gutter is where the lucide icon pin should be"). One pin per table,
 * at the table's first band on the page where that band lands.
 *
 * M-GUTTER — CONTEXTUAL REPLACEMENT: the pin renders IN the line
 * NUMBER's slot (right-aligned, 8px off the content edge, vertically
 * centered on the band's line box) and the number it covers is
 * hidden (LineNumberGutter's `suppressed` set — the shared y key).
 * Tooltip is the shadcn/base-ui surface (portaled, zoom-proof).
 *
 * M-T4 polish: the pin is an INDICATOR — it renders ONLY on a pinned
 * (header) leading row (the filled pin, click to unpin). Unpinned
 * tables show nothing in the gutter; pinning a body row happens
 * through the context menu's "Make Header Row", the side panel, or
 * the insert dialog's header checkbox.
 *
 * Sibling of LineNumberGutter INSIDE the sheet — but unlike the gutter
 * (pointer-events-none by contract), the pin is intentionally
 * interactive chrome. Pageless mode has no pin.
 */

export interface TableHeaderPin {
  blockId: string;
  pageIndex: number;
  /** The band's top y, content-relative (the row's first line). */
  y: number;
  /** The band's line-box height — the pin centers on the SAME box
   *  the number would occupy (M-GUTTER). */
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
                  // THE NUMBER SLOT (M-GUTTER): left edge at
                  // contentBox.x − 28 → the icon's right edge sits 8px
                  // off the content edge, exactly where the number's
                  // right edge lives; the box spans the band's line
                  // height with the icon centered on it.
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
