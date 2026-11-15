import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { undo as pmUndo, redo as pmRedo } from '@tiptap/pm/history';
import {
  currentPageSetup,
  nextPending,
  peekPageSetupRedo,
  peekPageSetupUndo,
  popPageSetupRedo,
  popPageSetupUndo,
  pushPageSetupRedo,
  pushPageSetupUndo,
  restorePageSetup,
  PAGE_SETUP_MARKER,
  type PageSetupPendingState,
} from '@/lib/editor/pageSetupHistory';

/**
 * #58 — the undo/redo COMMANDS with the page-setup co-restore: the
 * store's pageSetup lives outside ProseMirror, so the raw history
 * would half-undo a page-setup action (the break nodes revert, the
 * final section keeps the new values). This override runs the SAME PM
 * undo/redo, and when the page-setup write is the NEWEST recorded
 * action (the doc-snapshot + pending correlation in
 * pageSetupHistory.ts), it restores the store side in the SAME step.
 *
 * Registers after StarterKit's history — the last command definition
 * wins, and EVERY surface (shortcuts, palette, context menu, ribbon)
 * routes through editor.commands.undo()/redo().
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
            // A PM undo/redo movement: prosemirror-history's own
            // undo/redo transactions carry its plugin meta ({ redo,
            // historyState }) — detected by SHAPE, not by key name (the
            // key dedupes to 'history$' when the name collides). The
            // meta's historyState IS the post-movement state — its
            // undone stack tells whether a redo stack survives.
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
        // TipTap's command contract: build from the PROVIDED state and
        // dispatch through the PROVIDED dispatcher (a deferred dispatch —
        // post-dispatch doc reads come from the ENTRY's snapshots, never
        // live).
        ({ state, dispatch, view }) => {
          const top = peekPageSetupUndo();
          const { pending, redoNonEmpty } = PAGE_SETUP_HISTORY_KEY.getState(state) ?? { pending: null, redoNonEmpty: false };
          // The precise path: our item is PM's done-top. The RECOVERY
          // path: a foreign edit was undone since (pending null after
          // the burial, but PM's redo stack survives) — the doc
          // snapshot alone can't tell these from a net-zero edit
          // cycle's coincidence, the redo-stack signal can.
          const precise = pending === 'undo';
          const recovered = pending === null && redoNonEmpty;
          if (top && (precise || recovered) && state.doc.eq(top.docAfter)) {
            // OURS — one Ctrl+Z reverts the PM part and the store part.
            popPageSetupUndo();
            const nextSetup = currentPageSetup();
            pmUndo(state, dispatch, view);
            // The REDO entry: next = the setup the undo replaced; the
            // docs are the ORIGINAL action's snapshots (captured at
            // write time — immune to the deferred dispatch).
            pushPageSetupRedo({ next: nextSetup, docAfter: top.docAfter, docBefore: top.docBefore });
            restorePageSetup(top.prev);
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
            pmRedo(state, dispatch, view);
            // The undo entry: the ORIGINAL action's snapshots (prev =
            // the undone setup as its previous value).
            pushPageSetupUndo(prev, top.docAfter, top.docBefore);
            restorePageSetup(top.next);
            return true;
          }
          return pmRedo(state, dispatch, view) ?? true;
        },
    };
  },
});
