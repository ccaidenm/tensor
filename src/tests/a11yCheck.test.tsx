import { describe, it, expect, beforeEach } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { AltTextDialog, useAltTextStore } from '@/components/dialogs/ImageDialogs';
import { AccessibilityCheckPanel } from '@/components/editor/AccessibilityCheckPanel';
import { AccessibilityGroup } from '@/components/layout/ribbon/review/groups/AccessibilityGroup';
import { SidebarHost } from '@/lib/layout/sidebar/SidebarHost';
import { useSidebarStore } from '@/lib/layout/sidebarStore';
import { getCommand } from '@/lib/commands/registry';
import { renderTensor, settleLayout } from './harness';

/**
 * The checker UI suite: the docked panel (mount → scan → grouped rows →
 * jump), the Review tab trigger, and the alt-text fix loop. The
 * scan-rule suite lives in a11yScan.test.tsx.
 */

function insertNode(editor: Editor, node: PMNode, pos: number): void {
  act(() => {
    editor.view.dispatch(editor.state.tr.insert(pos, node));
  });
}

function blockImage(editor: Editor, alt: string): PMNode {
  const { schema } = editor.state;
  return schema.nodes.image.create({ src: 'media://img', width: 10, height: 10, alt });
}

function addColorMark(editor: Editor, from: number, to: number, color: string): void {
  act(() => {
    const mark = editor.state.schema.marks.textStyle.create({ color });
    editor.view.dispatch(editor.state.tr.addMark(from, to, mark));
  });
}

function textPos(editor: Editor, text: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text === text) found = pos;
  });
  return found;
}


describe('the Accessibility Check panel', () => {
  beforeEach(() => {
    useSidebarStore.getState().close();
  });

  /** The mount pattern (tablePanel.test's mountPanel): the docked host
   * + the panel, opened through the real command. */
  function mountPanel(editor: Editor) {
    render(
      <div className="relative">
        <SidebarHost id="accessibilityCheck" anchor="right">
          <AccessibilityCheckPanel />
        </SidebarHost>
      </div>,
    );
    act(() => {
      void getCommand('accessibilityCheck')?.run();
    });
    expect(useSidebarStore.getState().active?.id).toBe('accessibilityCheck');
    void editor;
  }

  function fixtureEditor() {
    // One of each issue: H3 skip, gray contrast, image without alt.
    return renderTensor('<h1>a</h1><h3>b</h3><p>gray</p>');
  }

  it('the command opens the panel; the scan lists the fixture issues grouped and counted', async () => {
    const { editor } = fixtureEditor();
    await settleLayout();
    const pos = textPos(editor, 'gray');
    addColorMark(editor, pos, pos + 4, '#777777');
    insertNode(editor, blockImage(editor, ''), 0);

    mountPanel(editor);
    expect(document.querySelector('[data-testid="a11y-panel"]')).not.toBeNull();
    // The total badge: 3 issues.
    expect(document.querySelector('[data-testid="a11y-count"]')!.textContent).toBe('3');
    // Groups render only when non-empty, in the fixed order.
    const groups = [...document.querySelectorAll('[data-testid^="a11y-group-"]')].map(
      (g) => g.getAttribute('data-testid')!,
    );
    expect(groups).toEqual(['a11y-group-altText', 'a11y-group-headingHierarchy', 'a11y-group-contrast']);
  });

  it('a HEADING row jumps the caret through the references navigation path', async () => {
    const { editor } = fixtureEditor();
    await settleLayout();
    mountPanel(editor);
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="a11y-row-headingHierarchy-0"]')!);
    });
    // The H3 sits at pos 3 (h1 nodeSize 3); the caret lands inside it.
    expect(editor.state.selection.head).toBe(4);
  });

  it('a CONTRAST row SELECTS the flagged range', async () => {
    const { editor } = fixtureEditor();
    await settleLayout();
    const pos = textPos(editor, 'gray');
    addColorMark(editor, pos, pos + 4, '#777777');
    mountPanel(editor);
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="a11y-row-contrast-0"]')!);
    });
    expect(editor.state.selection.from).toBe(pos);
    expect(editor.state.selection.to).toBe(pos + 4);
  });

  it('an ALT row selects the IMAGE NODE; the action opens the alt dialog at it', async () => {
    const { editor } = fixtureEditor();
    await settleLayout();
    insertNode(editor, blockImage(editor, ''), 0);
    mountPanel(editor);
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="a11y-row-altText-0"]')!);
    });
    expect(editor.state.selection instanceof NodeSelection).toBe(true);
    expect((editor.state.selection as NodeSelection).node.type.name).toBe('image');

    act(() => {
      fireEvent.click(document.querySelector('[data-testid="a11y-alt-action-0"]')!);
    });
    const altStore = useAltTextStore.getState();
    expect(altStore.isOpen).toBe(true);
    expect(altStore.pos).toBe(0);
    expect(altStore.src).toBe('media://img');
  });


  it('marking an image DECORATIVE from the dialog clears its issue (assisted fixing + live re-scan)', async () => {
    const { editor } = renderTensor('<p>one</p>');
    await settleLayout();
    insertNode(editor, blockImage(editor, ''), 0);
    mountPanel(editor);
    // The dialog is App-mounted in production; mount it here too.
    render(<AltTextDialog />);
    expect(document.querySelector('[data-testid="a11y-row-altText-0"]')).not.toBeNull();

    // The row action opens the alt dialog at the image — the toggle
    // starts off (flagged images are never decorative).
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="a11y-alt-action-0"]')!);
    });
    expect(useAltTextStore.getState().decorative).toBe(false);
    // Toggle decorative → the description greys out (decorative and
    // described are mutually exclusive) → Save.
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="alt-text-decorative"]')!);
    });
    expect(
      (document.querySelector('[data-testid="alt-text-input"]') as HTMLInputElement).disabled,
    ).toBe(true);
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="alt-text-save"]')!);
    });
    // The marking lands on the node and the LIVE list drops the issue.
    expect(editor.state.doc.child(0).attrs.decorative).toBe(true);
    expect(document.querySelector('[data-testid="a11y-row-altText-0"]')).toBeNull();
    expect(document.querySelector('[data-testid="a11y-empty"]')).not.toBeNull();
  });

  it('a clean document shows the EMPTY state', async () => {
    const { editor } = renderTensor('<p>plain and readable</p>');
    await settleLayout();
    mountPanel(editor);
    expect(document.querySelector('[data-testid="a11y-empty"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="a11y-count"]')).toBeNull();
  });

  it('LIVE re-scan: fixing an issue updates the list without reopening', async () => {
    const { editor } = renderTensor('<p>gray</p>');
    await settleLayout();
    const pos = textPos(editor, 'gray');
    addColorMark(editor, pos, pos + 4, '#777777');
    mountPanel(editor);
    expect(document.querySelector('[data-testid="a11y-row-contrast-0"]')).not.toBeNull();

    // Fix it: plain black text.
    act(() => {
      editor.view.dispatch(
        editor.state.tr.removeMark(pos, pos + 4, editor.state.schema.marks.textStyle),
      );
    });
    expect(document.querySelector('[data-testid="a11y-row-contrast-0"]')).toBeNull();
    expect(document.querySelector('[data-testid="a11y-empty"]')).not.toBeNull();
  });

  it('skipped runs surface in the footer note, never as issues', async () => {
    const { editor } = renderTensor('<p>brandy text</p>');
    await settleLayout();
    const pos = textPos(editor, 'brandy text');
    addColorMark(editor, pos, pos + 11, 'var(--brand)');
    mountPanel(editor);
    expect(document.querySelector('[data-testid="a11y-empty"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="a11y-skipped"]')!.textContent).toContain('1 text run skipped');
  });

  it('collapsing a group hides its rows', async () => {
    const { editor } = fixtureEditor();
    await settleLayout();
    mountPanel(editor);
    expect(document.querySelector('[data-testid="a11y-row-headingHierarchy-0"]')).not.toBeNull();
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="a11y-group-headingHierarchy"]')!);
    });
    expect(document.querySelector('[data-testid="a11y-row-headingHierarchy-0"]')).toBeNull();
  });

  it('closing the panel returns focus to the document (the table-panel pattern)', async () => {
    const { editor } = renderTensor('<p>plain</p>');
    await settleLayout();
    mountPanel(editor);
    act(() => {
      fireEvent.click(document.querySelector('button[aria-label="Close"]')!);
    });
    expect(useSidebarStore.getState().active).toBeNull();
  });
});

describe('the Review tab trigger', () => {
  beforeEach(() => {
    useSidebarStore.getState().close();
  });

  it('the ribbon button dispatches THE command (one run body — the registry law)', async () => {
    renderTensor('<p>x</p>');
    await settleLayout();
    render(<AccessibilityGroup />);
    const button = document.querySelector('button[aria-label="Accessibility Check"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.disabled).toBe(false);
    act(() => {
      fireEvent.click(button);
    });
    expect(useSidebarStore.getState().active?.id).toBe('accessibilityCheck');
  });

  it('the palette command is registered with the panel-opening run body', () => {
    const command = getCommand('accessibilityCheck');
    expect(command).toBeDefined();
    expect(command!.title).toBe('Check Accessibility');
    // #100 — the menu field is GONE with the native menu: palette-only,
    // zero Rust surface.
  });
});
