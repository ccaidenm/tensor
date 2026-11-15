import { Extension } from '@tiptap/core';
import { undo as pmUndo, redo as pmRedo } from '@tiptap/pm/history';
import {
  currentPageSetup,
  peekPageSetupRedo,
  peekPageSetupUndo,
  popPageSetupRedo,
  popPageSetupUndo,
  pushPageSetupRedo,
  pushPageSetupUndo,
  restorePageSetup,
} from '@/lib/editor/pageSetupHistory';

/**
 * #58 — the undo/redo COMMANDS with the page-setup co-restore: the
 * store's pageSetup lives outside ProseMirror, so the raw history
 * would half-undo a page-setup action (the break nodes revert, the
 * final section keeps the new values). This override runs the SAME PM
 * undo/redo, and when the page-setup write is the NEWEST recorded
 * action (the doc-snapshot correlation in pageSetupHistory.ts), it
 * restores the store side in the SAME step.
 *
 * Registers after StarterKit's history — the last command definition
 * wins, and EVERY surface (shortcuts, palette, context menu, ribbon)
 * routes through editor.commands.undo()/redo().
 */
export const PageSetupHistoryExtension = Extension.create({
  name: 'pageSetupHistory',

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
          if (top && state.doc.eq(top.docAfter)) {
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
          if (top && state.doc.eq(top.docBefore)) {
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
