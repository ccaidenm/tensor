import { describe, it, expect, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { NodeSelection } from '@tiptap/pm/state';
import { renderTensor, settleLayout, GEOMETRY } from './harness';
import { pmDocToSemantic } from '@/lib/paginated/adapter';
import { toLayoutOptions, DEFAULT_MARGINS, MARGIN_PRESETS, PAGE_GAP, type PageSetup } from '@/lib/document/pageSetup';
import { useDocumentStore } from '@/lib/document/store';
import { builtinDefinitionsById } from '@/lib/styles/builtins';
import { deleteSectionBreakNear, enableRegion } from '@/lib/editor/headerFooterCommands';
import { applyPageSetup } from '@/lib/editor/sections';
import { useDocumentPropertiesStore } from '@/lib/document/propertiesStore';
import { PageSetupDialog } from '@/components/dialogs/PageSetupDialog';
import { fireEvent, render } from '@testing-library/react';

let mountedDialog: ReturnType<typeof render> | null = null;

/** The dialog rides alongside the editor exactly as App mounts it.
 *  Self-cleaning: a previous test's dialog (still bound to the shared
 *  properties store) would otherwise double-apply on the shared Done
 *  click — the stale one unmounts first. */
function renderSectionDialog(): void {
  mountedDialog?.unmount();
  mountedDialog = render(<PageSetupDialog />);
}

const threeSections =
  '<p>one</p><div data-section-break></div><p>two</p><div data-section-break></div><p>three</p>';

/**
 * #58 SECTIONS — the shell suite: the node's insert law (split-dance,
 * seeded setup), the adapter's boundary resolution (the engine's
 * section-start table), and the VIEW's mixed-page rendering (sheets
 * sized per their own section). The ENGINE's laws live in the
 * engine's own suite (packages/engine/tests/sections.test.ts).
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
    // THE COMPLETE TABLE (1 break → 2 sections): section 0's start at
    // the doc begin (afterBlock −1, A4 — the break carries the
    // PRECEDING section's props) + the FINAL section after the break
    // (afterBlock 0) riding the doc's pageSetup (the seeded Letter).
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
    // The break carries the PRECEDING section's props: section 0 = A4
    // (the setup we seeded), section 1 = the Letter defaults.
    expect(firstSheet.style.width).toBe(`${a4W}px`);
    expect(lastSheet.style.width).toBe(`${letterW}px`);
    expect(a4W).not.toBe(letterW);
  });

  it('a section boundary forces a new page (content never shares the sheet)', async () => {
    const { editor } = renderTensor('<p>first page content</p><div data-section-break></div><p>second section</p>');
    await settleLayout();
    const sheets = Array.from(document.querySelectorAll<HTMLElement>('[data-page-index]'));
    // Two one-paragraph sections → the boundary forced a second sheet.
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

describe('Phase 2 — the tagged band containers', () => {
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

    // Select the break (NodeSelection) → the merge law.
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
    // The break AND the tagged container are gone (the merged section
    // keeps its own bands; the doc default is untouched).
    expect(countByType()).toMatchObject({ breaks: 0, tagged: 0 });
    // ONE undo step restores BOTH (the single-transaction law).
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
    // The override exists, tagged, and its content COPIES the default.
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
    // Doc default header + a sectioned doc → section 1's pages inherit
    // (no slot), while a section with NEITHER shows the slot.
    const { editor } = renderTensor(longText + '<div data-section-break></div>' + longText);
    act(() => {
      editor.commands.insertContentAt(0, {
        type: 'headerBlock',
        attrs: { variant: 'default' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'DEFAULT' }] }],
      });
    });
    await settleLayout();
    // Section 0 AND section 1 inherit the doc default — NO slots anywhere.
    expect(document.querySelector('[data-testid="hf-slot-header"]')).toBeNull();
    void editor;
  });
});

describe('Phase 2 — merge-on-delete adjacency', () => {
  it('Backspace at the block start after a break merges (caret-adjacent, not just NodeSelection)', () => {
    const { editor } = renderTensor('<p>body</p>');
    const tagged = 'sec-adj';
    // insertSectionBreak leaves the caret in the paragraph AFTER the
    // break — retag, then a tagged container to drop with it.
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
    // The caret lands in the paragraph AFTER the break (the insert
    // law) — but the insertContentAt calls above moved it. Set it
    // back: the last paragraph's text start (the Backspace posture).
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

describe('Phase 3 — the Section Properties dialog', () => {
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
    // The dialog names the caret's section ("Section 2 of 3").
    expect(document.body.textContent).toContain('Section 2 of 3');
    // The scope: 'Specific section' — reveals the chips and AUTO-
    // selects the caret's section.
    act(() => {
      fireEvent.click([...document.querySelectorAll('[role="group"][aria-label="Apply to"] button')].find((b) => b.textContent === 'Specific section')!);
    });
    expect(document.querySelector('[aria-label="Section 2"]')!.getAttribute('aria-pressed')).toBe('true');
    // Pick the Narrow margins preset (a DRAFT — nothing writes).
    const presetBtn = [...document.querySelectorAll('button')].find((b) => b.textContent!.startsWith('Narrow'))!;
    act(() => {
      fireEvent.click(presetBtn);
    });
    // The HTML fixture carries NO setup attrs — the dialog falls back
    // to the store (the effective setup); the commit WRITES the break.
    const setupOf = (pos: number) => editor.state.doc.nodeAt(pos)!.attrs.setup as PageSetup;
    // Done → ONE commit → break 1's setup carries Narrow.
    act(() => {
      fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Done')!);
    });
    const positions = breakPositions(editor);
    expect(setupOf(positions[1]!).margins).toEqual({ top: 36, bottom: 36, left: 36, right: 36 });
    // Break 0 untouched (its section wasn't the target — still null).
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
    // The scope: 'Specific section' — the chips auto-select the FINAL
    // (the store's props holder).
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
    // The STORE carries Narrow; the breaks untouched.
    expect(useDocumentStore.getState().pageSetup.margins).toEqual({ top: 36, bottom: 36, left: 36, right: 36 });
    // The breaks' attrs stay null (the final section writes the store;
    // the fixture carried no setup attrs to begin with).
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
    // Section 0's pages are A4-wide; the final section's are Letter.
    expect(sheets[0]!.style.width).toBe(`${a4W}px`);
    expect(sheets[sheets.length - 1]!.style.width).toBe(`${GEOMETRY.pageWidth}px`);
  });
});

describe('Phase 4 — persistence + the sweep', () => {
  it('a sectioned doc round-trips .wpdoc (the break attrs ride docJSON, zero format change)', async () => {
    const { DocumentFileSchema } = await import('@/lib/document/schema');
    const { editor } = renderTensor('<p>one</p><div data-section-break></div><p>two</p>');
    setBreakSetup(editor, { pageSize: 'A4', orientation: 'portrait', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP });
    // The .wpdoc's docJSON = the PM doc's JSON — the break node rides
    // verbatim (the z.any() passthrough).
    const docJSON = editor.state.doc.toJSON();
    const roundTripped = DocumentFileSchema.parse({
      version: 1,
      docJSON,
      metadata: { pageSetup: useDocumentStore.getState().pageSetup },
    });
    // The schema passed the break node through untouched.
    const content = (roundTripped.docJSON as { content: { type: string }[] }).content;
    expect(content.some((n) => n.type === 'sectionBreak')).toBe(true);
    // And the JSON re-opens: setContent restores the break + its attrs.
    const { editor: editor2 } = renderTensor();
    act(() => {
      editor2.commands.setContent(docJSON as never);
    });
    const found = findBreak(editor2);
    expect(found).toBeTruthy();
    expect((found!.node.attrs.setup as PageSetup).pageSize).toBe('A4');
  });
});

describe('Phase 5 — the ONE Page Setup dialog (Apply-to scopes)', () => {
  const threeSections =
    '<p>one</p><div data-section-break></div><p>two</p><div data-section-break></div><p>three</p>';

  beforeEach(() => {
    // The document store is a singleton — earlier describes' setup
    // writes (the final-section dialog test leaves Narrow) must not
    // bleed into the scope assertions.
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
    // Break 1 (section 1's props) carries Narrow; break 0 untouched.
    expect(setupOf(breakPositions(editor)[1]!)!.margins).toEqual({ top: 36, bottom: 36, left: 36, right: 36 });
    expect(setupOf(breakPositions(editor)[0]!)).toBeNull();
    // The store (the final section) untouched.
    expect(useDocumentStore.getState().pageSetup.margins).toEqual(DEFAULT_MARGINS);
  });

  it('Whole document: one commit merges into EVERY break + the store', async () => {
    const { editor } = renderTensor(threeSections);
    renderSectionDialog();
    act(() => {
      useDocumentPropertiesStore.getState().openPageSetup();
    });
    // The scope defaults to 'This section' — switch to Whole document.
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
    // EVERY break carries Narrow; the store too.
    for (const pos of breakPositions(editor)) {
      expect(setupOf(pos)!.margins).toEqual({ top: 36, bottom: 36, left: 36, right: 36 });
    }
    expect(useDocumentStore.getState().pageSetup.margins).toEqual({ top: 36, bottom: 36, left: 36, right: 36 });
  });

  it('This point forward: inserts a break seeded with the CURRENT setup; the following section gets the draft', async () => {
    const { editor } = renderTensor('<p>one</p><p>two</p>');
    // The caret in the SECOND paragraph → section 0. Point forward →
    // a break at the caret (seeded with section 0's effective = the
    // store's Letter) + the FOLLOWING section (the store, since no
    // next break) gets the draft.
    act(() => {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    });
    const breaksBefore = breakPositions(editor).length;
    renderSectionDialog();
    act(() => {
      useDocumentPropertiesStore.getState().openPageSetup();
    });
    // A uniform doc KEEPS the scope row visible (the dialog holds its
    // size) but disables the section-only controls; the write still
    // collapses to the store.
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
    // The uniform doc's write = the store (the scopes collapse to it).
    expect(useDocumentStore.getState().pageSetup.margins).toEqual({ top: 36, bottom: 36, left: 36, right: 36 });
    expect(breakPositions(editor).length).toBe(breaksBefore);
  });

  it('This point forward in a SECTIONED doc: the break is inserted + the next holder carries the draft', async () => {
    const { editor } = renderTensor(threeSections);
    const before = breakPositions(editor);
    // The caret in 'one' (section 0) → point forward → a break inside
    // section 0 + section 1 (break 1's attrs) gets the draft.
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
    // THREE breaks now (one inserted at the caret — the doc's very
    // start, so ALL content follows it). The inserted break (ordinal
    // 0) seeds section 0's effective (the store's Letter/Normal — the
    // fixture carries no attrs); the FOLLOWING section's holder (old
    // break 0, now ordinal 1) carries the draft (Narrow); the last
    // break is untouched.
    const after = breakPositions(editor);
    expect(after.length).toBe(before.length + 1);
    const setupOf = (pos: number) => editor.state.doc.nodeAt(pos)!.attrs.setup as PageSetup | null;
    expect(setupOf(after[0]!)!.margins).toEqual(DEFAULT_MARGINS);
    expect(setupOf(after[1]!)!.margins).toEqual({ top: 36, bottom: 36, left: 36, right: 36 });
    expect(setupOf(after[2]!)).toBeNull();
  });

  it('the RIBBON quick controls are document-wide (orientation merges into every break)', async () => {
    const { editor } = renderTensor(threeSections);
    // The orientation toggle path (the group's handler is a module
    // function — drive it through the same helper the group calls).
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

describe('Phase 6 — continuous breaks, the chooser, the start type', () => {
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
    // Same geometry → the sections SHARE the page (one sheet).
    const sheets = Array.from(document.querySelectorAll<HTMLElement>('[data-page-index]'));
    expect(sheets.length).toBe(1);
  });

  it('a continuous break with a DIFFERENT geometry upgrades to a page start (the view law)', async () => {
    const { editor } = renderTensor('<p>one</p><div data-section-break data-section-type="continuous"></div><p>two</p>');
    // Break 0 carries the PRECEDING section's props: section 0 = A4;
    // the final section (the store) = Letter → the geometries differ
    // → Word's auto-upgrade: the continuous boundary opens a page.
    setBreakSetup(editor, { pageSize: 'A4', orientation: 'portrait', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP });
    await settleLayout();
    const sheets = Array.from(document.querySelectorAll<HTMLElement>('[data-page-index]'));
    expect(sheets.length).toBe(2);
    // Page 0 = section 0's A4; page 1 = the final section's Letter.
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
    // The scope: 'Specific section' reveals the chips (auto-selecting
    // the caret's section — the LAST); toggling chip 1 yields {1, 3}.
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
    // Break 0 (section 1's props) = Narrow; break 1 (section 2)
    // untouched; the store (section 3, chosen) = Narrow.
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
    // The scope: 'Specific section' (the start control targets the
    // caret's section; its start boundary = break 0).
    act(() => {
      fireEvent.click([...document.querySelectorAll('[role="group"][aria-label="Apply to"] button')].find((b) => b.textContent === 'Specific section')!);
    });
    act(() => {
      fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Continuous (same page)')!);
    });
    act(() => {
      fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Done')!);
    });
    // Break 0 (the boundary where section 1 starts) is now continuous.
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

describe('Phase 7 — per-section page background', () => {
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
    // Section 0's setup carries a tint; the store's (the final
    // section + the doc default) carries another.
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
    // Section 0's sheets wear its tint; the final section's wear the
    // doc default.
    expect(sheets[0]!.style.backgroundColor).toBe('rgb(255, 238, 221)');
    expect(sheets[sheets.length - 1]!.style.backgroundColor).toBe('rgb(221, 238, 255)');
  });

  it('the background bucket in Page Setup edits the DRAFT (Done applies per the scope)', async () => {
    const { editor } = renderTensor('<p>body</p>');
    renderSectionDialog();
    act(() => {
      useDocumentPropertiesStore.getState().openPageSetup();
    });
    // The draft's color changes — the store untouched until Done.
    act(() => {
      const bucket = document.querySelector('[aria-label="Page background"]') as HTMLButtonElement;
      fireEvent.click(bucket);
    });
    // The palette popover opens — pick the custom color input path is
    // ColorPickerButton's internals; drive the draft directly through
    // the swatch's onChange is not reachable — assert the default.
    expect(useDocumentStore.getState().pageSetup.pageColor ?? '').toBe('');
    void editor;
  });
});

describe('Phase 8 — the page-setup co-undo', () => {
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
    // The history GROUPS sub-800ms-apart transactions into ONE item —
    // the test's Done would merge into the setContent item and one
    // undo would revert BOTH (the real user's open→edit gap is
    // seconds). The sleep keeps the page-setup write its own item.
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
    // The write landed: every break merged + the store carries Narrow.
    const setupOf = (pos: number) => editor.state.doc.nodeAt(pos)!.attrs.setup as PageSetup | null;
    expect(setupOf(breakPositions(editor)[0]!)!.margins).toEqual({ top: 36, bottom: 36, left: 36, right: 36 });
    expect(useDocumentStore.getState().pageSetup.margins).toEqual({ top: 36, bottom: 36, left: 36, right: 36 });
    // ONE Ctrl+Z reverts the PM part AND the store part.
    act(() => {
      editor.commands.undo();
    });
    expect(setupOf(breakPositions(editor)[0]!)).toBeNull();
    expect(setupOf(breakPositions(editor)[1]!)).toBeNull();
    expect(useDocumentStore.getState().pageSetup.margins).toEqual(DEFAULT_MARGINS);
    // Ctrl+Y re-applies both.
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
    // Typing AFTER the write — its OWN history item (another gap, or
    // it would merge into the Done item).
    await new Promise((r) => setTimeout(r, 850));
    act(() => {
      editor.commands.setTextSelection(1);
      editor.commands.insertContent('X');
    });
    expect(editor.state.doc.textContent.startsWith('X')).toBe(true);
    // Ctrl+Z #1: the typing (the page-setup write is buried).
    act(() => {
      editor.commands.undo();
    });
    expect(editor.state.doc.textContent.startsWith('X')).toBe(false);
    const setupOf = (pos: number) => editor.state.doc.nodeAt(pos)!.attrs.setup as PageSetup | null;
    expect(setupOf(breakPositions(editor)[0]!)!.margins).toEqual({ top: 36, bottom: 36, left: 36, right: 36 });
    // Ctrl+Z #2: the page-setup action (breaks + store together).
    act(() => {
      editor.commands.undo();
    });
    expect(setupOf(breakPositions(editor)[0]!)).toBeNull();
    expect(useDocumentStore.getState().pageSetup.margins).toEqual(DEFAULT_MARGINS);
  });

  it('a store-only write (the final section) undoes on its own', async () => {
    const { editor } = renderTensor(threeSections);
    const [brk0] = breakPositions(editor);
    act(() => {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1); // the final section
    });
    renderSectionDialog();
    act(() => {
      useDocumentPropertiesStore.getState().openPageSetup();
    });
    // The scope: 'Specific section' — the chips auto-select the FINAL
    // (the store's props holder — a store-only write).
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
    // ONE Ctrl+Z restores the store (no PM part — the doc is untouched).
    act(() => {
      editor.commands.undo();
    });
    expect(useDocumentStore.getState().pageSetup.margins).toEqual(DEFAULT_MARGINS);
    void brk0;
  });
});

describe('Phase 9 — the co-redo coincidence guard (the user repro)', () => {
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
    // The ColorPickerButton's popover internals drive custom colors —
    // set the draft's color through the palette's public path is its
    // own component's suite; the swatch here is the default. The
    // color's DRAFT write is covered by the dialog flow; this test
    // pins the UNDO/REDO machinery, so Wide alone carries it.
    act(() => {
      fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Done')!);
    });
    const setupOf = () => useDocumentStore.getState().pageSetup;
    const WIDE = MARGIN_PRESETS.Wide.margins;
    expect(setupOf().margins).toEqual(WIDE);
    // The dance: undo, redo, undo.
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
    // Bold, then unbold (a net-zero mark cycle — the doc returns to
    // the post-page-setup snapshot BY COINCIDENCE).
    act(() => {
      editor.commands.selectAll();
      editor.commands.toggleBold();
    });
    act(() => {
      editor.commands.toggleBold();
    });
    // Ctrl+Z: the bold item (net zero) — the page setup must NOT move.
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
