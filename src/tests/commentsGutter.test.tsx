import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, fireEvent, cleanup } from '@testing-library/react';
import { renderTensor, settleLayout } from './harness';
import { Editor } from '@/components/editor/Editor';
import { FakeMetrics } from './fakeMetrics';
import { useDocumentStore } from '@/lib/document/store';
import { runEditorCommand } from '@/lib/editor/editorCommands';
import {
  CommentsGutter,
  stackCards,
  useCommentsGutterVisible,
} from '@/components/comments/CommentsGutter';
import { useCommentStore, type CommentThread } from '@/lib/comments/store';
import { useConfigStore } from '@/lib/config/store';
import { DEFAULT_CONFIG } from '@/lib/config/schema';
import { useFocusStore } from '@/lib/layout/focusStore';
import { useSidebarStore } from '@/lib/layout/sidebarStore';
import { __resetAnnouncerForTests } from '@/lib/accessibility/announce';

/**
 * #COMMENTS — the boundary gutter: the anchored thread cards in the
 * document's right whitespace (the GDocs model). The stack is pure
 * (unit-tested with real heights); the components pin the visibility
 * law, the card interactions (draft/reply/edit/resolve/delete), the
 * orphan state, jump-to-thread, the SR announcements, and the desk
 * reservation syncing with the gutter.
 */

function thread(id: string, text = 'note', resolved = false): CommentThread {
  return {
    id,
    entries: [{ id: `e-${id}`, author: 'Ada Lovelace', text, createdAt: '2026-01-05T15:04:00.000Z' }],
    resolved,
  };
}

const gutter = () => document.querySelector('[data-testid="comments-gutter"]');

const button = (label: string) =>
  document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;

/** A probe for the shared visibility hook (hooks can't run bare in a
 *  test — mount the tiniest possible consumer). */
function VisibilityProbe() {
  return <span data-testid="visibility-probe">{String(useCommentsGutterVisible())}</span>;
}

beforeEach(() => {
  __resetAnnouncerForTests();
  useCommentStore.setState({
    threads: {},
    anchoredIds: new Set<string>(),
    activeThreadId: null,
    showResolved: false,
    draftThreadId: null,
  });
  useConfigStore.setState({ config: DEFAULT_CONFIG });
  useFocusStore.setState({ active: false });
  useSidebarStore.setState({ active: null });
});

afterEach(() => {
  cleanup();
});

describe('#COMMENTS gutter: the stacking function (pure)', () => {
  it('anchored cards sit at their anchor; overlaps push DOWN; orphans pin to the top', () => {
    const placed = stackCards(
      [
        { id: 'a', top: 500, height: 100 },
        { id: 'b', top: 520, height: 80 }, // overlaps a → pushed below it
        { id: 'orphan1', top: null, height: 60 },
        { id: 'orphan2', top: null, height: 60 },
        { id: 'c', top: 100, height: 50 },
      ],
      12,
    );
    expect(placed.get('orphan1')).toBe(0);
    expect(placed.get('orphan2')).toBe(72); // 0 + 60 + 12
    expect(placed.get('c')).toBe(144); // 72 + 60 + 12 — pushed below the orphans
    expect(placed.get('a')).toBe(500);
    expect(placed.get('b')).toBe(612); // 500 + 100 + 12
  });
});

describe('#COMMENTS gutter: the visibility law (one selector, two views)', () => {
  it('no threads → nothing; threads + toggle on → visible; off → hidden', () => {
    render(<VisibilityProbe />);
    const probe = () => document.querySelector('[data-testid="visibility-probe"]')!.textContent;
    expect(probe()).toBe('false');
    act(() => {
      useCommentStore.setState({ threads: { t1: thread('t1') } });
    });
    expect(probe()).toBe('true');
    act(() => {
      useConfigStore.setState({
        config: { ...DEFAULT_CONFIG, editor: { ...DEFAULT_CONFIG.editor, showBoundaryContent: false } },
      });
    });
    expect(probe()).toBe('false');
  });

  it('Focus Mode and a right-anchored sidebar hide it; left/bottom docks do not', () => {
    useCommentStore.setState({ threads: { t1: thread('t1') } });
    render(<VisibilityProbe />);
    const probe = () => document.querySelector('[data-testid="visibility-probe"]')!.textContent;
    expect(probe()).toBe('true');
    act(() => {
      useFocusStore.setState({ active: true });
    });
    expect(probe()).toBe('false');
    act(() => {
      useFocusStore.setState({ active: false });
      useSidebarStore.setState({ active: { id: 'search', anchor: 'right' } });
    });
    expect(probe()).toBe('false');
    act(() => {
      useSidebarStore.setState({ active: { id: 'search', anchor: 'left' } });
    });
    expect(probe()).toBe('true');
    act(() => {
      useSidebarStore.setState({ active: { id: 'search', anchor: 'bottom' } });
    });
    expect(probe()).toBe('true');
  });
});

describe('#COMMENTS gutter: the steal-stop boundary (the focus law)', () => {
  it('gutter events never reach the enclosing surface handlers — card controls still work', () => {
    useCommentStore.setState({ threads: { t1: thread('t1') }, anchoredIds: new Set(['t1']) });
    // The recording stand-ins for the two steals the views commit:
    // paginated's zoom-wrapper mousedown (preventDefault + focus) and
    // pageless's surface click (focus end). Neither may fire for a
    // card interaction, or the Reply box cannot be focused by clicking.
    const steals = { mousedown: 0, click: 0 };
    render(
      <div
        onMouseDown={() => {
          steals.mousedown += 1;
        }}
        onClick={() => {
          steals.click += 1;
        }}
        onDoubleClick={() => {
          steals.click += 1;
        }}
        onContextMenu={() => {
          steals.click += 1;
        }}
      >
        <CommentsGutter getAnchorTop={() => 10} scale={1} />
      </div>,
    );
    const toggle = document.querySelector('[data-testid="comments-show-resolved"]')!;
    const card = document.querySelector('[data-comment-card="t1"]')!;
    act(() => {
      fireEvent.mouseDown(toggle);
      fireEvent.click(toggle);
      fireEvent.mouseDown(card);
      fireEvent.click(card);
      fireEvent.doubleClick(card);
      fireEvent.contextMenu(card);
    });
    expect(steals.mousedown).toBe(0);
    expect(steals.click).toBe(0);
    // The card's own control still ran (the toggle flipped).
    expect(useCommentStore.getState().showResolved).toBe(true);
  });
});

describe('#COMMENTS gutter: cards', () => {
  it('renders initials, author, timestamp, text; the active card rings; resolved hides until toggled', () => {
    useCommentStore.setState({
      threads: { t1: thread('t1', 'the note'), t2: thread('t2', 'done deal', true) },
      anchoredIds: new Set(['t1', 't2']),
      activeThreadId: 't1',
    });
    render(<CommentsGutter getAnchorTop={() => 100} scale={1} />);

    const cards = document.querySelectorAll('[data-testid="comment-card"]');
    expect(cards).toHaveLength(1); // resolved hidden by default
    expect(cards[0]!.getAttribute('data-comment-card')).toBe('t1');
    expect(document.querySelector('[data-comment-card="t1"]')!.textContent).toContain('the note');
    expect(document.querySelector('[data-comment-card="t1"]')!.textContent).toContain('Ada Lovelace');
    expect(document.querySelector('[data-comment-card="t1"]')!.textContent).toContain('AL'); // initials
    expect(document.querySelector('[data-comment-card="t1"]')!.textContent).toContain('Jan 5');
    // Active card = the ring.
    expect(cards[0]!.className).toContain('ring-1');

    // The show toggle reveals the resolved thread.
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="comments-show-resolved"]')!);
    });
    expect(document.querySelectorAll('[data-testid="comment-card"]')).toHaveLength(2);
    expect(document.querySelector('[data-comment-card="t2"]')!.textContent).toContain('Resolved');
  });

  it('orphaned threads pin to the top with the Unanchored badge; no jump affordance exists', () => {
    useCommentStore.setState({
      threads: { t1: thread('t1', 'ghost note') },
      anchoredIds: new Set<string>(), // no anchor — the orphaned state
    });
    render(<CommentsGutter getAnchorTop={() => null} scale={1} />);
    const card = document.querySelector('[data-comment-card="t1"]')!;
    expect(card.textContent).toContain('Unanchored');
    expect(card.textContent).toContain('ghost note');
    // Never silently gone — the note is fully readable; there is simply
    // nothing to jump to, so no snippet row renders at all.
    expect(document.querySelector('[data-testid="comment-card-jump"]')).toBeNull();
  });

  it('the draft composer: Post commits the entry (mark stays); empty Post is disabled', async () => {
    const { editor } = renderTensor();
    await settleLayout();
    act(() => {
      editor.commands.setContent({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }],
      });
      editor.commands.setTextSelection({ from: 1, to: 6 });
      // The ONE command body — anchors + opens the draft.
      runEditorCommand('addComment');
    });
    const tid = useCommentStore.getState().draftThreadId!;
    expect(tid).toBeTruthy();

    // The gutter renders with the composer (the mount inside the
    // paginated view — the desk reservation is asserted below).
    const gutterEl = gutter();
    expect(gutterEl).not.toBeNull();
    const post = document.querySelector('[data-testid="comment-draft-post"]') as HTMLButtonElement;
    expect(post.disabled).toBe(true); // empty draft cannot post
    // The commit action is the PRIMARY accent (the user's ruling).
    expect(post.className).toContain('bg-primary');
    const input = document.querySelector('[data-testid="comment-draft-input"]') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(input, { target: { value: 'my posted note' } });
    });
    expect(
      (document.querySelector('[data-testid="comment-draft-post"]') as HTMLButtonElement).disabled,
    ).toBe(false);
    // ENTER posts too (the composer's keystroke law).
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(useCommentStore.getState().draftThreadId).toBeNull();
    expect(useCommentStore.getState().threads[tid]!.entries[0]!.text).toBe('my posted note');
    // The MARK stayed (a posted draft is a real comment).
    let marked = false;
    editor.state.doc.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === 'comment')) marked = true;
      return true;
    });
    expect(marked).toBe(true);

    // The composer is gone; the card reads as a normal thread.
    expect(document.querySelector('[data-testid="comment-draft-input"]')).toBeNull();
  });

  it('the draft composer: Cancel removes the thread AND its mark (an unsent draft leaves nothing)', async () => {
    const { editor } = renderTensor();
    await settleLayout();
    act(() => {
      editor.commands.setContent({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }],
      });
      editor.commands.setTextSelection({ from: 1, to: 6 });
      runEditorCommand('addComment');
    });
    const tid = useCommentStore.getState().draftThreadId!;
    const cancel = document.querySelector('[data-testid="comment-draft-cancel"]') as HTMLButtonElement;
    act(() => {
      fireEvent.click(cancel);
    });
    expect(useCommentStore.getState().threads[tid]).toBeUndefined();
    let marked = false;
    editor.state.doc.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === 'comment')) marked = true;
      return true;
    });
    expect(marked).toBe(false);
  });

  it('reply: Enter posts (Shift+Enter newlines); edit stamps editedAt; delete-last empties the thread; resolve flips', async () => {
    useCommentStore.setState({ threads: { t1: thread('t1', 'first') }, anchoredIds: new Set(['t1']) });
    render(<CommentsGutter getAnchorTop={() => 50} scale={1} />);

    // Shift+Enter → a newline, no entry.
    const reply = document.querySelector('[data-testid="comment-reply-t1"]') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(reply, { target: { value: 'line one' } });
      fireEvent.keyDown(reply, { key: 'Enter', shiftKey: true });
    });
    expect(useCommentStore.getState().threads['t1']!.entries).toHaveLength(1);

    // Enter → the reply lands.
    act(() => {
      fireEvent.keyDown(reply, { key: 'Enter' });
    });
    const entries = useCommentStore.getState().threads['t1']!.entries;
    expect(entries).toHaveLength(2);
    expect(entries[1]!.text).toBe('line one');
    expect(reply.value).toBe('');

    // Edit the first entry (hover actions are focus-within reachable
    // for keyboards; jsdom clicks them regardless of the CSS gate).
    const entryEl = document.querySelectorAll('[data-comment-card="t1"] li')[0]!;
    const editBtn = entryEl.querySelector('button[aria-label="Edit comment"]') as HTMLButtonElement;
    act(() => {
      fireEvent.click(editBtn);
    });
    const editTextarea = entryEl.querySelector('textarea') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(editTextarea, { target: { value: 'first (fixed)' } });
      fireEvent.keyDown(editTextarea, { key: 'Enter' });
    });
    const edited = useCommentStore.getState().threads['t1']!.entries[0]!;
    expect(edited.text).toBe('first (fixed)');
    expect(edited.editedAt).toBeTruthy();

    // Deleting an entry keeps the thread while entries remain (the
    // GDocs rule bites only on the LAST one).
    const delBtn = entryEl.querySelector('button[aria-label="Delete comment"]') as HTMLButtonElement;
    act(() => {
      fireEvent.click(delBtn);
    });
    expect(useCommentStore.getState().threads['t1']!.entries).toHaveLength(1);
    // The last entry's delete empties the thread.
    const lastEntryEl = document.querySelectorAll('[data-comment-card="t1"] li')[0]!;
    act(() => {
      fireEvent.click(
        lastEntryEl.querySelector('button[aria-label="Delete comment"]') as HTMLButtonElement,
      );
    });
    expect(useCommentStore.getState().threads['t1']).toBeUndefined();
  });

  it('resolve/unresolve and delete-thread buttons run the store actions', () => {
    useCommentStore.setState({ threads: { t1: thread('t1') }, anchoredIds: new Set(['t1']) });
    render(<CommentsGutter getAnchorTop={() => 50} scale={1} />);
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="comment-resolve-t1"]')!);
    });
    expect(useCommentStore.getState().threads['t1']!.resolved).toBe(true);
    // Resolved threads hide — the card disappears until the toggle.
    expect(document.querySelector('[data-comment-card="t1"]')).toBeNull();
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="comments-show-resolved"]')!);
    });
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="comment-resolve-t1"]')!);
    });
    expect(useCommentStore.getState().threads['t1']!.resolved).toBe(false);
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="comment-delete-t1"]')!);
    });
    expect(useCommentStore.getState().threads['t1']).toBeUndefined();
  });

  it('jump: the header selects the range, focuses the editor, sets the active thread, announces', async () => {
    const { editor } = renderTensor();
    await settleLayout();
    useCommentStore.setState({
      threads: { t1: thread('t1') },
      anchoredIds: new Set(['t1']),
    });
    act(() => {
      editor.commands.setContent({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }],
      });
      editor.commands.setTextSelection({ from: 1, to: 6 });
      editor.commands.setComment('t1');
      // Park the caret OUTSIDE the thread (no active thread yet).
      editor.commands.setTextSelection(9);
    });
    // The REAL paginated mount (the view's own gutter — not a direct one).
    expect(gutter()).not.toBeNull();
    expect(useCommentStore.getState().activeThreadId).toBeNull();
    // The SNIPPET is the jump affordance — the anchored text, quoted.
    const jumpEl = document.querySelector('[data-testid="comment-card-jump"]')!;
    expect(jumpEl.textContent).toContain('hello');
    act(() => {
      fireEvent.click(jumpEl);
    });
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(6);
    expect(useCommentStore.getState().activeThreadId).toBe('t1');
    await vi.waitFor(() => {
      const region = document.querySelector('[aria-live="polite"]');
      expect(region?.textContent).toBe('Jumped to comment thread');
    });
  });
});

describe('#COMMENTS gutter: THE OVERLAY RULING — the document never moves', () => {
  it('paginated: threads appear and the toggle hides the gutter, but the wrapper margin NEVER changes', async () => {
    const { editor } = renderTensor();
    await settleLayout();
    const wrapper = document.querySelector('[data-testid="paginated-zoom-wrapper"]') as HTMLElement;
    // 'margin: 0 auto' — the centered page, untouched by comments
    // forever (the overlay ruling: no reservation, no desk shift).
    expect(wrapper.style.marginRight).toBe('auto');

    act(() => {
      useCommentStore.setState({
        threads: { t1: thread('t1') },
        anchoredIds: new Set(['t1']),
      });
      editor.commands.setContent({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }],
      });
      editor.commands.setTextSelection({ from: 1, to: 6 });
      editor.commands.setComment('t1');
    });
    await settleLayout();
    // The gutter mounts (attached at the sheet's right edge) and the
    // page stayed centered — the drift class is structurally gone
    // (no reservation exists for the ruler to mis-account).
    expect(gutter()).not.toBeNull();
    expect(wrapper.style.marginRight).toBe('auto');
    // Boundary off → the gutter goes away; the margin STILL never moved.
    act(() => {
      useConfigStore.setState({
        config: { ...DEFAULT_CONFIG, editor: { ...DEFAULT_CONFIG.editor, showBoundaryContent: false } },
      });
    });
    expect(gutter()).toBeNull();
    expect(wrapper.style.marginRight).toBe('auto');
  });

  it('pageless: the strip margin NEVER changes when the gutter mounts', async () => {    // The pageless.test pattern: the mode toggle lives in the View
    // tab's DisplayModeGroup — mount it beside the editor.
    const { DisplayModeGroup } = await import(
      '@/components/layout/ribbon/view/groups/DisplayModeGroup'
    );
    useConfigStore.setState({
      config: { ...DEFAULT_CONFIG, editor: { ...DEFAULT_CONFIG.editor, defaultPageLayout: 'Pages' } },
    });
    render(
      <>
        <div data-desk-wrapper className="relative">
          <div data-desk-scroll style={{ overflow: 'auto' }}>
            <Editor metrics={FakeMetrics} />
          </div>
        </div>
        <DisplayModeGroup />
      </>,
    );
    await settleLayout();
    const editor = useDocumentStore.getState().editor!;
    // Threads FIRST (the write-order law — the janitor strips marks
    // whose thread is not yet in the store).
    useCommentStore.setState({ threads: { t1: thread('t1') }, anchoredIds: new Set(['t1']) });
    act(() => {
      editor.commands.setContent({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }],
      });
      editor.commands.setTextSelection({ from: 1, to: 6 });
      editor.commands.setComment('t1');
    });
    // Switch to pageless (the DisplayModeGroup toggle).
    act(() => {
      fireEvent.click(button('Paginated / Pageless')!);
    });
    await settleLayout();
    const strip = document.querySelector('[data-testid="pageless-surface"]') as HTMLElement;
    expect(strip).not.toBeNull();
    // No reservation ever (the overlay ruling) — the strip centers
    // exactly as before, and the gutter attaches at its right edge.
    expect(strip.style.marginRight).toBe('');
    expect(gutter()).not.toBeNull();
    // The anchored span tint class rides the pageless DOM (commit 3).
    expect(strip.querySelector('[data-comment-thread-id]')).not.toBeNull();
  });
});

describe('#COMMENTS gutter: comment surfaces', () => {
  it('the draft re-focus: clicking the anchored text hands focus back to the composer', async () => {
    const { editor } = renderTensor();
    await settleLayout();
    act(() => {
      editor.commands.setContent({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }],
      });
      editor.commands.setTextSelection({ from: 1, to: 6 });
      runEditorCommand('addComment');
    });
    const tid = useCommentStore.getState().draftThreadId!;
    // The composer is focused on open (autoFocus).
    expect(document.activeElement).toBe(
      document.querySelector('[data-testid="comment-draft-input"]'),
    );

    // The user clicks AWAY (caret into the unmarked text) — the draft
    // stays anchored, the active thread clears. (jsdom's programmatic
    // selection doesn't move DOM focus — a real click does; the FIX
    // below is what the test pins.)
    act(() => {
      editor.commands.setTextSelection(9);
    });
    expect(useCommentStore.getState().activeThreadId).toBeNull();

    // THE FIX (layer 1): clicking the anchored TEXT again makes the
    // draft the active thread — the card hands focus back to the
    // composer. (The textbox itself is the only other focus
    // affordance — the user's focus law; the card body never steals.)
    act(() => {
      editor.commands.setTextSelection(3);
    });
    expect(useCommentStore.getState().activeThreadId).toBe(tid);
    expect(document.activeElement).toBe(
      document.querySelector('[data-testid="comment-draft-input"]'),
    );
    // The composer carries NO manual resize handle (the autogrow
    // ruling — the browser's corner grip is gone).
    expect(
      (document.querySelector('[data-testid="comment-draft-input"]') as HTMLTextAreaElement)
        .className,
    ).toContain('resize-none');
  });

  it('the Insert-tab Comment button: ALWAYS enabled — a caret click anchors the word', async () => {
    const { editor } = renderTensor();
    await settleLayout();
    const { TextGroup } = await import('@/components/layout/ribbon/insert/groups/TextGroup');
    render(<TextGroup editor={editor} />);
    const btn = button('Comment')!;
    expect(btn).not.toBeNull();

    // Caret → still enabled (the user's ruling)…
    act(() => {
      editor.commands.setContent({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }],
      });
      editor.commands.setTextSelection(3);
    });
    expect(btn.disabled).toBe(false);

    // …and clicking with a bare caret anchors the WORD the cursor is
    // in ('hello'), selects it, and opens the draft.
    act(() => {
      fireEvent.click(btn);
    });
    const tid = useCommentStore.getState().draftThreadId!;
    expect(tid).toBeTruthy();
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(6); // 'hello' selected
    let markedText = '';
    editor.state.doc.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === 'comment')) markedText += n.text;
      return true;
    });
    expect(markedText).toBe('hello');
    expect(useCommentStore.getState().threads[tid]!.entries[0]!.text).toBe('');
  });
});
