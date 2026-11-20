import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { renderTensor } from './harness';
import { settleLayout } from './harness';
import { pmDocToSemantic } from '@/lib/paginated/adapter';
import { useCommentStore, type CommentThread } from '@/lib/comments/store';
import {
  assembleDocumentFile,
} from '@/lib/document/fileOperations';
import { DocumentFileSchema } from '@/lib/document/schema';
import { useDocumentStore } from '@/lib/document/store';

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
  });
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

describe('#COMMENTS: layout invisibility (the recognized-quiet law)', () => {
  it('the adapter converts comment-marked docs without a dropped-attr warning and identical flow', async () => {
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
