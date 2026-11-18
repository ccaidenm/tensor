import { describe, it, expect, beforeEach } from 'vitest';
import { renderTensor, settleLayout } from './harness';
import { pmDocToSemantic } from '@/lib/paginated/adapter';
import {
  toLayoutOptions,
  DEFAULT_MARGINS,
  PAGE_GAP,
  type PageSetup,
} from '@/lib/document/pageSetup';
import { useDocumentStore } from '@/lib/document/store';
import { builtinDefinitionsById } from '@/lib/styles/builtins';
import { createLayoutEngine } from '@tensor-editor/engine';
import { assembleDocumentFile } from '@/lib/document/fileOperations';
import { FakeMetrics } from './fakeMetrics';

/**
 * #74 COLUMNS — the shell suite. The ENGINE's laws live in the engine's
 * own suite (packages/engine/tests/columns.test.ts); this file pins the
 * SHELL seams: the persistence + pipeline (store pageSetup →
 * toLayoutOptions → the engine's opts; per-section specs ride the
 * sectionBreak setup verbatim), the column-correct rendering, and the
 * manual column-break node.
 */

const LETTER: PageSetup = {
  pageSize: 'Letter',
  orientation: 'portrait',
  margins: DEFAULT_MARGINS,
  pageGap: PAGE_GAP,
};

const TWO_COL = { count: 2, gap: 24 } as const;

/** The FIRST sectionBreak node's position (PM's descendants walk). */
function findBreakPos(editor: ReturnType<typeof useDocumentStore.getState>['editor']): number | null {
  let found: number | null = null;
  editor!.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === 'sectionBreak') {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

/** Re-target the first break's setup (the test's geometry switch). */
function setBreakSetup(
  editor: NonNullable<ReturnType<typeof useDocumentStore.getState>['editor']>,
  setup: PageSetup,
) {
  const pos = findBreakPos(editor)!;
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(pos, undefined, {
      ...editor.state.doc.nodeAt(pos)!.attrs,
      setup,
    }),
  );
}

function adapt() {
  const { editor } = renderTensor('<p>x</p>');
  return {
    editor,
    run(html: string) {
      editor.commands.setContent(html);
      return pmDocToSemantic(
        editor.state.doc,
        { fontFamily: 'sans-serif', fontSize: 16 },
        { definitions: builtinDefinitionsById(), epoch: 0 },
        { differentFirstPage: false },
        undefined,
        undefined,
        useDocumentStore.getState().pageSetup,
      );
    },
  };
}

describe('columns — the persistence + pipeline', () => {
  beforeEach(() => {
    useDocumentStore.getState().setPageSetup({ ...LETTER });
  });

  it('toLayoutOptions carries the document-level column spec (null ≡ absent ≡ one column)', () => {
    const withColumns = toLayoutOptions({ ...LETTER, columns: TWO_COL });
    expect(withColumns.columns).toEqual(TWO_COL);
    // null is the PM round-trip spelling of "none" — mapped away.
    expect(toLayoutOptions({ ...LETTER, columns: null }).columns).toBeUndefined();
    expect(toLayoutOptions({ ...LETTER }).columns).toBeUndefined();
  });

  it('the store pageSetup drives the engine facts end-to-end (doc-level columns)', () => {
    useDocumentStore.getState().setPageSetup({ ...LETTER, columns: TWO_COL });
    const sem = adapt().run('<p>' + 'word '.repeat(600) + '</p>');
    const result = createLayoutEngine({ metrics: FakeMetrics }).layout(
      sem.doc,
      toLayoutOptions(useDocumentStore.getState().pageSetup),
    );
    // The page carries the resolved grid (Letter content 624 − 24 gap →
    // 300px columns at 0 and 324).
    expect(result.pages[0]!.columns).toEqual([
      { x: 0, width: 300 },
      { x: 324, width: 300 },
    ]);
    // Lines carry the slot index; both columns hold flow (the doc is
    // long enough to fill col 0 to the 54-line cap and spill).
    const col0 = result.lines.filter((l) => l.column === 0);
    const col1 = result.lines.filter((l) => l.column === 1);
    expect(col0.length).toBeGreaterThan(0);
    expect(col1.length).toBeGreaterThan(0);
    // Column left edges fold into rect.x.
    expect(col0.every((l) => l.rect.x === 0)).toBe(true);
    expect(col1.every((l) => l.rect.x === 324)).toBe(true);
  });

  it('per-section columns ride the sectionBreak setup verbatim (the pageColor precedent)', () => {
    const { editor, run } = adapt();
    run('<p>one</p><div data-section-break></div><p>two</p>');
    setBreakSetup(editor, { ...LETTER, columns: TWO_COL });
    const sem = pmDocToSemantic(
      editor.state.doc,
      { fontFamily: 'sans-serif', fontSize: 16 },
      { definitions: builtinDefinitionsById(), epoch: 0 },
      { differentFirstPage: false },
      undefined,
      undefined,
      useDocumentStore.getState().pageSetup,
    );
    // Section 0 (the −1 boundary) carries the break's setup — the grid.
    expect(sem.sections).toHaveLength(2);
    expect(sem.sections![0]!.geometry.columns).toEqual(TWO_COL);
    // The final section rides the store's pageSetup — single column.
    expect(sem.sections![1]!.geometry.columns).toBeUndefined();
  });

  it('the sections table reaches the engine with the per-section grid', () => {
    const { editor, run } = adapt();
    run('<p>' + 'word '.repeat(600) + '</p><div data-section-break></div><p>' + 'word '.repeat(600) + '</p>');
    setBreakSetup(editor, { ...LETTER, columns: TWO_COL });
    const sem = pmDocToSemantic(
      editor.state.doc,
      { fontFamily: 'sans-serif', fontSize: 16 },
      { definitions: builtinDefinitionsById(), epoch: 0 },
      { differentFirstPage: false },
      undefined,
      undefined,
      useDocumentStore.getState().pageSetup,
    );
    const result = createLayoutEngine({ metrics: FakeMetrics }).layout(sem.doc, {
      ...toLayoutOptions(useDocumentStore.getState().pageSetup),
      sections: sem.sections,
    });
    // Page 0 = section 0 (columned): the grid + slot-indexed lines.
    expect(result.pages[0]!.columns).toEqual([
      { x: 0, width: 300 },
      { x: 324, width: 300 },
    ]);
    expect(result.lines.some((l) => l.pageIndex === 0 && l.column === 1)).toBe(true);
    // Page 1+ = the final section (single column): no facts.
    const laterPages = result.pages.slice(1);
    expect(laterPages.length).toBeGreaterThan(0);
    expect(laterPages.every((p) => p.columns === undefined)).toBe(true);
    expect(
      result.lines.filter((l) => l.pageIndex > 0).every((l) => l.column === undefined),
    ).toBe(true);
  });

  it('columns persist through .wpdoc save/reopen (the schema satisfies binding)', () => {
    useDocumentStore.getState().setPageSetup({ ...LETTER, columns: TWO_COL });
    const { editor } = renderTensor('<p>persisted</p>');
    const file = assembleDocumentFile(editor, {
      pageSetup: useDocumentStore.getState().pageSetup,
    });
    // The file's metadata carries the spec verbatim (the schema's
    // `satisfies z.ZodType<PageSetup>` binding keeps file and model in
    // lockstep — a spelling drift is a type error).
    expect(file.metadata.pageSetup!.columns).toEqual(TWO_COL);
    // And the model side reads it back into a valid PageSetup.
    const reopened = file.metadata.pageSetup! as PageSetup;
    expect(toLayoutOptions(reopened).columns).toEqual(TWO_COL);
  });
});

describe('columns — the manual column break (ColumnBreakNode)', () => {
  beforeEach(() => {
    useDocumentStore.getState().setPageSetup({ ...LETTER });
  });

  it('inserts the atom with the pageBreak split-dance (the MIRROR law: identical shape)', () => {
    // The columnBreak node is the pageBreak node's twin — the mid-block
    // insert must produce the IDENTICAL doc shape with the kind swapped
    // (one mechanism, two spellings; the split-dance is shared code).
    const twin = (cmd: 'insertPageBreak' | 'insertColumnBreak') => {
      const { editor } = renderTensor('<p>before the break</p>');
      editor.commands.setTextSelection(7);
      editor.commands[cmd]();
      const names: string[] = [];
      editor.state.doc.forEach((n) => names.push(n.type.name));
      return names.map((n) => (n === 'pageBreak' || n === 'columnBreak' ? 'BREAK' : n));
    };
    expect(twin('insertColumnBreak')).toEqual(twin('insertPageBreak'));
    // And the atom exists between paragraphs (the caret's block split
    // around it, the text surviving on both sides).
    const names = twin('insertColumnBreak');
    const atomIndex = names.indexOf('BREAK');
    expect(atomIndex).toBeGreaterThan(0);
    expect(names[atomIndex - 1]).toBe('paragraph');
    expect(names[atomIndex + 1]).toBe('paragraph');
  });

  it('a block-start insert needs no split; a following textblock is guaranteed', () => {
    const { editor } = renderTensor('<p>whole block</p>');
    editor.commands.setTextSelection(1); // block start
    editor.commands.insertColumnBreak();
    const names: string[] = [];
    editor.state.doc.forEach((n) => names.push(n.type.name));
    expect(names).toEqual(['columnBreak', 'paragraph']);
  });

  it('the adapter stamps flow.breakBefore column on the following block + the NPC fact', () => {
    const { editor } = renderTensor('<p>one</p><div data-column-break></div><p>two</p>');
    const sem = pmDocToSemantic(
      editor.state.doc,
      { fontFamily: 'sans-serif', fontSize: 16 },
      { definitions: builtinDefinitionsById(), epoch: 0 },
      { differentFirstPage: false },
      undefined,
      undefined,
      useDocumentStore.getState().pageSetup,
    );
    // The pageBreak law: the node is NOT part of the IR — the FOLLOWING
    // block carries the forced break.
    const two = sem.doc.blocks.find((b) => b.id.endsWith('-two') || (sem.doc.blocks.indexOf(b) === 1));
    expect(two!.flow?.breakBefore).toBe('column');
    // The NPC sidecar: the badge anchors above "two"'s first line.
    expect(sem.breakFacts).toHaveLength(1);
    expect(sem.breakFacts![0]!.kind).toBe('columnBreak');
    expect(sem.breakFacts![0]!.afterBlockId).toBe(two!.id);
  });

  it('a trailing columnBreak stamps the next block if one follows (the harness normalizes one in)', () => {
    // TipTap normalizes a doc to `block+` — a trailing atom gets an
    // empty paragraph appended, so "nothing follows" is unreachable
    // through setContent; the LAW is what's pinned: the atom forces
    // the FOLLOWING block (here the normalized empty one), and a
    // genuinely trailing atom would simply skip (the pageBreak law —
    // pages/slots derive from placed lines).
    const { editor } = renderTensor('<p>one</p><div data-column-break></div>');
    const sem = pmDocToSemantic(
      editor.state.doc,
      { fontFamily: 'sans-serif', fontSize: 16 },
      { definitions: builtinDefinitionsById(), epoch: 0 },
      { differentFirstPage: false },
      undefined,
      undefined,
      useDocumentStore.getState().pageSetup,
    );
    expect(sem.breakFacts).toHaveLength(1);
    expect(sem.breakFacts![0]!.kind).toBe('columnBreak');
    // The forced block is the LAST block (the normalized empty p).
    const lastBlock = sem.doc.blocks[sem.doc.blocks.length - 1]!;
    expect(sem.breakFacts![0]!.afterBlockId).toBe(lastBlock.id);
    expect(lastBlock.flow?.breakBefore).toBe('column');
    // "one" itself carries no stamp.
    expect(sem.doc.blocks[0]!.flow?.breakBefore).toBeUndefined();
  });

  it('the engine honors the stamp: content after the break opens the next column', () => {
    useDocumentStore.getState().setPageSetup({ ...LETTER, columns: TWO_COL });
    const { editor } = renderTensor(
      '<p>' + 'word '.repeat(120) + '</p><div data-column-break></div><p>' + 'word '.repeat(60) + '</p>',
    );
    const sem = pmDocToSemantic(
      editor.state.doc,
      { fontFamily: 'sans-serif', fontSize: 16 },
      { definitions: builtinDefinitionsById(), epoch: 0 },
      { differentFirstPage: false },
      undefined,
      undefined,
      useDocumentStore.getState().pageSetup,
    );
    const result = createLayoutEngine({ metrics: FakeMetrics }).layout(
      sem.doc,
      toLayoutOptions(useDocumentStore.getState().pageSetup),
    );
    // Slot cap 54 (16px lines in 864px): block one fills column 0 with
    // 54 lines; the break forces block two to open column 1 at y 0.
    const two = result.lines.filter((l) => l.blockId !== result.lines[0]!.blockId);
    expect(two[0]!.column).toBe(1);
    expect(two[0]!.rect.y).toBe(0);
    expect(two[0]!.rect.x).toBe(324);
  });

  it('the Column Break badge paints at the anchor line’s column (NPC marks on)', async () => {
    useDocumentStore.getState().setPageSetup({ ...LETTER, columns: TWO_COL });
    renderTensor('<p>' + 'word '.repeat(120) + '</p><div data-column-break></div><p>after the break</p>');
    await settleLayout();
    const marks = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="break-mark-columnBreak"]'),
    );
    expect(marks).toHaveLength(1);
    expect(marks[0]!.textContent).toContain('Column Break');
    // The bar spans the COLUMN (300px), not the content box (624px).
    const width = parseFloat(marks[0]!.style.width);
    expect(width).toBeLessThan(624);
    expect(width).toBeGreaterThan(0);
  });
});
