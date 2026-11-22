import { Omega } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSymbolBubbleStore } from '@/lib/editor/symbols/bubbleStore';

/**
 * The Insert tab's Symbol trigger. The bubble itself mounts in App.tsx,
 * so it persists across ribbon tab switches; this button only opens it
 * (anchored to its rect) or closes it when already open.
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
