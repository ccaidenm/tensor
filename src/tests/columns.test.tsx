import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, act } from '@testing-library/react';
import { unzipSync, strToU8 } from 'fflate';
import { renderTensor, settleLayout } from './harness';
import { pmDocToSemantic } from '@/lib/paginated/adapter';
import {
  toLayoutOptions,
  DEFAULT_MARGINS,
  PAGE_GAP,
  type PageSetup,
} from '@/lib/document/pageSetup';
import { useDocumentStore } from '@/lib/document/store';
import { useDocumentPropertiesStore } from '@/lib/document/propertiesStore';
import { builtinDefinitionsById } from '@/lib/styles/builtins';
import { createLayoutEngine } from '@tensor-editor/engine';
import { assembleDocumentFile } from '@/lib/document/fileOperations';
import { FakeMetrics } from './fakeMetrics';
import { ColumnsDialog } from '@/components/dialogs/ColumnsDialog';
import { ArrangeGroup } from '@/components/layout/ribbon/layout/groups/ArrangeGroup';
import { BreaksGroup } from '@/components/layout/ribbon/insert/groups/BreaksGroup';
import { buildDocx, type DocxExportInput } from '@/lib/docx/export';
import { buildPrintDocument } from '@/lib/print/buildDocument';
import { mapDocxDocument, parseDocxTrees } from '@/lib/docx/import';
import { BUILTIN_DEFINITIONS } from '@/lib/styles/builtins';

// The DOCX round-trip harness (docx.test.tsx's shapes).
const TINY_PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);
const SHA = 'c'.repeat(64);
function doc(...children: import('@tiptap/core').JSONContent[]): import('@tiptap/core').JSONContent {
  return { type: 'doc', content: children };
}
function para(text: string): import('@tiptap/core').JSONContent {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}
function makeInput(json: import('@tiptap/core').JSONContent, overrides: Partial<DocxExportInput> = {}): DocxExportInput {
  return {
    json,
    pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: 32 } satisfies PageSetup,
    headerFooter: null,
    coreProperties: { title: 'Columns Test', creator: 'Tensor' },
    styleDefinitions: [...BUILTIN_DEFINITIONS],
    baseStyle: { fontFamily: 'Source Serif 4', fontSize: 16 },
    media: new Map([[SHA, { bytes: TINY_PNG, ext: 'png' }]]),
    ...overrides,
  };
}
async function exportParts(input: DocxExportInput) {
  const { bytes } = await buildDocx(input);
  const parts = unzipSync(bytes);
  const decoder = new TextDecoder();
  return { text: (part: string) => decoder.decode(parts[part]!) };
}

/**
 * #74 — the columns shell suite. The engine-side behavior lives in
 * packages/engine/tests/columns.test.ts; this file pins the SHELL
 * seams: the persistence + pipeline (store pageSetup → toLayoutOptions
 * → the engine's opts; per-section specs ride the sectionBreak setup
 * verbatim), the column-correct rendering, and the manual column-break
 * node.
 */

const LETTER: PageSetup = {
  pageSize: 'Letter',
  orientation: 'portrait',
  margins: DEFAULT_MARGINS,
  pageGap: PAGE_GAP,
};

const TWO_COL = { count: 2, gap: 36 } as const; // 36pt = Word's 0.5" → 48px

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

  it('toLayoutOptions carries the document-level column spec (gap pt → px; null ≡ absent ≡ one column)', () => {
    const withColumns = toLayoutOptions({ ...LETTER, columns: TWO_COL });
    // The setup's gap is POINTS; the boundary converts.
    expect(withColumns.columns).toEqual({ count: 2, gap: 48 });
    // null is the PM round-trip spelling of "none" — mapped away.
    expect(toLayoutOptions({ ...LETTER, columns: null }).columns).toBeUndefined();
    expect(toLayoutOptions({ ...LETTER }).columns).toBeUndefined();
    // Absent gap ≡ the engine's own default (Word's 0.5") — omitted.
    expect(toLayoutOptions({ ...LETTER, columns: { count: 3 } }).columns).toEqual({ count: 3 });
  });

  it('the store pageSetup drives the engine facts end-to-end (doc-level columns)', () => {
    useDocumentStore.getState().setPageSetup({ ...LETTER, columns: TWO_COL });
    const sem = adapt().run('<p>' + 'word '.repeat(600) + '</p>');
    const result = createLayoutEngine({ metrics: FakeMetrics }).layout(
      sem.doc,
      toLayoutOptions(useDocumentStore.getState().pageSetup),
    );
    // The page carries the resolved grid (Letter content 624 − the
    // 48px gap → 288px columns at 0 and 336).
    expect(result.pages[0]!.columns).toEqual([
      { x: 0, width: 288 },
      { x: 336, width: 288 },
    ]);
    // Lines carry the slot index; both columns hold flow (the doc is
    // long enough to fill col 0 to the 54-line cap and spill).
    const col0 = result.lines.filter((l) => l.column === 0);
    const col1 = result.lines.filter((l) => l.column === 1);
    expect(col0.length).toBeGreaterThan(0);
    expect(col1.length).toBeGreaterThan(0);
    // Column left edges fold into rect.x.
    expect(col0.every((l) => l.rect.x === 0)).toBe(true);
    expect(col1.every((l) => l.rect.x === 336)).toBe(true);
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
    expect(sem.sections![0]!.geometry.columns).toEqual({ count: 2, gap: 48 });
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
      { x: 0, width: 288 },
      { x: 336, width: 288 },
    ]);
    expect(result.lines.some((l) => l.pageIndex === 0 && l.column === 1)).toBe(true);
    // The FINAL section's page (the last page) is single column — no
    // facts. (Section 0's own overflow pages legitimately carry the
    // grid — the section's pages, not the final section's.)
    const lastPage = result.pages[result.pages.length - 1]!;
    expect(lastPage.columns).toBeUndefined();
    expect(
      result.lines
        .filter((l) => l.pageIndex === lastPage.index)
        .every((l) => l.column === undefined),
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
    // And the model side reads it back into a valid PageSetup (the
    // boundary converts the persisted pt to the engine's px).
    const reopened = file.metadata.pageSetup! as PageSetup;
    expect(toLayoutOptions(reopened).columns).toEqual({ count: 2, gap: 48 });
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
    // The node is NOT part of the IR — the FOLLOWING block carries
    // the forced break.
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
    // through setContent. What's pinned: the atom forces the FOLLOWING
    // block (here the normalized empty one); a genuinely trailing
    // atom would simply skip (pages/slots derive from placed lines).
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
    expect(two[0]!.rect.x).toBe(336);
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
    // The bar spans the COLUMN (288px), not the content box (624px).
    const width = parseFloat(marks[0]!.style.width);
    expect(width).toBeLessThan(624);
    expect(width).toBeGreaterThan(0);
  });
});

describe('columns — the Columns surfaces (the dialog, the popover, the button)', () => {
  beforeEach(() => {
    useDocumentStore.getState().setPageSetup({ ...LETTER });
    useDocumentPropertiesStore.getState().closeColumns();
  });

  function mountDialog() {
    const dialog = render(<ColumnsDialog />);
    return { dialog, open: () => act(() => useDocumentPropertiesStore.getState().openColumns()) };
  }

  it('the dialog drafts from the store; Done applies document-wide (the store + every break)', () => {
    useDocumentStore.getState().setPageSetup({ ...LETTER, columns: TWO_COL });
    const { editor } = renderTensor('<p>a</p><div data-section-break></div><p>b</p>');
    const { open } = mountDialog();
    open();
    // The draft seeds from the store's spec (the document scope's target).
    const count = document.querySelector<HTMLInputElement>('input[aria-label="Number of columns"]');
    expect(count?.value).toBe('2');
    // Preset "Three" drafts count 3; Done applies document-wide.
    fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Three')!);
    fireEvent.click(document.querySelector('[data-testid="columns-dialog-done"]')!);
    // The store carries the spec; the break's setup merged it too
    // (the document scope is one transaction).
    expect(useDocumentStore.getState().pageSetup.columns).toEqual({ count: 3, gap: 36 });
    const breakPos = ((): number | null => {
      let found: number | null = null;
      editor.state.doc.descendants((node, pos) => {
        if (found !== null) return false;
        if (node.type.name === 'sectionBreak') {
          found = pos;
          return false;
        }
        return true;
      });
      return found;
    })();
    const setup = editor.state.doc.nodeAt(breakPos!)!.attrs.setup as PageSetup;
    expect(setup.columns).toEqual({ count: 3, gap: 36 });
  });

  it('the One preset clears the spec (null = one column, the additive law)', () => {
    useDocumentStore.getState().setPageSetup({ ...LETTER, columns: TWO_COL });
    renderTensor('<p>a</p>');
    const { open } = mountDialog();
    open();
    fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'One')!);
    fireEvent.click(document.querySelector('[data-testid="columns-dialog-done"]')!);
    expect(useDocumentStore.getState().pageSetup.columns).toBeNull();
    // And toLayoutOptions maps it away — the engine never sees null.
    expect(toLayoutOptions(useDocumentStore.getState().pageSetup).columns).toBeUndefined();
  });

  it('unequal widths ride the draft (the Word checkbox; the engine consumes the weights)', () => {
    renderTensor('<p>a</p>');
    const { open } = mountDialog();
    open();
    // Left preset: 1:2 (the narrow left column takes a third) — the
    // count drafts to 2 with UNEQUAL widths (the checkbox unchecks).
    fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Left')!);
    const widthInputs = document.querySelectorAll<HTMLInputElement>('input[aria-label^="Column "]');
    expect(widthInputs.length).toBe(2);
    fireEvent.click(document.querySelector('[data-testid="columns-dialog-done"]')!);
    const spec = useDocumentStore.getState().pageSetup.columns!;
    expect(spec.count).toBe(2);
    expect(spec.widths).toHaveLength(2);
    expect(spec.widths![0]!).toBeLessThan(spec.widths![1]!);
    // The engine's grid honors the ratio: the 576px post-gap space
    // (624 − the 48px gap) splits 1:2 → 192/384.
    const sem = adapt().run('<p>' + 'word '.repeat(300) + '</p>');
    const result = createLayoutEngine({ metrics: FakeMetrics }).layout(
      sem.doc,
      toLayoutOptions(useDocumentStore.getState().pageSetup),
    );
    expect(result.pages[0]!.columns![0]!.width).toBeCloseTo(192, 0);
    expect(result.pages[0]!.columns![1]!.width).toBeCloseTo(384, 0);
  });

  it('the ColumnsButton presets apply document-wide; "More columns…" opens the dialog', () => {
    renderTensor('<p>a</p><div data-section-break></div><p>b</p>');
    render(<ArrangeGroup />);
    // The Two preset: one click, the store + the break merge.
    fireEvent.click(document.querySelector('[data-testid="columns-button"]')!);
    fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Two')!);
    expect(useDocumentStore.getState().pageSetup.columns).toEqual({ count: 2 });
    // More columns… opens the dialog.
    fireEvent.click(document.querySelector('[data-testid="columns-button"]')!);
    fireEvent.click(document.querySelector('[data-testid="more-columns"]')!);
    expect(useDocumentPropertiesStore.getState().columnsIsOpen).toBe(true);
  });

  it('the BreaksGroup carries the Column Break button (the insert command)', () => {
    const { editor } = renderTensor('<p>one</p>');
    render(<BreaksGroup editor={editor} />);
    fireEvent.click(
      [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Column Break')!,
    );
    const names: string[] = [];
    editor.state.doc.forEach((n) => names.push(n.type.name));
    expect(names).toContain('columnBreak');
  });

  it('the ruler frames to the caret’s column (the tab-stop glyph anchors to the slot)', async () => {
    useDocumentStore.getState().setPageSetup({ ...LETTER, columns: TWO_COL });
    const { editor } = renderTensor(
      '<p>' + 'word '.repeat(1200) + '</p><p>tail block in the second column</p>',
    );
    await settleLayout();
    // The caret into the LAST block (whose first line flows in column 1
    // — the second slot) and give it a tab stop at 100px.
    const lastPos = editor.state.doc.content.size - 2;
    act(() => {
      editor.commands.setTextSelection(lastPos);
      editor.commands.setTabStops([{ position: 100, alignment: 'left' }]);
    });
    await settleLayout();
    // The bar's tab glyph: left = (contentX 96 + slot.x 336 + 100) × 1.
    const glyph = document.querySelector<HTMLElement>('[data-testid="ruler-tab-stop"]');
    expect(glyph).not.toBeNull();
    expect(parseFloat(glyph!.style.left)).toBeCloseTo(96 + 336 + 100, 0);
  });
});

describe('columns — the DOCX round trip (Word’s w:cols + the break runs)', () => {
  // The import fixtures' local helpers (docx-import.test.tsx's shapes,
  // re-declared — the section/break arms need only the minimal parts).
  const W_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const STYLES_XML = `${W_DECL}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;
  const body = (children: string) =>
    `${W_DECL}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${children}</w:body></w:document>`;
  const runXml = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
  const importParts = (entries: Record<string, string>) => {
    const parts: Record<string, Uint8Array> = {};
    for (const [name, value] of Object.entries(entries)) parts[name] = strToU8(value);
    return mapDocxDocument(parseDocxTrees(parts), { fontPolicy: 'keep', mediaPartToId: new Map() });
  };

  it('the export spells w:cols (count + spacing in twips; widths as w:col entries)', async () => {
    const { text } = await exportParts(makeInput(doc(para('a')), {
      pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: 32, columns: { count: 2, gap: 36 } },
    }));
    const documentXml = text('word/document.xml');
    expect(documentXml).toContain('w:cols');
    expect(documentXml).toContain('w:num="2"');
    // 36pt = 720 twips (Word's spacing unit).
    expect(documentXml).toContain('w:space="720"');
    // Equal widths: no per-col entries, equalWidth stays true (absent).
    expect(documentXml).not.toContain('w:equalWidth="0"');

    const { text: custom } = await exportParts(makeInput(doc(para('a')), {
      pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: 32, columns: { count: 2, gap: 36, widths: [144, 288] } },
    }));
    const customXml = custom('word/document.xml');
    // Word's custom spelling: equalWidth false (ST_OnOff's 0/false) +
    // the absolute w:col entries (pt → twips: 144pt = 2880tw, 288pt =
    // 5760tw).
    expect(customXml).toContain('w:equalWidth="false"');
    expect(customXml).toContain('w:w="2880"');
    expect(customXml).toContain('w:w="5760"');
  });

  it('the export spells the column break run (w:br type="column")', async () => {
    const { text } = await exportParts(makeInput(doc(para('a'), { type: 'columnBreak' }, para('b'))));
    expect(text('word/document.xml')).toContain('<w:br w:type="column"/>');
  });

  it('the import reads w:cols into the setup (twips → pt; custom widths)', () => {
    const parsed = importParts({
      'word/document.xml': body(
        `${runXml('x')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:cols w:num="3" w:space="480"/></w:sectPr>`,
      ),
      'word/styles.xml': STYLES_XML,
    });
    // 480 twips = 24pt.
    expect(parsed.pageSetup.columns).toEqual({ count: 3, gap: 24 });
    // Custom widths: w:equalWidth="false" + the entries (2880/5760 tw →
    // 144/288 pt — the engine's weights).
    const custom = importParts({
      'word/document.xml': body(
        `${runXml('x')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>` +
        `<w:cols w:num="2" w:space="720" w:equalWidth="0"><w:col w:w="2880"/><w:col w:w="5760"/></w:cols></w:sectPr>`,
      ),
      'word/styles.xml': STYLES_XML,
    });
    expect(custom.pageSetup.columns).toEqual({ count: 2, gap: 36, widths: [144, 288] });
    // Equal entries (no equalWidth="0") ARE the equal spelling — no
    // widths array.
    const equal = importParts({
      'word/document.xml': body(
        `${runXml('x')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>` +
        `<w:cols w:num="2" w:space="720"><w:col w:w="4320"/><w:col w:w="4320"/></w:cols></w:sectPr>`,
      ),
      'word/styles.xml': STYLES_XML,
    });
    expect(equal.pageSetup.columns).toEqual({ count: 2, gap: 36 });
  });

  it('the import maps the column-break runs (own-paragraph node; trailing attr)', () => {
    // Word's own-paragraph spelling → the columnBreak node.
    const own = importParts({
      'word/document.xml': body(
        `<w:p>${runXml('before')}</w:p><w:p><w:r><w:br w:type="column"/></w:r></w:p><w:p>${runXml('after')}</w:p>`,
      ),
      'word/styles.xml': STYLES_XML,
    });
    const types = own.json.content!.map((n) => n.type);
    expect(types).toEqual(['paragraph', 'columnBreak', 'paragraph']);

    // A trailing break rides the paragraph (Word's break-after spelling).
    const trailing = importParts({
      'word/document.xml': body(`<w:p>${runXml('content')}<w:r><w:br w:type="column"/></w:r></w:p>`),
      'word/styles.xml': STYLES_XML,
    });
    const only = trailing.json.content![0]!;
    expect(only.type).toBe('paragraph');
    expect(only.attrs!.breakAfter).toBe('column');
  });

  it('THE ROUND TRIP: Tensor → docx → Tensor keeps the spec and the break', async () => {
    // Export a columned doc with a manual break.
    const { bytes } = await buildDocx(makeInput(doc(
      para('a'),
      { type: 'columnBreak' },
      para('b'),
    ), {
      pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: 32, columns: { count: 2, gap: 36, widths: [144, 288] } },
    }));
    const parts = unzipSync(bytes);
    const parsed = mapDocxDocument(parseDocxTrees(parts as Record<string, Uint8Array>), {
      fontPolicy: 'keep',
      mediaPartToId: new Map(),
    });
    // The spec: count + gap (tw→pt) + the absolute widths.
    expect(parsed.pageSetup.columns).toEqual({ count: 2, gap: 36, widths: [144, 288] });
    // The break: the node survives as the columnBreak block.
    const types = parsed.json.content!.map((n) => n.type);
    expect(types).toEqual(['paragraph', 'columnBreak', 'paragraph']);
  });
});

describe('columns — print renders the columned flow (the walk is column-blind by construction)', () => {
  it('print elements land in the second slot’s band (column-offset x)', async () => {
    useDocumentStore.getState().setPageSetup({ ...LETTER, columns: TWO_COL });
    // Long enough to spill past column 0's 54-line slot under ANY
    // metrics (jsdom's canvas measures narrow — the real ones wide).
    const { editor } = renderTensor('<p>' + 'word '.repeat(3000) + '</p>');
    await settleLayout();
    const built = buildPrintDocument(editor);
    // Column 1's band starts at contentBox.x + slot.x = 96 + 336 = 432:
    // spilled text elements there carry the column offset.
    const col2Texts = built.pages[0]!.elements.filter(
      (e) => e.kind === 'text' && e.x >= 430,
    );
    expect(col2Texts.length).toBeGreaterThan(0);
  });
});
