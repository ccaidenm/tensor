import { Mark } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { AddMarkStep, RemoveMarkStep } from '@tiptap/pm/transform';
import { useCommentStore } from '@/lib/comments/store';

/**
 * #COMMENTS — the comment MARK: the ANCHORING half of the two-half
 * model (see comments/store.ts for the ruling). One mark, one attr
 * (`threadId`), all anchoring semantics ride ProseMirror's mark
 * machinery for free:
 *
 *  - inclusive (the mark default): typing at EITHER edge of an anchored
 *    range extends the anchor — the issue's edge-editing rule.
 *  - marks ride getJSON()/setContent verbatim → the .wpdoc round-trip
 *    needs no extra machinery (the ids join to metadata.commentThreads).
 *  - a thread spanning paragraphs/columns/section boundaries is simply
 *    the same threadId on several text runs — PM moves each piece with
 *    its block.
 *  - deleting the full anchored range deletes the marks → the thread
 *    becomes ORPHANED (store record without a live anchor) — the
 *    defined state, never silently gone.
 *
 * RECOGNIZED-QUIET (the indexEntry precedent, adapter.ts's dropped-attr
 * enumeration): the layout adapter never reads this mark — comments
 * cannot change pagination or line layout, structurally. The pageless
 * surface styles the rendered spans via CSS; paginated paints its own
 * overlay from PM positions (the SearchHighlights pattern).
 *
 * THE TRACKING PLUGIN (this mark's own ProseMirror plugins) owns the
 * store-side projections:
 *  - ANCHORED SCAN: on any transaction whose changed ranges touch a
 *    comment mark (a cheap gate — ordinary typing never trips it), a
 *    full-doc scan writes the set of live threadIds to the store. This
 *    is VIEW-state derivation, NOT document data — never markDirty.
 *  - THE JANITOR: marks whose threadId has no store record are stripped
 *    (only reachable via undo-of-delete or a hand-edited file — the
 *    store write order and hydrate-before-load keep it dormant in the
 *    normal flows). Silent strip, undo-asymmetric: documented.
 *  - ACTIVE THREAD: the thread under the caret (selection tracking) —
 *    the gutter's highlight/jump partner.
 */

export const COMMENT_MARK_NAME = 'comment';

/** One anchored span of a thread — PM positions (the spell plugin's
 *  position spelling: ranges survive edits by mapping/rebuilding, so
 *  both view modes project from ONE state). Adjacent same-thread runs
 *  merge; a thread spanning blocks/columns/sections is several ranges. */
export interface CommentRange {
  threadId: string;
  from: number;
  to: number;
}

export interface CommentTrackingState {
  ranges: CommentRange[];
}

/** The tracking plugin's key — PaginatedView's projection reads the
 *  same state the pageless decorations render (the spellPluginKey
 *  pattern: one state, two projections). */
export const commentTrackingKey = new PluginKey<CommentTrackingState>('commentTracking');

/** All comment-marked spans of the doc, merged into per-thread ranges.
 *  Full-doc walk — called on doc/mark-affecting transactions only (the
 *  same gating family as the appendTransaction scan; relayout already
 *  does heavier work per keystroke). */
export function collectCommentRanges(doc: PMNode): CommentRange[] {
  const out: CommentRange[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const m = node.marks.find((mk) => mk.type.name === COMMENT_MARK_NAME);
    if (!m?.attrs.threadId) return true;
    const threadId = m.attrs.threadId as string;
    const last = out[out.length - 1];
    // Adjacent same-thread runs merge (one logical anchor, N text
    // nodes); runs in different blocks never merge (position jump).
    if (last && last.threadId === threadId && last.to === pos) {
      last.to = pos + node.nodeSize;
    } else {
      out.push({ threadId, from: pos, to: pos + node.nodeSize });
    }
    return true;
  });
  return out;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    comment: {
      /** Anchor the (non-empty) selection with a comment thread mark. */
      setComment: (threadId: string) => ReturnType;
      /** Remove the comment mark(s) with this id from the document. */
      unsetComment: (threadId: string) => ReturnType;
    };
  }
}

/** The thread under a caret/selection edge — direct marks at the
 *  position plus the adjacent text node (boundary tolerance: a caret
 *  parked exactly at a range's start/end still reads its thread). */
function threadAtPos(state: EditorState, pos: number): string | null {
  const markType = state.schema.marks.comment;
  if (!markType) return null;
  const $pos = state.doc.resolve(pos);
  const direct = $pos.marks().find((m) => m.type === markType);
  if (direct?.attrs.threadId) return direct.attrs.threadId as string;
  for (const neighbor of [$pos.nodeBefore, $pos.nodeAfter]) {
    if (!neighbor?.isText) continue;
    const m = neighbor.marks.find((mk) => mk.type === markType);
    if (m?.attrs.threadId) return m.attrs.threadId as string;
  }
  return null;
}

/** The ACTIVE-thread decorations (the pageless visual tier): the
 *  caret's thread's ranges get `.tensor-comment-active` on top of the
 *  mark spans' base tint. Live-composed from the cached ranges + the
 *  LIVE activeThreadId (the caret's thread changes on selection moves,
 *  which carry no doc change and must not dispatch) — the spell
 *  decorations are cached state, this tier is a read. Exported for the
 *  tests (the plugin's props wire it directly). */
export function activeCommentDecorations(state: EditorState): DecorationSet {
  const activeId = useCommentStore.getState().activeThreadId;
  if (!activeId) return DecorationSet.empty;
  const ranges = commentTrackingKey.getState(state)?.ranges ?? [];
  const spans = ranges.filter((r) => r.threadId === activeId);
  if (spans.length === 0) return DecorationSet.empty;
  return DecorationSet.create(
    state.doc,
    spans.map((r) => Decoration.inline(r.from, r.to, { class: 'tensor-comment-active' })),
  );
}

export const CommentMark = Mark.create({
  name: COMMENT_MARK_NAME,
  // Typing at either edge grows the anchor (the issue's edge rule);
  // keepOnSplit mirrors IndexMark (an Enter inside a comment keeps the
  // mark on both pieces — one thread, two ranges; the documented paste/
  // split posture).
  keepOnSplit: true,

  addAttributes() {
    return {
      threadId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-comment-thread-id'),
        renderHTML: (attributes) => {
          if (!attributes.threadId) return {};
          return { 'data-comment-thread-id': attributes.threadId as string };
        },
      },
    };
  },

  // CLIPBOARD (the IndexMark law): parseHTML matches ONLY Tensor's own
  // marker — external <span>s never parse in; internal copy/paste
  // round-trips the mark (a pasted copy re-anchors the SAME thread —
  // the documented multi-range posture, single-source-of-truth store).
  parseHTML() {
    return [{ tag: 'span[data-comment-thread-id]' }];
  },

  renderHTML({ mark }) {
    return [
      'span',
      { class: 'tensor-comment-mark', 'data-comment-thread-id': mark.attrs.threadId },
      0,
    ];
  },

  addCommands() {
    return {
      setComment:
        (threadId: string) =>
        ({ state, tr, dispatch }) => {
          const { selection } = state;
          if (selection.empty) return false;
          if (dispatch) {
            tr.addMark(selection.from, selection.to, state.schema.marks.comment.create({ threadId }));
          }
          return true;
        },
      unsetComment:
        (threadId: string) =>
        ({ state, tr, dispatch }) => {
          const markType = state.schema.marks.comment;
          if (dispatch) {
            state.doc.descendants((node, pos) => {
              if (!node.isText) return true;
              const m = node.marks.find((mk) => mk.type === markType && mk.attrs.threadId === threadId);
              if (m) tr.removeMark(pos, pos + node.nodeSize, markType);
              return true;
            });
          }
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: commentTrackingKey,
        // THE SPELL LIFECYCLE (SpellExtension's law): ranges live in PM
        // positions so edits map them for free; membership changes
        // (mark steps) rebuild. The ACTIVE-TINT decorations are NOT
        // cached state — they compose the cached ranges with the LIVE
        // activeThreadId read at decoration time (the caret's thread
        // changes on selection moves, which carry no doc change and
        // must not dispatch).
        state: {
          init: (_, state) => ({ ranges: collectCommentRanges(state.doc) }),
          apply: (tr, prev) => {
            const membershipChanged = tr.steps.some(
              (s) => s instanceof AddMarkStep || s instanceof RemoveMarkStep,
            );
            if (!tr.docChanged && !membershipChanged) return prev;
            // Rebuild on ANY doc change (not a remap): typing at an
            // edge CARRIES the mark to the inserted text (inclusive) —
            // a remap of the old range would miss the grown extent.
            return { ranges: collectCommentRanges(tr.doc) };
          },
        },
        props: {
          decorations: activeCommentDecorations,
        },
        appendTransaction(transactions, oldState, newState) {
          // ── THE GATE: did any changed range (old OR new coords) touch
          // a comment mark? Old ranges catch deletions (the marks are
          // gone from the new doc); new ranges catch setMark/paste. An
          // ordinary keystroke touches no comment marks → null return,
          // zero work. Mark steps count too — Add/RemoveMarkStep leave
          // docChanged FALSE (content untouched) but ARE anchor changes
          // (setComment, the strip, undo of either). Multi-step
          // transactions are the conservative exception: per-step
          // coords live in intermediate docs, so they trip
          // unconditionally (they are rare — composites,
          // multi-removeMark strips, undo batches — and a false trip
          // costs one scan, while a miss would stale the orphan state).
          const relevant = transactions.filter(
            (tr) =>
              tr.docChanged ||
              tr.steps.some((s) => s instanceof AddMarkStep || s instanceof RemoveMarkStep),
          );
          if (relevant.length === 0) return null;
          const oldMarkType = oldState.schema.marks.comment;
          const newMarkType = newState.schema.marks.comment;
          if (!oldMarkType || !newMarkType) return null;
          let touched = relevant.some((tr) => tr.steps.length !== 1);
          if (!touched) {
            for (const tr of relevant) {
              const step = tr.steps[0]!;
              // Mark steps DON'T move positions — their map is identity
              // (map.forEach yields nothing), so the range check below
              // never fires for them. Their own from/to IS the touched
              // range; only COMMENT-mark steps trip (bold/highlight
              // steps never change anchored membership).
              if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
                if (step.mark.type === oldMarkType || step.mark.type === newMarkType) touched = true;
                continue;
              }
              const map = step.getMap();
              map.forEach((oldStart, oldSize, newStart, newSize) => {
                let oldHas = false;
                let newHas = false;
                oldState.doc.nodesBetween(
                  Math.max(0, oldStart - 1),
                  Math.min(oldState.doc.content.size, oldStart + oldSize + 1),
                  (node) => {
                    if (node.isText && node.marks.some((m) => m.type === oldMarkType)) {
                      oldHas = true;
                      return false;
                    }
                    return true;
                  },
                );
                newState.doc.nodesBetween(
                  Math.max(0, newStart - 1),
                  Math.min(newState.doc.content.size, newStart + newSize + 1),
                  (node) => {
                    if (node.isText && node.marks.some((m) => m.type === newMarkType)) {
                      newHas = true;
                      return false;
                    }
                    return true;
                  },
                );
                if (oldHas || newHas) touched = true;
              });
              if (touched) break;
            }
          }
          if (!touched) return null;

          // ── FULL-DOC SCAN (only on touched transactions): live thread
          // ids + marks whose thread is missing from the store.
          const store = useCommentStore.getState();
          const known = new Set(Object.keys(store.threads));
          const anchored = new Set<string>();
          const unknown: Array<{ from: number; to: number }> = [];
          newState.doc.descendants((node, pos) => {
            if (!node.isText) return true;
            const m = node.marks.find((mk) => mk.type === newMarkType);
            if (!m) return true;
            const tid = m.attrs.threadId as string | undefined;
            if (tid && known.has(tid)) anchored.add(tid);
            else unknown.push({ from: pos, to: pos + node.nodeSize });
            return true;
          });
          store.setAnchoredIds(anchored);

          if (unknown.length === 0) return null;

          // ── THE JANITOR: strip marks with no thread record (never
          // render-highlighted, never persisted as orphans — the PM doc
          // stays honest). Silent: the undo-asymmetry is documented in
          // docs/features/comments.md.
          const tr = newState.tr;
          for (const r of unknown) tr.removeMark(r.from, r.to, newMarkType);
          tr.setMeta('commentJanitor', true);
          return tr;
        },
        view: () => ({
          update: (view) => {
            const { state } = view;
            const { selection } = state;
            // The caret's thread: the from-edge's thread (collapsed
            // inside a range → its thread; a range → the thread at its
            // start — the click-to-jump case). Null when in none.
            const tid = threadAtPos(state, selection.from);
            useCommentStore.getState().setActiveThread(tid);
          },
        }),
      }),
    ];
  },
});
