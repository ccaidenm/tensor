import { useState } from 'react';
import { useEditorState } from '@tiptap/react';
import { AlignVerticalSpaceAround, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import type { Editor } from '@tiptap/core';
import {
  flowSelectionState,
  lineSpacingSelectionState,
  FLOW_FLAG_KEYS,
  type FlowFlagKey,
  type ParagraphFlowAttrs,
} from '@/lib/editor/ParagraphExtensions';
import { lookupStyle, useStyleRegistryStore } from '@/lib/styles/registry';
import { headingStyleId } from '@/lib/styles/types';

const PRESETS = [
  { label: 'Single', value: '1' },
  { label: '1.15', value: '1.15' },
  { label: '1.5', value: '1.5' },
  { label: 'Double', value: '2' },
];

/** Word's "Line and Page Breaks" tab labels (the two Tensor superset
 * flags ride along in the same order the writer accepts them). */
const FLOW_LABELS: Record<FlowFlagKey, string> = {
  keepNext: 'Keep with next',
  keepLines: 'Keep lines together',
  keepPrevious: 'Keep with previous',
  widowControl: 'Widow/orphan control',
  breakBefore: 'Page break before',
  breakAfter: 'Page break after',
};

const slug = (label: string) => label.toLowerCase().replace(/[^a-z]+/g, '-');

/**
 * One pagination checkbox (shadcn kit): uniform `checked` renders the
 * plain box, 'mixed' renders the INDETERMINATE box (clicking either way
 * applies the explicit next state to every selected paragraph —
 * Word's dialog semantics). Stays-open: the line-spacing radio closes
 * the popover on pick (menu semantics), the break toggles apply live
 * so a user can watch the pages reflow.
 */
function FlowToggle({
  label,
  state,
  onToggle,
}: {
  label: string;
  state: boolean | 'mixed';
  onToggle: (nextChecked: boolean) => void;
}) {
  return (
    <label
      className="flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
    >
      <Checkbox
        data-testid={`flow-toggle-${slug(label)}`}
        checked={state === true}
        indeterminate={state === 'mixed'}
        onCheckedChange={(checked: boolean) => onToggle(!!checked)}
      />
      {label}
    </label>
  );
}

/**
 * The paragraph popover (M5 rework of the line-spacing dropdown): LINE
 * SPACING above (a radio group reflecting the selection's EFFECTIVE
 * multiplier — every paragraph always has one — plus the custom
 * escape hatch), LINE & PAGE BREAKS below (the six M-FLOW pagination
 * checkboxes — live, stay-open, mixed-state aware). One popover is
 * Word's Paragraph dialog in ribbon clothing; both readers resolve
 * through the style registry — the same cascade the adapter runs.
 */
export function LineSpacingButton({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [customValue, setCustomValue] = useState('');
  const registry = useStyleRegistryStore((s) => s.merged);

  const resolveStyle = (node: {
    type: { name: string };
    attrs?: Record<string, unknown>;
  }) =>
    lookupStyle(
      node.type.name === 'heading'
        ? headingStyleId(typeof node.attrs?.level === 'number' ? node.attrs.level : 1)
        : typeof node.attrs?.styleId === 'string' && node.attrs.styleId
          ? node.attrs.styleId
          : 'normal',
      registry,
    );

  const flow = useEditorState({
    editor,
    selector: (ctx) => flowSelectionState(ctx.editor!, resolveStyle),
  });
  const spacing = useEditorState({
    editor,
    selector: (ctx) => lineSpacingSelectionState(ctx.editor!, resolveStyle),
  });

  /** The radio group's value: the preset matching the uniform effective
   * multiplier, or '' when mixed/px-custom (no radio checked). */
  const radioValue =
    spacing != null && PRESETS.some((p) => Math.abs(spacing - parseFloat(p.value)) < 0.001)
      ? String(spacing)
      : '';

  function apply(value: string) {
    editor.chain().focus().setLineHeight(value).run();
    setOpen(false);
  }

  /** The checkbox write rule (attr-over-style, explicit both ways):
   * checking writes the affirmative spelling (true / 'page'); uncheck-
   * ing writes the explicit OFF that beats every tier (false for the
   * booleans — a style-inherited flag needs the override; null for the
   * breaks, whose off-spelling IS null). */
  function toggleFlag(flag: FlowFlagKey, nextChecked: boolean) {
    const value: ParagraphFlowAttrs[FlowFlagKey] =
      flag === 'breakBefore' || flag === 'breakAfter'
        ? nextChecked
          ? 'page'
          : null
        : nextChecked
          ? true
          : false;
    editor.chain().focus().setFlowAttrs({ [flag]: value }).run();
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="line-spacing-trigger"
                  className="h-8 gap-1 rounded-md px-1.5"
                >
                  <AlignVerticalSpaceAround size={16} />
                  <ChevronDown size={12} className="text-muted-foreground" />
                </Button>
              }
            />
          }
        />
        <TooltipContent>Line Spacing &amp; Page Breaks</TooltipContent>
      </Tooltip>

      <PopoverContent className="w-60 p-1.5">
        {/* ── Line Spacing (the radio reflects the always-present
              attribute; a pick applies and closes — menu semantics) ── */}
        <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground">Line Spacing</div>
        <RadioGroup
          value={radioValue}
          onValueChange={(value: unknown) => apply(String(value))}
          className="flex flex-col gap-0.5"
        >
          {PRESETS.map((preset) => (
            <label
              key={preset.value}
              className="flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
            >
              <RadioGroupItem data-testid={`spacing-radio-${preset.value}`} value={preset.value} />
              {preset.label}
            </label>
          ))}
        </RadioGroup>

        {/* Custom — the preset family's escape hatch (multipliers; a
            px spelling rides the attr via the command path). */}
        <div className="mt-1.5 flex items-center gap-1 border-t border-border px-1 pt-2">
          <Input
            type="number"
            step="0.05"
            min="0.5"
            max="4"
            placeholder="Custom"
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            className="mx-1 h-7 text-sm"
          />
          <Button
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => customValue && apply(customValue)}
          >
            Set
          </Button>
        </div>

        {/* ── Line & Page Breaks (M-FLOW; Word's tab name) ── */}
        <div className="mt-1.5 border-t border-border pt-1.5">
          <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground">
            Line &amp; Page Breaks
          </div>
          <div className="flex flex-col gap-0.5">
            {FLOW_FLAG_KEYS.map((flag) => (
              <FlowToggle
                key={flag}
                label={FLOW_LABELS[flag]}
                state={flow?.[flag] ?? (flag === 'widowControl')}
                onToggle={(next) => toggleFlag(flag, next)}
              />
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
