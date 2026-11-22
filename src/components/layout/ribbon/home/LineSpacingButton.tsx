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

/** The popover's section header — matches the FontGroup picker's exact
 * rhythm so the two dropdowns read as one kit. No CSS uppercase. */
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pt-1 pb-0.5 text-xs font-medium text-muted-foreground">{children}</div>
  );
}

/** One menu row (radio or checkbox): identical padding and hover for
 * both sections — one rhythm, no per-section drift. */
function MenuRow({ testId, control, label }: { testId?: string; control: React.ReactNode; label: string }) {
  return (
    <label
      data-testid={testId ? `row-${testId}` : undefined}
      className="flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
    >
      {control}
      {label}
    </label>
  );
}

/**
 * One pagination checkbox: 'mixed' renders the indeterminate box; either
 * way, clicking applies the explicit next state to every selected
 * paragraph (Word's dialog semantics). Stays open — toggles apply live.
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
    <MenuRow
      testId={`flow-toggle-${slug(label)}`}
      control={
        <Checkbox
          data-testid={`flow-toggle-${slug(label)}`}
          checked={state === true}
          indeterminate={state === 'mixed'}
          onCheckedChange={(checked: boolean) => onToggle(!!checked)}
        />
      }
      label={label}
    />
  );
}

/**
 * The paragraph popover: line-spacing presets (the selection's effective
 * multiplier, resolved through the style registry — the same cascade the
 * adapter runs) plus the live, stay-open pagination checkboxes.
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

  /** Attr-over-style, explicit both ways: unchecking writes the explicit
   *  OFF that beats every tier (false for the booleans — a style-inherited
   *  flag needs the override; null for the breaks, whose off-spelling IS null). */
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
                  className="h-8 gap-0.5 rounded-md px-1.5"
                >
                  <AlignVerticalSpaceAround size={16} />
                  <span className="flex h-4 w-4 items-center justify-center text-muted-foreground">
                    <ChevronDown size={12} />
                  </span>
                </Button>
              }
            />
          }
        />
        <TooltipContent>Line Spacing &amp; Page Breaks</TooltipContent>
      </Tooltip>

      <PopoverContent className="w-60 p-1" align="start">
        <SectionHeader>Line Spacing</SectionHeader>
        <RadioGroup
          value={radioValue}
          onValueChange={(value: unknown) => apply(String(value))}
          className="flex flex-col gap-0"
        >
          {PRESETS.map((preset) => (
            <MenuRow
              key={preset.value}
              testId={`spacing-row-${preset.value}`}
              control={
                <RadioGroupItem data-testid={`spacing-radio-${preset.value}`} value={preset.value} />
              }
              label={preset.label}
            />
          ))}
        </RadioGroup>

        {/* The custom escape hatch (multipliers). No divider above — a
            border here would read as an unlabeled section break. */}
        <div className="flex items-center gap-1 px-1 pt-1">
          <Input
            type="number"
            step="0.05"
            min="0.5"
            max="4"
            placeholder="Custom"
            data-testid="line-spacing-custom-input"
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            className="h-7 flex-1 text-sm"
          />
          <Button
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => customValue && apply(customValue)}
          >
            Set
          </Button>
        </div>

        <div className="mx-1 my-1 border-t" />
        <SectionHeader>Line &amp; Page Breaks</SectionHeader>
        <div className="flex flex-col gap-0">
          {FLOW_FLAG_KEYS.map((flag) => (
            <FlowToggle
              key={flag}
              label={FLOW_LABELS[flag]}
              state={flow?.[flag] ?? (flag === 'widowControl')}
              onToggle={(next) => toggleFlag(flag, next)}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
