import { describe, it, expect, beforeEach } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { DEFAULT_CONFIG } from '@/lib/config/schema';
import { useConfigStore } from '@/lib/config/store';
import { useDocumentStore } from '@/lib/document/store';
import { useSpellStore } from '@/lib/editor/spell/store';
import { getCommand } from '@/lib/commands/registry';
import { SpellSetupDialog } from '@/components/dialogs/SpellSetupDialog';
import { renderTensor, settleLayout } from './harness';
import { DEFAULT_MARGINS, PAGE_GAP } from '@/lib/document/pageSetup';
import { getSpellErrors, spellErrorAt } from '@/lib/editor/spell/SpellExtension';
import type { SpellBlockRange } from '@/lib/editor/spell/SpellExtension';
import type { SpellError } from '@/lib/editor/spell/types';
import type { Editor } from '@tiptap/core';

/**
 * SPELL CHECK (model layer): the plugin's state contract — flags
 * survive unrelated edits by MAPPING, die instantly on content edits
 * (the unflag-as-typed law), replace per-block, and ignore/clear. The
 * pageless surface renders the decorations as DOM, which makes this
 * suite the cheap receipt for both view modes (Pages projects the same
 * state through positionMap — covered once the overlay lands).
 */

const HELLO_ERR: SpellError = {
  from: 1, to: 5, word: 'helo', suggestions: ['hello'], message: 'spelling', ruleId: 'MISSPELLED_RULE', kind: 'spelling',
};
const WROLD_ERR: SpellError = {
  from: 6, to: 11, word: 'wrold', suggestions: ['world'], message: 'spelling', ruleId: 'MISSPELLED_RULE', kind: 'spelling',
};
// <p>helo wrold</p> spans [0,12)
const PARA_1: SpellBlockRange = { blockId: 'b1', from: 0, to: 12 };

function setErrors(editor: Editor, errors: SpellError[], blocks: SpellBlockRange[]) {
  act(() => {
    editor.commands.setSpellErrors(errors, blocks);
  });
}

function flagSpans(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.tensor-spell-error')];
}

function underlines(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-testid="spell-underline"]')];
}

beforeEach(() => {
  useConfigStore.setState({
    config: {
      ...DEFAULT_CONFIG,
      editor: { ...DEFAULT_CONFIG.editor, defaultPageLayout: 'Pageless' },
    },
  });
  useDocumentStore.setState({
    pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP },
    isDirty: false,
    filePath: null,
    lineNumbers: null,
    coreProperties: {},
  });
});

describe('spell plugin: state lifecycle', () => {
  it('renders flagged words as decoration spans (pageless)', () => {
    const { editor } = renderTensor('<p>helo wrold</p>');
    setErrors(editor, [HELLO_ERR, WROLD_ERR], [PARA_1]);
    const spans = flagSpans();
    expect(spans.map((s) => s.textContent)).toEqual(['helo', 'wrold']);
  });

  it('an edit INSIDE the word unflags instantly; the other word survives', () => {
    const { editor } = renderTensor('<p>helo wrold</p>');
    setErrors(editor, [HELLO_ERR, WROLD_ERR], [PARA_1]);
    act(() => {
      editor.view.dispatch(editor.state.tr.insertText('x', 3)); // "hexlo"
    });
    expect(flagSpans().map((s) => s.textContent)).toEqual(['wrold']);
  });

  it('an unrelated edit BEFORE the word keeps it flagged (mapped range)', () => {
    const { editor } = renderTensor('<p>helo wrold</p>');
    setErrors(editor, [HELLO_ERR, WROLD_ERR], [PARA_1]);
    act(() => {
      editor.view.dispatch(editor.state.tr.insertText('A', 1)); // "Ahelo wrold"
    });
    const spans = flagSpans();
    expect(spans.map((s) => s.textContent)).toEqual(['helo', 'wrold']);
    // ranges shifted by the sticky mapping
    const errors = getSpellErrors(editor.state);
    expect(errors.find((e) => e.word === 'helo')).toMatchObject({ from: 2, to: 6 });
  });

  it('deleting the word drops its flag', () => {
    const { editor } = renderTensor('<p>helo wrold</p>');
    setErrors(editor, [HELLO_ERR, WROLD_ERR], [PARA_1]);
    act(() => {
      editor.view.dispatch(editor.state.tr.delete(1, 5));
    });
    expect(flagSpans().map((s) => s.textContent)).toEqual(['wrold']);
  });

  it('ignoreSpellWord removes every flag of the word, case-insensitively', () => {
    const { editor } = renderTensor('<p>helo wrold helo</p>');
    // "helo" [1,5) · "wrold" [6,11) · second "helo" [12,16)
    setErrors(editor, [HELLO_ERR, WROLD_ERR, { ...HELLO_ERR, from: 12, to: 16 }], [PARA_1]);
    act(() => {
      editor.commands.ignoreSpellWord('HELO');
    });
    expect(flagSpans().map((s) => s.textContent)).toEqual(['wrold']);
  });

  it('clearSpellErrors empties the state', () => {
    const { editor } = renderTensor('<p>helo wrold</p>');
    setErrors(editor, [HELLO_ERR, WROLD_ERR], [PARA_1]);
    act(() => {
      editor.commands.clearSpellErrors();
    });
    expect(flagSpans()).toHaveLength(0);
    expect(getSpellErrors(editor.state)).toHaveLength(0);
  });

  it('setErrors replaces per-block: unchecked blocks keep their flags', () => {
    const { editor } = renderTensor('<p>helo</p><p>wrold</p>');
    // <p>helo</p> spans [0,6) (text [1,5)); <p>wrold</p> spans [6,12) (text [7,12))
    const b1: SpellBlockRange = { blockId: 'b1', from: 0, to: 6 };
    const b2: SpellBlockRange = { blockId: 'b2', from: 6, to: 12 };
    setErrors(editor, [{ ...HELLO_ERR }, { ...WROLD_ERR, from: 7, to: 12 }], [b1, b2]);
    // recheck of block 2 only, now clean
    setErrors(editor, [], [b2]);
    expect(flagSpans().map((s) => s.textContent)).toEqual(['helo']);
    // recheck of block 1 replaces its error (same word, new suggestions)
    setErrors(editor, [{ ...HELLO_ERR, suggestions: ['jello'] }], [b1]);
    expect(flagSpans().map((s) => s.textContent)).toEqual(['helo']);
    expect(getSpellErrors(editor.state)[0]?.suggestions).toEqual(['jello']);
  });

  it('spellErrorAt finds the error under a click position', () => {
    const { editor } = renderTensor('<p>helo wrold</p>');
    setErrors(editor, [HELLO_ERR, WROLD_ERR], [PARA_1]);
    expect(spellErrorAt(editor.state, 3)?.word).toBe('helo');
    expect(spellErrorAt(editor.state, 8)?.word).toBe('wrold');
    expect(spellErrorAt(editor.state, 5)).toBeUndefined();
  });
});

describe('spell projection (Pages mode)', () => {
  beforeEach(() => {
    useConfigStore.setState({
      config: { ...DEFAULT_CONFIG, editor: { ...DEFAULT_CONFIG.editor, defaultPageLayout: 'Pages' } },
    });
    useDocumentStore.setState({
      pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP },
      isDirty: false,
      filePath: null,
      lineNumbers: null,
      coreProperties: {},
    });
  });

  it('renders flat bars at the tuned signal geometry (FakeMetrics)', async () => {
    const { editor } = renderTensor('<p>helo</p>');
    await settleLayout();
    setErrors(editor, [HELLO_ERR], [PARA_1]);
    const bars = underlines();
    expect(bars).toHaveLength(1);
    const style = bars[0]!.style;
    // contentBox 96, line baseline 12.8, +0.12·fontSize (1.92) — the
    // signal offset; width 4 chars × 10px; 2px thick (the min).
    expect(style.top).toBe('110.72px');
    expect(style.left).toBe('96px');
    expect(style.width).toBe('40px');
    expect(style.height).toBe('2px');
  });

  it('editing inside the word removes its bar immediately', async () => {
    const { editor } = renderTensor('<p>helo</p>');
    await settleLayout();
    setErrors(editor, [HELLO_ERR], [PARA_1]);
    expect(underlines()).toHaveLength(1);
    act(() => {
      editor.view.dispatch(editor.state.tr.insertText('x', 3));
    });
    await settleLayout();
    expect(underlines()).toHaveLength(0);
  });

  it('an edit before the word keeps the bar mapped to the moved glyphs', async () => {
    const { editor } = renderTensor('<p>helo</p>');
    await settleLayout();
    setErrors(editor, [HELLO_ERR], [PARA_1]);
    act(() => {
      editor.view.dispatch(editor.state.tr.insertText('A', 1));
    });
    await settleLayout();
    const bars = underlines();
    expect(bars).toHaveLength(1);
    expect(bars[0]!.style.left).toBe('106px'); // 96 + one 10px char
    expect(bars[0]!.style.width).toBe('40px');
  });
});

describe('spell suggestion bubble (Pages mode)', () => {
  beforeEach(() => {
    useConfigStore.setState({
      config: { ...DEFAULT_CONFIG, editor: { ...DEFAULT_CONFIG.editor, defaultPageLayout: 'Pages' } },
    });
    useDocumentStore.setState({
      pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP },
      isDirty: false,
      filePath: null,
      lineNumbers: null,
      coreProperties: {},
    });
  });

  /** A plain left click on the painted surface. FakeMetrics + default
   *  Letter geometry: content box at (96, 96); 'helo' paints at
   *  x 96..136 on line 0 (y 0..16) — (110, 100) is char 1. */
  function clickWord() {
    const surface = document.querySelector('[data-testid="paginated-zoom-wrapper"]') as HTMLElement;
    expect(surface).not.toBeNull();
    act(() => {
      fireEvent.mouseDown(surface, { button: 0, clientX: 110, clientY: 100 });
      fireEvent.mouseUp(surface, { button: 0 });
    });
  }

  function bubble(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[data-spell-bubble]');
  }

  it('a plain left-click on a flagged word opens the bubble; clicking a suggestion replaces it, undoably', async () => {
    // Build the document OUTSIDE history (tr meta) so the suggestion
    // insert is the single undoable step — the harness's setContent
    // would coalesce with it inside PM's newGroupDelay and make the
    // undo receipt step-count-dependent.
    const { editor } = renderTensor();
    await settleLayout();
    act(() => {
      const tr = editor.state.tr;
      tr.setMeta('addToHistory', false);
      tr.replaceWith(
        0,
        tr.doc.content.size,
        editor.state.schema.node('paragraph', {}, editor.state.schema.text('helo'))
      );
      editor.view.dispatch(tr);
    });
    await settleLayout();
    setErrors(editor, [HELLO_ERR], [PARA_1]);
    expect(underlines().length).toBeGreaterThan(0);
    clickWord();
    const el = bubble();
    expect(el).not.toBeNull();
    expect(el!.dataset.word).toBe('helo');
    // Suggestion click → replacement…
    const sug = document.querySelector('[data-testid="spell-sug-0"]') as HTMLElement;
    expect(sug?.textContent).toBe('hello');
    act(() => {
      fireEvent.click(sug);
    });
    expect(editor.state.doc.textContent).toBe('hello');
    // …the bubble closes and the flag is gone (the word changed).
    expect(bubble()).toBeNull();
    expect(getSpellErrors(editor.state)).toHaveLength(0);
    // THE UNDO RECEIPT: the replacement is a normal history step —
    // one undo restores the misspelling, redo re-applies the fix.
    act(() => {
      editor.commands.undo();
    });
    expect(editor.state.doc.textContent).toBe('helo');
    act(() => {
      editor.commands.redo();
    });
    expect(editor.state.doc.textContent).toBe('hello');
  });

  it('Escape and outside pointerdown dismiss the bubble', async () => {
    const { editor } = renderTensor('<p>helo</p>');
    await settleLayout();
    setErrors(editor, [HELLO_ERR], [PARA_1]);
    clickWord();
    expect(bubble()).not.toBeNull();
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(bubble()).toBeNull();
    // Re-open (offset >10px from the first click so this is a NEW
    // single click, not the double-click word-select), then click
    // outside (any pointerdown not on the bubble).
    const surface = document.querySelector('[data-testid="paginated-zoom-wrapper"]') as HTMLElement;
    act(() => {
      fireEvent.mouseDown(surface, { button: 0, clientX: 121, clientY: 100 });
      fireEvent.mouseUp(surface, { button: 0 });
    });
    expect(bubble()).not.toBeNull();
    act(() => {
      fireEvent.pointerDown(document.body);
    });
    expect(bubble()).toBeNull();
  });

  it('“Add to Dictionary” unflags the word everywhere and records it', async () => {
    const { editor } = renderTensor('<p>helo helo</p>');
    await settleLayout();
    setErrors(editor, [HELLO_ERR, { ...HELLO_ERR, from: 6, to: 10 }], [PARA_1]);
    expect(underlines()).toHaveLength(2);
    clickWord();
    const add = document.querySelector('[data-testid="spell-add-dict"]') as HTMLElement;
    act(() => {
      fireEvent.click(add);
    });
    expect(bubble()).toBeNull();
    expect(underlines()).toHaveLength(0);
    expect(useSpellStore.getState().dictionaryWords).toContain('helo');
  });
});

describe('spell suggestion bubble (pageless surface)', () => {  beforeEach(() => {
    useConfigStore.setState({
      config: { ...DEFAULT_CONFIG, editor: { ...DEFAULT_CONFIG.editor, defaultPageLayout: 'Pageless' } },
    });
    useDocumentStore.setState({
      pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP },
      isDirty: false,
      filePath: null,
      lineNumbers: null,
      coreProperties: {},
    });
  });

  it('a plain click on the decoration span opens the bubble; suggestion applies', () => {
    const { editor } = renderTensor('<p>helo</p>');
    setErrors(editor, [HELLO_ERR], [PARA_1]);
    const span = document.querySelector<HTMLElement>('.tensor-spell-error');
    expect(span).not.toBeNull();
    act(() => {
      fireEvent.click(span!);
    });
    const el = document.querySelector<HTMLElement>('[data-spell-bubble]');
    expect(el).not.toBeNull();
    expect(el!.dataset.word).toBe('helo');
    const sug = document.querySelector('[data-testid="spell-sug-0"]') as HTMLElement;
    act(() => {
      fireEvent.click(sug);
    });
    expect(editor.state.doc.textContent).toBe('hello');
    expect(getSpellErrors(editor.state)).toHaveLength(0);
  });
});

describe('spell setup: the consent gate', () => {
  beforeEach(() => {
    useConfigStore.setState({
      config: { ...DEFAULT_CONFIG, editor: { ...DEFAULT_CONFIG.editor, defaultPageLayout: 'Pageless' } },
    });
    useDocumentStore.setState({
      pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP },
      isDirty: false,
      filePath: null,
      lineNumbers: null,
      coreProperties: {},
    });
    useSpellStore.setState({
      serverStatus: 'stopped',
      localInstalled: null,
      dictionaryWords: [],
      dictionaryLang: null,
      sessionIgnored: new Set<string>(),
      lastError: null,
      setupOpen: false,
      dictionaryOpen: false,
    });
  });

  it('F7/ribbon/palette toggle opens SETUP while unconfigured; choosing online enables spell', () => {
    renderTensor();
    render(<SpellSetupDialog />);
    // Default posture: OFF and UNCONFIGURED — nothing runs, nothing sends.
    expect(useConfigStore.getState().config.spellCheck).toMatchObject({
      enabled: false,
      configured: false,
    });
    // The command the ribbon button, F7, and the palette all dispatch.
    act(() => {
      getCommand('toggleSpellCheck')!.run();
    });
    expect(document.querySelector('[data-testid="spell-setup-dialog"]')).not.toBeNull();
    // Spell stays off until the provider is chosen.
    expect(useConfigStore.getState().config.spellCheck.enabled).toBe(false);
    const online = document.querySelector('[data-testid="spell-setup-online-btn"]') as HTMLElement;
    act(() => {
      fireEvent.click(online);
    });
    expect(useConfigStore.getState().config.spellCheck).toMatchObject({
      enabled: true,
      configured: true,
      provider: 'online',
    });
    // The dialog closes on choice; the next toggle is a plain off.
    expect(document.querySelector('[data-testid="spell-setup-dialog"]')).toBeNull();
    act(() => {
      getCommand('toggleSpellCheck')!.run();
    });
    expect(useConfigStore.getState().config.spellCheck.enabled).toBe(false);
    expect(document.querySelector('[data-testid="spell-setup-dialog"]')).toBeNull();
  });
});
