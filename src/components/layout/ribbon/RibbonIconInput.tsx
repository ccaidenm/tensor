import { useEffect, useState, type ReactNode } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Kbd } from '@/components/ui/kbd';
import { useConfigStore } from '@/lib/config/store';
import { getEffectiveKeybinding, formatShortcutParts } from '@/lib/shortcuts';

interface RibbonIconInputProps {
  label: string;
  icon: ReactNode;
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  width?: string;
  showSteppers?: boolean;
  stepAmount?: number;
  /** The input's own accessible name (defaults to the tooltip's label —
   *  the icon alone isn't announced). */
  ariaLabel?: string;
  /** #58 — a unit readout INSIDE the box (right edge, before the
   *  steppers when they show): "0.5 in" reads without leaving the
   *  field. */
  suffix?: string;
  /** #58 — suppress this field's OWN tooltip (a tooltip GROUP wraps
   *  the row instead: one hover, one delay, carried across the
   *  fields). */
  hideTooltip?: boolean;
  /** #101 — the shortcut ids whose LIVE bindings ride the tooltip
   *  (the user's keybindings, never a hardcoded spelling). Absent =
   *  the field has none. */
  shortcutIds?: string[];
}

export function RibbonIconInput({
  label,
  icon,
  value,
  onCommit,
  min = 0,
  max = 9999,
  width = 'w-16',
  showSteppers = false,
  stepAmount = 1,
  ariaLabel,
  suffix,
  hideTooltip = false,
  shortcutIds,
}: RibbonIconInputProps) {
  const [localValue, setLocalValue] = useState(String(value));
  // The bindings read ONCE (the hook law: never inside the map below).
  const keybindings = useConfigStore((s) => s.config.keybindings);

  useEffect(() => {
    setLocalValue(String(value));
  }, [value]);

  function commit() {
    const num = Number(localValue);
    if (!Number.isNaN(num)) onCommit(num);
  }

  function step(delta: number) {
    const current = Number(localValue) || value;
    const next = Math.min(max, Math.max(min, current + delta));
    setLocalValue(String(next));
    onCommit(next);
  }

  const field = (
    <div className="relative flex h-8 items-stretch">
            <span className="pointer-events-none absolute left-2 top-1/2 z-10 -translate-y-1/2 text-muted-foreground">
              {icon}
            </span>
            <Input
                type="number"
                min={min}
                max={max}
                aria-label={ariaLabel ?? label}
                value={localValue}
                onChange={(e) => setLocalValue(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commit();
                    e.currentTarget.blur();
                  } else if (showSteppers && e.key === 'ArrowUp') {
                    e.preventDefault();
                    step(stepAmount);
                  } else if (showSteppers && e.key === 'ArrowDown') {
                    e.preventDefault();
                    step(-stepAmount);
                  }
                }}
                className={`relative z-0 h-8 ${width} pl-6 text-sm [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${
                  suffix ? (showSteppers ? 'pr-9' : 'pr-6') : showSteppers ? 'pr-5' : 'pr-2'
                }`}
              />

            {suffix && (
              <span
                className={`pointer-events-none absolute top-1/2 z-10 -translate-y-1/2 text-[10px] text-muted-foreground ${
                  showSteppers ? 'right-5' : 'right-2'
                }`}
              >
                {suffix}
              </span>
            )}
            {showSteppers && (
              <div className="absolute right-0 top-0 z-10 flex h-full w-5 flex-col">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="h-1/2 w-full flex-none items-end justify-center rounded-none p-0"
                  onClick={() => step(stepAmount)}
                  tabIndex={-1}
                >
                  <ChevronUp size={10} className="translate-y-px" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="h-1/2 w-full flex-none items-start justify-center rounded-none p-0"
                  onClick={() => step(-stepAmount)}
                  tabIndex={-1}
                >
                  <ChevronDown size={10} className="-translate-y-px" />
                </Button>
              </div>
            )}
          </div>
  );
  if (hideTooltip) return field;
  return (
    <Tooltip>
      <TooltipTrigger render={field} />
      <TooltipContent>
        <span className="flex items-center gap-2">
          {label}
          {shortcutIds && shortcutIds.length > 0 && (
            <span className="flex items-center gap-1">
              {shortcutIds.map((id) => {
                const binding = getEffectiveKeybinding(keybindings, id);
                return binding ? (
                  <Kbd key={id}>{formatShortcutParts(binding).join('+')}</Kbd>
                ) : null;
              })}
            </span>
          )}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
