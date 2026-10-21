import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { tensorExtensions } from '@/lib/editor/tensorExtensions';
import { DEFAULT_CONFIG } from '@/lib/config/schema';
import { useConfigStore } from '@/lib/config/store';
import { useSpellStore } from '@/lib/editor/spell/store';
import { SpellController } from '@/lib/editor/spell/controller';
import { getSpellErrors } from '@/lib/editor/spell/SpellExtension';
import { ensureBlockIds } from '@/lib/editor/BlockIdExtension';
import type { LTMatch } from '@/lib/editor/spell/types';

/**
 * The CHECKING PIPELINE (controller): debounce, block-diffed rechecks
 * (identity cache — the adapter trick), the LT offset → PM position
 * mapping, dictionary/session filtering, and the staleness guards.
 * `invoke` is mocked; no Rust, no LanguageTool.
 */

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
const invokeMock = vi.mocked(invoke);

/** A misspelling match at `offset` in the CHECK TEXT (LT wire shape). */
function matchAt(offset: number, word: string, ...replacements: string[]): LTMatch {
  return {
    message: `Possible spelling mistake found.`,
    offset,
    length: word.length,
    replacements: replacements.map((value) => ({ value })),
    rule: {
      id: 'MISSPELLED_RULE',
      description: 'Possible spelling mistake',
      issueType: 'misspelling',
      category: { id: 'TYPOS', name: 'Possible Typo' },
    },
  };
}

/** The invoke contract returns the bare match array (Rust
 *  Vec<LTMatch>), not LT's response wrapper. */
function ltResponse(...matches: LTMatch[]): LTMatch[] {
  return matches;
}

/** Microtask flush — a resolved mock invoke needs only a few ticks. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function makeEditor(html: string): Editor {
  const editor = new Editor({ extensions: tensorExtensions(), content: html });
  // The app's onCreate runs this (Editor.tsx) — without it the
  // blockId mint pass fires on EVERY edit via appendTransaction and
  // rebuilds every block (breaking the identity cache the controller
  // relies on, exactly like it would in the app if onCreate skipped it).
  ensureBlockIds(editor);
  return editor;
}

/** Enable spell check in the config store (default local provider). */
function enableSpell(): void {
  useConfigStore.setState({
    config: {
      ...DEFAULT_CONFIG,
      spellCheck: { enabled: true, configured: true, provider: 'local', language: 'en-US' },
    },
  });
}

function disableSpell(): void {
  useConfigStore.setState({
    config: {
      ...DEFAULT_CONFIG,
      spellCheck: { enabled: false, configured: true, provider: 'local', language: 'en-US' },
    },
  });
}

let editors: Editor[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockReset().mockResolvedValue(ltResponse());
  disableSpell();
  useSpellStore.setState({
    serverStatus: 'stopped',
    localInstalled: null,
    dictionaryWords: [],
    dictionaryLang: 'en-US',
    sessionIgnored: new Set<string>(),
    lastError: null,
    setupOpen: false,
    dictionaryOpen: false,
  });
});

afterEach(() => {
  for (const e of editors) e.destroy();
  editors = [];
  vi.useRealTimers();
});

describe('SpellController', () => {
  it('maps LT offsets to PM positions and dispatches setSpellErrors', async () => {
    enableSpell();
    const editor = makeEditor('<p>helo</p><p>wrold</p>');
    editors.push(editor);
    invokeMock.mockResolvedValueOnce(ltResponse(matchAt(6, 'wrold', 'world')));
    const controller = new SpellController(editor);
    controller.attach();
    await flush();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('spell_check', {
      text: 'helo\n\nwrold',
      language: 'en-US',
      provider: 'local',
    });
    const errors = getSpellErrors(editor.state);
    expect(errors).toHaveLength(1);
    // 'wrold' is para 2's text [7,12)
    expect(errors[0]).toMatchObject({ from: 7, to: 12, word: 'wrold', suggestions: ['world'] });
  });

  it('debounces: no check until typing goes idle (600ms local)', async () => {
    enableSpell();
    const editor = makeEditor('<p>helo</p>');
    editors.push(editor);
    // Attach with spell disabled, then flip enabled (config listener
    // runs the initial full check immediately).
    disableSpell();
    const controller = new SpellController(editor);
    controller.attach();
    enableSpell();
    await flush();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    // Now type — nothing until idle.
    editor.view.dispatch(editor.state.tr.insertText('x', 5));
    await vi.advanceTimersByTimeAsync(599);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenLastCalledWith(
      'spell_check',
      expect.objectContaining({ text: 'helox' }),
    );
  });

  it('rechecks only EDITED blocks (the identity cache)', async () => {
    enableSpell();
    const editor = makeEditor('<p>helo</p><p>wrold</p>');
    editors.push(editor);
    const controller = new SpellController(editor);
    controller.attach();
    await flush();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenLastCalledWith(
      'spell_check',
      expect.objectContaining({ text: 'helo\n\nwrold' }),
    );
    // Append to block 1 only (block 2 keeps its node identity).
    editor.view.dispatch(editor.state.tr.insertText(' more', 5));
    await vi.advanceTimersByTimeAsync(600);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenLastCalledWith(
      'spell_check',
      expect.objectContaining({ text: 'helo more' }),
    );
  });

  it('recheckAll re-sends every block (enable after disable)', async () => {
    const editor = makeEditor('<p>helo</p><p>wrold</p>');
    editors.push(editor);
    const controller = new SpellController(editor);
    controller.attach();
    await flush();
    expect(invokeMock).not.toHaveBeenCalled();
    enableSpell();
    await flush();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenLastCalledWith(
      'spell_check',
      expect.objectContaining({ text: 'helo\n\nwrold' }),
    );
  });

  it('filters dictionary words and session-ignored words', async () => {
    enableSpell();
    useSpellStore.setState({ dictionaryWords: ['wrold'] });
    const editor = makeEditor('<p>helo wrold</p>');
    editors.push(editor);
    const controller = new SpellController(editor);
    useSpellStore.getState().ignoreSessionWord('helo');
    invokeMock.mockResolvedValueOnce(ltResponse(matchAt(0, 'helo', 'hello'), matchAt(5, 'wrold', 'world')));
    controller.attach();
    await flush();
    expect(getSpellErrors(editor.state)).toHaveLength(0);
  });

  it('drops grammar/style matches (spelling only)', async () => {
    enableSpell();
    const editor = makeEditor('<p>helo</p>');
    editors.push(editor);
    const grammar: LTMatch = {
      message: 'Grammar issue',
      offset: 0,
      length: 4,
      rule: { id: 'SOME_GRAMMAR', description: 'x', issueType: 'grammar', category: { id: 'GRAMMAR', name: 'Grammar' } },
    };
    invokeMock.mockResolvedValueOnce(ltResponse(grammar, matchAt(0, 'helo', 'hello')));
    const controller = new SpellController(editor);
    controller.attach();
    await flush();
    const errors = getSpellErrors(editor.state);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.ruleId).toBe('MISSPELLED_RULE');
  });

  it('a doc edit mid-flight drops the stale batch', async () => {
    enableSpell();
    const editor = makeEditor('<p>helo</p>');
    editors.push(editor);
    let release!: (v: unknown) => void;
    invokeMock.mockReturnValueOnce(new Promise((res) => (release = res)));
    const controller = new SpellController(editor);
    controller.attach();
    await flush();
    // The check is in flight; edit the doc now.
    editor.view.dispatch(editor.state.tr.insertText('x', 5));
    release(ltResponse(matchAt(0, 'helo', 'hello')));
    await flush();
    expect(getSpellErrors(editor.state)).toHaveLength(0);
    // The invalidating edit scheduled a fresh check instead.
    await vi.advanceTimersByTimeAsync(600);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('disabling clears all flags and stops checking', async () => {
    enableSpell();
    const editor = makeEditor('<p>helo</p>');
    editors.push(editor);
    invokeMock.mockResolvedValueOnce(ltResponse(matchAt(0, 'helo', 'hello')));
    const controller = new SpellController(editor);
    controller.attach();
    await flush();
    expect(getSpellErrors(editor.state)).toHaveLength(1);
    disableSpell();
    expect(getSpellErrors(editor.state)).toHaveLength(0);
    editor.view.dispatch(editor.state.tr.insertText('x', 5));
    await vi.advanceTimersByTimeAsync(2000);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('a failed check surfaces lastError and retries once', async () => {
    enableSpell();
    const editor = makeEditor('<p>helo</p>');
    editors.push(editor);
    invokeMock.mockRejectedValueOnce(new Error('server not up'));
    const controller = new SpellController(editor);
    controller.attach();
    await flush();
    expect(useSpellStore.getState().lastError).toBe('server not up');
    // The retry fires after RETRY_MS and recovers.
    invokeMock.mockResolvedValueOnce(ltResponse(matchAt(0, 'helo', 'hello')));
    await vi.advanceTimersByTimeAsync(15_000);
    await flush();
    expect(useSpellStore.getState().lastError).toBeNull();
    expect(getSpellErrors(editor.state)).toHaveLength(1);
  });
});
