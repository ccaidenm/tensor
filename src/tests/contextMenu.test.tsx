import { describe, it, expect, beforeEach } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { useDocumentStore } from '@/lib/document/store';
import { useConfigStore } from '@/lib/config/store';
import { useSidebarStore } from '@/lib/layout/sidebarStore';
import { renderTensor, settleLayout } from './harness';
import { DEFAULT_MARGINS, PAGE_GAP } from '@/lib/document/pageSetup';
import { applyRightClickSelection } from '@/lib/editor/rightClickSelection';

/**
 * The document context menu: the app-wide replacement for the WebView's
 * native right-click menu (App suppresses `contextmenu` globally;
 * DocumentContextMenu wraps both view modes at the Editor routing
 * seam). The variant reads the LIVE selection at open time — these
 * tests pin the variant routing and the actions per variant.
 *
 * Submenu items mount on hover (base-ui's submenu open-on-rest); the
 * helper drives both the pointer and mouse event pairs.
 */

beforeEach(() => {
  useSidebarStore.getState().close();
  const state = useConfigStore.getState();
  useConfigStore.setState({
    config: { ...state.config, editor: { ...state.config.editor, defaultPageLayout: 'Pages' } },
  });
  useDocumentStore.setState({
    pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP },
    isDirty: false,
    filePath: null,
    lineNumbers: null,
    coreProperties: {},
  });
});

/** Right-click the editor surface (any inner element bubbles to the
 *  trigger's display:contents wrapper). */
function rightClick() {
  act(() => {
    fireEvent.contextMenu(document.querySelector('[data-testid="paginated-root"]')!);
  });
}

/** Hover-opens a submenu by its trigger testid. */
async function openSubmenu(triggerTestId: string) {
  const trigger = document.querySelector(`[data-testid="${triggerTestId}"]`) as HTMLElement;
  expect(trigger).not.toBeNull();
  await act(async () => {
    fireEvent.pointerOver(trigger);
    fireEvent.pointerMove(trigger, { clientX: 10, clientY: 10 });
    fireEvent.mouseOver(trigger);
    fireEvent.mouseMove(trigger, { clientX: 10, clientY: 10 });
    await new Promise((r) => setTimeout(r, 350));
  });
}

function clickItem(testId: string) {
  const item = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;
  expect(item).not.toBeNull();
  act(() => {
    fireEvent.click(item);
  });
}

/** Parks the caret in the table's first cell. */
function caretIntoFirstCell(editor: Editor) {
  const positions: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') positions.push(pos);
  });
  act(() => {
    editor.commands.setTextSelection(positions[0]! + 2);
  });
}

/** The General panel's accepted-warning path writes this same action. */
function editor_setDeveloper(value: boolean) {
  act(() => {
    useConfigStore.getState().setDeveloperMode(value);
  });
}

describe('the document context menu', () => {
  it('table variant: a caret in a table opens the structural menu; actions run', async () => {
    const { editor } = renderTensor('<p>lead</p><table><tr><td>a</td></tr></table>');
    await settleLayout();
    caretIntoFirstCell(editor);
    rightClick();
    // The table variant's items (structure + management).
    expect(document.querySelector('[data-testid="ctx-insert-row-below"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="ctx-merge"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="ctx-table-properties"]')).not.toBeNull();
    // The image/text items are absent.
    expect(document.querySelector('[data-testid="ctx-image-caption"]')).toBeNull();
    expect(document.querySelector('[data-testid="ctx-copy"]')).toBeNull();
    clickItem('ctx-insert-row-below');
    await settleLayout();
    // The table grew a row (1 → 2); the lead paragraph is untouched.
    const table = editor.state.doc.content.child(1)!;
    expect(table.childCount).toBe(2);
  });

  it('table variant: Merge⇄Split flips on merged cells; the borders submenu applies a preset', async () => {
    const { editor } = renderTensor('<table><tr><td>a</td><td>b</td></tr></table>');
    await settleLayout();
    // Merge both cells first (via the SAME command the menu runs).
    const positions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tableCell') positions.push(pos);
    });
    act(() => {
      editor.commands.setCellSelection({ anchorCell: positions[0]!, headCell: positions[1]! });
    });
    rightClick();
    expect(document.querySelector('[data-testid="ctx-merge"]')).not.toBeNull();
    clickItem('ctx-merge');
    await settleLayout();
    // Re-right-click on the merged selection: the item flipped to Split.
    rightClick();
    expect(document.querySelector('[data-testid="ctx-split"]')).not.toBeNull();
    clickItem('ctx-split');
    await settleLayout();
    expect(editor.state.doc.content.firstChild!.firstChild!.childCount).toBe(2);
    // Borders submenu: hover-open, apply 'none'.
    caretIntoFirstCell(editor);
    rightClick();
    await openSubmenu('ctx-borders-menu');
    clickItem('ctx-borders-none');
    expect(editor.state.doc.content.firstChild!.attrs.borderStyle).toBe('none');
  });

  it('table variant: Table Properties… opens the side panel; Distribute clears colwidths', async () => {
    const { editor } = renderTensor(
      '<table><tr><td colwidth="200">a</td><td colwidth="100">b</td></tr></table>',
    );
    await settleLayout();
    caretIntoFirstCell(editor);
    rightClick();
    clickItem('ctx-table-properties');
    expect(useSidebarStore.getState().active?.id).toBe('table');
    rightClick();
    clickItem('ctx-distribute');
    let sawColwidth = false;
    editor.state.doc.descendants((node) => {
      if ((node.type.name === 'tableCell' || node.type.name === 'tableHeader') && node.attrs.colwidth != null) {
        sawColwidth = true;
      }
    });
    expect(sawColwidth).toBe(false);
  });

  it('text variant (focused): a text selection opens the CLIPBOARD group only — formatting stays on the toolbar/ribbon', async () => {
    const { editor } = renderTensor('<p>hello world</p>');
    await settleLayout();
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 6 });
    });
    rightClick();
    expect(document.querySelector('[data-testid="ctx-cut"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="ctx-copy"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="ctx-paste"]')).not.toBeNull();
    // Focused menu: no formatting, no other variants' items.
    expect(document.querySelector('[data-testid="ctx-bold"]')).toBeNull();
    expect(document.querySelector('[data-testid="ctx-link"]')).toBeNull();
    expect(document.querySelector('[data-testid="ctx-insert-row-below"]')).toBeNull();
    expect(document.querySelector('[data-testid="ctx-select-all"]')).toBeNull();
    void editor;
  });

  it('right-click inside a text selection KEEPS it; outside, the caret collapses (never word/paragraph expansion)', async () => {
    const { editor } = renderTensor('<p>hello world</p>');
    await settleLayout();
    const stack = document.querySelector('[data-testid="paginated-stack"]') as HTMLElement;
    // 'hello' spans content-x [0, 50) → client [96, 146); the line's
    // band is content-y [0, 17.6) → client-y [96, 114). Click INSIDE.
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 6 });
    });
    act(() => {
      fireEvent.mouseDown(stack, { button: 2, clientX: 120, clientY: 100 });
    });
    // The right-click landed INSIDE [1,6) — kept.
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(6);
    rightClick();
    // The menu reads the KEPT selection: the clipboard variant.
    expect(document.querySelector('[data-testid="ctx-copy"]')).not.toBeNull();
    // OUTSIDE: a right-click past the selection collapses the caret.
    act(() => {
      fireEvent.mouseDown(stack, { button: 2, clientX: 300, clientY: 100 });
    });
    expect(editor.state.selection.empty).toBe(true);
  });

  it('a right-click after recent left clicks never expands to word/paragraph (the count register is left-only)', async () => {
    const { editor } = renderTensor('<p>hello world</p>');
    await settleLayout();
    const stack = document.querySelector('[data-testid="paginated-stack"]') as HTMLElement;
    // Two rapid LEFT clicks = the word 'hello' selected; a third LEFT
    // would grab the paragraph. Interleave a RIGHT click instead — it
    // must inherit NOTHING from the count (the reported "grouped the
    // whole sentence") and keep the word selection as-is.
    act(() => {
      fireEvent.mouseDown(stack, { button: 0, clientX: 120, clientY: 100 });
    });
    act(() => {
      fireEvent.mouseDown(stack, { button: 0, clientX: 120, clientY: 100 });
    });
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(6); // the word
    act(() => {
      fireEvent.mouseDown(stack, { button: 2, clientX: 120, clientY: 100 });
    });
    // NOT the paragraph [1, 12): the word selection stands.
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(6);
  });

  it('the shared right-click selection rule (rightClickSelection.ts): image click selects the image; inside a selection keeps it; outside collapses', async () => {
    // The image rides the SCOPED clipboard marker (ImageNode's
    // parseHTML contract — external <img> never parses in).
    const { editor } = renderTensor(
      '<p>hello world</p>' +
      '<div data-tensor-image="true" data-src="media://x" data-width="100" data-height="50"></div>' +
      '<p>after</p>',
    );
    await settleLayout();
    // (1) Outside a selection: the caret collapses to the click pos.
    act(() => {
      editor.commands.setTextSelection(1);
    });
    act(() => {
      applyRightClickSelection(editor, 7);
    });
    expect(editor.state.selection.from).toBe(7);
    expect(editor.state.selection.empty).toBe(true);
    // (2) Inside a selection [1,6): kept — the menu reads the subject.
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 6 });
    });
    act(() => {
      applyRightClickSelection(editor, 3);
    });
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(6);
    // (3) An image under the click: NodeSelection (either shape). A
    // click on an atom resolves to the NODE position (posAtCoords /
    // the paginated hitTest spell it the same way).
    let imagePos = 0;
    editor.state.doc.descendants((n, p) => {
      if (n.type.name === 'image') { imagePos = p; return false; }
      return true;
    });
    act(() => {
      applyRightClickSelection(editor, imagePos);
    });
    expect(editor.state.selection instanceof NodeSelection).toBe(true);
    expect((editor.state.selection as NodeSelection).node.type.name).toBe('image');
    // (4) null (no position) is a no-op.
    act(() => {
      applyRightClickSelection(editor, null);
    });
    expect(editor.state.selection instanceof NodeSelection).toBe(true);
  });

  it('Developer Mode (default OFF): no reload/inspect; ON (the accepted flag): the items ride every variant', async () => {
    renderTensor('<p>plain</p>');
    await settleLayout();
    act(() => {
      editor_setDeveloper(false);
    });
    rightClick();
    expect(document.querySelector('[data-testid="ctx-reload"]')).toBeNull();
    expect(document.querySelector('[data-testid="ctx-inspect"]')).toBeNull();
    // Escape-close the menu, flip the flag (the General panel's
    // accepted-warning path writes this same store action), re-open.
    act(() => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });
    act(() => {
      editor_setDeveloper(true);
    });
    rightClick();
    expect(document.querySelector('[data-testid="ctx-reload"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="ctx-inspect"]')).not.toBeNull();
  });

  it('none variant: a bare caret outside any object opens Paste + Select All; Select All works', async () => {
    const { editor } = renderTensor('<p>hello</p><p>world</p>');
    await settleLayout();
    act(() => {
      editor.commands.setTextSelection(1);
    });
    rightClick();
    expect(document.querySelector('[data-testid="ctx-select-all"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="ctx-bold"]')).toBeNull();
    clickItem('ctx-select-all');
    expect(editor.state.selection.from).toBe(0);
    expect(editor.state.selection.to).toBe(editor.state.doc.content.size);
  });
});
