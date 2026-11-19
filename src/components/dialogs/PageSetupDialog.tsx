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

/**
 * #58 — THE ONE PAGE SETUP DIALOG (the margins dialog grown up, the
 * section properties merged in): paper size (incl. custom), orientation,
 * margins — with an APPLY-TO scope:
 *   • Whole document — every section (one PM transaction + the store).
 *   • This section — the caret's section only (its break's attrs, or
 *     the store for the final one).
 *   • This point forward — inserts a section break at the caret
 *     (seeded with the current section's setup: nothing above changes)
 *     and applies to everything after (Word's spelling).
 *   • The SECTION CHIPS — always visible on a sectioned document;
 *     toggling any chip switches the scope to the chosen set (the
 *     "individual sections" power without a buried dropdown).
 * A UNIFORM document disables the section controls (never hides them —
 * the dialog holds its size); Whole document and This point forward
 * stay live (point-forward is how sectioning begins).
 * Pages cannot own a setup — a page's geometry IS its section's (the
 * engine's law); "this point forward" is the closest spelling to a
 * page-scoped wish.
 *
 * COMMIT-GATED (the margins dialog's law): presets and fields edit a
 * DRAFT; Apply writes EXACTLY ONE commit per scope. The draft re-seeds
 * from the SCOPE'S TARGET whenever the scope buttons change (what you
 * see is what will change); chip toggles do NOT re-seed (the drafted
 * values ride to the newly chosen sections).
 */

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
  // #48 — the page-scoped DECOR layer: a page owns its background,
  // never its geometry (the engine's law) — under this scope only
  // the bucket stays live.
  { value: 'page', label: 'This page' },
];

/** The margin fields' IDENTITY: a letter prefix (T/B/L/R) — no icons
 *  (the user's call); the box must still say which edge it owns. */
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
  /** #58 — the TARGET's page background (per-section capable): a
   *  break-owned section's setup carries its own; unset inherits the
   *  doc default (the store's — the two-level band model). */
  pageColor: string;
  /** M-FLOW — the DOCUMENT-LEVEL widow/orphan default (absent = ON,
   * the engine's default; per-paragraph flow overrides). */
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
    // M-FLOW — the doc-level widow/orphan default rides every Apply.
    widowControl: draft.widowControl,
    ...custom,
  };
}

export function PageSetupDialog() {
  const isOpen = useDocumentPropertiesStore((s) => s.pageSetupIsOpen);
  const closePageSetup = useDocumentPropertiesStore((s) => s.closePageSetup);
  const pageSetup = useDocumentStore((s) => s.pageSetup);
  const editor = useDocumentStore((s) => s.editor);
  // #48 — the page-style layer's target: the caret's page (the
  // status bar's fact, 1-based) + the live map.
  const currentPage = useDocumentStore((s) => s.currentPage);
  const pageStyles = useDocumentStore((s) => s.pageStyles);
  const pageIndex = Math.max(0, currentPage - 1);
  const unit = useConfigStore((s) => s.config.editor.measurementUnit);

  const [scope, setScope] = useState<PageSetupScope>('document');
  const [facts, setFacts] = useState<SectionFacts | null>(null);
  const [target, setTarget] = useState<SectionFacts | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  // THE DIALOG'S MODE TOGGLE (the pageless ruling): Paginated shows the
  // paper/orientation/scopes machinery; Pageless shows the strip's
  // fields (margins incl. Full + page background — no paper, no
  // scopes, no sections). The toggle writes pageSetup.viewMode
  // INSTANTLY (the View-tab toggle's own law — a mode switch is not a
  // drafted field); the drafted margins ride across the switch.
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
  // #48 — the page-scoped DECOR layer (derived; the geometry controls
  // gate on it, the bucket never does).
  const pageScope = scope === 'page';
  // The geometry sections GATE on it (never hide — the dialog holds
  // its size; pointer-events + opacity, the section-scope's disabled
  // buttons' treatment).
  const geometryGate = pageScope ? 'pointer-events-none opacity-50' : undefined;

  // OPEN: reset the scope + the chip set (the dialog's fresh start;
  // a previous session's chip selection must not leak in).
  useEffect(() => {
    if (!isOpen) return;
    setScope('document');
    setSectionSet([]);
    setDialogMode(resolvedMode);
    // resolvedMode rides the OPEN seed only: the dialog's toggle owns
    // the mode while open (switching mid-dialog must not snap back).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Re-seed from the SCOPE'S TARGET: the caret's section facts fix the
  // "Section N of M" caption; the draft reads the scope's target setup.
  // Chip toggles do NOT re-seed (they only flip the scope — the drafted
  // values ride to the newly chosen sections).
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
    // #48 — 'page' seeds the bucket from the PAGE's own override
    // ('' = inherit the section/doc chain); the modal dialog holds
    // focus, so the caret can't move while open — seeding once per
    // scope entry is the whole story.
    setDraft(
      snapshot(
        targetFacts.setup,
        unit,
        scope === 'page'
          ? (pageStyles[pageIndex]?.background ?? '')
          : (pageSetup.pageColor ?? ''),
      ),
    );
    // Entering 'section' unhides the chips and AUTO-SELECTS the
    // section the caret sits in (the user's flow); the other scopes
    // carry no chip selection.
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

  /** ONE commit per Apply (the scope's writer — applyPageSetup).
   *  PAGELESS: the strip reads the STORE's margins (no sections render
   *  in the continuous flow) — the commit is the store write ONLY, so
   *  per-section setups ride untouched (a pageless margin edit never
   *  clobbers a section override the user will see back in paginated). */
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
    // #48 — ONE PAGE STYLE: the bucket alone is live under this
    // scope; '' = CLEAR the entry (back to the section/doc chain).
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
      {/* WIDER AT ALL TIMES (the two-column layout needs it; the old
          sm:max-w-sm clipped the sectioned shape). The scroll guard
          keeps short viewports usable. */}
      <DialogContent className="sm:max-w-2xl max-h-[calc(100vh-4rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Page Setup</DialogTitle>
          <DialogDescription>
            {pagelessDialog
              ? 'Margins and page background for the continuous pageless flow — changes apply when you press Done.'
              : 'Modify the setup of your document — paper size, orientation, and margins. Changes apply when you press Done and are saved with the document.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          {/* LEFT — the LAYOUT MODE TOGGLE (the user's spot: above
              "Apply to", same stacked-button treatment — the selected
              mode wears the accent) + the scope (what the draft
              applies to). PAGELESS: the paginated-only controls below
              DISABLE (never hide — the dialog holds its size; the
              ribbon's disabled-but-never-removed law). */}
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
                        // INSTANT (the View-tab toggle's law): a mode
                        // switch is not a drafted field.
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
              {/* Stacked full-width: three long labels never fit a
                  half-column on one line — the wrap/clip came free with
                  flex-1. The SELECTED scope wears the accent (the
                  group's answer); the others stay gray. */}
              <div className="flex flex-col gap-1" role="group" aria-label="Apply to">
                {SCOPES.map((s) => {
                  // A uniform doc disables the section-only scope;
                  // PAGELESS disables them ALL (the strip reads the
                  // store's margins — no sections render in the
                  // continuous flow). Never hides — the dialog holds
                  // its size.
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

            {/* THE SECTION STEP — revealed by 'Specific section' (the
                chips auto-select the caret's section on entry; toggling
                picks others — the drafted values ride along). The other
                scopes keep it hidden. */}
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
                        // The accent answers "which sections"; the gray
                        // chips are the un-chosen ones.
                        variant={chosen ? 'default' : 'secondary'}
                        className="h-7 w-9"
                        aria-pressed={chosen}
                        aria-label={`Section ${k + 1}`}
                        onClick={(e) => {
                          // The app's modifier (Settings ▸ the trigger
                          // preference — shift by default): clicking a
                          // chip with it held selects ONLY that section
                          // (deselects the rest).
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

            {/* SECTION START — how the target section begins (Word's
                "Section start"): a fresh page, or flowing on the same
                one. The type lives on the boundary break BEFORE the
                section; section 0 starts at the doc start — disabled.
                'forward' inserts the boundary, so the choice applies
                to it. #48: gated under the page scope. */}
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
                      // Muted gray when selected (the settings
                      // toggles' treatment) — the START of a section
                      // is a state, not the dialog's answer.
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

          {/* RIGHT — the setup itself. PAGELESS: the paginated-only
              controls DISABLE (never hide — the dialog holds its size);
              the page background bucket and margins stay live. */}
          <div className="flex flex-col gap-4">
            {/* #48 — PAPER, one section: the size dropdown SPANS the
                row, the background bucket stands alone at the far
                right (tooltips on both; the old two-column "Background"
                heading retired). The bucket edits the DRAFT; Done
                applies it per the scope — the PAGE scope keeps ONLY
                the bucket live (a page owns its background, never its
                geometry — the engine's law). PAGELESS: the bucket alone
                (the continuous flow has no paper). */}
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Paper</span>
              <div className="flex items-center gap-2">
              <Select
                value={draft.pageSize}
                disabled={pageScope || pagelessDialog}
                onValueChange={(value) => {
                  if (value == null) return;
                  if (value === 'custom') {
                    // The SHARED custom-size dialog (the ribbon's
                    // surface) opens in DRAFT mode: Done hands the pick
                    // back into THIS draft (the scope decides where it
                    // lands); Cancel changes nothing.
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
                  {/* w-(--anchor-width) — the popup matches the trigger
                      (the w-64 override read as an 80%-wide box). */}
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

            {/* Orientation — a heading with the options below (the
                dialog's own rhythm), the page glyphs aiding the scan.
                #48: gated under the page scope. PAGELESS: DISABLED —
                no sheets to orient. */}
            <div className={cn('flex flex-col gap-1', geometryGate)}>
              <span className="text-xs font-medium text-muted-foreground">Orientation</span>
              <div className="flex gap-1">
                {(['portrait', 'landscape'] as const).map((o) => (
                  <Button
                    key={o}
                    size="sm"
                    disabled={pagelessDialog}
                    // Muted gray when selected (the settings toggles'
                    // treatment) — never the accent.
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

            {/* M-FLOW — the document-level widow/orphan default (Word's
                layout option; off = natural splits everywhere a
                paragraph doesn't carry its own override). #48: gated
                under the page scope. PAGELESS: DISABLED — the strip is
                one continuous flow (the engine's pagination option). */}
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

            {/* Margins — the CUSTOM row first (one ticker per edge,
                icon + unit inside), the presets under it as human
                one-liners ("1\" vertical, 0.75\" horizontal"). #48:
                gated under the page scope. */}
            <div className={cn('flex flex-col gap-1', geometryGate)}>
              <span className="text-xs font-medium text-muted-foreground">Margins</span>
              {/* ONE TooltipProvider for the ROW — base-ui's grouping
                  shows the ADJACENT field's tooltip instantly (the
                  400ms carry window), so hovering straight across the
                  four never re-waits. Each field keeps its own tooltip
                  ("Top margin"…). */}
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
