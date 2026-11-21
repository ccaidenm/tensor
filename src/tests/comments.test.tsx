import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { NodeSelection } from '@tiptap/pm/state';
import { renderTensor } from './harness';
import { settleLayout } from './harness';
import { pmDocToSemantic } from '@/lib/paginated/adapter';
import { useCommentStore, type CommentThread } from '@/lib/comments/store';
import {
  assembleDocumentFile,
} from '@/lib/document/fileOperations';
import { DocumentFileSchema } from '@/lib/document/schema';
import { useDocumentStore } from '@/lib/document/store';
import { runEditorCommand } from '@/lib/editor/editorCommands';
import { getCommand } from '@/lib/commands/registry';
import { commentTrackingKey, activeCommentDecorations } from '@/lib/editor/CommentExtension';
import { ShowGroup } from '@/components/layout/ribbon/view/groups/ShowGroup';
import { FloatingToolbar } from '@/components/editor/FloatingToolbar';
import { useConfigStore } from '@/lib/config/store';
import { DEFAULT_CONFIG } from '@/lib/config/schema';
import { toast } from '@/components/ui/toast';

/**
 * #COMMENTS — commit 1: the two-half model. The ANCHORING half is the
 * `comment` mark (attrs.threadId) riding the PM doc; the CONTENT half
 * rides the comment store and .wpdoc metadata.commentThreads. The tests
 * pin the anchoring semantics (edge extension, orphaning, the janitor,
 * the load-order law), the file round-trip, and the layout-invisibility
 * (the adapter's recognized-quiet posture).
 */

interface MarkedRange {
  threadId: string;
  text: string;
}

/** All comment-marked text runs in the doc (id + their text). */
function markedRanges(editor: ReturnType<typeof renderTensor>['editor']): MarkedRange[] {
  const out: MarkedRange[] = [];
  editor!.state.doc.descendants((node) => {
    if (!node.isText) return true;
    const m = node.marks.find((mk) => mk.type.name === 'comment');
    if (m) out.push({ threadId: m.attrs.threadId as string, text: node.text ?? '' });
    return true;
  });
  return out;
}

function thread(id: string, text = 'note'): CommentThread {
  return {
    id,
    entries: [{ id: `e-${id}`, author: 'Tester', text, createdAt: '2026-01-01T00:00:00.000Z' }],
    resolved: false,
  };
}

/** The JSON shape of "hello world" with 'hello' comment-marked. */
function markedDoc(threadId: string) {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'hello', marks: [{ type: 'comment', attrs: { threadId } }] },
          { type: 'text', text: ' world' },
        ],
      },
    ],
  };
}

beforeEach(() => {
  // The comment store is a module singleton — reset wholesale (the
  // focus.test pattern; hydrate is the OPEN seam, setState the test one).
  useCommentStore.setState({
    threads: {},
    anchoredIds: new Set<string>(),
    activeThreadId: null,
    showResolved: false,
    draftThreadId: null,
  });
  useConfigStore.setState({ config: DEFAULT_CONFIG });
});

describe('#COMMENTS: the anchor (comment mark)', () => {
  it('rides getJSON verbatim and re-loads from it (the .wpdoc round-trip at the model layer)', async () => {
    const { editor } = renderTensor();
    await settleLayout();

    act(() => {
      useCommentStore.getState().hydrate([thread('t1')]);
      editor!.commands.setContent(markedDoc('t1'));
    });
    const json = editor!.getJSON();
    const para = json.content?.[0]?.content ?? [];
    const marked = para.find((c) => c.marks?.some((m) => m.type === 'comment'));
    expect(marked?.marks?.[0]).toEqual({ type: 'comment', attrs: { threadId: 't1' } });

    // The full file round-trip: assemble → validate → hydrate → load.
    const file = assembleDocumentFile(editor!, {
      pageSetup: useDocumentStore.getState().pageSetup,
      commentThreads: useCommentStore.getState().threadsForSave(),
    });
    expect(file.metadata.commentThreads).toHaveLength(1);
    const parsed = DocumentFileSchema.parse(JSON.parse(JSON.stringify(file)));
    act(() => {
      useCommentStore.getState().hydrate(parsed.metadata.commentThreads ?? []);
      editor!.commands.setContent(parsed.docJSON);
    });
    expect(markedRanges(editor!)).toEqual([{ threadId: 't1', text: 'hello' }]);
    expect(useCommentStore.getState().anchoredIds.has('t1')).toBe(true);
  });

  it('typing at EITHER edge extends the anchor; typing elsewhere does not', async () => {
    const { editor } = renderTensor();
    await settleLayout();

    act(() => {
      useCommentStore.getState().hydrate([thread('t1')]);
      editor!.commands.setContent(markedDoc('t1'));
    });
    // "hello world" — 'hello' is [1, 6). END edge: caret at 6, type X.
    act(() => {
      const tr = editor!.state.tr.insertText('X', 6);
      editor!.view.dispatch(tr);
    });
    expect(markedRanges(editor!)).toContainEqual({ threadId: 't1', text: 'helloX' });

    // START edge: caret at 1, type Y → Y joins the anchor.
    act(() => {
      const tr = editor!.state.tr.insertText('Y', 1);
      editor!.view.dispatch(tr);
    });
    expect(markedRanges(editor!)).toContainEqual({ threadId: 't1', text: 'YhelloX' });

    // Control: an unmarked gap ('world' at [9, 14)) — typed text there
    // stays unmarked.
    act(() => {
      const tr = editor!.state.tr.insertText('Z', 10);
      editor!.view.dispatch(tr);
    });
    const ranges = markedRanges(editor!);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.text).toBe('YhelloX');
  });

  it('deleting the full anchored range ORPHANS the thread — never silently gone', async () => {
    const { editor } = renderTensor();
    await settleLayout();

    act(() => {
      useCommentStore.getState().hydrate([thread('t1', 'my note')]);
      editor!.commands.setContent(markedDoc('t1'));
    });
    expect(useCommentStore.getState().anchoredIds.has('t1')).toBe(true);

    act(() => {
      editor!.commands.deleteRange({ from: 1, to: 6 }); // delete 'hello'
    });
    const state = useCommentStore.getState();
    // The anchor is gone; the thread (its note) remains — the orphaned
    // state the gutter will render with a clear affordance.
    expect(state.anchoredIds.has('t1')).toBe(false);
    expect(state.threads['t1']?.entries[0]?.text).toBe('my note');
  });

  it('THE LOAD-ORDER LAW: hydrate before setContent — loaded marks survive, ghosts are stripped', async () => {
    const { editor } = renderTensor();
    await settleLayout();

    // (a) A hydrated thread's marks survive the load.
    act(() => {
      useCommentStore.getState().hydrate([thread('t1')]);
      editor!.commands.setContent(markedDoc('t1'));
    });
    expect(markedRanges(editor!)).toEqual([{ threadId: 't1', text: 'hello' }]);

    // (b) A mark with NO thread record (a hand-edited file / the undo
    // asymmetry) is stripped by the janitor — the doc stays honest.
    act(() => {
      useCommentStore.getState().hydrate([]);
      editor!.commands.setContent(markedDoc('ghost'));
    });
    expect(markedRanges(editor!)).toEqual([]);
  });

  it('one thread spans paragraphs, sections, and columns — same threadId, several runs', async () => {
    const { editor } = renderTensor();
    await settleLayout();

    act(() => {
      useCommentStore.getState().hydrate([thread('t1')]);
      editor!.commands.setContent({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'first', marks: [{ type: 'comment', attrs: { threadId: 't1' } }] },
            ],
          },
          { type: 'paragraph', content: [{ type: 'text', text: 'middle' }] },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'last', marks: [{ type: 'comment', attrs: { threadId: 't1' } }] },
            ],
          },
        ],
      });
    });
    // Both runs anchor the ONE thread; a delete of the 'middle'
    // paragraph leaves the anchor live (the range spans the boundary).
    expect(useCommentStore.getState().anchoredIds.has('t1')).toBe(true);
    act(() => {
      editor!.commands.deleteRange({ from: 7, to: 14 }); // 'middle' paragraph
    });
    expect(useCommentStore.getState().anchoredIds.has('t1')).toBe(true);
    expect(markedRanges(editor!).map((r) => r.text)).toEqual(['first', 'last']);
  });

  it('the caret tracks its thread — active in, null out', async () => {
    const { editor } = renderTensor();
    await settleLayout();

    act(() => {
      useCommentStore.getState().hydrate([thread('t1')]);
      editor!.commands.setContent(markedDoc('t1'));
    });
    // Caret inside 'hello' (pos 3).
    act(() => {
      editor!.commands.setTextSelection(3);
    });
    expect(useCommentStore.getState().activeThreadId).toBe('t1');
    // Caret in the unmarked region (pos 9, inside 'world').
    act(() => {
      editor!.commands.setTextSelection(9);
    });
    expect(useCommentStore.getState().activeThreadId).toBeNull();
  });
});

describe('#COMMENTS: the thread store', () => {
  it('reply / edit / resolve stamp the record; entry deletion deletes the emptied thread', async () => {
    renderTensor();
    await settleLayout();

    act(() => {
      useCommentStore.getState().addThread('t1', 'first note');
      useCommentStore.getState().addReply('t1', 'a reply');
    });
    let t = useCommentStore.getState().threads['t1']!;
    expect(t.entries).toHaveLength(2);
    expect(t.entries[1]!.text).toBe('a reply');

    act(() => {
      useCommentStore.getState().editEntry('t1', t.entries[0]!.id, 'first note (fixed)');
    });
    t = useCommentStore.getState().threads['t1']!;
    expect(t.entries[0]!.text).toBe('first note (fixed)');
    expect(t.entries[0]!.editedAt).toBeTruthy();

    act(() => {
      useCommentStore.getState().setResolved('t1', true);
    });
    t = useCommentStore.getState().threads['t1']!;
    expect(t.resolved).toBe(true);
    expect(t.resolvedAt).toBeTruthy();
    act(() => {
      useCommentStore.getState().setResolved('t1', false);
    });
    t = useCommentStore.getState().threads['t1']!;
    expect(t.resolved).toBe(false);
    expect(t.resolvedAt).toBeUndefined();

    // Deleting the LAST entry deletes the thread (GDocs behavior).
    const lastId = t.entries[1]!.id;
    act(() => {
      useCommentStore.getState().deleteEntry('t1', lastId);
    });
    t = useCommentStore.getState().threads['t1']!;
    expect(t.entries).toHaveLength(1);
    act(() => {
      useCommentStore.getState().deleteEntry('t1', t.entries[0]!.id);
    });
    expect(useCommentStore.getState().threads['t1']).toBeUndefined();
  });

  it('deleteThread strips the anchor from the document (marks AND record gone)', async () => {
    const { editor } = renderTensor();
    await settleLayout();

    act(() => {
      useCommentStore.getState().hydrate([thread('t1')]);
      editor!.commands.setContent(markedDoc('t1'));
    });
    expect(markedRanges(editor!)).toHaveLength(1);
    act(() => {
      useCommentStore.getState().deleteThread('t1');
    });
    expect(markedRanges(editor!)).toEqual([]);
    expect(useCommentStore.getState().threads['t1']).toBeUndefined();
    expect(useCommentStore.getState().activeThreadId).toBeNull();
  });

  it('threadsForSave is the file seam; assembleDocumentFile writes threads only when non-empty', async () => {
    const { editor } = renderTensor();
    await settleLayout();

    // Empty store → the optional-field precedent (absent, not []).
    const empty = assembleDocumentFile(editor!, {
      pageSetup: useDocumentStore.getState().pageSetup,
      commentThreads: useCommentStore.getState().threadsForSave(),
    });
    expect('commentThreads' in empty.metadata).toBe(false);

    act(() => {
      useCommentStore.getState().addThread('t1', 'note');
    });
    const nonEmpty = assembleDocumentFile(editor!, {
      pageSetup: useDocumentStore.getState().pageSetup,
      commentThreads: useCommentStore.getState().threadsForSave(),
    });
    expect(nonEmpty.metadata.commentThreads).toEqual([
      expect.objectContaining({ id: 't1', resolved: false }),
    ]);

    // Backward compat: a file WITHOUT the field parses fine (old docs).
    const legacy = DocumentFileSchema.safeParse({
      version: 1,
      docJSON: { type: 'doc', content: [] },
      metadata: {},
    });
    expect(legacy.success).toBe(true);
  });
});

describe('#COMMENTS: layout invisibility (the recognized-quiet law)', () => {  it('the adapter converts comment-marked docs without a dropped-attr warning and identical flow', async () => {
    const { editor } = renderTensor();
    await settleLayout();

    const plain = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { blockId: 'plain-1' },
          content: [{ type: 'text', text: 'hello world' }],
        },
      ],
    };
    act(() => {
      useCommentStore.getState().hydrate([thread('t1')]);
      editor!.commands.setContent(markedDoc('t1'));
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const commented = pmDocToSemantic(editor!.state.doc, { fontFamily: 'system-ui', fontSize: 16 });
    const unmarked = pmDocToSemantic(
      // A fresh PM doc parsed from the same plain JSON (same engine
      // inputs, no comment marks). Node.fromJSON takes untyped JSON.
      (await import('@tiptap/pm/model')).Node.fromJSON(editor!.schema, plain),
      { fontFamily: 'system-ui', fontSize: 16 },
    );
    expect(warnSpy).not.toHaveBeenCalled();
    // The comment contributes NOTHING to layout: the concatenated text
    // and every run's resolved style are identical (the mark splits
    // runs at its boundaries — PM granularity — but paints no style).
    // (The Block union narrows runs to paragraph-like blocks — cast.)
    const runsOf = (blocks: typeof commented.doc.blocks): Array<{ text: string; style: unknown }> =>
      (blocks[0] as unknown as { runs?: Array<{ text: string; style: unknown }> }).runs ?? [];
    expect(runsOf(commented.doc.blocks).map((r) => r.text).join('')).toBe(
      runsOf(unmarked.doc.blocks).map((r) => r.text).join(''),
    );
    expect(runsOf(commented.doc.blocks).map((r) => r.text).join('')).toBe('hello world');
    // Deep style equality (separate object instances — the reference
    // identity of the resolved style is not the invariant).
    const plainStyle = runsOf(unmarked.doc.blocks)[0]?.style;
    expect(plainStyle).toBeDefined();
    for (const r of runsOf(commented.doc.blocks)) {
      expect(r.style).toEqual(plainStyle);
    }
    warnSpy.mockRestore();
  });
});

describe('#COMMENTS: the one command body — toolbar, Ctrl+Alt+M, palette', () => {
  it('addComment: a selection anchors it; a CARET anchors the word under it (the always-enabled ruling)', async () => {
    const { editor } = renderTensor('<p>hello world</p>');
    await settleLayout();

    // Text selection → the draft flow: anchor + empty first entry +
    // the draft flag (the composer's signal).
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 6 });
    });
    expect(runEditorCommand('addComment')).toBe(true);
    const state = useCommentStore.getState();
    const tid = state.draftThreadId!;
    expect(tid).toBeTruthy();
    expect(Object.keys(state.threads)).toHaveLength(1);
    expect(state.threads[tid]!.entries[0]!.text).toBe('');
    expect(state.anchoredIds.has(tid)).toBe(true);
    expect(markedRanges(editor)).toEqual([{ threadId: tid, text: 'hello' }]);

    // Submit fills the entry and clears the draft flag.
    act(() => {
      useCommentStore.getState().submitDraft(tid, 'my comment');
    });
    expect(useCommentStore.getState().threads[tid]!.entries[0]!.text).toBe('my comment');
    expect(useCommentStore.getState().draftThreadId).toBeNull();

    // THE CARET FALLBACK: park the caret INSIDE 'world' (pos 8) with
    // no selection → the command anchors exactly that word, selects
    // it (the user sees what got anchored), and opens the draft.
    act(() => {
      editor.commands.setTextSelection(8);
    });
    expect(runEditorCommand('addComment')).toBe(true);
    const tid2 = useCommentStore.getState().draftThreadId!;
    expect(tid2).toBeTruthy();
    expect(tid2).not.toBe(tid);
    expect(editor.state.selection.from).toBe(7);
    expect(editor.state.selection.to).toBe(12); // 'world' selected
    expect(markedRanges(editor)).toEqual([
      { threadId: tid, text: 'hello' },
      { threadId: tid2, text: 'world' },
    ]);
  });

  it('addComment with a caret in NO word toasts the guidance and writes nothing', async () => {
    const { editor } = renderTensor();
    await settleLayout();
    const toastSpy = vi.spyOn(toast, 'add');

    // An EMPTY paragraph: the caret sits in no word.
    act(() => {
      editor.commands.setContent({
        type: 'doc',
        content: [{ type: 'paragraph' }],
      });
      editor.commands.setTextSelection(1);
    });
    expect(runEditorCommand('addComment')).toBe(true); // handled (the toast)
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'info' }));
    expect(markedRanges(editor)).toEqual([]);
    expect(Object.keys(useCommentStore.getState().threads)).toHaveLength(0);
    expect(useCommentStore.getState().draftThreadId).toBeNull();
    toastSpy.mockRestore();
  });

  it('wordAround reads the word on the caret\'s text side at boundaries', async () => {
    // NOTE: PM's DOM parsing normalizes whitespace (runs collapse —
    // 'hello  world' parses as 'hello world'), so the boundary truth
    // here is single-spelled.
    const { editor } = renderTensor('<p>hello world</p>');
    await settleLayout();
    const { wordAround } = await import('@/lib/editor/CommentExtension');
    const doc = editor.state.doc;
    expect(wordAround(doc, 3)).toEqual({ from: 1, to: 6 }); // inside 'hello'
    expect(wordAround(doc, 6)).toEqual({ from: 1, to: 6 }); // caret ON the space — the word on its text side
    expect(wordAround(doc, 7)).toEqual({ from: 7, to: 12 }); // before 'world'
    expect(wordAround(doc, 12)).toEqual({ from: 7, to: 12 }); // after 'world' (doc end)
    expect(wordAround(doc, 0)).toBeNull(); // before the paragraph — no word
  });

  it('addComment refuses an image/node selection (non-text anchors out of scope)', async () => {
    const { editor } = renderTensor('<p>hello world</p>');
    await settleLayout();

    act(() => {
      const sel = NodeSelection.create(editor.state.doc, 0);
      editor.view.dispatch(editor.state.tr.setSelection(sel));
    });
    expect(runEditorCommand('addComment')).toBe(false);
    expect(Object.keys(useCommentStore.getState().threads)).toHaveLength(0);
  });

  it('addComment refuses band selections with a LOUD toast (the referenceTable precedent)', async () => {
    const { editor } = renderTensor();
    await settleLayout();
    const toastSpy = vi.spyOn(toast, 'add');

    act(() => {
      editor.commands.setContent({
        type: 'doc',
        content: [
          {
            type: 'headerBlock',
            attrs: { variant: 'first' },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'band text' }] }],
          },
        ],
      });
    });
    let bandPos = 1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'band text') {
        bandPos = pos;
        return false;
      }
      return true;
    });
    // A NON-EMPTY selection inside the band (a bare caret is refused by
    // the empty-guard first — and the UI never reaches it: the toolbar
    // disables itself and the palette's enablement is false).
    act(() => {
      editor.commands.setTextSelection({ from: bandPos, to: bandPos + 4 });
    });
    // Handled (the toast IS the outcome) — but no anchor, no thread.
    expect(runEditorCommand('addComment')).toBe(true);
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
    expect(markedRanges(editor)).toEqual([]);
    expect(Object.keys(useCommentStore.getState().threads)).toHaveLength(0);
    toastSpy.mockRestore();
  });

  it('cancelDraft removes the draft thread AND its anchor (an unsent draft leaves nothing)', async () => {
    const { editor } = renderTensor('<p>hello world</p>');
    await settleLayout();

    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 6 });
      runEditorCommand('addComment');
    });
    const tid = useCommentStore.getState().draftThreadId!;
    expect(markedRanges(editor)).toHaveLength(1);
    act(() => {
      useCommentStore.getState().cancelDraft(tid);
    });
    expect(markedRanges(editor)).toEqual([]);
    expect(useCommentStore.getState().threads[tid]).toBeUndefined();
    expect(useCommentStore.getState().draftThreadId).toBeNull();
  });

  it('Ctrl+Alt+M runs the SAME body through the real keymap pipeline', async () => {
    const { editor } = renderTensor('<p>hello world</p>');
    await settleLayout();

    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 6 });
    });
    act(() => {
      editor.view.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, altKey: true, bubbles: true }),
      );
    });
    expect(useCommentStore.getState().draftThreadId).toBeTruthy();
    expect(markedRanges(editor)).toHaveLength(1);
  });

  it('the palette dispatches the SAME body, ALWAYS enabled (the caret anchors the word)', async () => {
    const { editor } = renderTensor('<p>hello world</p>');
    await settleLayout();

    const cmd = getCommand('addComment')!;
    // A bare caret is no longer a disabled state — the ruling.
    act(() => {
      editor.commands.setTextSelection(3);
    });
    expect(cmd.enablement?.()).toBe(true);
    act(() => {
      cmd.run();
    });
    const tid = useCommentStore.getState().draftThreadId!;
    expect(tid).toBeTruthy();
    // The caret fallback anchored the word + selected it.
    expect(markedRanges(editor)).toEqual([{ threadId: tid, text: 'hello' }]);
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(6);
  });

  it('the floating toolbar comment button: always enabled, wired to the one body', async () => {
    const { editor } = renderTensor('<p>hello world</p>');
    await settleLayout();

    const position = { left: 100, top: 100, bottom: 120, placement: 'above' as const, gap: 8 };
    act(() => {
      editor.commands.setTextSelection(3); // bare caret
    });
    render(
      <FloatingToolbar editor={editor} position={position} containerTop={0} containerLeft={0} />,
    );
    const btn = document.querySelector('button[aria-label="Insert Comment"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(false);
    act(() => {
      fireEvent.click(btn);
    });
    const tid = useCommentStore.getState().draftThreadId!;
    expect(tid).toBeTruthy();
    expect(markedRanges(editor)).toEqual([{ threadId: tid, text: 'hello' }]);
  });
});

describe('#COMMENTS: the boundary-content toggle (the rewired Show Margins stub)', () => {
  it('the command flips the persisted flag; the View-tab button shows and toggles', async () => {
    renderTensor('<p>x</p>');
    await settleLayout();

    expect(useConfigStore.getState().config.editor.showBoundaryContent).toBe(true);
    act(() => {
      getCommand('toggleBoundaryContent')!.run();
    });
    expect(useConfigStore.getState().config.editor.showBoundaryContent).toBe(false);

    render(<ShowGroup />);
    const btn = document.querySelector(
      'button[aria-label="Show Boundary Content"]',
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(false); // both modes — pageless has boundary space too
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    act(() => {
      fireEvent.click(btn);
    });
    expect(useConfigStore.getState().config.editor.showBoundaryContent).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('in-flight drafts never survive a reopen (hydrate prunes all-empty threads)', () => {
    useCommentStore.getState().hydrate([
      thread('t1', 'a real note'),
      {
        id: 'draft1',
        entries: [{ id: 'e', author: 'A', text: '', createdAt: '2026-01-01T00:00:00.000Z' }],
        resolved: false,
      },
    ]);
    expect(useCommentStore.getState().threads['t1']).toBeDefined();
    expect(useCommentStore.getState().threads['draft1']).toBeUndefined();
  });
});

describe('#COMMENTS: highlights — one state, two projections', () => {
  it('collectCommentRanges merges adjacent runs and keeps block-spanning pieces apart-joined', async () => {
    const { editor } = renderTensor();
    await settleLayout();

    act(() => {
      useCommentStore.getState().hydrate([thread('t1'), thread('t2')]);
      editor.commands.setContent({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              // Three adjacent same-thread runs → ONE range.
              { type: 'text', text: 'aa', marks: [{ type: 'comment', attrs: { threadId: 't1' } }] },
              { type: 'text', text: 'bb', marks: [{ type: 'comment', attrs: { threadId: 't1' } }] },
              { type: 'text', text: 'cc', marks: [{ type: 'comment', attrs: { threadId: 't1' } }] },
              { type: 'text', text: 'gap' },
              { type: 'text', text: 'dd', marks: [{ type: 'comment', attrs: { threadId: 't2' } }] },
            ],
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'ee', marks: [{ type: 'comment', attrs: { threadId: 't1' } }] },
            ],
          },
        ],
      });
    });
    const ranges = commentTrackingKey.getState(editor.state)!.ranges;
    expect(ranges).toEqual([
      { threadId: 't1', from: 1, to: 7 }, // aa+bb+cc merged
      { threadId: 't2', from: 10, to: 12 },
      { threadId: 't1', from: 14, to: 16 }, // the second paragraph's piece
    ]);
  });

  it('typing at the edge grows the RANGE (the visible anchor extension)', async () => {
    const { editor } = renderTensor();
    await settleLayout();

    act(() => {
      useCommentStore.getState().hydrate([thread('t1')]);
      editor.commands.setContent(markedDoc('t1')); // 'hello' = [1, 6)
    });
    expect(commentTrackingKey.getState(editor.state)!.ranges).toEqual([
      { threadId: 't1', from: 1, to: 6 },
    ]);
    act(() => {
      editor.view.dispatch(editor.state.tr.insertText('X', 6));
    });
    expect(commentTrackingKey.getState(editor.state)!.ranges).toEqual([
      { threadId: 't1', from: 1, to: 7 },
    ]);
  });

  it('the paginated overlay: per-thread tinted rects, the active tier on the caret\'s thread', async () => {
    const { editor } = renderTensor();
    await settleLayout();

    act(() => {
      useCommentStore.getState().hydrate([thread('t1')]);
      editor.commands.setContent(markedDoc('t1'));
    });
    await settleLayout();
    // The base tier painted for the anchored thread.
    const rects = document.querySelectorAll('[data-testid="comment-rect"]');
    expect(rects.length).toBeGreaterThan(0);
    expect(rects[0]!.getAttribute('data-comment-thread')).toBe('t1');
    // No active tier yet (the caret is not in the thread).
    expect(document.querySelectorAll('[data-testid="comment-rect-active"]').length).toBe(0);

    // Caret into the thread → the active tier paints; out → it clears.
    act(() => {
      editor.commands.setTextSelection(3);
    });
    await settleLayout();
    expect(document.querySelectorAll('[data-testid="comment-rect-active"]').length).toBeGreaterThan(0);
    act(() => {
      editor.commands.setTextSelection(9);
    });
    await settleLayout();
    expect(document.querySelectorAll('[data-testid="comment-rect-active"]').length).toBe(0);
  });

  it('the pageless active-tier decoration: the caret\'s thread only, cleared on leave', async () => {
    const { editor } = renderTensor();
    await settleLayout();

    act(() => {
      useCommentStore.getState().hydrate([thread('t1')]);
      editor.commands.setContent(markedDoc('t1'));
    });
    // No active thread → empty decorations.
    expect(activeCommentDecorations(editor.state).find()).toHaveLength(0);
    act(() => {
      editor.commands.setTextSelection(3);
    });
    const decos = activeCommentDecorations(editor.state).find();
    expect(decos).toHaveLength(1);
    expect(decos[0]!.from).toBe(1);
    expect(decos[0]!.to).toBe(6);
    expect(
      (decos[0] as unknown as { type: { attrs: { class: string } } }).type.attrs.class,
    ).toBe('tensor-comment-active');
    act(() => {
      editor.commands.setTextSelection(9);
    });
    expect(activeCommentDecorations(editor.state).find()).toHaveLength(0);
  });

  it('orphaning clears the paint: the full-range delete leaves no rects', async () => {
    const { editor } = renderTensor();
    await settleLayout();

    act(() => {
      useCommentStore.getState().hydrate([thread('t1')]);
      editor.commands.setContent(markedDoc('t1'));
    });
    await settleLayout();
    expect(document.querySelectorAll('[data-testid="comment-rect"]').length).toBeGreaterThan(0);
    act(() => {
      editor.commands.deleteRange({ from: 1, to: 6 });
    });
    await settleLayout();
    expect(document.querySelectorAll('[data-testid="comment-rect"]').length).toBe(0);
    // The thread survives (the orphaned state — the gutter's job later).
    expect(useCommentStore.getState().threads['t1']).toBeDefined();
  });
});
