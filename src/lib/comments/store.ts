import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { useDocumentStore } from '@/lib/document/store';
import { useConfigStore } from '@/lib/config/store';
import { announce } from '@/lib/accessibility/announce';

/**
 * The thread-content store. Anchoring lives in the PM doc (the
 * `comment` mark); entries/authors/resolution live here and travel in
 * .wpdoc metadata — comment edits must not pollute undo history or
 * trigger layout rescans. hydrate runs BEFORE editor.setContent on
 * every open path: the tracking plugin strips marks with no store
 * record, so a late hydrate would destroy fresh anchors.
 * activeThreadId, showResolved, and draftThreadId are session-only.
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
  /** The first entry is the opening comment; ≥1 always (deleting the
   *  last entry deletes the thread). */
  entries: CommentEntry[];
  resolved: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
}

interface CommentStore {
  threads: Record<string, CommentThread>;
  /** Threads with ≥1 live mark. A thread without its id here is
   *  orphaned — visible in the gutter, never silently gone. */
  anchoredIds: ReadonlySet<string>;
  /** The thread under the caret (selection tracking). */
  activeThreadId: string | null;
  /** Resolved threads hidden by default; the gutter's show toggle. */
  showResolved: boolean;
  /** The in-flight draft (session-only): the thread being composed;
   *  cancel deletes it and its mark. */
  draftThreadId: string | null;

  /** The open-path seam: replaces ALL thread state. All-empty threads
   *  (drafts) don't survive a reopen. */
  hydrate: (threads: CommentThread[]) => void;
  /** The tracking plugin's doc-scan write (anchored membership). */
  setAnchoredIds: (ids: ReadonlySet<string>) => void;
  setActiveThread: (id: string | null) => void;
  setShowResolved: (show: boolean) => void;

  /** Create with the first entry; called BEFORE setMark — the janitor
   *  must never see a mark with no store record. */
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

  /** Threads as an ordered array for the save seam;
   *  absent-when-empty is the caller's job. */
  threadsForSave: () => CommentThread[];
}

/** The author for a new entry: the document's author, else the app
 * identity, else Anonymous. */
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
      // In-flight drafts (all entries empty) don't survive a reopen.
      if (t.entries.every((e) => e.text.trim() === '')) continue;
      record[t.id] = t;
    }
    // activeThreadId resets (the caret's thread belongs to the OLD
    // document); showResolved is session-only and deliberately rides.
    set({ threads: record, anchoredIds: new Set<string>(), activeThreadId: null, draftThreadId: null });
  },

  setAnchoredIds: (ids) => {
    const { anchoredIds } = get();
    // Membership-compare: an equal Set must not re-render subscribers.
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
    announce('Comment added');
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
    announce('Reply posted');
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
    // Strip the marks first, then drop the record — idempotent with
    // the janitor either way.
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
    announce('Comment deleted');
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
    announce(resolved ? 'Comment thread resolved' : 'Comment thread reopened');
  },

  threadsForSave: () => Object.values(get().threads),
}));
