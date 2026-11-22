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
 * Pagination flags (engine FlowPolicy, OOXML-mirrored names; keepPrevious
 * and breakAfter are the Tensor superset). null = UNSET — inherits the
 * style tier / doc default; the data-* spelling survives copy/paste.
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
 * The table-level subset: the five flags meaningful for a table block.
 * widowControl is EXCLUDED — the engine ignores boundary minimums
 * between a table's bands, so the flag is inert there.
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
 * The ribbon's mixed-state reader: each flag's uniform EFFECTIVE state
 * (the same cascade the adapter runs) or 'mixed'; widowControl is ON
 * when unset, the rest OFF. Top-level paragraphs/headings only.
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
 * The ribbon's line-spacing reader: the selection's uniform EFFECTIVE
 * multiplier, or null when it disagrees or any block carries a px
 * spelling. Cascade: direct attr over style tier over the 1.0 default.
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
 * FIRST-LINE INDENT: px, may be NEGATIVE (hanging indent). Round-trips
 * through CSS text-indent (the pageless spelling) and the engine's
 * firstLineIndent (identical semantics); null = unset.
 */
const firstLineIndentAttribute = {
  firstLineIndent: {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const raw = element.style.textIndent;
      if (!raw) return null;
      const v = parseFloat(raw);
      if (!Number.isFinite(v)) return null;
      // pt at the data boundary — the chrome speaks pt, the core px.
      return raw.trim().endsWith('pt') ? Math.round(v * (96 / 72)) : v;
    },
    renderHTML: (attributes: { firstLineIndent?: number | null }) => {
      if (attributes.firstLineIndent == null) return {};
      return { style: `text-indent: ${attributes.firstLineIndent}px` };
    },
  },
};

/**
 * LEGACY `indent` attr (steps of 32px): kept for round-trips of old
 * files; the commands no longer write it. The adapter folds it into
 * indentLeft, and the first indent press migrates it away.
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

/** The paragraph's EFFECTIVE left indent (px): indentLeft plus the
 *  legacy `indent` steps folded in — the ONE reader (commands and the
 *  ruler projection), so the legacy fold can never fork. */
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
 * TAB STOPS: the engine's TabStop objects — px from the CONTENT-BOX
 * LEFT EDGE (indent edits never move stops), sorted/deduped, null =
 * none. Round-trips via data-tab-stops; .wpdoc rides the docJSON.
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
 * The paragraph's STYLE IDENTITY — a registry reference, not stamped
 * attrs; every paragraph carries one (default 'normal' — no migration
 * pass). Direct attrs beat the class: the cascade (direct > style).
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
 * The ENTRY ID: a referenceTable paragraph carries its scan entry's
 * reconciliation key — an unchanged key is never rewritten, so the
 * user's formatting survives refresh. Round-trips null, never DOM ink.
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

/** Headings carry `heading-{level}` as their style identity (attr
 *  default; HeadingSync maintains it reactively) — the adapter resolves
 *  through the same tier, so a pre-sync node never renders wrong. */
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
 * The caret's RULER-EDITABLE PARAGRAPH: top-level paragraphs and band
 * children qualify; list-item/blockquote paragraphs do NOT (ruler is
 * margins-only there). One acceptance rule, shared commands + ruler.
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

      // TAB STOPS: ONE writer — the tabStops attr, normalized on the way
      // in. Caret's block (empty selection) or every overlapped top-level
      // paragraph (range); no-change writes skipped (one undo per gesture).
      setTabStops:
        (stops: TabStop[]) =>
        ({ tr, state, dispatch }: { tr: any; state: any; dispatch: any }) => {
          const normalized = normalizeTabStops(stops);
          const { empty, from, to, $from } = tr.selection;
          const targets: Array<{ pos: number; node: any }> = [];
          if (empty) {
            // `$from.before(1)` is the BAND CONTAINER here, not the
            // paragraph — resolve through caretEditableParagraph.
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

      // INDENT DRAG WRITER: same targeting as setTabStops; absolute px
      // values, no-change writes skipped (idempotent, one undo step per
      // gesture).
      setIndents:
        (indents: { indentLeft?: number; indentRight?: number; firstLineIndent?: number }) =>
        ({ tr, state, dispatch }: { tr: any; state: any; dispatch: any }) => {
          const { empty, from, to, $from } = tr.selection;
          const targets: Array<{ pos: number; node: any }> = [];
          if (empty) {
            // Band-aware (see setTabStops).
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

      // The pagination flags writer: same targeting as clearFormatting;
      // partial writes merge over current attrs (checkboxes are
      // independent); null = unset; no-change writes skipped.
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

      // INDENT COMMANDS: ONE writer — the indentLeft attr, px, stepped
      // 32. The legacy `indent` attr is folded in and cleared on the
      // first press (migration).
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
          // Word semantics: resets the STYLE — headings become
          // paragraphs under styleId 'normal'. Direct tr, NOT a nested
          // chain: a second dispatch against the pending tr throws.
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
                // Pagination flags are paragraph formatting — reset too (Word's rule).
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
     * Tab semantics: list extensions' handlers win inside lists (registered
     * earlier). codeBlock inserts a literal '\t'; block start indents ±32
     * (GDocs); mid-line inserts a tab character.
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
       * Paragraph tab stops do NOT continue across Enter — the split's
       * NEW block strips them (Word/GDocs continue them; deliberate
       * divergence). One tr: undo collapses Enter to one step.
       */
      Enter: () => {
        const { $from, empty } = this.editor.state.selection;
        if ($from.depth !== 1 || $from.parent.type.name !== 'paragraph') return false;
        const tr = this.editor.state.tr;
        if (!empty) tr.deleteSelection();
        const pos = tr.selection.$from.pos;
        tr.split(pos, 1);
        // The depth-1 split's NEW paragraph starts at pos + 1 — strip
        // its tab stops (stops do not continue across Enter).
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

        // MID-LINE: a tab character — the engine's \t advance jumps to
        // the next stop (custom stops or the 0.5" grid). A non-empty
        // selection is replaced by the tab (Word behavior).
        return this.editor.commands.insertContent('\t');
      },

      'Shift-Tab': () => {
        const { $from, empty } = this.editor.state.selection;
        const name = $from.parent.type.name;

        if (name !== 'paragraph') return false;
        if (inListItem($from)) return false;

        // Mid-line CARET: backtrack to the current tab section's start
        // (non-destructive — the un-tab is Backspace's job); no tab
        // behind → the legacy no-op.
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

        // BLOCK START: out-dent, floored at 0 (ctrl+[ owns indentLeft below that).
        const node = $from.parent;
        const fli = firstLineIndentOf(node);
        if (fli <= 0) return false;
        return this.editor.commands.updateAttributes('paragraph', {
          firstLineIndent: fli - INDENT_STEP_PX,
        });
      },

      // BACKSPACE STEP (Word/GDocs): at an indented paragraph's start,
      // step the FIRST-LINE indent out first; only when that is 0 does
      // the paragraph indentLeft step.
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
