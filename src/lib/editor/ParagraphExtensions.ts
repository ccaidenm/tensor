import { Extension } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import Paragraph from '@tiptap/extension-paragraph';
import Heading from '@tiptap/extension-heading';
import type { TabStop } from '@tensor-editor/engine';
import type { StyleDefinition } from '@/lib/styles/types';
import { resolveFlowTier } from '@/lib/styles/resolve';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    paragraphExtras: {
      setLineHeight: (lineHeight: string) => ReturnType;
      unsetLineHeight: () => ReturnType;
      increaseIndent: () => ReturnType;
      decreaseIndent: () => ReturnType;
      clearFormatting: () => ReturnType;
      setTabStops: (stops: TabStop[]) => ReturnType;
      setIndents: (indents: { indentLeft?: number; indentRight?: number; firstLineIndent?: number }) => ReturnType;
      setFlowAttrs: (flow: ParagraphFlowAttrs) => ReturnType;
    };
  }
}

const MAX_INDENT = 8;
const INDENT_STEP_PX = 32;
const MAX_INDENT_PX = MAX_INDENT * INDENT_STEP_PX;

/**
 * M-FLOW — PARAGRAPH PAGINATION FLAGS: the engine FlowPolicy's six
 * fields under their OOXML-mirrored names (w:keepNext / w:keepLines /
 * w:widowControl / w:pageBreakBefore round-trip through DOCX;
 * keepPrevious and breakAfter are the Tensor superset — the engine's
 * two extra bond/break spellings, .wpdoc-native). null = UNSET at
 * every use site (the PM JSON round-trip convention): the flag
 * inherits the STYLE tier (M-STYLES) and, for widowControl, the
 * document-level default (engine opts — on). Pagination inputs ONLY:
 * the pageless editor never renders them as CSS (no UA property
 * exists for "keep with next"); the paginated view consumes them
 * through the adapter into engine `flow`. Clipboard spelling:
 * data-keep-next / data-keep-lines / data-keep-previous /
 * data-widow-control / data-break-before / data-break-after (the
 * ImageNode data-keep-next precedent), so flags survive intra-app
 * copy/paste.
 */
export type ParagraphFlowAttrs = {
  keepNext?: boolean | null;
  keepLines?: boolean | null;
  keepPrevious?: boolean | null;
  widowControl?: boolean | null;
  breakBefore?: 'page' | null;
  breakAfter?: 'page' | null;
};

const kebab = (name: string): string => name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

const boolFlowAttr = (name: 'keepNext' | 'keepLines' | 'keepPrevious' | 'widowControl') => ({
  [name]: {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const raw = element.getAttribute(`data-${kebab(name)}`);
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      return null;
    },
    renderHTML: (attributes: Record<string, unknown>) => {
      const v = attributes[name];
      if (v !== true && v !== false) return {};
      return { [`data-${kebab(name)}`]: String(v) };
    },
  },
});

const breakFlowAttr = (name: 'breakBefore' | 'breakAfter') => ({
  [name]: {
    default: null,
    parseHTML: (element: HTMLElement) =>
      element.getAttribute(`data-${kebab(name)}`) === 'page' ? ('page' as const) : null,
    renderHTML: (attributes: Record<string, unknown>) =>
      attributes[name] === 'page' ? { [`data-${kebab(name)}`]: 'page' } : {},
  },
});

const flowAttributes = {
  ...boolFlowAttr('keepNext'),
  ...boolFlowAttr('keepLines'),
  ...boolFlowAttr('keepPrevious'),
  ...boolFlowAttr('widowControl'),
  ...breakFlowAttr('breakBefore'),
  ...breakFlowAttr('breakAfter'),
};

/**
 * M-FLOW — the TABLE-level subset: the five flags meaningful for a
 * table block (keepLines = R-ATOMIC band-wise, keepNext/keepPrevious
 * bond the table to a neighbor, the forced breaks close pages around
 * it). widowControl is EXCLUDED — the engine ignores boundary
 * minimums between a table's bands (rows break naturally), so the
 * flag is inert there and never offered.
 */
export const tableFlowAttributes = {
  keepNext: flowAttributes.keepNext,
  keepLines: flowAttributes.keepLines,
  keepPrevious: flowAttributes.keepPrevious,
  breakBefore: flowAttributes.breakBefore,
  breakAfter: flowAttributes.breakAfter,
};

/** The flow flag keys in popover order (Word's Line and Page Breaks
 * tab order, plus the two Tensor superset flags). */
export const FLOW_FLAG_KEYS = [
  'keepNext',
  'keepLines',
  'keepPrevious',
  'widowControl',
  'breakBefore',
  'breakAfter',
] as const;

export type FlowFlagKey = (typeof FLOW_FLAG_KEYS)[number];

/**
 * M-FLOW — the ribbon's mixed-state reader: for each flow flag, the
 * selection's uniform EFFECTIVE state (the style tier resolved through
 * resolveFlowTier — the SAME cascade the adapter runs), or 'mixed'
 * when paragraphs in the selection disagree (the indeterminate-
 * checkbox spelling). The DEFAULT-ON / DEFAULT-OFF split mirrors
 * Word's dialog: widowControl is ON when unset (null = inherit the
 * document default, true); the keep flags and forced breaks are OFF
 * when unset. Top-level paragraphs and headings only — the same
 * targeting contract as the writer and clearFormatting (header/footer
 * band paragraphs never paginate, so flags there are inert and the UI
 * never reports them).
 *
 * `resolveStyle` supplies the STYLE TIER (the ribbon passes the
 * registry's merged definitions + the node's styleId; omitted =
 * attr-only, the cascade floor — the unit-test spelling).
 */
export function flowSelectionState(
  editor: Editor,
  resolveStyle?: (node: { type: { name: string }; attrs?: Record<string, unknown> }) => StyleDefinition | null
): Record<FlowFlagKey, boolean | 'mixed'> {
  const { from, to } = editor.state.selection;
  const values = new Map<FlowFlagKey, Set<boolean>>();
  let touched = 0;
  editor.state.doc.forEach((node, offset) => {
    const name = node.type.name;
    if (name !== 'paragraph' && name !== 'heading') return;
    if (offset >= to || offset + node.nodeSize <= from) return;
    touched += 1;
    const paraDef = resolveStyle?.(node) ?? null;
    const policy = resolveFlowTier(paraDef, node.attrs ?? {});
    for (const flag of FLOW_FLAG_KEYS) {
      const effective =
        flag === 'widowControl'
          ? policy?.widowControl !== false
          : flag === 'breakBefore' || flag === 'breakAfter'
            ? policy?.[flag] === 'page'
            : policy?.[flag] === true;
      if (!values.has(flag)) values.set(flag, new Set());
      values.get(flag)!.add(effective);
    }
  });
  const out = {} as Record<FlowFlagKey, boolean | 'mixed'>;
  for (const flag of FLOW_FLAG_KEYS) {
    const set = values.get(flag);
    if (touched === 0 || set === undefined || set.size === 0) {
      out[flag] = flag === 'widowControl'; // no selection targets: the defaults
    } else if (set.size > 1) {
      out[flag] = 'mixed';
    } else {
      out[flag] = set.values().next().value!;
    }
  }
  return out;
}

/**
 * M6/M-FLOW — the ribbon's line-spacing reader: the selection's uniform
 * EFFECTIVE multiplier, or null when the selection disagrees or any
 * block carries a px spelling (a custom height is never a preset).
 * Every paragraph ALWAYS has a value (the radio group's law): direct
 * attr over the style tier over the 1.0 default — the same cascade
 * flowSelectionState resolves, read by the popover's radio group. No
 * selection targets → the default 1.0 ('Single' checks).
 */
export function lineSpacingSelectionState(
  editor: Editor,
  resolveStyle?: (node: { type: { name: string }; attrs?: Record<string, unknown> }) => StyleDefinition | null
): number | null {
  const { from, to } = editor.state.selection;
  const values = new Set<number>();
  let touched = 0;
  let sawPx = false;
  editor.state.doc.forEach((node, offset) => {
    const name = node.type.name;
    if (name !== 'paragraph' && name !== 'heading') return;
    if (offset >= to || offset + node.nodeSize <= from) return;
    touched += 1;
    const attr = typeof node.attrs?.lineHeight === 'string' && node.attrs.lineHeight.trim()
      ? node.attrs.lineHeight
      : null;
    if (attr?.trim().endsWith('px')) {
      sawPx = true;
      return;
    }
    const mult = attr
      ? parseFloat(attr)
      : ((resolveStyle?.(node)?.properties.lineHeight as number | undefined) ?? 1);
    if (Number.isFinite(mult) && mult > 0) values.add(mult);
  });
  if (sawPx) return null;
  if (touched === 0 || values.size === 0) return 1;
  if (values.size > 1) return null;
  return values.values().next().value!;
}


const lineHeightAttribute = {
  lineHeight: {
    default: null,
    parseHTML: (element: HTMLElement) => element.style.lineHeight || null,
    renderHTML: (attributes: { lineHeight?: string | null }) => {
      if (!attributes.lineHeight) return {};
      return { style: `line-height: ${attributes.lineHeight}` };
    },
  },
};

/**
 * FIRST-LINE INDENT (M6.2): px, may be NEGATIVE (hanging indent).
 * Round-trips through CSS text-indent — the pageless editor renders it
 * natively (positive text-indent = first line out; negative under a
 * padding-left = hanging), and the adapter maps it to the engine's
 * firstLineIndent (identical semantics: line 0 sits at
 * indentLeft + firstLineIndent and wraps at its own width). null =
 * unset (no text-indent style).
 */
const firstLineIndentAttribute = {
  firstLineIndent: {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const raw = element.style.textIndent;
      if (!raw) return null;
      const v = parseFloat(raw);
      if (!Number.isFinite(v)) return null;
      // pt at the data boundary like every other CSS unit here
      // (M6-PRE: pt at the chrome, px in the core).
      return raw.trim().endsWith('pt') ? Math.round(v * (96 / 72)) : v;
    },
    renderHTML: (attributes: { firstLineIndent?: number | null }) => {
      if (attributes.firstLineIndent == null) return {};
      return { style: `text-indent: ${attributes.firstLineIndent}px` };
    },
  },
};

/**
 * LEGACY `indent` attr (steps of 32px): the pre-M6.2 spelling, kept
 * for .wpdoc/HTML round-trips of old files. The commands below no
 * longer write it; the adapter folds it into indentLeft (steps × 32,
 * additive), and the first indent command press MIGRATES it away (see
 * currentIndentLeft).
 */
const indentAttribute = {
  indent: {
    default: 0,
    parseHTML: (element: HTMLElement) => {
      const margin = parseInt(element.style.marginLeft || '0', 10);
      return Math.round(margin / INDENT_STEP_PX);
    },
    renderHTML: (attributes: { indent?: number }) => {
      if (!attributes.indent) return {};
      return { style: `margin-left: ${attributes.indent * INDENT_STEP_PX}px` };
    },
  },
};

/** The paragraph's EFFECTIVE left indent (px): the indentLeft attr plus
 * the legacy `indent` steps folded in. One writer (indentLeft), one
 * reader (this — the indent commands AND the M-RULER projection both
 * read through it, so the legacy fold can never fork), migration on
 * the first command press. */
export function currentIndentLeft(node: { attrs?: Record<string, unknown> }): number {
  const left = typeof node.attrs?.indentLeft === 'number' && Number.isFinite(node.attrs.indentLeft)
    ? node.attrs.indentLeft
    : 0;
  const legacy = typeof node.attrs?.indent === 'number' && Number.isFinite(node.attrs.indent)
    ? node.attrs.indent * INDENT_STEP_PX
    : 0;
  return left + legacy;
}

const directionalIndentAttributes = {
  indentLeft: {
    default: 0,
    parseHTML: (element: HTMLElement) => parseInt(element.style.paddingLeft || '0', 10),
    renderHTML: (attributes: { indentLeft?: number }) => {
      if (!attributes.indentLeft) return {};
      return { style: `padding-left: ${attributes.indentLeft}px` };
    },
  },
  indentRight: {
    default: 0,
    parseHTML: (element: HTMLElement) => parseInt(element.style.paddingRight || '0', 10),
    renderHTML: (attributes: { indentRight?: number }) => {
      if (!attributes.indentRight) return {};
      return { style: `padding-right: ${attributes.indentRight}px` };
    },
  },
};

const spacingAttributes = {
  spaceBefore: {
    default: 0,
    parseHTML: (element: HTMLElement) => parseInt(element.style.marginTop || '0', 10),
    renderHTML: (attributes: { spaceBefore?: number }) => {
      if (!attributes.spaceBefore) return {};
      return { style: `margin-top: ${attributes.spaceBefore}px` };
    },
  },
  spaceAfter: {
    default: 0,
    parseHTML: (element: HTMLElement) => parseInt(element.style.marginBottom || '0', 10),
    renderHTML: (attributes: { spaceAfter?: number }) => {
      if (!attributes.spaceAfter) return {};
      return { style: `margin-bottom: ${attributes.spaceAfter}px` };
    },
  },
};

/**
 * TAB STOPS (M-RULER Phase 3/3.5): the engine's TabStop objects — px
 * from the CONTENT-BOX LEFT EDGE (margin-relative: indent edits never
 * move tab stops), each with an alignment kind (left/center/right —
 * the context menu's choice). Sorted ascending by position, deduped,
 * null = none. Round-trips through `data-tab-stops="96:left,192:right"`
 * (bare numbers parse as left stops, for tolerance); .wpdoc rides the
 * docJSON free. The breaker advance rule (and with it the Tab keymap's
 * mid-line branch) lands in Phase 4 — until then the attr is
 * ruler-visible data only.
 */
export function normalizeTabStops(stops: unknown): TabStop[] | null {
  if (!Array.isArray(stops)) return null;
  const clean = stops
    .map((v): TabStop | null => {
      if (v == null || typeof v !== 'object') return null;
      const position = (v as { position?: unknown }).position;
      if (typeof position !== 'number' || !Number.isFinite(position) || position < 0) {
        return null;
      }
      const alignment = (v as { alignment?: unknown }).alignment;
      return {
        position,
        alignment:
          alignment === 'center' || alignment === 'right' ? alignment : 'left',
      };
    })
    .filter((v): v is TabStop => v != null)
    .sort((a, b) => a.position - b.position);
  const deduped: TabStop[] = [];
  for (const stop of clean) {
    const last = deduped[deduped.length - 1];
    if (last == null || stop.position - last.position > 0.5) {
      deduped.push(stop);
    }
  }
  return deduped.length ? deduped : null;
}

const tabStopsAttribute = {
  tabStops: {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const raw = element.getAttribute('data-tab-stops');
      if (!raw) return null;
      return normalizeTabStops(
        raw.split(',').map((part) => {
          const [pos, align] = part.split(':');
          return {
            position: parseFloat(pos),
            alignment: align === 'center' || align === 'right' ? align : 'left',
          };
        }),
      );
    },
    renderHTML: (attributes: { tabStops?: TabStop[] | null }) => {
      const stops = normalizeTabStops(attributes.tabStops);
      if (!stops) return {};
      return {
        'data-tab-stops': stops
          .map((s) => `${s.position}:${s.alignment}`)
          .join(','),
      };
    },
  },
};

/**
 * M-STYLES: the paragraph's STYLE IDENTITY — a reference into the
 * style registry, never a bundle of stamped attrs. Non-optional
 * INVARIANT: every paragraph carries a styleId; old documents get it
 * via the attr default ('normal') on load — no migration pass. The
 * pageless render path consumes the class (wp-style-{id}) through the
 * registry-generated stylesheet; direct attrs (inline styles from the
 * attribute renderers above) beat the class by CSS construction,
 * which is the pageless spelling of the cascade (direct > style).
 */
const styleIdAttribute = (fallback: string) => ({
  styleId: {
    default: fallback,
    parseHTML: (element: HTMLElement) => element.getAttribute('data-style-id') ?? undefined,
    renderHTML: (attributes: { styleId?: string }) => ({
      'data-style-id': attributes.styleId,
      class: `wp-style-${attributes.styleId}`,
    }),
  },
});

/**
 * M-REFS — the ENTRY ID: a paragraph inside a referenceTable container
 * carries its scan entry's reconciliation key (the target's stable
 * blockId; the term itself for index entries; null = the placeholder).
 * The generator (lib/references/generator.ts) matches children by it —
 * an unchanged key is NEVER rewritten, so the user's formatting on the
 * entry survives every refresh. Pure model identity: no renderHTML,
 * never DOM ink, never clipboard noise (the attr round-trips null).
 */
const refIdAttribute = {
  refId: {
    default: null,
    keepOnSplit: false,
  },
};

export const ParagraphWithExtras = Paragraph.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...lineHeightAttribute,
      ...indentAttribute,
      ...directionalIndentAttributes,
      ...firstLineIndentAttribute,
      ...spacingAttributes,
      ...tabStopsAttribute,
      ...flowAttributes,
      ...styleIdAttribute('normal'),
      ...refIdAttribute,
    };
  },
});

/** The heading tier carries `heading-{level}` as its style identity
 * (attr default per the M-STYLES ruling; HeadingSync maintains the
 * alignment reactively). The adapter resolves headings through
 * `heading-{level}` — the attr's guaranteed twin — so a pre-sync node
 * can never render under the wrong tier. */
export const HeadingWithExtras = Heading.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...lineHeightAttribute,
      ...flowAttributes,
      ...styleIdAttribute('heading-1'),
    };
  },
});

/**
 * M-HEADER-FOOTER-3 — the caret's RULER-EDITABLE PARAGRAPH: the block
 * whose attrs the ruler's tab-stop/indent writers target. Top-level
 * paragraphs (body) and BAND-container children (headerBlock/footerBlock
 * — M-3: `$from.before(1)` is the CONTAINER there, so the old spelling
 * no-oped) qualify; list-item and blockquote paragraphs do NOT (Word:
 * the ruler is margins-only there). Shared by the commands below and
 * the ruler's model derivation (lib/paginated/ruler.ts) — one
 * acceptance rule, no fork.
 */
export function caretEditableParagraph(
  $from: { depth: number; node(d: number): { type: { name: string } } | null },
): { pos: number; node: { type: { name: string } } } | null {
  for (let d = $from.depth; d >= 1; d--) {
    const node = $from.node(d);
    if (!node || node.type.name !== 'paragraph') continue;
    const parent = d - 1 === 0 ? { type: { name: 'doc' } } : $from.node(d - 1);
    const parentName = parent?.type.name;
    if (parentName === 'doc' || parentName === 'headerBlock' || parentName === 'footerBlock') {
      // `before(depth)` = the position directly before this ancestor.
      return { pos: ($from as unknown as { before(d: number): number }).before(d), node };
    }
  }
  return null;
}

export const ParagraphExtraCommands = Extension.create({
  name: 'paragraphExtraCommands',

  addCommands() {
    return {
      setLineHeight:
        (lineHeight: string) =>
        ({ commands }: { commands: any }) =>
          commands.focus() &&
          ['paragraph', 'heading'].every((type: string) => commands.updateAttributes(type, { lineHeight })),

      unsetLineHeight:
        () =>
        ({ commands }: { commands: any }) =>
          commands.focus() &&
          ['paragraph', 'heading'].every((type: string) => commands.resetAttributes(type, 'lineHeight')),

      // TAB STOPS (M-RULER Phase 3): ONE writer — the tabStops attr, px
      // content-box-relative, normalized (sorted, deduped, null when
      // empty) on the way in. Targets the CARET's block for an empty
      // selection and every top-level paragraph overlapped by a range
      // selection (Word semantics: a selection applies to all of them).
      // Skips writes that wouldn't change anything, so the ruler's
      // release commit stays idempotent and undo stays one-step-per-
      // gesture.
      setTabStops:
        (stops: TabStop[]) =>
        ({ tr, state, dispatch }: { tr: any; state: any; dispatch: any }) => {
          const normalized = normalizeTabStops(stops);
          const { empty, from, to, $from } = tr.selection;
          const targets: Array<{ pos: number; node: any }> = [];
          if (empty) {
            // M-HEADER-FOOTER-3: the caret's RULER-EDITABLE paragraph —
            // `$from.before(1)` is the BAND CONTAINER for header/footer
            // paragraphs, so the old spelling no-oped there (the
            // "clicking the ruler never inserts" bug).
            const hit = caretEditableParagraph($from);
            if (hit) targets.push({ pos: hit.pos, node: hit.node });
          } else {
            state.doc.forEach((node: any, offset: number) => {
              if (node.type.name !== 'paragraph') return;
              if (offset >= to || offset + node.nodeSize <= from) return;
              targets.push({ pos: offset, node });
            });
          }
          if (targets.length === 0) return false;
          let changed = false;
          const nextJson = JSON.stringify(normalized);
          for (const { pos, node } of targets) {
            const current = Array.isArray(node.attrs.tabStops)
              ? JSON.stringify(node.attrs.tabStops)
              : JSON.stringify(null);
            if (current === nextJson) continue;
            if (dispatch) {
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, tabStops: normalized });
            }
            changed = true;
          }
          return changed;
        },

      // INDENT DRAG WRITER (M-RULER: the indent markers' handles): the
      // same targeting contract as setTabStops — the CARET's block for
      // an empty selection, every top-level paragraph overlapped by a
      // range selection (Word semantics). Absolute px values (the
      // dragged marker's final position), skipped when nothing changes
      // so gestures stay idempotent and one-undo-step-per-gesture.
      setIndents:
        (indents: { indentLeft?: number; indentRight?: number; firstLineIndent?: number }) =>
        ({ tr, state, dispatch }: { tr: any; state: any; dispatch: any }) => {
          const { empty, from, to, $from } = tr.selection;
          const targets: Array<{ pos: number; node: any }> = [];
          if (empty) {
            // M-HEADER-FOOTER-3: band-aware (see setTabStops).
            const hit = caretEditableParagraph($from);
            if (hit) targets.push({ pos: hit.pos, node: hit.node });
          } else {
            state.doc.forEach((node: any, offset: number) => {
              if (node.type.name !== 'paragraph') return;
              if (offset >= to || offset + node.nodeSize <= from) return;
              targets.push({ pos: offset, node });
            });
          }
          if (targets.length === 0) return false;
          let changed = false;
          for (const { pos, node } of targets) {
            const next = { ...node.attrs, ...indents };
            const same =
              (next.indentLeft ?? 0) === (node.attrs.indentLeft ?? 0) &&
              (next.indentRight ?? 0) === (node.attrs.indentRight ?? 0) &&
              (next.firstLineIndent ?? null) === (node.attrs.firstLineIndent ?? null);
            if (same) continue;
            if (dispatch) tr.setNodeMarkup(pos, undefined, next);
            changed = true;
          }
          return changed;
        },

      // M-FLOW — the pagination flags writer: the SAME targeting
      // contract as clearFormatting (every top-level paragraph/heading
      // overlapped by the selection; the caret's own block for an
      // empty selection — Word's dialog semantics: a toggle applies to
      // all of them). Partial writes merge over the current attrs, so
      // the popover's checkboxes are independent; null = unset
      // (inherit the style tier / the document default). No-op writes
      // are skipped (idempotent gestures, one undo step per toggle).
      setFlowAttrs:
        (flow: ParagraphFlowAttrs) =>
        ({ tr, state, dispatch }: { tr: any; state: any; dispatch: any }) => {
          const { $from, $to } = tr.selection;
          const targets: Array<{ pos: number; node: any }> = [];
          state.doc.forEach((node: any, offset: number) => {
            const name = node.type.name;
            if (name !== 'paragraph' && name !== 'heading') return;
            if (offset >= $to.pos || offset + node.nodeSize <= $from.pos) return;
            targets.push({ pos: offset, node });
          });
          if (targets.length === 0) return false;
          const keys = Object.keys(flow) as (keyof ParagraphFlowAttrs)[];
          let changed = false;
          for (const { pos, node } of targets) {
            const differs = keys.some(
              (key) => (node.attrs?.[key] ?? null) !== ((flow[key] ?? null) as unknown),
            );
            if (!differs) continue;
            if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...flow });
            changed = true;
          }
          return changed;
        },

      // INDENT COMMANDS (M6.2): ONE writer — the indentLeft attr, in
      // px, stepped by INDENT_STEP_PX (32, the historical step, now in
      // px on the px attr the ribbon input shows). The legacy `indent`
      // attr is folded in and cleared on the first press (migration),
      // so command, ribbon, engine field, and adapter all agree.
      increaseIndent:
        () =>
        ({ tr, state, dispatch }: { tr: any; state: any; dispatch: any }) => {
          const { $from } = state.selection;
          const pos = $from.before($from.depth);
          const node = state.doc.nodeAt(pos);
          if (!node || node.type.name !== 'paragraph') return false;

          const current = currentIndentLeft(node);
          const next = Math.min(MAX_INDENT_PX, current + INDENT_STEP_PX);
          if (next === current) return false;

          if (dispatch) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: 0, indentLeft: next });
            dispatch(tr);
          }
          return true;
        },

      decreaseIndent:
        () =>
        ({ tr, state, dispatch }: { tr: any; state: any; dispatch: any }) => {
          const { $from } = state.selection;
          const pos = $from.before($from.depth);
          const node = state.doc.nodeAt(pos);
          if (!node || node.type.name !== 'paragraph') return false;

          const current = currentIndentLeft(node);
          if (current <= 0) return false; // at the floor: today's no-op

          const next = Math.max(0, current - INDENT_STEP_PX);
          if (dispatch) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: 0, indentLeft: next });
            dispatch(tr);
          }
          return true;
        },

      clearFormatting:
        () =>
        ({ editor, tr, state, dispatch }: { editor: any; tr: any; state: any; dispatch: any }) => {
          // Word semantics: Clear Formatting resets the STYLE, not
          // just the direct props — headings convert to paragraphs
          // under styleId 'normal' (M-STYLES; the dropdown's apply
          // path shares the rule).
          //
          // Direct tr manipulation, NOT a nested editor.chain(): a
          // nested chain dispatches a second transaction while this
          // command's tr is pending ("applying a mismatched
          // transaction"), and the node-type conversion below makes
          // that combination throw — pinned by the styles-model suite.
          const { empty, ranges } = tr.selection;
          if (!empty) {
            const clearable = Object.values(editor.schema.marks).filter(
              (markType: any) => !editor.extensionManager.nonClearableMarks.includes(markType.name)
            );
            for (const range of ranges) {
              for (const markType of clearable) {
                tr.removeMark(range.$from.pos, range.$to.pos, markType);
              }
            }
          }
          const { $from, $to } = tr.selection;
          const targets: Array<{ pos: number; node: any }> = [];
          state.doc.forEach((node: any, offset: number) => {
            const name = node.type.name;
            if (name !== 'paragraph' && name !== 'heading') return;
            if (offset >= $to.pos || offset + node.nodeSize <= $from.pos) return;
            targets.push({ pos: offset, node });
          });
          for (const { pos, node } of targets) {
            tr.setNodeMarkup(
              pos,
              node.type.name === 'heading' ? state.schema.nodes.paragraph : undefined,
              {
                ...node.attrs,
                lineHeight: null,
                indent: 0,
                textAlign: null,
                styleId: 'normal',
                // M-FLOW: pagination flags are paragraph formatting —
                // Clear Formatting resets them too (Word's rule).
                keepNext: null,
                keepLines: null,
                keepPrevious: null,
                widowControl: null,
                breakBefore: null,
                breakAfter: null,
              }
            );
          }
          if (dispatch) dispatch(tr);
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    /**
     * TAB KEYMAPS (P1 semantics — receipts first, wiring second):
     *  - LIST (receipt: ListItem's Tab→sinkListItem / Shift-Tab→
     *    liftListItem are alive, verified empirically): the list
     *    extensions register before this one, so inside a list their
     *    handlers win. The guard below covers the first-item case
     *    where their sink declines and the event falls through: Tab
     *    there does NOTHING (today's behavior).
     *  - codeBlock (receipt: enableTabIndentation defaults FALSE): a
     *    literal '\t' character (the stock option inserts SPACES —
     *    rejected deliberately).
     *  - paragraph AT BLOCK START (empty selection, pos 0): the GDocs
     *    convention — firstLineIndent += 32. Shift+Tab: −= 32, floored
     *    at 0.
     *  - paragraph MID-LINE: NO-OP v1 (returning true swallows the
     *    keypress so the browser's focus traversal cannot steal focus).
     *    DEFERRED: a tab CHARACTER in prose needs engine tab stops —
     *    issue tree, separate session; do not bolt it on here.
     *  - headings carry no indent attrs (receipt: HeadingWithExtras
     *    adds only lineHeight) → Tab does nothing there.
     *  - ctrl+]/ctrl+[ remain the paragraph indentLeft ±32 commands
     *    (registered, rebindable — see shortcuts.ts).
     */
    const inListItem = ($from: any): boolean => {
      for (let i = $from.depth; i > 0; i--) {
        if ($from.node(i).type.name === 'listItem') return true;
      }
      return false;
    };

    const firstLineIndentOf = (node: { attrs?: Record<string, unknown> }): number =>
      typeof node.attrs?.firstLineIndent === 'number' &&
      Number.isFinite(node.attrs.firstLineIndent) &&
      node.attrs.firstLineIndent > 0
        ? node.attrs.firstLineIndent
        : 0;

    return {
      /**
       * ENTER (M-RULER ruling — the user's deliberate call): paragraph
       * tab stops do NOT continue across Enter — the split's NEW block
       * strips them, so every new line starts with no stops (Word/GDocs
       * continue them; Tensor diverges deliberately). ONE transaction:
       * the chain shares a single tr, so undo collapses Enter to one
       * step. Lists/codeBlock/headings fall through to their own Enter
       * (tabStops only live on top-level paragraphs).
       */
      Enter: () => {
        const { $from, empty } = this.editor.state.selection;
        if ($from.depth !== 1 || $from.parent.type.name !== 'paragraph') return false;
        // ONE transaction: split + strip — one history step, so undo
        // collapses Enter (no stop-resurrection half-step).
        const tr = this.editor.state.tr;
        if (!empty) tr.deleteSelection();
        const pos = tr.selection.$from.pos;
        tr.split(pos, 1);
        // The depth-1 split inserts close+open tokens at `pos` — the
        // NEW paragraph starts at pos + 1. Strip its tab stops (the
        // ruling: stops do not continue across Enter).
        const newBlockPos = pos + 1;
        const node = tr.doc.nodeAt(newBlockPos);
        if (node?.type.name === 'paragraph' && Array.isArray(node.attrs.tabStops)) {
          tr.setNodeMarkup(newBlockPos, undefined, { ...node.attrs, tabStops: null });
        }
        this.editor.view.dispatch(tr);
        return true;
      },

      Tab: () => {
        const { $from, empty } = this.editor.state.selection;
        const name = $from.parent.type.name;

        if (name === 'codeBlock') {
          if (!empty) return false;
          return this.editor.commands.insertContent('\t');
        }
        if (name !== 'paragraph') return false; // headings: nothing today
        if (inListItem($from)) return false; // the list owns Tab

        // BLOCK START (empty caret at offset 0): the GDocs convention —
        // firstLineIndent += 32, one gutter out.
        if (empty && $from.parentOffset === 0) {
          const node = $from.parent;
          return this.editor.commands.updateAttributes('paragraph', {
            firstLineIndent: firstLineIndentOf(node) + INDENT_STEP_PX,
          });
        }

        // M-RULER Phase 4: the deferred tab-CHAR branch lands — the
        // engine's \t advance rule jumps the pen to the next stop (the
        // block's custom stops or the 0.5" default grid), so the cursor
        // lands exactly ON the stop instead of a fixed-width gap. A
        // non-empty selection is replaced by the tab (Word behavior).
        return this.editor.commands.insertContent('\t');
      },

      'Shift-Tab': () => {
        const { $from, empty } = this.editor.state.selection;
        const name = $from.parent.type.name;

        if (name !== 'paragraph') return false;
        if (inListItem($from)) return false;

        // M-RULER Phase 4: mid-line CARET — backtrack to the current
        // tab section's start (just after the nearest preceding \t;
        // already at a section start → chain back one more stop, one
        // stop per press). Non-destructive: the caret MOVE is the
        // backtrack (the destructive un-tab is Backspace's job). No
        // tab behind → the legacy mid-line no-op.
        if (empty && $from.parentOffset > 0) {
          const text = $from.parent.textContent;
          const off = $from.parentOffset;
          let i = off - 1;
          while (i >= 0 && text[i] !== '\t') i--;
          if (i >= 0 && i + 1 === off) {
            // Already AT the section start: chain back one more stop.
            i--;
            while (i >= 0 && text[i] !== '\t') i--;
          }
          if (i >= 0) {
            return this.editor.commands.setTextSelection($from.before(1) + 1 + i + 1);
          }
          return true;
        }
        if (!empty) return true; // non-empty selections: the legacy no-op

        // BLOCK START (offset 0): out-dent, floored at 0 (below that
        // there is nothing to un-indent via Shift+Tab — ctrl+[ owns
        // paragraph indentLeft).
        const node = $from.parent;
        const fli = firstLineIndentOf(node);
        if (fli <= 0) return false;
        return this.editor.commands.updateAttributes('paragraph', {
          firstLineIndent: fli - INDENT_STEP_PX,
        });
      },

      // BACKSPACE STEP (Word/GDocs, P1 ordering): at an indented
      // paragraph's start (empty selection, offset 0), step the
      // FIRST-LINE indent out first; only when that is already 0 does
      // the paragraph indentLeft step (the M6.2 rule). Everything
      // else — normal backspace.
      Backspace: () => {
        const { state } = this.editor;
        const { $from, empty } = state.selection;

        if (!empty || $from.parentOffset !== 0) return false;

        const node = $from.parent;
        if (node.type.name !== 'paragraph') return false;

        const fli = firstLineIndentOf(node);
        if (fli > 0) {
          return this.editor.commands.updateAttributes('paragraph', {
            firstLineIndent: fli - INDENT_STEP_PX,
          });
        }
        if (currentIndentLeft(node) > 0) {
          return this.editor.commands.decreaseIndent();
        }
        return false;
      },
    };
  },
});
