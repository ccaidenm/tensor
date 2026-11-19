import { Omega } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSymbolBubbleStore } from '@/lib/editor/symbols/bubbleStore';

/**
 * THE SYMBOL TRIGGER — the Insert tab's entry for the floating Symbol
 * BUBBLE. Store-driven and dumb: the bubble itself mounts in App.tsx
 * (so it PERSISTS across ribbon tab switches — park it in a corner,
 * switch to Home, keep dropping symbols); this button only opens it
 * (with its rect as the anchor) or closes it when already open.
 */
export function SymbolButton() {
  const open = useSymbolBubbleStore((s) => s.open);
  const openAt = useSymbolBubbleStore((s) => s.openAt);
  const close = useSymbolBubbleStore((s) => s.close);

  function toggle(e: React.MouseEvent<HTMLButtonElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    if (open) {
      close();
    } else {
      openAt({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant="ghost" size="icon-sm" data-testid="symbol-button-trigger" onClick={toggle}>
            <Omega size={16} />
          </Button>
        }
      />
      <TooltipContent>Symbol</TooltipContent>
    </Tooltip>
  );
}
