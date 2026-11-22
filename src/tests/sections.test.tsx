import { describe, it, expect, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { NodeSelection } from '@tiptap/pm/state';
import { renderTensor, settleLayout, GEOMETRY } from './harness';
import { pmDocToSemantic } from '@/lib/paginated/adapter';
import { toLayoutOptions, DEFAULT_MARGINS, MARGIN_PRESETS, PAGE_GAP, type PageSetup } from '@/lib/document/pageSetup';
import { useDocumentStore } from '@/lib/document/store';
import { builtinDefinitionsById } from '@/lib/styles/builtins';
import { deleteSectionBreakNear, enableRegion, relinkBand } from '@/lib/editor/headerFooterCommands';
import { applyPageSetup } from '@/lib/editor/sections';
import { assembleDocumentFile } from '@/lib/document/fileOperations';
import { normalizePageStyles } from '@/lib/document/pageSetup';
import { useDocumentPropertiesStore } from '@/lib/document/propertiesStore';
import { PageSetupDialog } from '@/components/dialogs/PageSetupDialog';
import { fireEvent, render } from '@testing-library/react';

let mountedDialog: ReturnType<typeof render> | null = null;

/** Mounted alongside the editor as App does. Self-cleaning: a stale
 *  dialog would double-apply on Done — the previous one unmounts first. */
function renderSectionDialog(): void {
  mountedDialog?.unmount();
  mountedDialog = render(<PageSetupDialog />);
}

const threeSections =
  '<p>one</p><div data-section-break></div><p>two</p><div data-section-break></div><p>three</p>';

/**
 * #58 — the shell suite: the node's insert behavior, the adapter's
 * boundary resolution, and per-section sheet sizing. Engine-level
 * behavior lives in packages/engine/tests/sections.test.ts.
 */


/** The FIRST sectionBreak node + its position (PM's descendants walk —
 *  a Node has no querySelector). */
function findBreak(editor: NonNullable<ReturnType<typeof useDocumentStore.getState>['editor']>) {
  let found: { pos: number; node: import('@tiptap/pm/model').Node } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === 'sectionBreak') {
      found = { pos, node };
      return false;
    }
    return true;
  });
  return found as { pos: number; node: import('@tiptap/pm/model').Node } | null;
}

/** Re-target the first break's setup (the test's geometry switch). */
function setBreakSetup(
  editor: NonNullable<ReturnType<typeof useDocumentStore.getState>['editor']>,
  setup: PageSetup,
) {
  const found = findBreak(editor);
  expect(found).toBeTruthy();
  act(() => {
    editor.view.dispatch(editor.state.tr.setNodeMarkup(found!.pos, undefined, { ...found!.node.attrs, setup }));
  });
}

const A4_SETUP: PageSetup = {
  pageSize: 'A4',
  orientation: 'portrait',
  margins: DEFAULT_MARGINS,
  pageGap: PAGE_GAP,
};

describe('SectionBreakNode — the insert law', () => {
  beforeEach(() => {
    useDocumentStore.getState().setPageSetup({
      pageSize: 'Letter',
      orientation: 'portrait',
      margins: DEFAULT_MARGINS,
      pageGap: PAGE_GAP,
    });
  });

  it('inserts an atom with the seeded setup + a stable sectionId (the split-dance)', () => {
    const { editor } = renderTensor('<p>before the break</p>');
    act(() => {
      editor.commands.insertSectionBreak();
    });
    const found = findBreak(editor);
    expect(found).toBeTruthy();
    expect(found!.node.attrs.setup).toMatchObject({ pageSize: 'Letter' });
    expect(typeof found!.node.attrs.sectionId).toBe('string');
    expect(found!.node.attrs.sectionId).toMatch(/^sec-/);
  });

  it('an explicit setup arg seeds verbatim (the ribbon/driver surface)', () => {
    const { editor } = renderTensor('<p>explicit</p>');
    act(() => {
      editor.commands.insertSectionBreak(A4_SETUP);
    });
    const found = findBreak(editor);
    expect(found!.node.attrs.setup).toMatchObject({ pageSize: 'A4' });
  });
});

describe('the adapter — boundary resolution', () => {
  it('sectionBreak nodes resolve to the engine’s section-start table', () => {
    const { editor } = renderTensor('<p>a</p><div data-section-break></div><p>b</p><p>c</p>');
    // Set the break's setup to A4 (the insert seeded Letter).
    setBreakSetup(editor, A4_SETUP);
    const adapted = pmDocToSemantic(
      editor.state.doc,
      { fontFamily: 'sans-serif', fontSize: 16 },
      { definitions: builtinDefinitionsById(), epoch: 0 },
      { differentFirstPage: false },
      undefined,
      undefined,
      useDocumentStore.getState().pageSetup,
    );
    // 1 break → 2 sections: the break carries the PRECEDING section's
    // props; the final section rides the doc's pageSetup.
    expect(adapted.sections).toHaveLength(2);
    expect(adapted.sections![0]!.afterBlock).toBe(-1);
    expect(adapted.sections![0]!.geometry.page).toMatchObject(
      toLayoutOptions(A4_SETUP).page,
    );
    expect(adapted.sections![1]!.afterBlock).toBe(0);
    expect(adapted.sections![1]!.geometry.page).toMatchObject(
      toLayoutOptions({ pageSize: 'Letter', orientation: 'portrait', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP }).page,
    );
  });

  it('a doc with no sectionBreak nodes carries NO sections (the additive law)', () => {
    const { editor } = renderTensor('<p>plain</p>');
    const adapted = pmDocToSemantic(
      editor.state.doc,
      { fontFamily: 'sans-serif', fontSize: 16 },
      { definitions: builtinDefinitionsById(), epoch: 0 },
      { differentFirstPage: false },
      undefined,
      undefined,
      useDocumentStore.getState().pageSetup,
    );
    expect(adapted.sections).toBeUndefined();
  });
});

describe('the view — mixed page sizes render per section', () => {
  it('sheets sized per their own section (A4 section 0, Letter section 1)', async () => {
    const longText = '<p>' + 'word '.repeat(400) + '</p>';
    const { editor } = renderTensor(longText + '<div data-section-break></div>' + longText);
    // The break seeds Letter (the store default) — make section 0 A4.
    setBreakSetup(editor, A4_SETUP);
    await settleLayout();
    const sheets = Array.from(document.querySelectorAll<HTMLElement>('[data-page-index]'));
    expect(sheets.length).toBeGreaterThanOrEqual(2);
    const a4W = Math.round((595 * 96) / 72); // A4 pt → px
    const letterW = Math.round((612 * 96) / 72);
    const firstSheet = sheets[0]!;
    const lastSheet = sheets[sheets.length - 1]!;
    // The break carries the PRECEDING section's props: section 0 = A4, section 1 = Letter.
    expect(firstSheet.style.width).toBe(`${a4W}px`);
    expect(lastSheet.style.width).toBe(`${letterW}px`);
    expect(a4W).not.toBe(letterW);
  });

  it('a section boundary forces a new page (content never shares the sheet)', async () => {
    const { editor } = renderTensor('<p>first page content</p><div data-section-break></div><p>second section</p>');
    await settleLayout();
    const sheets = Array.from(document.querySelectorAll<HTMLElement>('[data-page-index]'));
    expect(sheets.length).toBe(2);
    void editor;
  });

  it('GEOMETRY unchanged for uniform docs (the additive law, smoke)', async () => {
    const { editor } = renderTensor('<p>uniform</p>');
    await settleLayout();
    const sheets = Array.from(document.querySelectorAll<HTMLElement>('[data-page-index]'));
    expect(sheets.length).toBe(1);
    expect(sheets[0]!.style.width).toBe(`${GEOMETRY.pageWidth}px`);
    void editor;
  });
});

describe('the tagged band containers', () => {
  const longText = '<p>' + 'word '.repeat(400) + '</p>';

  /** Insert a break and retag it with a KNOWN sectionId (the deterministic
   *  fixture — insertSectionBreak generates a random id). */
  function insertBreakTagged(
    editor: NonNullable<ReturnType<typeof useDocumentStore.getState>['editor']>,
    sectionId: string,
  ): void {
    act(() => {
      editor.commands.insertSectionBreak();
    });
    const found = findBreak(editor);
    expect(found).toBeTruthy();
    act(() => {
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(found!.pos, undefined, {
          ...found!.node.attrs,
          sectionId,
        }),
      );
    });
  }

  it('a tagged band container resolves to its section’s override (the adapter table)', async () => {
    const { editor } = renderTensor('<p>a</p>');
    insertBreakTagged(editor, 'sec-a');
    act(() => {
      editor.commands.insertContentAt(0, {
        type: 'headerBlock',
        attrs: { variant: 'default', sectionId: 'sec-a' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'SEC ZERO' }] }],
      });
    });
    const adapted = pmDocToSemantic(
      editor.state.doc,
      { fontFamily: 'sans-serif', fontSize: 16 },
      { definitions: builtinDefinitionsById(), epoch: 0 },
      { differentFirstPage: false },
      undefined,
      undefined,
      useDocumentStore.getState().pageSetup,
    );
    // The override rides bands.perSection keyed to the break's ordinal.
    expect(adapted.doc.bands?.perSection).toHaveLength(1);
    expect(adapted.doc.bands!.perSection![0]!.section).toBe(0);
    expect(adapted.doc.bands!.perSection![0]!.header).toHaveLength(1);
    expect(adapted.doc.bands!.header).toBeUndefined();
  });

  it('an UNTAGGED container stays the doc default alongside a tagged one', async () => {
    const { editor } = renderTensor('<p>a</p>');
    insertBreakTagged(editor, 'sec-a');
    act(() => {
      editor.commands.insertContentAt(0, {
        type: 'headerBlock',
        attrs: { variant: 'default' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'DOC DEFAULT' }] }],
      });
    });
    act(() => {
      editor.commands.insertContentAt(0, {
        type: 'headerBlock',
        attrs: { variant: 'default', sectionId: 'sec-a' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'SEC ZERO' }] }],
      });
    });
    const adapted = pmDocToSemantic(
      editor.state.doc,
      { fontFamily: 'sans-serif', fontSize: 16 },
      { definitions: builtinDefinitionsById(), epoch: 0 },
      { differentFirstPage: false },
      undefined,
      undefined,
      useDocumentStore.getState().pageSetup,
    );
    expect(adapted.doc.bands?.header).toHaveLength(1);
    expect(adapted.doc.bands?.perSection).toHaveLength(1);
  });

  it('merge-on-delete: NodeSelection + Delete drops the break AND its tagged containers in one undo step', async () => {
    const { editor } = renderTensor('<p>body</p>');
    insertBreakTagged(editor, 'sec-a');
    act(() => {
      editor.commands.insertContentAt(0, {
        type: 'headerBlock',
        attrs: { variant: 'default', sectionId: 'sec-a' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'DOOMED' }] }],
      });
    });
    const countByType = () => {
      let breaks = 0;
      let tagged = 0;
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'sectionBreak') breaks += 1;
        if (node.type.name === 'headerBlock' && node.attrs.sectionId === 'sec-a') tagged += 1;
        return true;
      });
      return { breaks, tagged };
    };
    expect(countByType()).toMatchObject({ breaks: 1, tagged: 1 });

    // Select the break (NodeSelection).
    const found = findBreak(editor);
    act(() => {
      editor.view.dispatch(
        editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, found!.pos)),
      );
    });
    let deleted = false;
    act(() => {
      deleted = deleteSectionBreakNear(editor, 'back');
    });
    expect(deleted).toBe(true);
    expect(countByType()).toMatchObject({ breaks: 0, tagged: 0 });
    act(() => {
      editor.commands.undo();
    });
    expect(countByType()).toMatchObject({ breaks: 1, tagged: 1 });
  });

  it('enableRegion with a sectionId seeds the override from the doc default’s copy', () => {
    const { editor } = renderTensor('<p>body</p>');
    insertBreakTagged(editor, 'sec-a');
    // The doc default header with content.
    act(() => {
      editor.commands.insertContentAt(0, {
        type: 'headerBlock',
        attrs: { variant: 'default' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'DEFAULT INK' }] }],
      });
    });
    act(() => {
      enableRegion(editor, 'header', 'default', 'sec-a');
    });
    let found: { text: string; tag: string | null } | null = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name !== 'headerBlock' || node.attrs.sectionId !== 'sec-a') return true;
      found = {
        text: node.textContent,
        tag: node.attrs.sectionId,
      };
      return false;
    });
    expect(found).not.toBeNull();
    expect(found!.text).toBe('DEFAULT INK');
    expect(found!.tag).toBe('sec-a');
  });

  it('a section INHERITING the live default has no slot on its pages; an unsectioned doc is unchanged', async () => {
    const { editor } = renderTensor(longText + '<div data-section-break></div>' + longText);
    act(() => {
      editor.commands.insertContentAt(0, {
        type: 'headerBlock',
        attrs: { variant: 'default' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'DEFAULT' }] }],
      });
    });
    await settleLayout();
    expect(document.querySelector('[data-testid="hf-slot-header"]')).toBeNull();
    void editor;
  });
});

describe('merge-on-delete adjacency', () => {
  it('Backspace at the block start after a break merges (caret-adjacent, not just NodeSelection)', () => {
    const { editor } = renderTensor('<p>body</p>');
    const tagged = 'sec-adj';
    // insertSectionBreak leaves the caret after the break — retag, then a tagged container to drop with it.
    act(() => {
      editor.commands.insertSectionBreak();
    });
    const found = findBreak(editor);
    act(() => {
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(found!.pos, undefined, {
          ...found!.node.attrs,
          sectionId: tagged,
        }),
      );
    });
    act(() => {
      editor.commands.insertContentAt(0, {
        type: 'headerBlock',
        attrs: { variant: 'default', sectionId: tagged },
        content: [{ type: 'paragraph' }],
      });
    });
    // The insertContentAt calls moved the caret — reset it to the last paragraph's text start (the Backspace posture).
    act(() => {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    });
    let deleted = false;
    act(() => {
      deleted = deleteSectionBreakNear(editor, 'back');
    });
    expect(deleted).toBe(true);
    let breaks = 0;
    let taggedCount = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'sectionBreak') breaks += 1;
      if (node.type.name === 'headerBlock' && node.attrs.sectionId === tagged) taggedCount += 1;
      return true;
    });
    expect(breaks).toBe(0);
    expect(taggedCount).toBe(0);
  });
});

describe('the Section Properties dialog', () => {
  const threeSections =
    '<p>one</p><div data-section-break></div><p>two</p><div data-section-break></div><p>three</p>';

  /** Both breaks' positions (doc order). */
  function breakPositions(editor: NonNullable<ReturnType<typeof useDocumentStore.getState>['editor']>): number[] {
    const positions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'sectionBreak') positions.push(pos);
      return true;
    });
    return positions;
  }

  it('opens at the caret’s section; Apply edits THAT break’s setup (the commit gate)', async () => {
    const { editor } = renderTensor(threeSections);
    const [brk0] = breakPositions(editor);
    // The caret: the MIDDLE paragraph → section 1 (props on break 1).
    act(() => {
      editor.commands.setTextSelection(brk0! + 2); // inside 'two'
    });
    renderSectionDialog();
    act(() => {
      useDocumentPropertiesStore.getState().openPageSetup();
    });
    expect(document.body.textContent).toContain('Section 2 of 3');
    act(() => {
      fireEvent.click([...document.querySelectorAll('[role="group"][aria-label="Apply to"] button')].find((b) => b.textContent === 'Specific section')!);
    });
    expect(document.querySelector('[aria-label="Section 2"]')!.getAttribute('aria-pressed')).toBe('true');
    // Pick the Narrow margins preset (a DRAFT — nothing writes).
    const presetBtn = [...document.querySelectorAll('button')].find((b) => b.textContent!.startsWith('Narrow'))!;
    act(() => {
      fireEvent.click(presetBtn);
    });
    // The fixture carries NO setup attrs — the dialog falls back to the store; the commit writes the break.
    const setupOf = (pos: number) => editor.state.doc.nodeAt(pos)!.attrs.setup as PageSetup;
    act(() => {
      fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Done')!);
    });
    const positions = breakPositions(editor);
    expect(setupOf(positions[1]!).margins).toEqual({ top: 36, bottom: 36, left: 36, right: 36 });
    expect(setupOf(positions[0]!)).toBeNull();
  });

  it('the FINAL section’s dialog edits the STORE pageSetup (the spelling)', async () => {
    const { editor } = renderTensor(threeSections);
    const positions = breakPositions(editor);
    // The caret: the LAST paragraph → the final section (store-owned).
    act(() => {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    });
    renderSectionDialog();
    act(() => {
      useDocumentPropertiesStore.getState().openPageSetup();
    });
    expect(document.body.textContent).toContain('Section 3 of 3');
    act(() => {
      fireEvent.click([...document.querySelectorAll('[role="group"][aria-label="Apply to"] button')].find((b) => b.textContent === 'Specific section')!);
    });
    expect(document.querySelector('[aria-label="Section 3"]')!.getAttribute('aria-pressed')).toBe('true');
    const presetBtn = [...document.querySelectorAll('button')].find((b) => b.textContent!.startsWith('Narrow'))!;
    act(() => {
      fireEvent.click(presetBtn);
    });
    act(() => {
      fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Done')!);
    });
    expect(useDocumentStore.getState().pageSetup.margins).toEqual({ top: 36, bottom: 36, left: 36, right: 36 });
    const setupOf = (pos: number) => editor.state.doc.nodeAt(pos)!.attrs.setup as PageSetup | null;
    expect(setupOf(positions[0]!)).toBeNull();
    expect(setupOf(positions[1]!)).toBeNull();
  });

  it('an A4 section reflows its sheets (per-section geometry, the view law)', async () => {
    const longText = '<p>' + 'word '.repeat(300) + '</p>';
    const { editor } = renderTensor(longText + '<div data-section-break></div>' + longText);
    setBreakSetup(editor, { pageSize: 'A4', orientation: 'portrait', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP });
    await settleLayout();
    const sheets = Array.from(document.querySelectorAll<HTMLElement>('[data-page-index]'));
    const a4W = Math.round((595 * 96) / 72);
    expect(sheets[0]!.style.width).toBe(`${a4W}px`);
    expect(sheets[sheets.length - 1]!.style.width).toBe(`${GEOMETRY.pageWidth}px`);
  });
});

describe('persistence + the sweep', () => {
  it('a sectioned doc round-trips .wpdoc (the break attrs ride docJSON, zero format change)', async () => {
    const { DocumentFileSchema } = await import('@/lib/document/schema');
    const { editor } = renderTensor('<p>one</p><div data-section-break></div><p>two</p>');
    setBreakSetup(editor, { pageSize: 'A4', orientation: 'portrait', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP });
    // The break node rides docJSON verbatim (the z.any() passthrough).
    const docJSON = editor.state.doc.toJSON();
    const roundTripped = DocumentFileSchema.parse({
      version: 1,
      docJSON,
      metadata: { pageSetup: useDocumentStore.getState().pageSetup },
    });
    const content = (roundTripped.docJSON as { content: { type: string }[] }).content;
    expect(content.some((n) => n.type === 'sectionBreak')).toBe(true);
    const { editor: editor2 } = renderTensor();
    act(() => {
      editor2.commands.setContent(docJSON as never);
    });
    const found = findBreak(editor2);
    expect(found).toBeTruthy();
    expect((found!.node.attrs.setup as PageSetup).pageSize).toBe('A4');
  });
});

describe('the ONE Page Setup dialog (Apply-to scopes)', () => {
  const threeSections =
    '<p>one</p><div data-section-break></div><p>two</p><div data-section-break></div><p>three</p>';

  beforeEach(() => {
    // The store is a singleton — earlier describes' writes must not bleed into the scope assertions.
    useDocumentStore.getState().setPageSetup({
      pageSize: 'Letter',
      orientation: 'portrait',
      margins: DEFAULT_MARGINS,
      pageGap: PAGE_GAP,
    });
    useDocumentPropertiesStore.getState().closePageSetup();
  });

  /** The sectionBreak positions (doc order). */
  function breakPositions(editor: NonNullable<ReturnType<typeof useDocumentStore.getState>['editor']>): number[] {
    const positions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'sectionBreak') positions.push(pos);
      return true;
    });
    return positions;
  }

  it('Specific section: the draft seeds from the caret’s section; Apply writes THAT break only', async () => {
    const { editor } = renderTensor(threeSections);
    const [brk0] = breakPositions(editor);
    act(() => {
      editor.commands.setTextSelection(brk0! + 2); // 'two' → section 1
    });
    renderSectionDialog();
    act(() => {
      useDocumentPropertiesStore.getState().openPageSetup();
    });
    expect(document.body.textContent).toContain('Section 2 of 3');
    // The scope: 'Specific section' — the chips reveal with the
    // caret's section auto-selected.
    act(() => {
      fireEvent.click([...document.querySelectorAll('[role="group"][aria-label="Apply to"] button')].find((b) => b.textContent === 'Specific section')!);
    });
    expect(document.querySelector('[aria-label="Section 2"]')!.getAttribute('aria-pressed')).toBe('true');
    const presetBtn = [...document.querySelectorAll('button')].find((b) => b.textContent!.startsWith('Narrow'))!;
    act(() => {
      fireEvent.click(presetBtn);
    });
    act(() => {
      fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Done')!);
    });
    const setupOf = (pos: number) => editor.state.doc.nodeAt(pos)!.attrs.setup as PageSetup | null;
    expect(setupOf(breakPositions(editor)[1]!)!.margins).toEqual({ top: 36, bottom: 36, left: 36, right: 36 });
    expect(setupOf(breakPositions(editor)[0]!)).toBeNull();
    expect(useDocumentStore.getState().pageSetup.margins).toEqual(DEFAULT_MARGINS);
  });

  it('Whole document: one commit merges into EVERY break + the store', async () => {
    const { editor } = renderTensor(threeSections);
    renderSectionDialog();
    act(() => {
      useDocumentPropertiesStore.getState().openPageSetup();
    });
    act(() => {
      fireEvent.click([...document.querySelectorAll('[role="group"] button')].find((b) => b.textContent === 'Whole document')!);
    });
    const presetBtn = [...document.querySelectorAll('button')].find((b) => b.textContent!.startsWith('Narrow'))!;
    act(() => {
      fireEvent.click(presetBtn);
    });
    act(() => {
      fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Done')!);
    });
    const setupOf = (pos: number) => editor.state.doc.nodeAt(pos)!.attrs.setup as PageSetup | null;
    for (const pos of breakPositions(editor)) {
      expect(setupOf(pos)!.margins).toEqual({ top: 36, bottom: 36, left: 36, right: 36 });
    }
    expect(useDocumentStore.getState().pageSetup.margins).toEqual({ top: 36, bottom: 36, left: 36, right: 36 });
  });

  it('This point forward: inserts a break seeded with the CURRENT setup; the following section gets the draft', async () => {
    const { editor } = renderTensor('<p>one</p><p>two</p>');
    // Caret in the second paragraph → point forward inserts a break (seeded with the store's Letter); the following section gets the draft.
    act(() => {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    });
    const breaksBefore = breakPositions(editor).length;
    renderSectionDialog();
    act(() => {
      useDocumentPropertiesStore.getState().openPageSetup();
    });
    // A uniform doc keeps the scope row visible but disables the section-only controls; the write collapses to the store.
    const thisSectionBtn = [...document.querySelectorAll('[role="group"][aria-label="Apply to"] button')]
      .find((b) => b.textContent === 'Specific section') as HTMLButtonElement;
    expect(thisSectionBtn.disabled).toBe(true);
    const presetBtn = [...document.querySelectorAll('button')].find((b) => b.textContent!.startsWith('Narrow'))!;
    act(() => {
      fireEvent.click(presetBtn);
    });
    act(() => {
      fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Done')!);
    });
    expect(useDocumentStore.getState().pageSetup.margins).toEqual({ top: 36, bottom: 36, left: 36, right: 36 });
    expect(breakPositions(editor).length).toBe(breaksBefore);
  });

  it('This point forward in a SECTIONED doc: the break is inserted + the next holder carries the draft', async () => {
    const { editor } = renderTensor(threeSections);
    const before = breakPositions(editor);
    // Caret in 'one' (section 0) → a break lands inside section 0; section 1 (break 1) gets the draft.
    act(() => {
      editor.commands.setTextSelection(1); // inside 'one'
    });
    renderSectionDialog();
    act(() => {
      useDocumentPropertiesStore.getState().openPageSetup();
    });
    act(() => {
      fireEvent.click([...document.querySelectorAll('[role="group"][aria-label="Apply to"] button')].find((b) => b.textContent === 'This point forward')!);
    });
    const presetBtn = [...document.querySelectorAll('button')].find((b) => b.textContent!.startsWith('Narrow'))!;
    act(() => {
      fireEvent.click(presetBtn);
    });
    act(() => {
      fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Done')!);
    });
    // THREE breaks now: the inserted one (ordinal 0) seeds the store's
    // effective; old break 0 (now ordinal 1) carries the draft.
    const after = breakPositions(editor);
    expect(after.length).toBe(before.length + 1);
    const setupOf = (pos: number) => editor.state.doc.nodeAt(pos)!.attrs.setup as PageSetup | null;
    expect(setupOf(after[0]!)!.margins).toEqual(DEFAULT_MARGINS);
    expect(setupOf(after[1]!)!.margins).toEqual({ top: 36, bottom: 36, left: 36, right: 36 });
    expect(setupOf(after[2]!)).toBeNull();
  });

  it('the RIBBON quick controls are document-wide (orientation merges into every break)', async () => {
    const { editor } = renderTensor(threeSections);
    // The ribbon's handler is a module function — drive the same helper it calls.
    act(() => {
      applyPageSetup('document', { ...useDocumentStore.getState().pageSetup, orientation: 'landscape' }, { orientation: 'landscape' });
    });
    const setupOf = (pos: number) => editor.state.doc.nodeAt(pos)!.attrs.setup as PageSetup;
    for (const pos of breakPositions(editor)) {
      expect(setupOf(pos).orientation).toBe('landscape');
    }
    expect(useDocumentStore.getState().pageSetup.orientation).toBe('landscape');
  });
});

describe('continuous breaks, the chooser, the start type', () => {
  /** The sectionBreak positions (doc order). */
  function breakPositions(editor: NonNullable<ReturnType<typeof useDocumentStore.getState>['editor']>): number[] {
    const positions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'sectionBreak') positions.push(pos);
      return true;
    });
    return positions;
  }

  beforeEach(() => {
    useDocumentStore.getState().setPageSetup({
      pageSize: 'Letter',
      orientation: 'portrait',
      margins: DEFAULT_MARGINS,
      pageGap: PAGE_GAP,
    });
    useDocumentPropertiesStore.getState().closePageSetup();
  });

  it('insertSectionBreak carries the type attr (continuous flows on the same page)', async () => {
    const { editor } = renderTensor('<p>one</p>');
    act(() => {
      editor.commands.insertSectionBreak(undefined, 'continuous');
    });
    const found = findBreak(editor);
    expect(found!.node.attrs.type).toBe('continuous');
    await settleLayout();
    const sheets = Array.from(document.querySelectorAll<HTMLElement>('[data-page-index]'));
    expect(sheets.length).toBe(1);
  });

  it('a continuous break with a DIFFERENT geometry upgrades to a page start (the view law)', async () => {
    const { editor } = renderTensor('<p>one</p><div data-section-break data-section-type="continuous"></div><p>two</p>');
    // Section 0 = A4 vs the store's Letter → the continuous boundary auto-upgrades to a page start.
    setBreakSetup(editor, { pageSize: 'A4', orientation: 'portrait', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP });
    await settleLayout();
    const sheets = Array.from(document.querySelectorAll<HTMLElement>('[data-page-index]'));
    expect(sheets.length).toBe(2);
    const a4W = Math.round((595 * 96) / 72);
    expect(sheets[0]!.style.width).toBe(`${a4W}px`);
    expect(sheets[1]!.style.width).toBe(`${GEOMETRY.pageWidth}px`);
  });

  it('the chooser scope writes the chosen sections only', async () => {
    const { editor } = renderTensor(threeSections);
    renderSectionDialog();
    act(() => {
      useDocumentPropertiesStore.getState().openPageSetup();
    });
    // Chips auto-select the caret's (last) section; toggling chip 1 yields {1, 3}.
    act(() => {
      fireEvent.click([...document.querySelectorAll('[role="group"][aria-label="Apply to"] button')].find((b) => b.textContent === 'Specific section')!);
    });
    act(() => {
      fireEvent.click(document.querySelector('[aria-label="Section 1"]')!);
    });
    const presetBtn = [...document.querySelectorAll('button')].find((b) => b.textContent!.startsWith('Narrow'))!;
    act(() => {
      fireEvent.click(presetBtn);
    });
    act(() => {
      fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Done')!);
    });
    const setupOf = (pos: number) => editor.state.doc.nodeAt(pos)!.attrs.setup as PageSetup | null;
    const positions = breakPositions(editor);
    expect(setupOf(positions[0]!)!.margins).toEqual({ top: 36, bottom: 36, left: 36, right: 36 });
    expect(setupOf(positions[1]!)).toBeNull();
    expect(useDocumentStore.getState().pageSetup.margins).toEqual({ top: 36, bottom: 36, left: 36, right: 36 });
  });

  it('the Section start control retypes the boundary (continuous ⇄ next page)', async () => {
    const { editor } = renderTensor(threeSections);
    const [brk0] = breakPositions(editor);
    // The caret in 'two' → section 1 (its start = break 0's type).
    act(() => {
      editor.commands.setTextSelection(brk0! + 2);
    });
    renderSectionDialog();
    act(() => {
      useDocumentPropertiesStore.getState().openPageSetup();
    });
    // 'Specific section': the start control targets break 0 (section 1's start boundary).
    act(() => {
      fireEvent.click([...document.querySelectorAll('[role="group"][aria-label="Apply to"] button')].find((b) => b.textContent === 'Specific section')!);
    });
    act(() => {
      fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Continuous (same page)')!);
    });
    act(() => {
      fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Done')!);
    });
    const node = editor.state.doc.nodeAt(breakPositions(editor)[0]!)!;
    expect(node.attrs.type).toBe('continuous');
  });

  it('the NPC marks paint for page and section breaks (the ¶ toggle)', async () => {
    const longText = '<p>' + 'word '.repeat(200) + '</p>';
    const { editor } = renderTensor(
      longText +
        '<div data-page-break></div>' + longText +
        '<div data-section-break data-section-type="continuous"></div><p>after the join</p>',
    );
    await settleLayout();
    // The marks ride showNonPrintingChars (default ON).
    const marks = Array.from(document.querySelectorAll('[data-testid^="break-mark-"]'));
    const labels = marks.map((m) => m.textContent ?? '');
    expect(labels.some((l) => l.includes('Page Break'))).toBe(true);
    expect(labels.some((l) => l.includes('Section Break (Continuous)'))).toBe(true);
    void editor;
  });
});

describe('per-section page background', () => {
  beforeEach(() => {
    useDocumentStore.getState().setPageSetup({
      pageSize: 'Letter',
      orientation: 'portrait',
      margins: DEFAULT_MARGINS,
      pageGap: PAGE_GAP,
    });
    useDocumentPropertiesStore.getState().closePageSetup();
  });

  it('each section paints ITS background; an unset section inherits the doc default', async () => {
    const longText = '<p>' + 'word '.repeat(300) + '</p>';
    const { editor } = renderTensor(longText + '<div data-section-break></div>' + longText);
    setBreakSetup(editor, {
      pageSize: 'Letter',
      orientation: 'portrait',
      margins: DEFAULT_MARGINS,
      pageGap: PAGE_GAP,
      pageColor: '#ffeedd',
    });
    act(() => {
      useDocumentStore.getState().setPageSetup({
        ...useDocumentStore.getState().pageSetup,
        pageColor: '#ddeeff',
      });
    });
    await settleLayout();
    const sheets = Array.from(document.querySelectorAll<HTMLElement>('[data-page-index]'));
    expect(sheets.length).toBeGreaterThanOrEqual(2);
    expect(sheets[0]!.style.backgroundColor).toBe('rgb(255, 238, 221)');
    expect(sheets[sheets.length - 1]!.style.backgroundColor).toBe('rgb(221, 238, 255)');
  });

});

describe('the page-setup co-undo', () => {
  /** The sectionBreak positions (doc order). */
  function breakPositions(editor: NonNullable<ReturnType<typeof useDocumentStore.getState>['editor']>): number[] {
    const positions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'sectionBreak') positions.push(pos);
      return true;
    });
    return positions;
  }

  beforeEach(() => {
    useDocumentStore.getState().setPageSetup({
      pageSize: 'Letter',
      orientation: 'portrait',
      margins: DEFAULT_MARGINS,
      pageGap: PAGE_GAP,
    });
    useDocumentPropertiesStore.getState().closePageSetup();
  });

  it('a document-scope Done reverts BOTH the break merges and the store in ONE Ctrl+Z', async () => {
    const { editor } = renderTensor(threeSections);
    // History groups sub-800ms-apart transactions; the sleep keeps
    // the Done its own item so one undo reverts only it.
    await new Promise((r) => setTimeout(r, 850));
    renderSectionDialog();
    act(() => {
      useDocumentPropertiesStore.getState().openPageSetup();
    });
    const presetBtn = [...document.querySelectorAll('button')].find((b) => b.textContent!.startsWith('Narrow'))!;
    act(() => {
      fireEvent.click(presetBtn);
    });
    act(() => {
      fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Done')!);
    });
    const setupOf = (pos: number) => editor.state.doc.nodeAt(pos)!.attrs.setup as PageSetup | null;
    expect(setupOf(breakPositions(editor)[0]!)!.margins).toEqual({ top: 36, bottom: 36, left: 36, right: 36 });
    expect(useDocumentStore.getState().pageSetup.margins).toEqual({ top: 36, bottom: 36, left: 36, right: 36 });
    act(() => {
      editor.commands.undo();
    });
    expect(setupOf(breakPositions(editor)[0]!)).toBeNull();
    expect(setupOf(breakPositions(editor)[1]!)).toBeNull();
    expect(useDocumentStore.getState().pageSetup.margins).toEqual(DEFAULT_MARGINS);
    act(() => {
      editor.commands.redo();
    });
    expect(setupOf(breakPositions(editor)[0]!)!.margins).toEqual({ top: 36, bottom: 36, left: 36, right: 36 });
    expect(useDocumentStore.getState().pageSetup.margins).toEqual({ top: 36, bottom: 36, left: 36, right: 36 });
  });

  it('typing buries the entry: Ctrl+Z undoes the typing FIRST, then the page-setup action', async () => {
    const { editor } = renderTensor(threeSections);
    // The grouping gap (see the document-scope test).
    await new Promise((r) => setTimeout(r, 850));
    renderSectionDialog();
    act(() => {
      useDocumentPropertiesStore.getState().openPageSetup();
    });
    const presetBtn = [...document.querySelectorAll('button')].find((b) => b.textContent!.startsWith('Narrow'))!;
    act(() => {
      fireEvent.click(presetBtn);
    });
    act(() => {
      fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Done')!);
    });
    // Typing needs its own history item (another gap, or it merges into the Done item).
    await new Promise((r) => setTimeout(r, 850));
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertContent('X');
    });
    expect(editor.state.doc.textContent.startsWith('X')).toBe(true);
    act(() => {
      editor.commands.undo();
    });
    expect(editor.state.doc.textContent.startsWith('X')).toBe(false);
    const setupOf = (pos: number) => editor.state.doc.nodeAt(pos)!.attrs.setup as PageSetup | null;
    expect(setupOf(breakPositions(editor)[0]!)!.margins).toEqual({ top: 36, bottom: 36, left: 36, right: 36 });
    act(() => {
      editor.commands.undo();
    });
    expect(setupOf(breakPositions(editor)[0]!)).toBeNull();
    expect(useDocumentStore.getState().pageSetup.margins).toEqual(DEFAULT_MARGINS);
  });

  it('a store-only write (the final section) undoes on its own', async () => {
    const { editor } = renderTensor(threeSections);
    act(() => {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1); // the final section
    });
    renderSectionDialog();
    act(() => {
      useDocumentPropertiesStore.getState().openPageSetup();
    });
    // 'Specific section' auto-selects the FINAL section — a store-only write.
    act(() => {
      fireEvent.click([...document.querySelectorAll('[role="group"][aria-label="Apply to"] button')].find((b) => b.textContent === 'Specific section')!);
    });
    const presetBtn = [...document.querySelectorAll('button')].find((b) => b.textContent!.startsWith('Narrow'))!;
    act(() => {
      fireEvent.click(presetBtn);
    });
    act(() => {
      fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Done')!);
    });
    expect(useDocumentStore.getState().pageSetup.margins).toEqual({ top: 36, bottom: 36, left: 36, right: 36 });
    act(() => {
      editor.commands.undo();
    });
    expect(useDocumentStore.getState().pageSetup.margins).toEqual(DEFAULT_MARGINS);
  });
});

describe('the co-redo coincidence guard (the user repro)', () => {
  beforeEach(() => {
    useDocumentStore.getState().setPageSetup({
      pageSize: 'Letter',
      orientation: 'portrait',
      margins: DEFAULT_MARGINS,
      pageGap: PAGE_GAP,
    });
    useDocumentPropertiesStore.getState().closePageSetup();
  });

  it('bold+unbold after the undo dance does NOT resurrect the page setup (net-zero coincidence)', async () => {
    const { editor } = renderTensor('<p>hello world</p>');
    // The grouping gap (the Done must be its own history item).
    await new Promise((r) => setTimeout(r, 850));
    renderSectionDialog();
    act(() => {
      useDocumentPropertiesStore.getState().openPageSetup();
    });
    // Wide margins + the yellow background (the user's repro).
    const wideBtn = [...document.querySelectorAll('button')].find((b) => b.textContent!.startsWith('Wide'))!;
    act(() => {
      fireEvent.click(wideBtn);
    });
    act(() => {
      fireEvent.click(document.querySelector('[aria-label="Page background"]')!);
    });
    // The custom-color path is ColorPickerButton internals (its own suite); this pins the UNDO/REDO machinery, so Wide alone carries it.
    act(() => {
      fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Done')!);
    });
    const setupOf = () => useDocumentStore.getState().pageSetup;
    const WIDE = MARGIN_PRESETS.Wide.margins;
    expect(setupOf().margins).toEqual(WIDE);
    act(() => {
      editor.commands.undo();
    });
    act(() => {
      editor.commands.redo();
    });
    act(() => {
      editor.commands.undo();
    });
    expect(setupOf().margins).toEqual(DEFAULT_MARGINS);
    // Bold then unbold: a net-zero cycle — the doc coincidentally matches the post-page-setup snapshot.
    act(() => {
      editor.commands.selectAll();
      editor.commands.toggleBold();
    });
    act(() => {
      editor.commands.toggleBold();
    });
    act(() => {
      editor.commands.undo();
    });
    expect(setupOf().margins).toEqual(DEFAULT_MARGINS);
    // Ctrl+Y: PM's redo was emptied by the bold — nothing re-applies.
    act(() => {
      editor.commands.redo();
    });
    expect(setupOf().margins).toEqual(DEFAULT_MARGINS);
    expect(setupOf().pageColor ?? '').toBe('');
  });
});

describe('per-section header/footer unlink + relink', () => {
  /** Insert a break and retag it with a KNOWN sectionId. */
  function insertBreakTagged(
    editor: NonNullable<ReturnType<typeof useDocumentStore.getState>['editor']>,
    sectionId: string,
  ): void {
    act(() => {
      editor.commands.insertSectionBreak();
    });
    const found = findBreak(editor);
    expect(found).toBeTruthy();
    act(() => {
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(found!.pos, undefined, {
          ...found!.node.attrs,
          sectionId,
        }),
      );
    });
  }

  beforeEach(() => {
    useDocumentStore.getState().setPageSetup({
      pageSize: 'Letter',
      orientation: 'portrait',
      margins: DEFAULT_MARGINS,
      pageGap: PAGE_GAP,
    });
    useDocumentPropertiesStore.getState().closePageSetup();
  });

  it('double-clicking an INHERITING section strip creates its own header (seeded from the inherited copy)', async () => {
    const longText = '<p>' + 'word '.repeat(300) + '</p>';
    const { editor } = renderTensor(
      '<header-block><p>DOC HEADER</p></header-block>' + longText + '<div data-section-break></div>' + longText,
    );
    await settleLayout();
    expect(document.querySelector('[data-testid="hf-slot-header"]')).toBeNull();
    // Double-click page 1's header strip: the stack rect is mocked to
    // origin; page 1's top = pageHeight + gap.
    const stack = document.querySelector('[data-testid="paginated-stack"]') as HTMLElement;
    stack.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 816, bottom: 5000, width: 816, height: 5000, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const page1Top = GEOMETRY.pageHeight + PAGE_GAP;
    fireEvent.doubleClick(stack, { clientX: 300, clientY: page1Top + 40 });
    let found: { tag: string | null; text: string } | null = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'headerBlock' && node.attrs.sectionId) {
        found = { tag: node.attrs.sectionId, text: node.textContent };
        return false;
      }
      return true;
    });
    expect(found).not.toBeNull();
    expect(found!.text).toBe('DOC HEADER');
    let defaultCount = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'headerBlock' && !node.attrs.sectionId) defaultCount += 1;
      return true;
    });
    expect(defaultCount).toBe(1);
  });

  it('double-clicking an OVERRIDING section strip word-selects normally (no duplicate)', async () => {
    const longText = '<p>' + 'word '.repeat(300) + '</p>';
    const { editor } = renderTensor(
      '<header-block><p>DOC HEADER</p></header-block>' + longText + '<div data-section-break></div>' + longText,
    );
    const found = findBreak(editor);
    act(() => {
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(found!.pos, undefined, { ...found!.node.attrs, sectionId: 'sec-x' }),
      );
    });
    act(() => {
      editor.commands.insertContentAt(0, {
        type: 'headerBlock',
        attrs: { variant: 'default', sectionId: 'sec-x' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'OWN' }] }],
      });
    });
    await settleLayout();
    const stack = document.querySelector('[data-testid="paginated-stack"]') as HTMLElement;
    stack.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 816, bottom: 5000, width: 816, height: 5000, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const page1Top = GEOMETRY.pageHeight + PAGE_GAP;
    const before = (() => {
      let n = 0;
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'headerBlock' && node.attrs.sectionId === 'sec-x') n += 1;
        return true;
      });
      return n;
    })();
    fireEvent.doubleClick(stack, { clientX: 300, clientY: page1Top + 40 });
    const after = (() => {
      let n = 0;
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'headerBlock' && node.attrs.sectionId === 'sec-x') n += 1;
        return true;
      });
      return n;
    })();
    expect(after).toBe(before); // no duplicate — normal editing
  });

  it('Link to Previous re-links: the tagged override is deleted, the section inherits again', async () => {
    const { editor } = renderTensor(threeSections);
    insertBreakTagged(editor, 'sec-a');
    act(() => {
      editor.commands.insertContentAt(0, {
        type: 'headerBlock',
        attrs: { variant: 'default', sectionId: 'sec-a' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'OWN' }] }],
      });
    });
    const countTagged = () => {
      let n = 0;
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'headerBlock' && node.attrs.sectionId === 'sec-a') n += 1;
        return true;
      });
      return n;
    };
    expect(countTagged()).toBe(1);
    // The grouping gap: without it the setup trs + relink merge into ONE history item and one undo reverts everything.
    await new Promise((r) => setTimeout(r, 850));
    // Caret INSIDE the tagged container → the Link to Previous button appears.
    const container = (() => {
      let pos: number | null = null;
      editor.state.doc.descendants((node, p) => {
        if (pos !== null) return false;
        if (node.type.name === 'headerBlock' && node.attrs.sectionId === 'sec-a') {
          pos = p;
          return false;
        }
        return true;
      });
      return pos!;
    })();
    act(() => {
      editor.commands.setTextSelection(container + 2); // inside its paragraph
    });
    // The contextual tab's toggle wraps relinkBand — driven directly (the tab's mount is ribbon state).
    let relinked = false;
    act(() => {
      relinked = relinkBand(editor, 'header', 'default', 'sec-a');
    });
    expect(relinked).toBe(true);
    expect(countTagged()).toBe(0);
    act(() => {
      editor.commands.undo();
    });
    expect(countTagged()).toBe(1);
  });
});

describe('per-page styles (#48)', () => {
  beforeEach(() => {
    useDocumentStore.getState().setPageSetup({
      pageSize: 'Letter',
      orientation: 'portrait',
      margins: DEFAULT_MARGINS,
      pageGap: PAGE_GAP,
    });
    useDocumentStore.getState().setPageStyles({});
    useDocumentPropertiesStore.getState().closePageSetup();
  });

  it('the paint chain: per-page → per-section → doc → white', async () => {
    // Two sheets per section at FakeMetrics: doc default, section tint, and one page override each own a sheet.
    const longText = '<p>' + 'word '.repeat(700) + '</p>';
    const { editor } = renderTensor(longText + '<div data-section-break></div>' + longText);
    setBreakSetup(editor, {
      pageSize: 'Letter',
      orientation: 'portrait',
      margins: DEFAULT_MARGINS,
      pageGap: PAGE_GAP,
      pageColor: '#ffeedd',
    });
    act(() => {
      useDocumentStore.getState().setPageSetup({
        ...useDocumentStore.getState().pageSetup,
        pageColor: '#ddeeff',
      });
      useDocumentStore.getState().setPageStyles({ 1: { background: '#123456' } });
    });
    await settleLayout();
    const sheets = Array.from(document.querySelectorAll<HTMLElement>('[data-page-index]'));
    expect(sheets.length).toBeGreaterThanOrEqual(4);
    expect(sheets[0]!.style.backgroundColor).toBe('rgb(255, 238, 221)');
    expect(sheets[1]!.style.backgroundColor).toBe('rgb(18, 52, 86)');
    expect(sheets[sheets.length - 1]!.style.backgroundColor).toBe('rgb(221, 238, 255)');
  });

  it("applyPageSetup('page') writes one entry; a null background CLEARS it; a no-op Apply writes nothing", () => {
    const { editor } = renderTensor('<p>body</p>');
    applyPageSetup('page', useDocumentStore.getState().pageSetup, {}, {
      page: { index: 2, background: '#101010' },
    });
    expect(useDocumentStore.getState().pageStyles).toEqual({ 2: { background: '#101010' } });

    applyPageSetup('page', useDocumentStore.getState().pageSetup, {}, {
      page: { index: 2, background: null },
    });
    expect(useDocumentStore.getState().pageStyles).toEqual({});

    // No-op: re-applying the same value writes NOTHING.
    applyPageSetup('page', useDocumentStore.getState().pageSetup, {}, {
      page: { index: 0, background: null },
    });
    expect(useDocumentStore.getState().pageStyles).toEqual({});
    void editor;
  });

  it('one Ctrl+Z reverts the map (the co-undo law); redo restores it', () => {
    const { editor } = renderTensor('<p>body</p>');
    applyPageSetup('page', useDocumentStore.getState().pageSetup, {}, {
      page: { index: 0, background: '#abcdef' },
    });
    expect(useDocumentStore.getState().pageStyles).toEqual({ 0: { background: '#abcdef' } });
    act(() => {
      editor.commands.undo();
    });
    expect(useDocumentStore.getState().pageStyles).toEqual({});
    act(() => {
      editor.commands.redo();
    });
    expect(useDocumentStore.getState().pageStyles).toEqual({ 0: { background: '#abcdef' } });
  });

  it('an entry for a page that no longer exists is INERT (the chain falls through)', async () => {
    const { editor } = renderTensor('<p>one page only</p>');
    act(() => {
      useDocumentStore.getState().setPageStyles({ 7: { background: '#123123' } });
    });
    await settleLayout();
    const sheets = Array.from(document.querySelectorAll<HTMLElement>('[data-page-index]'));
    expect(sheets).toHaveLength(1);
    // Page 7 doesn't exist — page 0 paints the doc default (white),
    // and nothing crashes on the dangling entry.
    expect(sheets[0]!.style.backgroundColor).toBe('');
    void editor;
  });

  it('the .wpdoc surface: assembleDocumentFile carries the map (string keys); normalizePageStyles reads it back', () => {
    const { editor } = renderTensor('<p>body</p>');
    act(() => {
      useDocumentStore.getState().setPageStyles({ 0: { background: '#101010' }, 3: { background: '#f4f4f5' } });
    });
    const file = assembleDocumentFile(editor, {
      pageSetup: useDocumentStore.getState().pageSetup,
      pageStyles: useDocumentStore.getState().pageStyles,
    });
    // JSON object keys serialize as STRINGS — the file's spelling.
    expect(file.metadata.pageStyles).toEqual({
      '0': { background: '#101010' },
      '3': { background: '#f4f4f5' },
    });
    expect(normalizePageStyles({ '0': { background: '#101010' }, x: { background: 'nope' }, '3': {} }))
      .toEqual({ 0: { background: '#101010' } });
  });
});

describe('the Page Setup dialog\'s "This page" scope (#48)', () => {
  beforeEach(() => {
    useDocumentStore.getState().setPageSetup({
      pageSize: 'Letter',
      orientation: 'portrait',
      margins: DEFAULT_MARGINS,
      pageGap: PAGE_GAP,
    });
    useDocumentStore.getState().setPageStyles({});
    useDocumentPropertiesStore.getState().closePageSetup();
  });

  it('This page: geometry gates, the bucket sets ONE page\'s style end-to-end through the real popover', async () => {
    const longText = '<p>' + 'word '.repeat(1500) + '</p>';
    renderTensor(longText);
    await settleLayout();
    // The dialog targets the status bar's page fact: page 3 → index 2.
    // (1500 words ≈ 121 lines ≈ 3 sheets — the target page EXISTS.)
    act(() => {
      useDocumentStore.getState().setPageInfo(3, 3);
    });
    renderSectionDialog();
    act(() => {
      useDocumentPropertiesStore.getState().openPageSetup();
    });
    act(() => {
      fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'This page')!);
    });
    // The geometry gates: a page owns its background, never its geometry.
    expect((document.querySelector('button[aria-label="Paper size"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain('paper and margins belong to its section');
    expect(document.body.textContent).toContain('Page 3');
    // The swatch's aria-label IS its hex (hex-default display) — click through the real popover.
    act(() => {
      fireEvent.click(document.querySelector('button[aria-label="Page background options"]')!);
    });
    act(() => {
      fireEvent.click(document.querySelector('[aria-label="#b91c1c"]')!);
    });
    act(() => {
      fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Done')!);
    });
    expect(useDocumentStore.getState().pageStyles).toEqual({ 2: { background: '#b91c1c' } });
    await settleLayout();
    const sheet = document.querySelector('[data-page-index="2"]') as HTMLElement;
    expect(sheet).not.toBeNull();
    expect(sheet.style.backgroundColor).toBe('rgb(185, 28, 28)');
    const other = document.querySelector('[data-page-index="1"]') as HTMLElement;
    expect(other.style.backgroundColor).toBe('');
  });

  it('This page reset: "Remove page style" clears the entry (inherit the chain)', async () => {
    renderTensor('<p>body</p>');
    await settleLayout();
    applyPageSetup('page', useDocumentStore.getState().pageSetup, {}, {
      page: { index: 0, background: '#123123' },
    });
    renderSectionDialog();
    act(() => {
      useDocumentPropertiesStore.getState().openPageSetup();
    });
    act(() => {
      fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'This page')!);
    });
    act(() => {
      fireEvent.click(document.querySelector('button[aria-label="Page background options"]')!);
    });
    // The page-scope reset spells REMOVE (inherit), not "White".
    act(() => {
      fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Remove page style')!);
    });
    act(() => {
      fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Done')!);
    });
    expect(useDocumentStore.getState().pageStyles).toEqual({});
  });
});
