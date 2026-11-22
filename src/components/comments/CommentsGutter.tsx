import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { getScrollParent } from '@/lib/editor/domUtils';
import { commentTrackingKey } from '@/lib/editor/CommentExtension';
import { useDocumentStore } from '@/lib/document/store';
import { useCommentStore, type CommentThread } from '@/lib/comments/store';
import { useConfigStore } from '@/lib/config/store';
import { useFocusStore } from '@/lib/layout/focusStore';
import { useSidebarStore } from '@/lib/layout/sidebarStore';
import { announce } from '@/lib/accessibility/announce';
import { CommentThreadCard } from './CommentThreadCard';

/**
 * The anchored thread cards in the document's right whitespace; the
 * document never moves — the column overlays existing space. Props:
 * getAnchorTop → gutter-space tops (null = orphan); scale → visual px.
 */

/** Card-to-card breathing room in the stack. */
export const COMMENTS_GUTTER_GAP = 12;

/** The shared visibility contract — the gutter renders iff this is true,
 *  and the views reserve space iff this is true. */
export function useCommentsGutterVisible(): boolean {
  const showBoundary = useConfigStore((s) => s.config.editor.showBoundaryContent);
  const focusActive = useFocusStore((s) => s.active);
  // A right-anchored sidebar owns the same edge (Find & Replace,
  // Translate, …) — the gutter yields; left/bottom docks don't overlap.
  const sidebar = useSidebarStore((s) => s.active);
  const threadCount = useCommentStore((s) => Object.keys(s.threads).length);
  return showBoundary && threadCount > 0 && !focusActive && sidebar?.anchor !== 'right';
}

export interface StackItem {
  id: string;
  /** Desired top in gutter space; null = orphan (pins to the top). */
  top: number | null;
  /** Measured card height (0 in jsdom — the tests exercise the ORDER). */
  height: number;
}

/** The collision pass (PURE — unit-tested): sort by desired top
 *  (orphans first, creation order), walk down pushing each card below
 *  the previous card's bottom edge. */
export function stackCards(items: StackItem[], gap: number): Map<string, number> {
  const orphans = items.filter((i) => i.top == null);
  const anchored = items
    .filter((i) => i.top != null)
    .sort((a, b) => (a.top as number) - (b.top as number));
  const placed = new Map<string, number>();
  let cursor = 0;
  for (const item of [...orphans, ...anchored]) {
    const top = Math.max(item.top ?? cursor, cursor);
    placed.set(item.id, top);
    cursor = top + item.height + gap;
  }
  return placed;
}

interface CommentsGutterProps {
  getAnchorTop: (threadId: string) => number | null;
  scale: number;
}

export function CommentsGutter({ getAnchorTop, scale }: CommentsGutterProps) {
  const visible = useCommentsGutterVisible();
  const threads = useCommentStore((s) => s.threads);
  const anchoredIds = useCommentStore((s) => s.anchoredIds);
  const activeThreadId = useCommentStore((s) => s.activeThreadId);
  const showResolved = useCommentStore((s) => s.showResolved);
  const draftThreadId = useCommentStore((s) => s.draftThreadId);
  const editor = useDocumentStore((s) => s.editor);
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  // Editor transactions bump this → re-measure (anchors move with
  // every doc edit; selection moves re-run it too — harmless, cheap).
  const [epoch, setEpoch] = useState(0);
  const [positions, setPositions] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    if (!editor) return;
    const bump = () => setEpoch((e) => e + 1);
    editor.on('transaction', bump);
    return () => {
      editor.off('transaction', bump);
    };
  }, [editor]);

  const visibleThreads = useMemo(() => {
    const list = Object.values(threads);
    // Resolved threads hide by default.
    const shown = list.filter((t) => showResolved || !t.resolved);
    // Orphans pin to the top in creation order; anchored threads follow
    // in anchor order. getAnchorTop is a fresh read — recompute per
    // render (scrolls/zooms re-anchor).
    const orphans = shown.filter((t) => !anchoredIds.has(t.id) || getAnchorTop(t.id) == null);
    const anchored = shown
      .filter((t) => anchoredIds.has(t.id) && getAnchorTop(t.id) != null)
      .sort((a, b) => (getAnchorTop(a.id) ?? 0) - (getAnchorTop(b.id) ?? 0));
    return [...orphans, ...anchored];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getAnchorTop is a fresh closure by design (re-created per parent render); threads/anchoredIds/epoch are the data triggers.
  }, [threads, anchoredIds, showResolved, epoch, getAnchorTop]);

  useLayoutEffect(() => {
    // The measure + stack pass. jsdom measures zero heights (tests
    // assert anchor order); the equality guard keeps identical
    // results from looping.
    const items: StackItem[] = visibleThreads.map((t) => ({
      id: t.id,
      top: anchoredIds.has(t.id) ? getAnchorTop(t.id) : null,
      height: cardRefs.current.get(t.id)?.offsetHeight ?? 0,
    }));
    const next = stackCards(items, COMMENTS_GUTTER_GAP);
    setPositions((prev) => {
      if (prev.size === next.size && [...next].every(([id, top]) => prev.get(id) === top)) return prev;
      return next;
    });
  }, [visibleThreads, anchoredIds, getAnchorTop, epoch]);

  if (!visible) return null;

  function jump(threadId: string): void {
    const ed: Editor | null = useDocumentStore.getState().editor;
    if (!ed) return;
    const spans = (commentTrackingKey.getState(ed.state)?.ranges ?? []).filter(
      (r) => r.threadId === threadId,
    );
    const root = rootRef.current;
    if (spans.length > 0) {
      // Select the thread's full extent + focus — the selection makes
      // it the ACTIVE thread (the tracking plugin's caret read).
      // Jumping announces.
      ed.commands.setTextSelection({ from: spans[0]!.from, to: spans[spans.length - 1]!.to });
      ed.commands.focus();
      announce('Jumped to comment thread');
    }
    // The scroll: the card's placed top, gutter-space → visual px
    // (×scale) → the scroll content's offset → scrollTop with headroom.
    const cardTop = positions.get(threadId);
    if (cardTop == null || !root) return;
    const scroller = getScrollParent(root);
    if (!scroller) return;
    const rootTop = root.getBoundingClientRect().top;
    const scrollerTop = scroller.getBoundingClientRect().top;
    const contentTop = rootTop - scrollerTop + scroller.scrollTop;
    scroller.scrollTop = Math.max(0, contentTop + cardTop * scale - 96);
  }

  return (
    <div
      ref={rootRef}
      role="list"
      aria-label="Comments"
      data-testid="comments-gutter"
      // Events must never reach the desk/document handlers: both mounts
      // sit in surfaces that steal focus (the zoom-wrapper prevents
      // default; pageless focuses the editor) — without this stop the
      // Reply box cannot be clicked into focus.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      // The column itself never intercepts desk clicks — only cards do.
      className="pointer-events-none absolute top-0 bottom-0 left-full z-10 ml-3 w-[320px]"
    >
      {/* The show-resolved toggle. */}
      <div className="pointer-events-auto mb-2 flex justify-start">
        <button
          type="button"
          data-testid="comments-show-resolved"
          aria-pressed={showResolved}
          onClick={() => useCommentStore.getState().setShowResolved(!showResolved)}
          className="rounded-md border border-border bg-card/90 px-2 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
        >
          {showResolved ? 'Hiding: none — Showing resolved' : 'Show resolved'}
        </button>
      </div>
      {visibleThreads.map((thread: CommentThread) => (
        <CommentThreadCard
          key={thread.id}
          thread={thread}
          anchored={anchoredIds.has(thread.id)}
          active={activeThreadId === thread.id}
          isDraft={draftThreadId === thread.id}
          top={positions.get(thread.id) ?? 0}
          registerRef={(el) => {
            cardRefs.current.set(thread.id, el);
          }}
          onJump={() => jump(thread.id)}
        />
      ))}
    </div>
  );
}
