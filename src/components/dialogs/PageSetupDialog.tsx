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
import { Switch } from '@/components/ui/switch';
import { ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, ArrowUpToLine, PaintBucket } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from 'cn';
import { RibbonIconInput } from '@/components/layout/ribbon/RibbonIconInput';
import { ColorPickerButton } from '@/components/layout/ribbon/ColorPickerButton';
import { useDocumentPropertiesStore } from '@/lib/document/propertiesStore';
import { useDocumentStore } from '@/lib/document/store';
import { useConfigStore } from '@/lib/config/store';
import { summarizeMarginPreset } from '@/lib/document/pageSetup';
import {
  MEASUREMENT_UNITS,
  MARGIN_PRESETS,
  PAGELESS_MARGIN_PRESETS,
  PAGE_SIZES,
  formatPt,
  parseUnitToPt,
  type Margins,
  type MeasurementUnit,
  type PageSetup,
} from '@/lib/document/pageSetup';
import {
  applyPageSetup,
  sectionAfterCaret,
  sectionAtCaret,
  type PageSetupScope,
  type SectionFacts,
} from '@/lib/editor/sections';
import { useViewMode } from '@/lib/document/useViewMode';

// #58 — the page setup dialog with an apply-to scope. Presets and fields
// edit a DRAFT; Apply writes exactly one commit per scope. The draft re-seeds
// from the scope's target on scope change; chip toggles do not.

type MarginKey = keyof Margins;

const MARGIN_FIELDS: Array<{ key: MarginKey; label: string }> = [
  { key: 'top', label: 'Top' },
  { key: 'bottom', label: 'Bottom' },
  { key: 'left', label: 'Left' },
  { key: 'right', label: 'Right' },
];

const SCOPES: Array<{ value: PageSetupScope; label: string }> = [
  { value: 'document', label: 'Whole document' },
  { value: 'section', label: 'Specific section' },
  { value: 'forward', label: 'This point forward' },
  // #48 — a page owns its background, never its geometry: only the bucket stays live.
  { value: 'page', label: 'This page' },
];

const MARGIN_ICONS: Record<MarginKey, typeof ArrowUpToLine> = {
  top: ArrowUpToLine,
  bottom: ArrowDownToLine,
  left: ArrowLeftToLine,
  right: ArrowRightToLine,
};

interface Draft {
  pageSize: string;
  orientation: 'portrait' | 'landscape';
  customWidth: string;
  customHeight: string;
  margins: Record<MarginKey, string>;
  /** #58 — the target's page background; unset inherits the doc default. */
  pageColor: string;
  /** The document-level widow/orphan default (absent = ON;
   *  per-paragraph flow overrides). */
  widowControl: boolean;
}

function snapshot(setup: PageSetup, unit: MeasurementUnit, docColor = ''): Draft {
  return {
    pageSize: setup.pageSize,
    orientation: setup.orientation ?? 'portrait',
    customWidth: setup.customWidth != null ? String(formatPt(setup.customWidth, unit)) : '',
    customHeight: setup.customHeight != null ? String(formatPt(setup.customHeight, unit)) : '',
    margins: {
      top: formatPt(setup.margins.top, unit),
      bottom: formatPt(setup.margins.bottom, unit),
      left: formatPt(setup.margins.left, unit),
      right: formatPt(setup.margins.right, unit),
    },
    pageColor: setup.pageColor ?? docColor,
    widowControl: setup.widowControl ?? true,
  };
}

function draftMatchesPreset(draft: Draft, preset: Margins, unit: MeasurementUnit): boolean {
  return MARGIN_FIELDS.every(({ key }) => draft.margins[key] === formatPt(preset[key], unit));
}

/** The draft → a full PageSetup (invalid fields keep the target's
 *  values; 0 margins are legal). */
function draftToSetup(draft: Draft, base: PageSetup, unit: MeasurementUnit): PageSetup {
  const margins = { ...base.margins };
  for (const { key } of MARGIN_FIELDS) {
    const pt = parseUnitToPt(draft.margins[key], unit, { allowZero: true });
    if (pt != null && pt >= 0) margins[key] = pt;
  }
  const custom =
    draft.pageSize === 'custom'
      ? (() => {
          const wPt = parseUnitToPt(draft.customWidth, unit, { allowZero: false });
          const hPt = parseUnitToPt(draft.customHeight, unit, { allowZero: false });
          return {
            customWidth: wPt ?? base.customWidth,
            customHeight: hPt ?? base.customHeight,
          };
        })()
      : { customWidth: undefined, customHeight: undefined };
  return {
    ...base,
    pageSize: draft.pageSize || base.pageSize,
    orientation: draft.orientation,
    margins,
    pageColor: draft.pageColor,
    // The doc-level widow/orphan default rides every Apply.
    widowControl: draft.widowControl,
    ...custom,
  };
}

export function PageSetupDialog() {
  const isOpen = useDocumentPropertiesStore((s) => s.pageSetupIsOpen);
  const closePageSetup = useDocumentPropertiesStore((s) => s.closePageSetup);
  const pageSetup = useDocumentStore((s) => s.pageSetup);
  const editor = useDocumentStore((s) => s.editor);
  // #48 — the page-style layer's target: the caret's page (1-based) + the live map.
  const currentPage = useDocumentStore((s) => s.currentPage);
  const pageStyles = useDocumentStore((s) => s.pageStyles);
  const pageIndex = Math.max(0, currentPage - 1);
  const unit = useConfigStore((s) => s.config.editor.measurementUnit);

  const [scope, setScope] = useState<PageSetupScope>('document');
  const [facts, setFacts] = useState<SectionFacts | null>(null);
  const [target, setTarget] = useState<SectionFacts | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  // The dialog's mode toggle: it writes pageSetup.viewMode instantly
  // (a mode switch is not a drafted field); the drafted margins ride
  // across the switch.
  const resolvedMode = useViewMode();
  const setPageSetup = useDocumentStore((s) => s.setPageSetup);
  const [dialogMode, setDialogMode] = useState<'Pages' | 'Pageless'>(resolvedMode);
  const pagelessDialog = dialogMode === 'Pageless';
  // The individual-section chooser: the chosen ordinals. Selected
  // chips ⇔ the 'sections' scope (toggling a chip switches to it).
  const [sectionSet, setSectionSet] = useState<number[]>([]);
  // The section-START type (Word's "Section start") — how the target
  // section begins. Seeds from the target's boundary on re-scope.
  const [startType, setStartType] = useState<'nextPage' | 'continuous'>('nextPage');
  // #48 — the page-scoped decor layer: geometry gates on it, the bucket never does.
  const pageScope = scope === 'page';
  // Gated, never hidden — the dialog holds its size.
  const geometryGate = pageScope ? 'pointer-events-none opacity-50' : undefined;

  // Fresh start on open — a previous session's chip selection must not leak in.
  useEffect(() => {
    if (!isOpen) return;
    setScope('document');
    setSectionSet([]);
    setDialogMode(resolvedMode);
    // resolvedMode rides the OPEN seed only: the dialog's toggle owns
    // the mode while open (switching mid-dialog must not snap back).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Re-seed from the scope's target; chip toggles do NOT re-seed — the
  // drafted values ride to the newly chosen sections.
  useEffect(() => {
    if (!isOpen) return;
    const caretFacts = sectionAtCaret(editor, pageSetup);
    const targetFacts: SectionFacts =
      scope === 'document'
        ? { ...caretFacts, breakPos: null, setup: pageSetup }
        : scope === 'forward'
          ? sectionAfterCaret(editor, pageSetup)
          : caretFacts;
    setFacts(caretFacts);
    setTarget(targetFacts);
    // #48 — 'page' seeds the bucket from the page's own override ('' = inherit).
    // The modal holds focus, so seeding once per scope entry suffices.
    setDraft(
      snapshot(
        targetFacts.setup,
        unit,
        scope === 'page'
          ? (pageStyles[pageIndex]?.background ?? '')
          : (pageSetup.pageColor ?? ''),
      ),
    );
    // Entering 'section' auto-selects the caret's section; other scopes clear the chips.
    setSectionSet(scope === 'section' ? [caretFacts.index] : []);
    setStartType(
      targetFacts.startBreakPos != null && editor
        ? ((editor.state.doc.nodeAt(targetFacts.startBreakPos)?.attrs.type as
            | 'nextPage'
            | 'continuous'
            | undefined) ?? 'nextPage')
        : 'nextPage',
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, scope]);

  if (!isOpen || !draft || !facts || !target) {
    return (
      <Dialog open={false} onOpenChange={() => closePageSetup()}>
        <DialogContent />
      </Dialog>
    );
  }

  const suffix = MEASUREMENT_UNITS[unit].suffix;
  const sectioned = facts.total > 1;

  function editMargin(key: MarginKey, raw: string) {
    setDraft((d) => (d ? { ...d, margins: { ...d.margins, [key]: raw } } : d));
  }

  function pickMarginPreset(preset: Margins) {
    setDraft((d) =>
      d
        ? {
            ...d,
            margins: {
              top: formatPt(preset.top, unit),
              bottom: formatPt(preset.bottom, unit),
              left: formatPt(preset.left, unit),
              right: formatPt(preset.right, unit),
            },
          }
        : d,
    );
  }

  /** One commit per Apply (applyPageSetup). Pageless writes the store
   *  ONLY — no sections render in the continuous flow, so per-section
   *  setups ride untouched. */
  function apply() {
    const full = draftToSetup(draft!, target!.setup, unit);
    if (pagelessDialog) {
      setPageSetup({
        ...pageSetup,
        margins: full.margins,
        pageColor: full.pageColor,
        viewMode: 'pageless',
      });
      closePageSetup();
      return;
    }
    // #48 — only the bucket is live here; '' clears the page's entry.
    if (pageScope) {
      applyPageSetup('page', full, {}, {
        page: { index: pageIndex, background: draft!.pageColor || null },
      });
      closePageSetup();
      return;
    }
    const partial: Partial<PageSetup> = {
      pageSize: full.pageSize,
      orientation: full.orientation,
      margins: full.margins,
      pageColor: full.pageColor,
      widowControl: full.widowControl,
      ...(full.pageSize === 'custom'
        ? { customWidth: full.customWidth, customHeight: full.customHeight }
        : { customWidth: undefined, customHeight: undefined }),
    };
    applyPageSetup(scope, full, partial, {
      sectionSet,
      // The section-start type rides when the target has an editable
      // start boundary ('forward' passes it to the INSERTED break).
      startType: target!.startBreakPos != null || scope === 'forward' ? startType : undefined,
    });
    closePageSetup();
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) closePageSetup(); }}>
      {/* Wide for the two-column layout; the scroll guard keeps short viewports usable. */}
      <DialogContent className="sm:max-w-2xl max-h-[calc(100vh-4rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Page Setup</DialogTitle>
          <DialogDescription>
            {pagelessDialog
              ? 'Margins and page background for the continuous pageless flow.'
              : 'Modify the setup of your document — paper size, orientation, and margins.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          {/* LEFT — layout mode toggle + the scope. Pageless disables the
              paginated-only controls below (never hides). */}
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Layout mode</span>
              <div className="flex flex-col gap-1" role="group" aria-label="Layout mode" data-testid="page-setup-mode-toggle">
                {(['Pages', 'Pageless'] as const).map((m) => {
                  const selected = dialogMode === m;
                  return (
                    <Button
                      key={m}
                      size="sm"
                      variant={selected ? 'default' : 'secondary'}
                      className="h-7 justify-start"
                      aria-pressed={selected}
                      onClick={() => {
                        setDialogMode(m);
                        // Instant — a mode switch is not a drafted field.
                        setPageSetup({ ...pageSetup, viewMode: m === 'Pages' ? 'pages' : 'pageless' });
                      }}
                    >
                      {m === 'Pages' ? 'Paginated' : 'Pageless'}
                    </Button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-medium text-muted-foreground">Apply to</span>
                {pageScope ? (
                  <span className="text-xs text-muted-foreground">Page {currentPage}</span>
                ) : sectioned ? (
                  <span className="text-xs text-muted-foreground">
                    Section {facts.index + 1} of {facts.total}
                  </span>
                ) : null}
              </div>
              {/* Stacked full-width — the long labels need the whole half-column. */}
              <div className="flex flex-col gap-1" role="group" aria-label="Apply to">
                {SCOPES.map((s) => {
                  // A uniform doc disables the section scope; pageless
                  // disables all (the strip reads the store's margins —
                  // no sections in the flow).
                  const disabled = pagelessDialog || (!sectioned && s.value === 'section');
                  const selected = scope === s.value;
                  return (
                    <Button
                      key={s.value}
                      size="sm"
                      variant={selected ? 'default' : 'secondary'}
                      disabled={disabled}
                      className="h-7 justify-start"
                      aria-pressed={selected}
                      onClick={() => setScope(s.value)}
                    >
                      {s.label}
                    </Button>
                  );
                })}
              </div>
            </div>

            {/* Shown only under 'Specific section'; the drafted values ride chip toggles. */}
            {scope === 'section' && (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Section</span>
                <div className="flex flex-wrap gap-1" role="group" aria-label="Sections to apply to">
                  {Array.from({ length: facts.total }, (_, k) => {
                    const chosen = sectionSet.includes(k);
                    return (
                      <Button
                        key={k}
                        size="sm"
                        variant={chosen ? 'default' : 'secondary'}
                        className="h-7 w-9"
                        aria-pressed={chosen}
                        aria-label={`Section ${k + 1}`}
                        onClick={(e) => {
                          // With the app's select modifier held (Settings
                          // preference, shift by default), a click selects
                          // ONLY this section.
                          const trigger = useConfigStore.getState().config.pdfAlwaysAskTrigger;
                          const onlyThis =
                            trigger === 'ctrl' ? e.ctrlKey || e.metaKey : e.shiftKey;
                          if (onlyThis) {
                            setSectionSet([k]);
                            return;
                          }
                          setSectionSet((set) =>
                            chosen ? set.filter((x) => x !== k) : [...set, k].sort((a, b) => a - b),
                          );
                        }}
                      >
                        {k + 1}
                      </Button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* SECTION START — the type lives on the boundary break BEFORE
                the section; section 0 (doc start) is disabled. 'forward'
                inserts the boundary, so the choice applies to it.
                #48: gated under the page scope. */}
            <div className={cn('flex flex-col gap-1', geometryGate)}>
              <span className="text-xs font-medium text-muted-foreground">Section start</span>
              <span className="text-xs text-muted-foreground">
                How this section begins — a fresh page, or flowing on the same one.
              </span>
              <div className="flex gap-1">
                {([
                  { value: 'nextPage' as const, label: 'New page' },
                  { value: 'continuous' as const, label: 'Continuous (same page)' },
                ]).map((o) => {
                  const disabled = !sectioned || (target.startBreakPos == null && scope !== 'forward');
                  return (
                    <Button
                      key={o.value}
                      size="sm"
                      // Muted gray when selected — a state, not the dialog's answer.
                      variant={startType === o.value ? 'secondary' : 'ghost'}
                      disabled={disabled}
                      className="h-7 flex-1"
                      aria-pressed={startType === o.value}
                      onClick={() => setStartType(o.value)}
                    >
                      {o.label}
                    </Button>
                  );
                })}
              </div>
              {pageScope && (
                <span className="text-xs text-muted-foreground">
                  A page owns its background — paper and margins belong to its section.
                </span>
              )}
            </div>
          </div>

          {/* RIGHT — the setup. Pageless disables the paginated-only controls (never hides). */}
          <div className="flex flex-col gap-4">
            {/* #48 — the bucket edits the DRAFT; Done applies it per the
                scope. Page scope: only the bucket is live (a page owns its
                background, never its geometry). Pageless: the bucket alone. */}
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Paper</span>
              <div className="flex items-center gap-2">
              <Select
                value={draft.pageSize}
                disabled={pageScope || pagelessDialog}
                onValueChange={(value) => {
                  if (value == null) return;
                  if (value === 'custom') {
                    // The shared custom-size dialog opens in DRAFT mode:
                    // Done hands the pick back into this draft; Cancel
                    // changes nothing.
                    useDocumentPropertiesStore.getState().openCustomSize({
                      seed: {
                        pageSize: draft.pageSize,
                        customWidth: parseUnitToPt(draft.customWidth, unit, { allowZero: false }) ?? undefined,
                        customHeight: parseUnitToPt(draft.customHeight, unit, { allowZero: false }) ?? undefined,
                      },
                      onPick: (pick) =>
                        setDraft((d) =>
                          d
                            ? {
                                ...d,
                                pageSize: pick.pageSize,
                                customWidth: pick.customWidth != null ? String(formatPt(pick.customWidth, unit)) : d.customWidth,
                                customHeight: pick.customHeight != null ? String(formatPt(pick.customHeight, unit)) : d.customHeight,
                              }
                            : d,
                        ),
                    });
                    return;
                  }
                  setDraft((d) => (d ? { ...d, pageSize: value } : d));
                }}
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <SelectTrigger aria-label="Paper size" className="h-8 w-full flex-1 text-sm">
                        <SelectValue>
                          {draft.pageSize === 'custom'
                            ? 'Custom…'
                            : `${draft.pageSize} (${PAGE_SIZES[draft.pageSize]?.inches ?? ''})`}
                        </SelectValue>
                      </SelectTrigger>
                    }
                  />
                  <TooltipContent>Paper size</TooltipContent>
                </Tooltip>
                <SelectContent>
                  {/* w-(--anchor-width) — the popup matches the trigger width. */}
                  {Object.entries(PAGE_SIZES).map(([key, preset]) => (
                    <SelectItem key={key} value={key}>
                      {key} <span className="text-muted-foreground">({preset.inches})</span>
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">Custom…</SelectItem>
                  </SelectContent>
                </Select>
              <ColorPickerButton
                label="Page background"
                icon={<PaintBucket size={16} />}
                resetLabel={pageScope ? 'Remove page style' : 'White'}
                resetColor="#ffffff"
                defaultColor={draft.pageColor || '#ffffff'}
                onChange={(color) =>
                  setDraft((d) => (d ? { ...d, pageColor: color ?? '' } : d))
                }
              />
              </div>
            </div>

            {/* Orientation. #48: gated under the page scope; pageless disables it. */}
            <div className={cn('flex flex-col gap-1', geometryGate)}>
              <span className="text-xs font-medium text-muted-foreground">Orientation</span>
              <div className="flex gap-1">
                {(['portrait', 'landscape'] as const).map((o) => (
                  <Button
                    key={o}
                    size="sm"
                    disabled={pagelessDialog}
                    // Muted gray when selected, never the accent.
                    variant={draft.orientation === o ? 'secondary' : 'ghost'}
                    className="h-7 flex-1"
                    aria-pressed={draft.orientation === o}
                    onClick={() => setDraft((d) => (d ? { ...d, orientation: o } : d))}
                  >
                    {o.charAt(0).toUpperCase() + o.slice(1)}
                  </Button>
                ))}
              </div>
            </div>

            {/* The document-level widow/orphan default. #48: gated under
                the page scope; pageless disables it — one continuous flow. */}
            <div className={cn('flex items-center justify-between gap-2', geometryGate)}>
              <span className="text-xs font-medium text-muted-foreground">Widow/orphan control</span>
              <Switch
                size="sm"
                disabled={pagelessDialog}
                data-testid="page-setup-widow-control"
                checked={draft.widowControl}
                onCheckedChange={(checked: boolean) =>
                  setDraft((d) => (d ? { ...d, widowControl: checked } : d))
                }
              />
            </div>

            {/* Margins — custom row first, presets under it. #48: gated under page scope. */}
            <div className={cn('flex flex-col gap-1', geometryGate)}>
              <span className="text-xs font-medium text-muted-foreground">Margins</span>
              {/* One TooltipProvider for the row — grouping shows the adjacent
                  field's tooltip instantly, so hovering across the four
                  never re-waits. */}
              <TooltipProvider delay={300} closeDelay={0}>
                <div className="flex items-end justify-between gap-1.5">
                  {MARGIN_FIELDS.map(({ key, label }) => {
                    const Icon = MARGIN_ICONS[key];
                    const numeric = Number(draft.margins[key]);
                    return (
                      <RibbonIconInput
                        key={key}
                        label={`${label} margin`}
                        ariaLabel={`${label} margin`}
                        icon={<Icon size={12} />}
                        value={Number.isNaN(numeric) ? 0 : numeric}
                        onCommit={(n) => editMargin(key, String(n))}
                        min={0}
                        showSteppers
                        stepAmount={0.25}
                        width="w-[74px]"
                        suffix={suffix}
                      />
                    );
                  })}
                </div>
              </TooltipProvider>
              <div className="grid grid-cols-2 gap-1 pt-1" role="group" aria-label="Margin presets">
                {Object.entries(pagelessDialog ? PAGELESS_MARGIN_PRESETS : MARGIN_PRESETS).map(([key, preset]) => {
                  const matches = draftMatchesPreset(draft, preset.margins, unit);
                  return (
                    <Button
                      key={key}
                      size="sm"
                      variant={matches ? 'secondary' : 'ghost'}
                      className="h-auto w-full flex-col items-start gap-0.5 py-1.5"
                      aria-pressed={matches}
                      onClick={() => pickMarginPreset(preset.margins)}
                    >
                      <span className="text-[13px] leading-none">{preset.label}</span>
                      <span className="text-[10px] font-normal leading-none text-muted-foreground">
                        {summarizeMarginPreset(preset.margins, unit)}
                      </span>
                    </Button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={closePageSetup}>Cancel</Button>
          <Button size="sm" onClick={apply}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
