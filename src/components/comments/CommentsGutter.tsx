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
 * #COMMENTS — THE BOUNDARY GUTTER: the anchored thread cards living in
 * the document's right whitespace.
 *
 * THE OVERLAY RULING (the user's walk-back of the GDocs model): the
 * document NEVER moves — no margin reservation, no desk shift, ever
 * (the reservation de-synced the ruler's centered-page assumption
 * twice; the column just attaches at the sheet's right edge and
 * overlays whatever whitespace exists, like a print margin note).
 * Mounted by BOTH view modes inside their own coordinate space:
 *
 *  - getAnchorTop(threadId) → the anchor's top in the GUTTER'S OWN
 *    coordinate space (paginated: stack-space × zoom — the gutter is
 *    an unscaled sibling of the zoom-wrapper; pageless: content-space
 *    ÷ zoom — the gutter rides the scaled strip). Null = orphaned
 *    (or unmeasurable).
 *  - scale: the gutter-space → VISUAL-px factor for the jump scroll
 *    (paginated 1 — the gutter is unscaled chrome; pageless zoom).
 *
 * STACKING: cards sit at their anchor's top; overlaps push DOWN (the
 * measured-height collision pass — stackCards, pure + unit-tested).
 * Orphaned threads (anchor deleted) pin to the top in creation order
 * with an Unanchored badge — the defined state, never silently gone.
 */

export const COMMENTS_GUTTER_WIDTH = 320;
/** Card-to-card breathing room in the stack. */
export const COMMENTS_GUTTER_GAP = 12;

/** THE SHARED VISIBILITY LAW — the gutter renders iff this is true,
 *  and the views reserve exactly this much space iff this is true. */
export function useCommentsGutterVisible(): boolean {
  const showBoundary = useConfigStore((s) => s.config.editor.showBoundaryContent);
  const focusActive = useFocusStore((s) => s.active);
  // A right-anchored sidebar owns the same edge (Find & Replace,
  // Translate, …) — the gutter yields (the Focus Mode sidebar law's
  // twin; left/bottom docks don't overlap the column).
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
    // Resolved threads hide by default (the issue's show toggle).
    const shown = list.filter((t) => showResolved || !t.resolved);
    // THE ORDER: orphans (no live anchor) pin to the top in creation
    // order; anchored threads follow in anchor order. getAnchorTop is
    // a fresh read (pure store/PM reads) — calling it at render is the
    // house's recompute-per-render pattern (scrolls/zooms re-anchor).
    const orphans = shown.filter((t) => !anchoredIds.has(t.id) || getAnchorTop(t.id) == null);
    const anchored = shown
      .filter((t) => anchoredIds.has(t.id) && getAnchorTop(t.id) != null)
      .sort((a, b) => (getAnchorTop(a.id) ?? 0) - (getAnchorTop(b.id) ?? 0));
    return [...orphans, ...anchored];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getAnchorTop is a fresh closure by design (re-created per parent render); threads/anchoredIds/epoch are the data triggers.
  }, [threads, anchoredIds, showResolved, epoch, getAnchorTop]);

  useLayoutEffect(() => {
    // THE MEASURE + STACK PASS. Deps = every real trigger: thread
    // content (store identity — entry edits ride it too), anchored
    // membership, the parent's fresh anchor closure (per render), and
    // editor transactions (geometry moves). jsdom measures zero
    // heights: stacking degenerates to anchor order, which the tests
    // assert. The equality guard keeps identical results from looping.
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
      // THE RANGE: select the thread's full extent + focus — the
      // selection makes it the ACTIVE thread (the tracking plugin's
      // caret read), which deepens its text tint (commit 3) and marks
      // the card. THE SR LAW: jumping announces.
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
      // THE STEAL-STOP BOUNDARY: the gutter is self-contained chrome —
      // its events must NEVER reach the desk/document handlers. Both
      // mounts are inside interactive surfaces that steal focus:
      // paginated's zoom-wrapper onMouseDown PREVENTS THE DEFAULT
      // (killing the browser's native textarea-focus-on-mousedown) and
      // focuses the hidden input; pageless's strip onClick runs
      // editor.commands.focus('end') (its click-anywhere focus). Without
      // this stop the Reply box literally cannot be focused by
      // clicking. Double-click/context-menu too: textareas own their
      // native behaviors inside the cards.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      // The column itself never intercepts desk clicks — only cards do.
      className="pointer-events-none absolute top-0 bottom-0 left-full z-10 ml-3 w-[320px]"
    >
      {/* The show-resolved toggle (the issue's reveal control). */}
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
