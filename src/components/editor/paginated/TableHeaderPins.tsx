import { Pin } from 'lucide-react';

/**
 * M-T3 — the header-row PIN, gutter-mounted (the user's spec: "the
 * gutter is where the lucide icon pin should be"). One pin per table,
 * at the table's first band on the page where that band lands — the
 * FILLED pin shows the leading header row is pinned, the outline shows
 * unpinned; clicking toggles the row's header state (toggleHeaderRow
 * with the selection parked into the row and restored).
 *
 * Sibling of LineNumberGutter INSIDE the sheet — but unlike the gutter
 * (pointer-events-none by contract), the pin is intentionally
 * interactive chrome. Pageless mode has no pin: the FloatingToolbar's
 * Header Row button owns that surface.
 */

export interface TableHeaderPin {
  blockId: string;
  pageIndex: number;
  /** The band's top y, content-relative (the row's first line). */
  y: number;
  pinned: boolean;
}

interface TableHeaderPinsProps {
  geometry: { index: number; contentBox: { x: number; y: number } };
  pins: readonly TableHeaderPin[];
  onToggle: (blockId: string) => void;
}

export function TableHeaderPins({ geometry, pins, onToggle }: TableHeaderPinsProps) {
  const pagePins = pins.filter((p) => p.pageIndex === geometry.index);
  if (pagePins.length === 0) return null;
  return (
    <>
      {pagePins.map((pin) => (
        <button
          key={pin.blockId}
          data-testid={`table-header-pin-${pin.pinned ? 'on' : 'off'}`}
          data-block-id={pin.blockId}
          aria-label={pin.pinned ? 'Unpin header row' : 'Pin header row'}
          aria-pressed={pin.pinned}
          className="pointer-events-auto absolute flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          style={{
            // Right-aligned in the gutter, just left of the line numbers
            // (the numbers sit at right: 8px; the pin owns the next slot).
            left: `${geometry.contentBox.x - 28}px`,
            top: `${geometry.contentBox.y + pin.y + 2}px`,
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => onToggle(pin.blockId)}
        >
          <Pin size={12} fill={pin.pinned ? 'currentColor' : 'none'} />
        </button>
      ))}
    </>
  );
}