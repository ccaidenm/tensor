import { useEffect, useState } from 'react';
import { Columns3, MoveHorizontal, Ruler } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { RibbonIconInput } from '@/components/layout/ribbon/RibbonIconInput';
import { useDocumentPropertiesStore } from '@/lib/document/propertiesStore';
import { useDocumentStore } from '@/lib/document/store';
import { useConfigStore } from '@/lib/config/store';
import {
  MEASUREMENT_UNITS,
  formatPt,
  parseUnitToPt,
  ptToPx,
  pxToPt,
  type ColumnSetup,
  type MeasurementUnit,
  type PageSetup,
} from '@/lib/document/pageSetup';
import { toLayoutOptions } from '@/lib/document/pageSetup';
import {
  applyPageSetup,
  sectionAfterCaret,
  sectionAtCaret,
  type PageSetupScope,
  type SectionFacts,
} from '@/lib/editor/sections';

/**
 * #74 COLUMNS — THE ONE COLUMNS DIALOG ("More Columns…", the Page
 * Setup dialog's twin): the newsletter-style column spec with an
 * APPLY-TO scope reusing the exact machinery —
 *   • Whole document — every section (one PM transaction + the store).
 *   • This section — the caret's section only (chips; the final
 *     section rides the store).
 *   • This point forward — inserts a section break at the caret
 *     (seeded with the current section's setup) and applies after.
 * There is deliberately NO page scope: columns are GEOMETRY (the
 * engine's one-geometry-per-page law — a section's), never page decor.
 *
 * COMMIT-GATED (the margins dialog's law): presets and fields edit a
 * DRAFT; Done writes EXACTLY ONE commit per scope. The draft re-seeds
 * from the scope's target whenever the scope changes.
 *
 * THE WIDTH MODEL: the setup stores ABSOLUTE per-column widths in pt
 * (the store's canonical-unit law) which the engine consumes as
 * RELATIVE weights; "Equal column width" checked = no widths array
 * (equal split). The dialog shows the EFFECTIVE widths (each
 * column's share of the post-gap space) so the numbers mean what the
 * page shows — Word's dialog posture.
 *
 * The engine validates loudly at layout (integer count ≥ 1, a gap the
 * content box can divide) — the dialog's Done gate is a soft guard,
 * the engine the backstop.
 */

const SCOPES: Array<{ value: PageSetupScope; label: string }> = [
  { value: 'document', label: 'Whole document' },
  { value: 'section', label: 'Specific section' },
  { value: 'forward', label: 'This point forward' },
];

/** Word's preset row: Left/Right are UNEQUAL two-column layouts
 *  (1:2 / 2:1 — the narrow column takes a third). */
type ColumnsPreset = {
  label: string;
  /** The draft the preset writes (widths in pt at the CURRENT content
   *  width — resolved at pick time). */
  pick: (contentPt: number, gapPt: number, unit: MeasurementUnit) => {
    count: number;
    widths?: number[];
  };
};

const PRESETS: ColumnsPreset[] = [
  { label: 'One', pick: () => ({ count: 1 }) },
  { label: 'Two', pick: () => ({ count: 2 }) },
  { label: 'Three', pick: () => ({ count: 3 }) },
  {
    label: 'Left',
    pick: (contentPt, gapPt, unit) => ({
      count: 2,
      widths: splitWidths([1 / 3, 2 / 3], contentPt, gapPt, unit),
    }),
  },
  {
    label: 'Right',
    pick: (contentPt, gapPt, unit) => ({
      count: 2,
      widths: splitWidths([2 / 3, 1 / 3], contentPt, gapPt, unit),
    }),
  },
];

/** Absolute pt widths from fractions of the post-gap space, rounded
 *  to the unit's precision (the dialog speaks the user's unit). */
function splitWidths(fractions: number[], contentPt: number, gapPt: number, unit: MeasurementUnit): number[] {
  const space = contentPt - gapPt * (fractions.length - 1);
  return fractions.map((f) => roundToUnit(space * f, unit));
}

function roundToUnit(pt: number, unit: MeasurementUnit): number {
  // The unit's pt-per-display-step: inches 72, centimeters ~28.35,
  // the point-faithful units step at 1.
  const perUnit = unit === 'inches' ? 72 : unit === 'centimeters' ? 72 / 2.54 : 1;
  return Math.round(pt * perUnit) / perUnit;
}

interface Draft {
  /** The column count (integer ≥ 1). */
  count: number;
  /** The spacing between columns, unit-formatted (pt at rest). */
  gap: string;
  /** Equal column width (Word's checkbox): checked = no widths array. */
  equalWidth: boolean;
  /** The per-column widths, unit-formatted (only when unequal). */
  widths: string[];
}

/** The effective absolute widths (pt) of a spec at the target's
 *  content box: absent = equal shares; else the weights' shares. The
 *  gap reads off the spec itself (the store's pt, Word's 0.5" absent). */
function effectiveWidthsPt(spec: ColumnSetup | null | undefined, contentPt: number): number[] {
  const count = spec?.count ?? 1;
  const gap = spec?.gap ?? 36; // Word's 0.5" default (pt)
  const space = Math.max(0, contentPt - gap * (count - 1));
  if (!spec?.widths || spec.widths.length !== count) {
    return Array.from({ length: count }, () => space / count);
  }
  const total = spec.widths.reduce((s, w) => s + w, 0);
  if (total <= 0) return Array.from({ length: count }, () => space / count);
  return spec.widths.map((w) => (space * w) / total);
}

function snapshot(setup: PageSetup, unit: MeasurementUnit): Draft {
  const spec = setup.columns;
  const lo = toLayoutOptions(setup);
  const contentPt = pxToPt(lo.page.width - lo.margins.left - lo.margins.right);
  const gapPt = spec?.gap ?? 36;
  const widthsPt = effectiveWidthsPt(spec, contentPt);
  return {
    count: spec?.count ?? 1,
    gap: formatPt(gapPt, unit),
    equalWidth: !spec?.widths,
    widths: widthsPt.map((w) => formatPt(w, unit)),
  };
}

/** The draft → the setup's columns spelling (null = one column).
 *  Invalid fields keep the target's values (the margins law). */
function draftToColumns(draft: Draft, base: PageSetup, unit: MeasurementUnit): ColumnSetup | null {
  if (draft.count < 1) return base.columns ?? null;
  if (draft.count === 1) return null; // One column ≡ no spec (the additive law)
  const gapPt = parseUnitToPt(draft.gap, unit, { allowZero: true });
  const columns: ColumnSetup = {
    count: draft.count,
    ...(gapPt != null && gapPt >= 0 ? { gap: gapPt } : {}),
  };
  if (!draft.equalWidth) {
    const widths = draft.widths
      .slice(0, draft.count)
      .map((w) => parseUnitToPt(w, unit, { allowZero: false }))
      .map((pt, i) => pt ?? base.columns?.widths?.[i] ?? 0);
    if (widths.length === draft.count && widths.every((w) => w > 0)) {
      columns.widths = widths;
    }
    // A widths parse failure falls back to equal (the engine's
    // validation stays the loud backstop for impossible geometry).
  }
  return columns;
}

export function ColumnsDialog() {
  const isOpen = useDocumentPropertiesStore((s) => s.columnsIsOpen);
  const closeColumns = useDocumentPropertiesStore((s) => s.closeColumns);
  const pageSetup = useDocumentStore((s) => s.pageSetup);
  const editor = useDocumentStore((s) => s.editor);
  const unit = useConfigStore((s) => s.config.editor.measurementUnit);

  const [scope, setScope] = useState<PageSetupScope>('document');
  const [facts, setFacts] = useState<SectionFacts | null>(null);
  const [target, setTarget] = useState<SectionFacts | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sectionSet, setSectionSet] = useState<number[]>([]);

  useEffect(() => {
    if (!isOpen) return;
    setScope('document');
    setSectionSet([]);
  }, [isOpen]);

  // Re-seed from the SCOPE'S TARGET (the Page Setup dialog's law —
  // what you see is what will change; chip toggles do not re-seed).
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
    setDraft(snapshot(targetFacts.setup, unit));
    setSectionSet(scope === 'section' ? [caretFacts.index] : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, scope]);

  if (!isOpen || !draft || !facts || !target) {
    return (
      <Dialog open={false} onOpenChange={() => closeColumns()}>
        <DialogContent />
      </Dialog>
    );
  }

  const suffix = MEASUREMENT_UNITS[unit].suffix;
  const sectioned = facts.total > 1;
  // The target's content box in POINTS (the store's canonical unit —
  // the widths/gap the dialog speaks are pt at rest; toLayoutOptions
  // returns the engine's px frame, converted here).
  const contentPt = (() => {
    const lo = toLayoutOptions(target.setup);
    return pxToPt(lo.page.width - lo.margins.left - lo.margins.right);
  })();
  const gapPt = parseUnitToPt(draft.gap, unit, { allowZero: true }) ?? 36;

  function editCount(next: number) {
    const count = Math.min(12, Math.max(1, Math.round(next) || 1));
    setDraft((d) =>
      d
        ? {
            ...d,
            count,
            // Grow/shrink the per-column widths with the count (equal
            // shares of the post-gap space at the CURRENT gap) — the
            // unequal editor always shows count fields.
            widths: Array.from({ length: count }, (_, i) => {
              const parsed = parseUnitToPt(d.widths[i] ?? '', unit, { allowZero: false });
              return formatPt(
                parsed ?? Math.max(0, contentPt - gapPt * (count - 1)) / count,
                unit,
              );
            }),
          }
        : d,
    );
  }

  function pickPreset(preset: ColumnsPreset) {
    const picked = preset.pick(contentPt, gapPt, unit);
    setDraft((d) =>
      d
        ? {
            ...d,
            count: picked.count,
            equalWidth: !picked.widths,
            widths: picked.widths
              ? picked.widths.map((w) => formatPt(w, unit))
              : Array.from({ length: picked.count }, () =>
                  formatPt(Math.max(0, contentPt - gapPt * (picked.count - 1)) / picked.count, unit),
                ),
          }
        : d,
    );
  }

  /** ONE commit per Done (the scope's writer — applyPageSetup). */
  function apply() {
    const columns = draftToColumns(draft!, target!.setup, unit);
    const full: PageSetup = { ...target!.setup, columns };
    // The PARTIAL rides the merge machinery: null clears (one column),
    // a spec merges into the target's setup(s) + the store.
    const partial: Partial<PageSetup> = { columns };
    applyPageSetup(scope === 'section' && sectionSet.length === 0 ? 'document' : scope, full, partial, {
      sectionSet,
    });
    closeColumns();
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) closeColumns(); }}>
      <DialogContent className="sm:max-w-xl max-h-[calc(100vh-4rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Columns</DialogTitle>
          <DialogDescription>
            Flow text in multiple columns. Changes apply when you press Done and are saved with
            the document.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          {/* LEFT — the scope (what the draft applies to). */}
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-medium text-muted-foreground">Apply to</span>
                {sectioned ? (
                  <span className="text-xs text-muted-foreground">
                    Section {facts.index + 1} of {facts.total}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-col gap-1" role="group" aria-label="Apply to">
                {SCOPES.map((s) => {
                  const disabled = !sectioned && s.value === 'section';
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
                          const trigger = useConfigStore.getState().config.pdfAlwaysAskTrigger;
                          const onlyThis = trigger === 'ctrl' ? e.ctrlKey || e.metaKey : e.shiftKey;
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

            {/* THE PREVIEW: the draft's column diagram over the target's
                content box (Word's dialog draws one; divs suffice). */}
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Preview</span>
              <div
                data-testid="columns-preview"
                className="flex h-16 items-stretch rounded-sm border border-border bg-muted/40 p-1"
                aria-hidden="true"
              >
                {(() => {
                  const gapPx = ptToPx(gapPt);
                  const widths =
                    draft.equalWidth || draft.widths.length !== draft.count
                      ? Array.from({ length: draft.count }, () => 1)
                      : draft.widths
                          .slice(0, draft.count)
                          .map((w) => parseUnitToPt(w, unit, { allowZero: false }) ?? 1);
                  const total = widths.reduce((s, w) => s + w, 0) || 1;
                  return widths.map((w, i) => (
                    <div
                      key={i}
                      className="h-full rounded-[2px] bg-primary/25"
                      style={{
                        flexGrow: w / total,
                        marginRight: i < draft.count - 1 ? `${gapPx}px` : 0,
                      }}
                    />
                  ));
                })()}
              </div>
            </div>
          </div>

          {/* RIGHT — the spec itself. */}
          <div className="flex flex-col gap-4">
            {/* The preset row (Word's): One/Two/Three/Left/Right — the
                picked preset drafts count + widths; Done applies per
                the scope. */}
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Presets</span>
              <div className="grid grid-cols-5 gap-1" role="group" aria-label="Column presets">
                {PRESETS.map((preset) => {
                  const picked = preset.pick(contentPt, gapPt, unit);
                  const matches =
                    draft.count === picked.count &&
                    (picked.widths
                      ? !draft.equalWidth &&
                        picked.widths.every(
                          (w, i) => formatPt(w, unit) === draft.widths[i],
                        )
                      : draft.equalWidth);
                  return (
                    <Button
                      key={preset.label}
                      size="sm"
                      variant={matches ? 'secondary' : 'ghost'}
                      className="h-7 px-1"
                      aria-pressed={matches}
                      onClick={() => pickPreset(preset)}
                    >
                      {preset.label}
                    </Button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">Number of columns</span>
              <RibbonIconInput
                label="Number of columns"
                ariaLabel="Number of columns"
                icon={<Columns3 size={12} />}
                value={draft.count}
                onCommit={(n) => editCount(n)}
                min={1}
                max={12}
                showSteppers
                stepAmount={1}
                width="w-[74px]"
              />
            </div>

            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">Spacing between</span>
              <RibbonIconInput
                label="Spacing between columns"
                ariaLabel="Spacing between columns"
                icon={<MoveHorizontal size={12} />}
                value={Number(draft.gap) || 0}
                onCommit={(n) => setDraft((d) => (d ? { ...d, gap: String(n) } : d))}
                min={0}
                showSteppers
                stepAmount={0.25}
                width="w-[96px]"
                suffix={suffix}
              />
            </div>

            {/* Word's checkbox: equal widths (checked) or per-column
                width + spacing fields (unchecked). */}
            <label className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
              <span>Equal column width</span>
              <Checkbox
                data-testid="columns-equal-width"
                checked={draft.equalWidth}
                onCheckedChange={(checked: boolean) =>
                  setDraft((d) => (d ? { ...d, equalWidth: checked } : d))
                }
              />
            </label>

            {!draft.equalWidth && (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Column widths</span>
                <div className="flex flex-wrap items-end gap-1.5">
                  {draft.widths.slice(0, draft.count).map((w, i) => (
                    <RibbonIconInput
                      key={i}
                      label={`Column ${i + 1} width`}
                      ariaLabel={`Column ${i + 1} width`}
                      icon={<Ruler size={12} />}
                      value={Number(w) || 0}
                      onCommit={(n) =>
                        setDraft((d) => {
                          if (!d) return d;
                          const widths = [...d.widths];
                          widths[i] = String(n);
                          return { ...d, widths };
                        })
                      }
                      min={0}
                      showSteppers
                      stepAmount={0.25}
                      width="w-[96px]"
                      suffix={suffix}
                    />
                  ))}
                </div>
                <span className="text-xs text-muted-foreground">
                  Widths are proportional — they share the space between the columns.
                </span>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={closeColumns}>Cancel</Button>
          <Button size="sm" data-testid="columns-dialog-done" onClick={apply}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
