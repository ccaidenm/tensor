import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { undo as pmUndo, redo as pmRedo } from '@tiptap/pm/history';
import {
  currentPageSetup,
  currentPageStyles,
  nextPending,
  peekPageSetupRedo,
  peekPageSetupUndo,
  popPageSetupRedo,
  popPageSetupUndo,
  pushPageSetupRedo,
  pushPageSetupUndo,
  restorePageSetup,
  PAGE_SETUP_MARKER,
  PAGE_SETUP_SYNTH_UNDO,
  PAGE_SETUP_SYNTH_REDO,
  type PageSetupPendingState,
} from '@/lib/editor/pageSetupHistory';

/**
 * #58 — undo/redo with the page-setup co-restore: the store's
 * pageSetup lives outside PM, so raw history would half-undo a
 * page-setup action; this restores the store side in the same step.
 */
export const PAGE_SETUP_HISTORY_KEY = new PluginKey<PageSetupPendingState>('pageSetupHistoryPending');

export const PageSetupHistoryExtension = Extension.create({
  name: 'pageSetupHistory',

  addProseMirrorPlugins() {
    return [
      new Plugin<PageSetupPendingState>({
        key: PAGE_SETUP_HISTORY_KEY,
        state: {
          init: () => ({ pending: null, redoNonEmpty: false }),
          apply(tr, prev) {
            // OURS: a page-setup transaction (the history-joined ones
            // carry the marker) — a new action also clears PM's redo.
            if (tr.getMeta(PAGE_SETUP_MARKER)) {
              return { pending: nextPending(prev.pending, 'ours'), redoNonEmpty: false };
            }
            // #48 — the synthetic movements (store-only writes stand
            // in for the history trs that never dispatch for them).
            if (tr.getMeta(PAGE_SETUP_SYNTH_UNDO)) {
              return { pending: nextPending(prev.pending, 'history-undo'), redoNonEmpty: prev.redoNonEmpty };
            }
            if (tr.getMeta(PAGE_SETUP_SYNTH_REDO)) {
              return { pending: nextPending(prev.pending, 'history-redo'), redoNonEmpty: prev.redoNonEmpty };
            }
            // prosemirror-history's undo/redo trs carry its plugin meta
            // — detected by SHAPE, not key name (the key dedupes to
            // 'history$' on collisions); the undone stack tells redo survival.
            const meta = (tr as unknown as { meta?: Record<string, unknown> }).meta ?? {};
            const hist = Object.values(meta).find(
              (v) =>
                v != null &&
                typeof v === 'object' &&
                'redo' in v &&
                'historyState' in v,
            ) as { redo?: boolean; historyState?: { undone?: { items?: unknown[] } } } | undefined;
            if (hist) {
              return {
                pending: nextPending(prev.pending, hist.redo ? 'history-redo' : 'history-undo'),
                redoNonEmpty: (hist.historyState?.undone?.items?.length ?? 0) > 0,
              };
            }
            // A foreign RECORDED transaction buries ours AND empties
            // PM's redo (the standard rule).
            if (tr.docChanged && tr.getMeta('addToHistory') !== false) {
              return { pending: nextPending(prev.pending, 'foreign-recorded'), redoNonEmpty: false };
            }
            return prev;
          },
        },
      }),
    ];
  },

  addCommands() {
    return {
      undo:
        () =>
        // TipTap's contract: build from the PROVIDED state, dispatch
        // through the PROVIDED dispatcher — post-dispatch doc reads come
        // from the ENTRY's snapshots, never live.
        ({ state, dispatch, view }) => {
          const top = peekPageSetupUndo();
          const { pending, redoNonEmpty } = PAGE_SETUP_HISTORY_KEY.getState(state) ?? { pending: null, redoNonEmpty: false };
          // The precise path: our item is PM's done-top. The recovery
          // path: a foreign undo happened (redo stack survives) — the
          // redo-stack signal separates it from a net-zero edit cycle.
          const precise = pending === 'undo';
          const recovered = pending === null && redoNonEmpty;
          if (top && (precise || recovered) && state.doc.eq(top.docAfter)) {
            // OURS — one Ctrl+Z reverts the PM and store parts together.
            // #48 — STORE-ONLY entries recorded nothing in PM; pmUndo
            // would pop an unrelated item. Content-equal before/after
            // docs are the store-only signature: PM must not move.
            const storeOnly = top.docAfter.eq(top.docBefore);
            popPageSetupUndo();
            const nextSetup = currentPageSetup();
            if (!storeOnly) pmUndo(state, dispatch, view);
            // The redo entry: next = the setup the undo replaced; docs
            // are the ORIGINAL action's write-time snapshots (immune to
            // the deferred dispatch). #48: undefined restores nothing.
            pushPageSetupRedo({
              next: nextSetup,
              nextPageStyles: top.prevPageStyles !== undefined ? currentPageStyles() : undefined,
              docAfter: top.docAfter,
              docBefore: top.docBefore,
            });
            restorePageSetup(top.prev, top.prevPageStyles);
            // #48 — the synthetic movement: a store-only write's pmUndo
            // dispatched nothing; flip the pending state so REDO can
            // fire (idempotent when a real history tr did it first).
            if (dispatch) {
              const tr = state.tr;
              tr.setMeta(PAGE_SETUP_SYNTH_UNDO, true);
              dispatch(tr);
            }
            return true;
          }
          return pmUndo(state, dispatch, view) ?? true;
        },
      redo:
        () =>
        ({ state, dispatch, view }) => {
          const top = peekPageSetupRedo();
          const { pending } = PAGE_SETUP_HISTORY_KEY.getState(state) ?? { pending: null };
          if (top && pending === 'redo' && state.doc.eq(top.docBefore)) {
            // OURS — one Ctrl+Y re-applies the PM part and the store part.
            popPageSetupRedo();
            const prev = currentPageSetup();
            // #48 — the store-only mirror: PM recorded nothing for this
            // write; pmRedo would re-apply an UNRELATED undone item.
            if (!top.docAfter.eq(top.docBefore)) pmRedo(state, dispatch, view);
            // The undo entry: the ORIGINAL action's snapshots (prev =
            // the undone setup as its previous value). #48: the map
            // mirrors — captured only when the redo restores one.
            pushPageSetupUndo(
              prev,
              top.docAfter,
              top.docBefore,
              top.nextPageStyles !== undefined ? currentPageStyles() : undefined,
            );
            restorePageSetup(top.next, top.nextPageStyles);
            // #48 — the synthetic movement, redo-side mirror.
            if (dispatch) {
              const tr = state.tr;
              tr.setMeta(PAGE_SETUP_SYNTH_REDO, true);
              dispatch(tr);
            }
            return true;
          }
          return pmRedo(state, dispatch, view) ?? true;
        },
    };
  },
});
