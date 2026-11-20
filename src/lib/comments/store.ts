import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { useDocumentStore } from '@/lib/document/store';
import { useConfigStore } from '@/lib/config/store';

/**
 * #COMMENTS — the thread-content store, beside the document store.
 *
 * THE TWO-HALF MODEL: the ANCHORING half lives in the PM document (the
 * `comment` mark, attrs.threadId — CommentExtension.ts) and rides
 * docJSON like any content; the CONTENT half (entries, authors,
 * timestamps, resolved) lives HERE and travels in .wpdoc metadata as
 * `metadata.commentThreads` (the lineNumbers optional-field precedent).
 * The ids are the JOIN: one nanoid minted at creation names both the
 * mark's threadId and the store record.
 *
 * Why a separate store and not PM attrs: entries/replies/resolution are
 * document DATA that must survive save/close/reopen, but they are not
 * prose — putting them in the PM doc would make every comment edit a
 * document transaction (undo history pollution, layout rescans). The
 * store is the deliberate sidecar; `threadsForSave` + `hydrate` are the
 * file seam, exactly like pageStyles/lineNumbers.
 *
 * SESSION-ONLY fields (never persisted): activeThreadId (the caret's
 * thread — like the search plugin's current match), showResolved (the
 * gutter's reveal toggle). Every launch starts with them default.
 *
 * THE LOAD-ORDER LAW: on every open path (wpdoc/markdown/docx, and the
 * future recovery-restore UI), `hydrate` runs BEFORE editor.setContent
 * — the tracking plugin's janitor strips marks whose threadId has no
 * store record, so a late hydrate would destroy the freshly-loaded
 * document's anchors (openDocument does the ordering; the media-store
 * precedent — openV2 feeds the MediaStore during open).
 */

export interface CommentEntry {
  id: string;
  /** The author display name at entry time (never re-resolved — a
   *  historical record, like DOCX's w:author). */
  author: string;
  text: string;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of the last text edit, absent = never edited. */
  editedAt?: string;
}

export interface CommentThread {
  /** = the comment mark's threadId (the JOIN, stable across saves). */
  id: string;
  /** First entry = the thread's opening comment; the rest are replies,
   *  in conversation order. ≥1 always (deleting the last entry deletes
   *  the thread — GDocs behavior). */
  entries: CommentEntry[];
  resolved: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
}

interface CommentStore {
  threads: Record<string, CommentThread>;
  /** Thread ids with ≥1 live mark in the PM doc — the tracking
   *  plugin's scan write. A thread WITHOUT its id here is ORPHANED (the
   *  full range was deleted): visible in the gutter with a clear
   *  affordance, never silently gone. */
  anchoredIds: ReadonlySet<string>;
  /** The thread under the caret (selection tracking). */
  activeThreadId: string | null;
  /** Resolved threads hidden by default; the gutter's show toggle. */
  showResolved: boolean;
  /** The in-flight DRAFT (session-only): the thread the user just
   *  anchored and is composing the first entry for. Its card renders
   *  as a composer; submit fills the text, cancel deletes the thread
   *  (and its mark). The GDocs comment flow. */
  draftThreadId: string | null;

  /** The open-path seam: replaces ALL thread state (stale ghosts from
   *  the previously-open document must never survive an open). Threads
   *  whose entries are ALL empty text are IN-FLIGHT DRAFTS — they do
   *  not survive a reopen (the GDocs discard-on-close behavior; the
   *  empty-anchor mark is janitor-stripped as part of the same rule). */
  hydrate: (threads: CommentThread[]) => void;
  /** The tracking plugin's doc-scan write (anchored membership). */
  setAnchoredIds: (ids: ReadonlySet<string>) => void;
  setActiveThread: (id: string | null) => void;
  setShowResolved: (show: boolean) => void;

  /** Create a thread (the FIRST entry). The command mints the id and
   *  calls this BEFORE setMark (the WRITE-ORDER law: the janitor must
   *  never observe a mark whose thread is not yet in the store). */
  addThread: (threadId: string, text: string) => void;
  /** The comment flow: an anchored draft (an empty first entry) the
   *  composer fills. Submit fills the entry text and clears the draft
   *  flag; cancel deletes the thread AND its mark. */
  startDraft: (threadId: string) => void;
  submitDraft: (threadId: string, text: string) => void;
  cancelDraft: (threadId: string) => void;
  addReply: (threadId: string, text: string) => void;
  editEntry: (threadId: string, entryId: string, text: string) => void;
  /** Deleting the thread's LAST entry deletes the thread (and its
   *  marks — GDocs behavior). */
  deleteEntry: (threadId: string, entryId: string) => void;
  /** Deletes the thread AND strips its marks via the editor (the
   *  gutter's delete; never a silent ghost). */
  deleteThread: (threadId: string) => void;
  setResolved: (threadId: string, resolved: boolean) => void;

  /** The save seam: threads as an ordered array (absent-when-empty is
   *  the caller's job — assembleDocumentFile spreads conditionally).
   *  In-flight drafts write WITH their empty entry (session data — a
   *  crash mid-draft keeps the anchor; a REOPEN prunes empty threads,
   *  see hydrate). */
  threadsForSave: () => CommentThread[];
}

/** The author display name for a NEW entry: the document's own author
 *  (Properties dialog / DOCX import), else the app identity (Settings
 *  > General > User — the pristine-document posture), else Anonymous. */
function currentAuthor(): string {
  const docAuthor = useDocumentStore.getState().coreProperties.author;
  if (docAuthor) return docAuthor;
  const { config } = useConfigStore.getState();
  return config.identity.author || 'Anonymous';
}

/** Card initials: the first letters of the first two words, uppercased
 *  ("Ada Lovelace" → "AL", "Anonymous" → "A"). */
export function authorInitials(author: string): string {
  const words = author.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const initials = words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return initials;
}

export const useCommentStore = create<CommentStore>((set, get) => ({
  threads: {},
  anchoredIds: new Set<string>(),
  activeThreadId: null,
  showResolved: false,
  draftThreadId: null,

  hydrate: (threads) => {
    const record: Record<string, CommentThread> = {};
    for (const t of threads) {
      // In-flight drafts (ALL entries empty) do not survive a reopen —
      // the GDocs discard-on-close behavior; the janitor strips their
      // now-unknown marks as part of the same rule.
      if (t.entries.every((e) => e.text.trim() === '')) continue;
      record[t.id] = t;
    }
    // activeThreadId resets (the caret's thread belongs to the OLD
    // document); showResolved is session-only and deliberately rides.
    set({ threads: record, anchoredIds: new Set<string>(), activeThreadId: null, draftThreadId: null });
  },

  setAnchoredIds: (ids) => {
    const { anchoredIds } = get();
    // Membership-compare (not reference): the scan runs on every
    // touched keystroke — an equal Set must not re-render subscribers.
    if (ids.size === anchoredIds.size && [...ids].every((id) => anchoredIds.has(id))) return;
    set({ anchoredIds: ids });
  },

  setActiveThread: (id) => {
    if (get().activeThreadId === id) return;
    set({ activeThreadId: id });
  },

  setShowResolved: (show) => set({ showResolved: show }),

  addThread: (threadId, text) => {
    const entry: CommentEntry = {
      id: nanoid(),
      author: currentAuthor(),
      text,
      createdAt: new Date().toISOString(),
    };
    const thread: CommentThread = { id: threadId, entries: [entry], resolved: false };
    set((state) => ({ threads: { ...state.threads, [threadId]: thread } }));
    useDocumentStore.getState().markDirty();
  },

  startDraft: (threadId) => {
    const entry: CommentEntry = {
      id: nanoid(),
      author: currentAuthor(),
      text: '',
      createdAt: new Date().toISOString(),
    };
    const thread: CommentThread = { id: threadId, entries: [entry], resolved: false };
    set((state) => ({ threads: { ...state.threads, [threadId]: thread }, draftThreadId: threadId }));
    useDocumentStore.getState().markDirty();
  },

  submitDraft: (threadId, text) => {
    set((state) => {
      const thread = state.threads[threadId];
      if (!thread || state.draftThreadId !== threadId) return state;
      return {
        threads: {
          ...state.threads,
          [threadId]: { ...thread, entries: thread.entries.map((e, i) => (i === 0 ? { ...e, text } : e)) },
        },
        draftThreadId: null,
      };
    });
    useDocumentStore.getState().markDirty();
  },

  cancelDraft: (threadId) => {
    if (get().draftThreadId !== threadId) return;
    set({ draftThreadId: null });
    get().deleteThread(threadId);
  },

  addReply: (threadId, text) => {
    const entry: CommentEntry = {
      id: nanoid(),
      author: currentAuthor(),
      text,
      createdAt: new Date().toISOString(),
    };
    set((state) => {
      const thread = state.threads[threadId];
      if (!thread) return state;
      return {
        threads: {
          ...state.threads,
          [threadId]: { ...thread, entries: [...thread.entries, entry] },
        },
      };
    });
    useDocumentStore.getState().markDirty();
  },

  editEntry: (threadId, entryId, text) => {
    set((state) => {
      const thread = state.threads[threadId];
      if (!thread) return state;
      return {
        threads: {
          ...state.threads,
          [threadId]: {
            ...thread,
            entries: thread.entries.map((e) =>
              e.id === entryId ? { ...e, text, editedAt: new Date().toISOString() } : e,
            ),
          },
        },
      };
    });
    useDocumentStore.getState().markDirty();
  },

  deleteEntry: (threadId, entryId) => {
    const thread = get().threads[threadId];
    if (!thread) return;
    if (thread.entries.length <= 1) {
      get().deleteThread(threadId);
      return;
    }
    set((state) => ({
      threads: {
        ...state.threads,
        [threadId]: {
          ...thread,
          entries: thread.entries.filter((e) => e.id !== entryId),
        },
      },
    }));
    useDocumentStore.getState().markDirty();
  },

  deleteThread: (threadId) => {
    // Strip the marks FIRST (a document transaction), then drop the
    // record — the janitor's order reversed, but idempotent: a mark
    // whose thread vanished would be stripped by the janitor anyway;
    // doing it explicitly keeps the PM doc honest even when the store
    // write fails.
    const editor = useDocumentStore.getState().editor;
    const markType = editor?.schema.marks.comment;
    if (editor && markType) {
      const ranges: Array<{ from: number; to: number }> = [];
      editor.state.doc.descendants((node, pos) => {
        if (!node.isText) return true;
        const m = node.marks.find((mk) => mk.type === markType && mk.attrs.threadId === threadId);
        if (m) ranges.push({ from: pos, to: pos + node.nodeSize });
        return true;
      });
      if (ranges.length > 0) {
        const tr = editor.state.tr;
        for (const r of ranges) tr.removeMark(r.from, r.to, markType);
        editor.view.dispatch(tr);
      }
    }
    set((state) => {
      const threads = { ...state.threads };
      delete threads[threadId];
      return {
        threads,
        activeThreadId: state.activeThreadId === threadId ? null : state.activeThreadId,
      };
    });
    useDocumentStore.getState().markDirty();
  },

  setResolved: (threadId, resolved) => {
    set((state) => {
      const thread = state.threads[threadId];
      if (!thread || thread.resolved === resolved) return state;
      return {
        threads: {
          ...state.threads,
          [threadId]: resolved
            ? { ...thread, resolved: true, resolvedAt: new Date().toISOString(), resolvedBy: currentAuthor() }
            : { ...thread, resolved: false, resolvedAt: undefined, resolvedBy: undefined },
        },
      };
    });
    useDocumentStore.getState().markDirty();
  },

  threadsForSave: () => Object.values(get().threads),
}));
