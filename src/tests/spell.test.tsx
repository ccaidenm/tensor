import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { DEFAULT_CONFIG, ConfigSchema } from '@/lib/config/schema';
import { useConfigStore } from '@/lib/config/store';
import { useDocumentStore } from '@/lib/document/store';
import { useSpellStore } from '@/lib/editor/spell/store';
import { getCommand } from '@/lib/commands/registry';
import { SpellSetupDialog } from '@/components/dialogs/SpellSetupDialog';
import { ProofingPanel } from '@/components/settings/panels/ProofingPanel';
import { AccessibilityPanel } from '@/components/settings/panels/AccessibilityPanel';
import { renderTensor, settleLayout } from './harness';

/** The Proofing panel probes the Rust layer on mount — the honest
 *  answers for "runtime not installed yet". spell_check returns an
 *  empty match set so any controller run stays quiet. */
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string): Promise<unknown> => {
    if (cmd === 'spell_local_installed') return false;
    if (cmd === 'spell_server_status') return { status: 'stopped', port: 0 };
    if (cmd === 'spell_check') return [];
    return undefined;
  }),
}));
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
  from: 1, to: 5, word: 'helo', suggestions: ['hello'], message: 'spelling', ruleId: 'MISSPELLED_RULE', kind: 'spelling', category: 'TYPOS',
};
const WROLD_ERR: SpellError = {
  from: 6, to: 11, word: 'wrold', suggestions: ['world'], message: 'spelling', ruleId: 'MISSPELLED_RULE', kind: 'spelling', category: 'TYPOS',
};
// <p>helo wrold</p> spans [0,12)
const PARA_1: SpellBlockRange = { blockId: 'b1', from: 0, to: 12 };
/** A GRAMMAR flag: subject-verb, LT-shaped ("He dont" in <p>He dont</p>,
 *  text [1,8), block spans [0,9)). */
const GRAMMAR_ERR: SpellError = {
  from: 1, to: 8, word: 'He dont', suggestions: ['He doesn\u2019t', 'He does'], message: 'Use a third-person singular verb form.', ruleId: 'AGREEMENT_SENT_START', kind: 'grammar', category: 'GRAMMAR',
};
const GRAMMAR_PARA: SpellBlockRange = { blockId: 'b1', from: 0, to: 9 };

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
      sessionIgnoredRules: new Set<string>(),
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
      spelling: false,
      grammar: false,
      configured: false,
    });
    // The command the ribbon button, F7, and the palette all dispatch.
    act(() => {
      getCommand('toggleSpellCheck')!.run();
    });
    expect(document.querySelector('[data-testid="spell-setup-dialog"]')).not.toBeNull();
    // Spell stays off until the provider is chosen.
    expect(useConfigStore.getState().config.spellCheck.spelling).toBe(false);
    const online = document.querySelector('[data-testid="spell-setup-online-btn"]') as HTMLElement;
    act(() => {
      fireEvent.click(online);
    });
    expect(useConfigStore.getState().config.spellCheck).toMatchObject({
      spelling: true,
      grammar: true,
      configured: true,
      provider: 'online',
    });
    // The dialog closes on choice; the next toggle is a plain off (the
    // MASTER: both flags together).
    expect(document.querySelector('[data-testid="spell-setup-dialog"]')).toBeNull();
    act(() => {
      getCommand('toggleSpellCheck')!.run();
    });
    expect(useConfigStore.getState().config.spellCheck.spelling).toBe(false);
    expect(useConfigStore.getState().config.spellCheck.grammar).toBe(false);
    expect(document.querySelector('[data-testid="spell-setup-dialog"]')).toBeNull();
  });
});

describe('proofing settings: the local gate', () => {
  beforeEach(() => {
    useConfigStore.setState({ config: { ...DEFAULT_CONFIG } });
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
      sessionIgnoredRules: new Set<string>(),
      lastError: null,
      setupOpen: false,
      dictionaryOpen: false,
    });
  });

  it('Local is disabled until the runtime exists; Download installs inline (no setup dialog) and enables', async () => {
    render(<ProofingPanel />);
    // Let the mount probe resolve (invoke: not installed).
    await act(async () => {
      await Promise.resolve();
    });
    const localBtn = document.querySelector('[data-testid="settings-spell-local"]') as HTMLButtonElement;
    expect(localBtn).not.toBeNull();
    expect(localBtn.disabled).toBe(true);

    // Download starts INLINE — the setup dialog never opens.
    const download = document.querySelector('[data-testid="settings-spell-download"]') as HTMLElement;
    expect(download).not.toBeNull();
    await act(async () => {
      fireEvent.click(download);
      // Flush the (mocked, instantly-resolving) install.
      await act(async () => {});
    });
    expect(document.querySelector('[data-testid="spell-setup-dialog"]')).toBeNull();
    expect(useConfigStore.getState().config.spellCheck).toMatchObject({
      spelling: true,
      grammar: true,
      configured: true,
      provider: 'local',
    });
  });
});

describe('grammar feature (distinct flagging)', () => {
  beforeEach(() => {
    useConfigStore.setState({ config: { ...DEFAULT_CONFIG } });
    useDocumentStore.setState({
      pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP },
      isDirty: false,
      filePath: null,
      lineNumbers: null,
      coreProperties: {},
    });
  });

  it('Pages mode: grammar bars take the grammar color; the double line is opt-in', async () => {
    const { editor } = renderTensor('<p>He dont</p>');
    await settleLayout();
    setErrors(editor, [GRAMMAR_ERR], [GRAMMAR_PARA]);
    const bars = underlines();
    expect(bars).toHaveLength(1);
    expect(bars[0]!.style.backgroundColor).toBe('var(--color-grammar-error)');
    // Color-only by default — no second bar without the a11y opt-in.
    expect(document.querySelectorAll('[data-testid="spell-underline-double"]')).toHaveLength(0);
    // Opt in (Accessibility → Visual Cues): the second bar appears,
    // live, without any re-check.
    act(() => {
      useConfigStore.setState({
        config: {
          ...useConfigStore.getState().config,
          accessibility: { reduceMotion: 'system', grammarDoubleLine: true },
        },
      });
    });
    const doubles = document.querySelectorAll<HTMLElement>('[data-testid="spell-underline-double"]');
    expect(doubles).toHaveLength(1);
    expect(doubles[0]!.style.backgroundColor).toBe('var(--color-grammar-error)');
  });

  it('pageless: grammar decorations carry the grammar class + the double-line container class', async () => {
    useConfigStore.setState({
      config: {
        ...DEFAULT_CONFIG,
        editor: { ...DEFAULT_CONFIG.editor, defaultPageLayout: 'Pageless' },
        accessibility: { reduceMotion: 'system', grammarDoubleLine: true },
      },
    });
    const { editor } = renderTensor('<p>He dont</p>');
    setErrors(editor, [GRAMMAR_ERR], [GRAMMAR_PARA]);
    const span = document.querySelector<HTMLElement>('.tensor-grammar-error');
    expect(span).not.toBeNull();
    expect(span!.className).not.toContain('tensor-spell-error');
    // The a11y container class rides the surface — CSS does the rest.
    expect(document.querySelector('[data-testid="pageless-surface"]')!.className).toContain('grammar-double-line');
  });

  it('the grammar bubble: explanation + suggestion (undoable) + rule-scoped ignore', async () => {
    useConfigStore.setState({ config: { ...DEFAULT_CONFIG } });
    // Build the document OUTSIDE history (tr meta) so the suggestion
    // insert is the single undoable step — the harness's setContent
    // would coalesce with it inside PM's newGroupDelay.
    const { editor } = renderTensor();
    await settleLayout();
    act(() => {
      const tr = editor.state.tr;
      tr.setMeta('addToHistory', false);
      tr.replaceWith(
        0,
        tr.doc.content.size,
        editor.state.schema.node('paragraph', {}, editor.state.schema.text('He dont run. She dont'))
      );
      editor.view.dispatch(tr);
    });
    await settleLayout();
    setErrors(editor, [GRAMMAR_ERR, { ...GRAMMAR_ERR, from: 14, to: 22, word: 'She dont' }], [
      { blockId: 'b1', from: 0, to: 23 },
    ]);
    // Left-click the first flag ('He dont' paints at x 96..166 on line 0).
    const surface = document.querySelector('[data-testid="paginated-zoom-wrapper"]') as HTMLElement;
    act(() => {
      fireEvent.mouseDown(surface, { button: 0, clientX: 110, clientY: 100 });
      fireEvent.mouseUp(surface, { button: 0 });
    });
    const bubble = document.querySelector<HTMLElement>('[data-spell-bubble]');
    expect(bubble).not.toBeNull();
    expect(bubble!.dataset.kind).toBe('grammar');
    // THE EXPLANATION — the issue's explicit ask.
    expect(
      document.querySelector('[data-testid="spell-grammar-explanation"]')?.textContent
    ).toContain('third-person singular');
    // Dictionary actions hide for grammar; the rule ignore shows.
    expect(document.querySelector('[data-testid="spell-add-dict"]')).toBeNull();
    expect(document.querySelector('[data-testid="spell-ignore-rule"]')).not.toBeNull();
    // Suggestion applies…
    const sug = document.querySelector('[data-testid="spell-sug-0"]') as HTMLElement;
    act(() => {
      fireEvent.click(sug);
    });
    expect(editor.state.doc.textContent).toBe('He doesn’t run. She dont');
    // …and is one undo step.
    act(() => {
      editor.commands.undo();
    });
    expect(editor.state.doc.textContent).toBe('He dont run. She dont');
    // Re-open — on the SURVIVING flag (the first was dropped when its
    // text changed; 'She dont' paints at x 226..306) — and ignore the
    // RULE: every instance of it vanishes.
    act(() => {
      fireEvent.mouseDown(surface, { button: 0, clientX: 240, clientY: 100 });
      fireEvent.mouseUp(surface, { button: 0 });
    });
    const ignore = document.querySelector('[data-testid="spell-ignore-rule"]') as HTMLElement;
    act(() => {
      fireEvent.click(ignore);
    });
    expect(getSpellErrors(editor.state)).toHaveLength(0);
    expect(document.querySelectorAll('[data-testid="spell-underline"]')).toHaveLength(0);
  });
});

describe('spell config migration + independence', () => {
  it('a pre-grammar config (enabled) migrates to both flags on', () => {
    const parsed = ConfigSchema.parse({
      spellCheck: { enabled: true, configured: true, provider: 'online', language: 'en-US' },
    });
    expect(parsed.spellCheck).toMatchObject({
      spelling: true,
      grammar: true,
      configured: true,
      provider: 'online',
    });
    const off = ConfigSchema.parse({ spellCheck: { enabled: false } });
    expect(off.spellCheck).toMatchObject({ spelling: false, grammar: false });
  });

  it('Proofing: the two switches flip independently', async () => {
    useConfigStore.setState({
      config: {
        ...DEFAULT_CONFIG,
        spellCheck: { configured: true, provider: 'online', language: 'en-US', spelling: true, grammar: false },
      },
    });
    render(<ProofingPanel />);
    await act(async () => {});
    const spellToggle = document.querySelector('[data-testid="settings-spell-toggle"]') as HTMLElement;
    const grammarToggle = document.querySelector('[data-testid="settings-grammar-toggle"]') as HTMLElement;
    expect(spellToggle.getAttribute('aria-checked')).toBe('true');
    expect(grammarToggle.getAttribute('aria-checked')).toBe('false');
    // Grammar on: spelling untouched.
    act(() => {
      fireEvent.click(grammarToggle);
    });
    expect(useConfigStore.getState().config.spellCheck).toMatchObject({ spelling: true, grammar: true });
    // Spelling off: grammar survives (only-grammar is a legal state).
    act(() => {
      fireEvent.click(spellToggle);
    });
    expect(useConfigStore.getState().config.spellCheck).toMatchObject({ spelling: false, grammar: true });
  });

  it('Accessibility: Reduce Motion lives here now; the double-line switch writes config', () => {
    render(<AccessibilityPanel />);
    // The row moved from General — its control is present exactly once.
    expect(document.querySelector('[data-testid="a11y-reduce-motion"]')).not.toBeNull();
    const dbl = document.querySelector('[data-testid="a11y-grammar-double-line"]') as HTMLElement;
    expect(dbl).not.toBeNull();
    expect(dbl.getAttribute('aria-checked')).toBe('false');
    act(() => {
      fireEvent.click(dbl);
    });
    expect(useConfigStore.getState().config.accessibility.grammarDoubleLine).toBe(true);
  });
});
