import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { IconButton } from '@/components/layout/IconButton';
import { useCommentStore, authorInitials, type CommentEntry, type CommentThread } from '@/lib/comments/store';
import { useDocumentStore } from '@/lib/document/store';
import { commentTrackingKey } from '@/lib/editor/CommentExtension';
import { announce } from '@/lib/accessibility/announce';

/**
 * #COMMENTS — one thread card in the boundary gutter. Shadcn-native
 * surfaces (Button/Textarea/IconButton — no title attrs, aria-labels
 * on icon buttons per the house law).
 *
 * THE LAYOUT (the GDocs chain, redesigned):
 *   ┌──────────────────────────────────────────────┐
 *   │ [AL] Anonymous · Jan 5, 3:04 PM    ✓  🗑     │  header: avatar, author, time,
 *   │                                    (hover)  │  status — card actions on hover
 *   │ “the commented text…”                       │  the anchored SNIPPET — the ONE
 *   │                                              │  jump affordance (click → select
 *   │ The opening comment body.                    │  + focus the range)
 *   │ Bob · Jan 6 → the reply body.                 │  replies: author·time, then body
 *   │ [Reply…]                                     │  grows with text
 *   └──────────────────────────────────────────────┘
 *
 * THE FOCUS LAW (the user's ruling): the composer's textbox is the
 * ONLY card-side focus affordance — clicking it focuses it (native),
 * and the active-thread effect hands focus back when the caret returns
 * to the anchored text. Nothing else on the card steals focus.
 *
 * THE ORPHANED STATE (the issue's "never silently gone"): no live
 * anchor → no snippet row, an Unanchored badge in the header, and the
 * conversation stays fully readable/deletable.
 */

/** Absolute timestamp, compact ("Jan 5, 3:04 PM"). */
function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * AUTO-GROW: the comment textareas size to their content — no manual
 * resize handle (`resize-none`; the browser's default corner grip is
 * gone). Deterministic across engines: the ui Textarea's
 * field-sizing-content is best-effort (WebKitGTK support varies), so
 * the explicit height is authoritative everywhere. Called from each
 * textarea's ref callback (mount sizing) and onChange (typing).
 */
function autogrow(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

/** The anchored text excerpt — the card's context line. First marked
 *  piece's text, whitespace-flattened, ellipsized. Null = orphaned (or
 *  no editor yet). A FRESH read at render time (the gutter re-renders
 *  on editor transactions — the house's recompute-per-render pattern). */
function anchorSnippet(threadId: string): string | null {
  const editor = useDocumentStore.getState().editor;
  if (!editor) return null;
  const spans = (commentTrackingKey.getState(editor.state)?.ranges ?? []).filter(
    (r) => r.threadId === threadId,
  );
  if (spans.length === 0) return null;
  const text = editor.state.doc
    .textBetween(spans[0]!.from, spans[0]!.to, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return null;
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

interface CommentThreadCardProps {
  thread: CommentThread;
  anchored: boolean;
  active: boolean;
  isDraft: boolean;
  top: number;
  onJump: () => void;
  registerRef: (el: HTMLDivElement | null) => void;
}

export function CommentThreadCard({
  thread,
  anchored,
  active,
  isDraft,
  top,
  onJump,
  registerRef,
}: CommentThreadCardProps) {
  const [replyText, setReplyText] = useState('');
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  // THE ACTIVE-THREAD RE-FOCUS (the return path): clicking the anchored
  // TEXT makes the draft the active thread — the effect hands focus
  // back to the composer. The textbox itself is the only other focus
  // affordance (the focus law — nothing else on the card steals it).
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (isDraft && active) draftRef.current?.focus();
  }, [isDraft, active]);
  // The reply box's height follows its value — including the CLEAR
  // after posting, which fires no onChange (a state write). The
  // layout effect covers mount, typing, and the reset in one law.
  const replyRef = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    autogrow(replyRef.current);
  }, [replyText]);
  const store = useCommentStore;
  const first = thread.entries[0];
  const snippet = !isDraft ? anchorSnippet(thread.id) : null;

  function submitReply(): void {
    const text = replyText.trim();
    if (!text) return;
    store.getState().addReply(thread.id, text);
    setReplyText('');
  }

  function beginEdit(entry: CommentEntry): void {
    setEditingEntryId(entry.id);
    setEditText(entry.text);
  }

  function saveEdit(): void {
    if (!editingEntryId) return;
    const text = editText.trim();
    if (!text) return;
    store.getState().editEntry(thread.id, editingEntryId, text);
    setEditingEntryId(null);
    announce('Comment edited');
  }

  return (
    <div
      ref={registerRef}
      role="listitem"
      data-testid="comment-card"
      data-comment-card={thread.id}
      className={cn(
        'group/card pointer-events-auto absolute left-0 w-full rounded-lg border bg-popover p-3 text-sm shadow-md',
        active && 'ring-1 ring-ring',
        thread.resolved && 'opacity-70',
      )}
      style={{ top: `${top}px` }}
    >
      {/* THE HEADER — the thread's author + time + status. Card actions
          (resolve, delete) reveal on hover/focus-within; the status
          badges ride inline. NOT a button — the snippet below is the
          jump affordance. */}
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary"
        >
          {authorInitials(first?.author ?? '?')}
        </span>
        <span className="min-w-0 truncate font-medium">{first?.author ?? 'Unknown'}</span>
        {first && (
          <time dateTime={first.createdAt} className="shrink-0 text-xs text-muted-foreground">
            {formatTimestamp(first.createdAt)}
          </time>
        )}
        {thread.resolved && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            Resolved
          </span>
        )}
        {!anchored && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            Unanchored
          </span>
        )}
        <span className="ml-auto hidden shrink-0 gap-0.5 group-hover/card:flex group-focus-within/card:flex">
          <IconButton
            label={thread.resolved ? 'Unresolve thread' : 'Resolve thread'}
            icon={thread.resolved ? <X size={14} /> : <Check size={14} />}
            data-testid={`comment-resolve-${thread.id}`}
            onClick={() => store.getState().setResolved(thread.id, !thread.resolved)}
          />
          <IconButton
            label="Delete thread"
            icon={<Trash2 size={14} />}
            data-testid={`comment-delete-${thread.id}`}
            onClick={() => store.getState().deleteThread(thread.id)}
          />
        </span>
      </div>

      {/* THE SNIPPET — the anchored text excerpt, and the ONE jump
          affordance: clicking selects the range, focuses the editor
          (making this the active thread), and scrolls to it. */}
      {snippet && (
        <button
          type="button"
          data-testid="comment-card-jump"
          aria-label="Jump to commented text"
          onClick={onJump}
          className="mt-2 block max-w-full cursor-pointer truncate text-left text-xs italic text-muted-foreground transition-colors hover:text-foreground"
        >
          “{snippet}”
        </button>
      )}

      {/* THE DRAFT COMPOSER — the GDocs flow: an anchored thread whose
          first entry is empty until posted; cancel removes the thread
          AND its mark (an unsent draft leaves nothing behind). */}
      {isDraft ? (
        <div className="mt-2">
          <Textarea
            data-testid="comment-draft-input"
            ref={(el) => {
              draftRef.current = el;
              autogrow(el);
            }}
            className="resize-none"
            autoFocus
            placeholder="Add a comment…"
            rows={3}
            value={replyText}
            onChange={(e) => {
              setReplyText(e.target.value);
              autogrow(e.target);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const text = replyText.trim();
                if (!text) return;
                store.getState().submitDraft(thread.id, text);
                setReplyText('');
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                store.getState().cancelDraft(thread.id);
              }
            }}
          />
          <div className="mt-2 flex justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              data-testid="comment-draft-cancel"
              onClick={() => store.getState().cancelDraft(thread.id)}
            >
              Cancel
            </Button>
            <Button
              variant="default"
              size="sm"
              data-testid="comment-draft-post"
              disabled={replyText.trim() === ''}
              onClick={() => {
                store.getState().submitDraft(thread.id, replyText.trim());
                setReplyText('');
              }}
            >
              Post
            </Button>
          </div>
        </div>
      ) : (
        <>
          {/* THE CHAIN — the opening comment body up top (its author
              lives in the header), replies below with their own
              author · time line. Per-entry hover actions (edit,
              delete) at the body's right — pr-10 keeps long lines
              from running under them. */}
          <ul className="mt-2 space-y-2">
            {thread.entries.map((entry, idx) => (
              <li key={entry.id} className="group/entry relative">
                {idx > 0 && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{entry.author}</span>
                    <time dateTime={entry.createdAt}>{formatTimestamp(entry.createdAt)}</time>
                  </div>
                )}
                {editingEntryId === entry.id ? (
                  <div className="mt-1">
                    <Textarea
                      ref={autogrow}
                      className="resize-none"
                      autoFocus
                      rows={2}
                      value={editText}
                      onChange={(e) => {
                        setEditText(e.target.value);
                        autogrow(e.target);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          saveEdit();
                        }
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          setEditingEntryId(null);
                        }
                      }}
                    />
                    <div className="mt-1 flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditingEntryId(null)}>
                        Cancel
                      </Button>
                      <Button variant="default" size="sm" disabled={editText.trim() === ''} onClick={saveEdit}>
                        Save
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap break-words pr-10">
                    {entry.text}
                    {entry.editedAt && <span className="italic"> (edited)</span>}
                  </p>
                )}
                <span className="absolute right-0 top-0 hidden gap-0.5 group-hover/entry:flex group-focus-within/entry:flex">
                  <IconButton
                    label="Edit comment"
                    icon={<Pencil size={12} />}
                    onClick={() => beginEdit(entry)}
                  />
                  <IconButton
                    label="Delete comment"
                    icon={<Trash2 size={12} />}
                    onClick={() => store.getState().deleteEntry(thread.id, entry.id)}
                  />
                </span>
              </li>
            ))}
          </ul>

          {/* THE REPLY ROW — Enter sends, Shift+Enter newlines; grows
              with the text (no resize handle — the autogrow law). */}
          <div className="mt-2">
            <Textarea
              data-testid={`comment-reply-${thread.id}`}
              ref={replyRef}
              className="resize-none"
              placeholder="Reply…"
              rows={1}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submitReply();
                }
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
