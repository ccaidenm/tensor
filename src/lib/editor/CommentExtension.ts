import { Mark } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { AddMarkStep, RemoveMarkStep } from '@tiptap/pm/transform';
import { useCommentStore } from '@/lib/comments/store';

/**
 * The comment MARK — one attr (`threadId`): inclusive edges grow the
 * anchor; the adapter never reads it (comments cannot move layout).
 * The plugin below tracks live/active threads and strips unknown ones.
 */

export const COMMENT_MARK_NAME = 'comment';

/** One anchored span of a thread — PM positions; adjacent same-thread
 *  runs merge, and a thread spanning blocks/sections is several ranges. */
export interface CommentRange {
  threadId: string;
  from: number;
  to: number;
}

/** A word character for the caret fallback — "what the user means by
 *  the word the cursor is in", not the spell layer's segmentation. */
const WORD_CHAR = /[\p{L}\p{N}'’]/u;

/**
 * The word around a position, or null when the caret sits in no word.
 * A caret at a word/space boundary reads the word on its text side.
 */
export function wordAround(doc: PMNode, pos: number): { from: number; to: number } | null {
  const $pos = doc.resolve(pos);
  let from = pos;
  let to = pos;
  const before = $pos.nodeBefore;
  if (before?.isText && before.text) {
    for (let i = before.text.length - 1; i >= 0; i--) {
      if (!WORD_CHAR.test(before.text[i]!)) break;
      from--;
    }
  }
  const after = $pos.nodeAfter;
  if (after?.isText && after.text) {
    for (let i = 0; i < after.text.length; i++) {
      if (!WORD_CHAR.test(after.text[i]!)) break;
      to++;
    }
  }
  return from === to ? null : { from, to };
}

export interface CommentTrackingState {
  ranges: CommentRange[];
}

/** The tracking plugin's key — both view modes project from this one state. */
export const commentTrackingKey = new PluginKey<CommentTrackingState>('commentTracking');

/** All comment-marked spans of the doc, merged into per-thread ranges.
 *  Full-doc walk — run on mark-affecting transactions only. */
export function collectCommentRanges(doc: PMNode): CommentRange[] {
  const out: CommentRange[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const m = node.marks.find((mk) => mk.type.name === COMMENT_MARK_NAME);
    if (!m?.attrs.threadId) return true;
    const threadId = m.attrs.threadId as string;
    const last = out[out.length - 1];
    // Adjacent same-thread runs merge (one anchor, N text nodes); different blocks never merge.
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

/** The ACTIVE-thread decorations (the pageless tier): the caret's
 *  thread's ranges get `.tensor-comment-active`, composed LIVE from
 *  cached ranges + current activeThreadId (selection moves don't dispatch). */
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
  // Typing at either edge grows the anchor; Enter inside a comment keeps
  // the mark on both pieces (mirrors IndexMark).
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

  // parseHTML matches ONLY Tensor's own marker — external <span>s never
  // parse in; a pasted copy re-anchors the SAME thread (multi-range posture).
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
          // tr.selection (NOT state.selection): a chained
          // setTextSelection updates the TRANSACTION's selection;
          // state's would anchor the pre-selection range.
          const { selection } = tr;
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
        // Ranges live in PM positions (edits map them free; membership
        // changes rebuild). The active-tint decorations are composed
        // live at decoration time with the current activeThreadId
        // (selection moves carry no doc change and must not dispatch).
        state: {
          init: (_, state) => ({ ranges: collectCommentRanges(state.doc) }),
          apply: (tr, prev) => {
            const membershipChanged = tr.steps.some(
              (s) => s instanceof AddMarkStep || s instanceof RemoveMarkStep,
            );
            if (!tr.docChanged && !membershipChanged) return prev;
            // Rebuild on ANY doc change, not a remap: typing at an edge
            // carries the mark to inserted text, which a remap would miss.
            return { ranges: collectCommentRanges(tr.doc) };
          },
        },
        props: {
          decorations: activeCommentDecorations,
        },
        appendTransaction(transactions, oldState, newState) {
          // The gate: old ranges catch deletions, new ranges catch
          // setMark/paste; mark steps count (docChanged stays false).
          // Multi-step transactions trip unconditionally — per-step
          // coords live in intermediate docs.
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
              // Mark steps' map is identity, so the range check never
              // fires for them — only COMMENT-mark steps trip.
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

          // Full-doc scan (touched transactions only): live thread ids
          // + marks whose thread is missing from the store.
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

          // The janitor: strip marks with no thread record — silently
          // (the undo-asymmetry is documented in docs/features/comments.md).
          const tr = newState.tr;
          for (const r of unknown) tr.removeMark(r.from, r.to, newMarkType);
          tr.setMeta('commentJanitor', true);
          return tr;
        },
        view: () => ({
          update: (view) => {
            const { state } = view;
            const { selection } = state;
            // The caret's thread: collapsed inside a range → its thread;
            // a range → the thread at its start (click-to-jump case).
            const tid = threadAtPos(state, selection.from);
            useCommentStore.getState().setActiveThread(tid);
          },
        }),
      }),
    ];
  },
});
