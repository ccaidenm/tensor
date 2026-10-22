import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorState } from '@tiptap/pm/state';
import type { SpellError } from './types';

/**
 * The spell-check STATE HOLDER — the search pattern, one word at a
 * time: a PM plugin whose state is the single source of truth for
 * flagged spans, expressed in PM positions so it survives edits by
 * MAPPING (never re-derivation). The two view modes project it:
 *
 *  - PAGES: PaginatedView maps error ranges through positionMap into
 *    flat underline bars (SpellHighlights) — the SearchHighlights
 *    projection, underline-shaped (paint.ts's own bar geometry).
 *  - PAGELESS/fallback: the plugin's DecorationSet renders the
 *    .tensor-spell-error class in the visible DOM.
 *
 * WHY NOT ONLY DECORATIONS: the hidden view (L3) never paints; the
 * decoration set is the pageless visual AND the test surface, while
 * the errors array is the data both views + the suggestion bubble
 * read. One state, two projections.
 *
 * LIFECYCLE (the live-update law): results arrive ASYNC from the
 * LanguageTool client, so between a keystroke and its recheck the
 * stored errors must still track the text —
 *  - unrelated edits (before/after a flagged word): ranges MAP
 *    (insertion at a boundary uses sticky assoc so the span never
 *    absorbs neighboring text);
 *  - edits INSIDE a flagged word: the text-at-range no longer equals
 *    `word` → the error is dropped INSTANTLY (unflag-as-typed); the
 *    debounced recheck re-flags whatever is still misspelled.
 */
export interface SpellPluginState {
  errors: SpellError[];
  decorations: DecorationSet;
}

/** A top-level block's PM span — setErrors replaces all errors inside
 *  these spans (block-scoped recheck; the controller computes them). */
export interface SpellBlockRange {
  blockId: string;
  from: number;
  to: number;
}

export type SpellMeta =
  | { type: 'setErrors'; errors: SpellError[]; blocks: SpellBlockRange[] }
  | { type: 'ignoreWord'; word: string }
  | { type: 'ignoreRule'; ruleId: string }
  | { type: 'clear' };

export const spellPluginKey = new PluginKey<SpellPluginState>('spell');

/** The decoration class per feature kind — the pageless visual (Pages
 *  mode colors the overlay bars the same way via SpellHighlights). */
function classForKind(kind: SpellError['kind']): string {
  return kind === 'grammar' ? 'tensor-grammar-error' : 'tensor-spell-error';
}

function buildDecorations(doc: import('@tiptap/pm/model').Node, errors: readonly SpellError[]): DecorationSet {
  return DecorationSet.create(
    doc,
    errors.map((e) => Decoration.inline(e.from, e.to, { class: classForKind(e.kind) })),
  );
}

/** The flagged text at a (possibly remapped) range, for the
 *  drop-on-content-edit guard. Clamped to the doc — a stale/malformed
 *  range (e.g. beyond doc end) reads as "" ≠ word and gets dropped;
 *  it must NEVER throw, or one bad range would kill every subsequent
 *  transaction's dispatch. */
function textAtRange(state: EditorState, from: number, to: number): string {
  const size = state.doc.content.size;
  const f = Math.max(0, Math.min(from, size));
  const t = Math.max(f, Math.min(to, size));
  return state.doc.textBetween(f, t, '\n');
}

function createSpellPlugin() {
  return new Plugin<SpellPluginState>({
    key: spellPluginKey,
    state: {
      init(): SpellPluginState {
        return { errors: [], decorations: DecorationSet.empty };
      },
      apply(tr, prev, _oldState, newState): SpellPluginState {
        const meta = tr.getMeta(spellPluginKey) as SpellMeta | undefined;
        let errors = prev.errors;

        if (meta?.type === 'clear') {
          errors = [];
        } else if (meta?.type === 'ignoreWord') {
          const word = meta.word.toLowerCase();
          errors = errors.filter((e) => e.word.toLowerCase() !== word);
        } else if (meta?.type === 'ignoreRule') {
          // Grammar's ignore: rule-scoped, not word-scoped — one false
          // positive kills the whole RULE for the session.
          errors = errors.filter((e) => e.ruleId !== meta.ruleId);
        } else if (meta?.type === 'setErrors') {
          // Block-scoped replacement: fresh results for the rechecked
          // blocks (they all live inside `blocks`); everything outside
          // is by-construction still valid (unchanged nodes — the
          // identity cache proof) and survives untouched.
          errors = [
            ...prev.errors.filter((e) => !meta.blocks.some((b) => e.from >= b.from && e.to <= b.to)),
            ...meta.errors,
          ].sort((a, b) => a.from - b.from);
        }

        if (tr.docChanged) {
          errors = errors
            .map((e) => ({
              ...e,
              // Sticky assoc: insertion exactly at `from` pushes the
              // span forward (the new text is not part of the word);
              // insertion exactly at `to` stays out (same rule).
              from: tr.mapping.map(e.from, 1),
              to: tr.mapping.map(e.to, -1),
            }))
            // Collapsed (fully deleted) or content-edited spans die
            // immediately — the instant-unflag law.
            .filter((e) => e.to > e.from && textAtRange(newState, e.from, e.to) === e.word);
        }

        if (errors === prev.errors && !meta) return prev;
        return { errors, decorations: buildDecorations(newState.doc, errors) };
      },
    },
    props: {
      decorations(state) {
        return spellPluginKey.getState(state)?.decorations;
      },
    },
  });
}

export interface SpellStorage {
  errors: SpellError[];
}

declare module '@tiptap/core' {
  interface Storage {
    spell: SpellStorage;
  }

  interface Commands<ReturnType> {
    spell: {
      /** Replace the errors inside the given block spans with fresh
       *  results (block-scoped recheck); errors outside survive. */
      setSpellErrors: (errors: SpellError[], blocks: SpellBlockRange[]) => ReturnType;
      /** Drop every current flag of this word (case-insensitive) — the
       *  add-to-dictionary / ignore-all immediate receipt. */
      ignoreSpellWord: (word: string) => ReturnType;
      /** Grammar's twin: drop every flag of this RULE — the
       *  ignore-rule immediate receipt (one false positive, whole
       *  rule, this session). */
      ignoreSpellRule: (ruleId: string) => ReturnType;
      clearSpellErrors: () => ReturnType;
    };
  }
}

export const SpellExtension = Extension.create<Record<string, never>, SpellStorage>({
  name: 'spell',

  addStorage() {
    return { errors: [] };
  },

  onTransaction() {
    const state = spellPluginKey.getState(this.editor.state);
    if (state) this.storage.errors = state.errors;
  },

  addCommands() {
    return {
      setSpellErrors:
        (errors, blocks) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(spellPluginKey, { type: 'setErrors', errors, blocks });
            dispatch(tr);
          }
          return true;
        },

      ignoreSpellWord:
        (word) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(spellPluginKey, { type: 'ignoreWord', word });
            dispatch(tr);
          }
          return true;
        },

      ignoreSpellRule:
        (ruleId) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(spellPluginKey, { type: 'ignoreRule', ruleId });
            dispatch(tr);
          }
          return true;
        },

      clearSpellErrors:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(spellPluginKey, { type: 'clear' });
            dispatch(tr);
          }
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [createSpellPlugin()];
  },
});

/** Live error list read from PM state (the bubble + both projections
 *  read this, never a stale storage copy). */
export function getSpellErrors(state: EditorState): readonly SpellError[] {
  return spellPluginKey.getState(state)?.errors ?? [];
}

/** The error whose span contains `pos` (right/left-click lookup), if any. */
export function spellErrorAt(state: EditorState, pos: number): SpellError | undefined {
  return getSpellErrors(state).find((e) => e.from <= pos && pos < e.to);
}
