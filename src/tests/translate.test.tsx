import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { tensorExtensions } from '@/lib/editor/tensorExtensions';
import { DEFAULT_CONFIG } from '@/lib/config/schema';
import { useConfigStore } from '@/lib/config/store';
import { ensureBlockIds } from '@/lib/editor/BlockIdExtension';
import { getCommand } from '@/lib/commands/registry';
import { useSidebarStore } from '@/lib/layout/sidebarStore';
import {
  TranslationNotEnabledError,
  requireTranslationConfig,
  FALLBACK_LANGUAGES,
} from '@/lib/editor/translate/client';
import { collectBlocks, hasSelection, type TranslateScope } from '@/lib/editor/translate/walk';
import { runTranslation, type CancelToken } from '@/lib/editor/translate/run';
import { applyTranslation, parseBlockHtml } from '@/lib/editor/translate/apply';
import { useTranslateStore } from '@/lib/editor/translate/store';

// The local engine is mocked here: the local ROUTING is under test —
// the engine itself has its own suite (translateLocal) and the WASM a
// real-binary smoke path.
vi.mock('@/lib/editor/translate/local/engine', () => ({
  translateHtmlsLocal: vi.fn(async (_installed: unknown, _from: string, _to: string, htmls: string[]) =>
    htmls.map((h) => h.replace(/Hello/g, 'Hallo')),
  ),
  disposeLocalEngine: vi.fn(),
}));

/** Content-only HTML: the schema's own attrs (blockid, data-style-id,
 *  the style class, link rel) are document plumbing, not content —
 *  stripped so assertions speak content. */
function bare(html: string): string {
  return html.replace(/ (?:blockid|data-style-id|class|rel)="[^"]*"/g, '');
}
function docBare(editor: Editor): string {
  return bare(editor.getHTML());
}

/**
 * THE TRANSLATE PIPELINE: the scope walk (the explicit contract),
 * the consent gate, the batched run, and the four commit paths
 * (replace / interleave / append / staleness refusal). `invoke` is
 * mocked; no Rust, no instance.
 */

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
const invokeMock = vi.mocked(invoke);

function makeEditor(html: string): Editor {
  const editor = new Editor({ extensions: tensorExtensions(), content: html });
  ensureBlockIds(editor);
  return editor;
}

function configureTranslation(endpoint = 'https://lt.example', apiKey = '', provider: 'libretranslate' | 'google' | 'deepl' | 'local' = 'libretranslate'): void {
  useConfigStore.setState({
    config: {
      ...DEFAULT_CONFIG,
      translation: { provider, configured: true, endpoint, apiKey, lastTargetLang: 'en' },
    },
  });
}

function token(): CancelToken {
  return { cancelled: false };
}

/** The instance mock: LibreTranslate's array-in → array-out law,
 *  translating deterministically for assertions. */
function mockInstance(handler?: (html: string, i: number) => string | undefined): void {
  invokeMock.mockImplementation(async (cmd, args) => {
    if (cmd === 'translate') {
      const blocks = (args as { blocks: string[] }).blocks;
      const translatedText = blocks.map((html, i) => {
        const custom = handler?.(html, i);
        return custom ?? html.replace(/Hello/g, 'Bonjour');
      });
      return {
        translatedText,
        detectedLanguage: { language: 'en', confidence: 1 },
      };
    }
    throw new Error('unexpected invoke: ' + cmd);
  });
}

/** Microtask flush (the spell-controller law — a resolved mock
 *  invoke needs only a few ticks). */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

beforeEach(() => {
  invokeMock.mockReset();
  useConfigStore.setState({ config: DEFAULT_CONFIG });
});

// ─── The walk ───────────────────────────────────────────────────────────

describe('the scope walk', () => {
  it('collects every translatable top-level block and skips the contract\'s exclusions', () => {
    const editor = makeEditor(
      '<h1>Hello one</h1>' +
      '<p></p>' + // empty — never rides the wire
      '<pre><code>code is not prose</code></pre>' +
      '<p>Hello two</p>' +
      '<hr><p>Hello three</p>',
    );
    const blocks = collectBlocks(editor, 'document');
    expect(blocks.map((b) => b.nodeType)).toEqual(['heading', 'paragraph', 'paragraph']);
    expect(blocks.every((b) => typeof b.blockId === 'string' && b.blockId)).toBe(true);
  });

  it('serializes blocks as the schema\'s own HTML (marks travel)', () => {
    const editor = makeEditor('<p>Hello <strong>world</strong> and <a href="https://x">a link</a></p>');
    const [block] = collectBlocks(editor, 'document');
    expect(bare(block!.html)).toBe('<p>Hello <strong>world</strong> and <a href="https://x">a link</a></p>');
  });

  it('selection scope covers every translatable block INTERSECTING the selection — partial selects translate whole', () => {
    const editor = makeEditor('<p>one</p><p>two</p><p>three</p>');
    // Doc geometry: blocks are 0-5, 5-10, 10-15 ("two" text at 6-9).
    // A caret inside "two" touches NOTHING.
    editor.commands.setTextSelection(8);
    expect(hasSelection(editor)).toBe(false);
    expect(collectBlocks(editor, 'selection')).toEqual([]);

    editor.commands.setTextSelection({ from: 6, to: 9 }); // "two" fully
    let scope: TranslateScope = 'selection';
    expect(collectBlocks(editor, scope).map((b) => b.text)).toEqual(['two']);

    // A partial selection of the middle paragraph still covers it (and
    // ONLY it — "one" and "three" are outside).
    editor.commands.setTextSelection({ from: 7, to: 9 }); // "wo"
    scope = 'selection';
    expect(collectBlocks(editor, scope).map((b) => b.text)).toEqual(['two']);
  });
});

// ─── The gate ───────────────────────────────────────────────────────────

describe('the consent gate', () => {
  it('no call reaches the network while unconfigured — not even the run entry', async () => {
    const editor = makeEditor('<p>Hello</p>');
    await expect(runTranslation(editor, { scope: 'document', targetLang: 'en' }, token(), () => {})).rejects.toThrow(TranslationNotEnabledError);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(() => requireTranslationConfig()).toThrow(TranslationNotEnabledError);
  });

  it('configured without an endpoint is still unconfigured (a half choice is no choice)', () => {
    useConfigStore.setState({
      config: {
        ...DEFAULT_CONFIG,
        translation: { provider: 'libretranslate', configured: true, endpoint: '', apiKey: '', lastTargetLang: '' },
      },
    });
    expect(() => requireTranslationConfig()).toThrow(TranslationNotEnabledError);
  });

  it('google/deepl need a KEY (not an endpoint); libretranslate needs an ENDPOINT', () => {
    useConfigStore.setState({
      config: {
        ...DEFAULT_CONFIG,
        translation: { provider: 'google', configured: true, endpoint: '', apiKey: '', lastTargetLang: '' },
      },
    });
    expect(() => requireTranslationConfig()).toThrow(TranslationNotEnabledError);
    useConfigStore.setState({
      config: {
        ...DEFAULT_CONFIG,
        translation: { provider: 'deepl', configured: true, endpoint: '', apiKey: 'k:fx', lastTargetLang: '' },
      },
    });
    expect(requireTranslationConfig().provider).toBe('deepl');
  });

  it('the provider rides the wire payload (the Rust layer routes on it)', async () => {
    configureTranslation('https://lt.example', 'k', 'deepl');
    const editor = makeEditor('<p>Hello</p>');
    mockInstance();
    await runTranslation(editor, { scope: 'document', targetLang: 'en' }, token(), () => {});
    const call = invokeMock.mock.calls.find(([cmd]) => cmd === 'translate')!;
    expect(call[1]).toMatchObject({ provider: 'deepl', endpoint: 'https://lt.example', apiKey: 'k' });
  });

  it('local runs through the engine with the DOWNLOADED pair — no wire, explicit source', async () => {
    configureTranslation('', '', 'local');
    const editor = makeEditor('<p>Hello one</p>');
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === 'translate_model_installed') {
        return [{ code: 'en-de', from: 'en', to: 'de', files: [{ kind: 'model', path: '/m', size: 1, sha256: 'h' }] }];
      }
      throw new Error('unexpected invoke: ' + cmd);
    });
    const { translateHtmlsLocal } = await import('@/lib/editor/translate/local/engine');
    const engineMock = vi.mocked(translateHtmlsLocal);
    engineMock.mockClear();

    const result = await runTranslation(editor, { scope: 'document', targetLang: 'de', sourceLang: 'en' }, token(), () => {});
    expect(result.rows[0]!.translatedText).toBe('Hallo one');
    // No online wire call — the invoke surface only probed the disk.
    expect(invokeMock.mock.calls.every(([cmd]) => cmd === 'translate_model_installed')).toBe(true);
    expect(engineMock).toHaveBeenCalledWith(expect.anything(), 'en', 'de', expect.anything());

    // 'auto' is not a source local can honor — the honest error.
    await expect(
      runTranslation(editor, { scope: 'document', targetLang: 'de' }, token(), () => {}),
    ).rejects.toThrow('explicit source');
  });

  it('local refuses a pair that is not downloaded (disk is the truth)', async () => {
    configureTranslation('', '', 'local');
    const editor = makeEditor('<p>Hello one</p>');
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === 'translate_model_installed') return [];
      throw new Error('unexpected invoke: ' + cmd);
    });
    await expect(
      runTranslation(editor, { scope: 'document', targetLang: 'de', sourceLang: 'en' }, token(), () => {}),
    ).rejects.toThrow('No downloaded model');
  });
});

// ─── The run ────────────────────────────────────────────────────────────

describe('the run', () => {
  it('batches whole blocks and reports progress per batch', async () => {
    configureTranslation();
    const long = 'Hello '.repeat(1200); // ≈7.2k chars — over the 5k budget
    const editor = makeEditor(`<p>${long}</p><p>Hello small</p>`);
    mockInstance();
    const progress: Array<{ done: number; total: number }> = [];
    const result = await runTranslation(editor, { scope: 'document', targetLang: 'en' }, token(), (_rows, done, total) => {
      progress.push({ done, total });
    });
    await flush();
    // Two batches: the giant block alone, then the small one.
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(progress).toEqual([{ done: 1, total: 2 }, { done: 2, total: 2 }]);
    expect(result.rows.length).toBe(2);
    expect(result.detectedLanguage).toBe('en');
  });

  it('cancelled runs stop before the next batch', async () => {
    configureTranslation();
    const long = 'Hello '.repeat(1200);
    const editor = makeEditor(`<p>${long}</p><p>Hello small</p>`);
    mockInstance();
    const cancel = token();
    const first = await new Promise<void>((resolve) => {
      void runTranslation(editor, { scope: 'document', targetLang: 'en' }, cancel, () => {
        cancel.cancelled = true; // cancel right after batch 1 lands
        resolve();
      }).then(() => resolve());
    });
    await first;
    // The second batch never rode the wire.
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('a failed instance marks the block, never loses it silently', async () => {
    configureTranslation();
    const editor = makeEditor('<p>Hello one</p><p>Hello two</p>');
    mockInstance((_html, i) => (i === 1 ? '' : undefined));
    const result = await runTranslation(editor, { scope: 'document', targetLang: 'en' }, token(), () => {});
    expect(result.rows[0]!.failed).toBeUndefined();
    expect(result.rows[1]!.failed).toBeTruthy();
  });
});

// ─── The apply ──────────────────────────────────────────────────────────

describe('the apply', () => {
  it('replace: one transaction, headings stay headings, marks survive', async () => {
    configureTranslation();
    const editor = makeEditor('<h1>Hello one</h1><p>Hello <strong>two</strong></p>');
    mockInstance();
    const result = await runTranslation(editor, { scope: 'document', targetLang: 'en' }, token(), () => {});
    expect(applyTranslation(editor, result.capturedDoc, 'replace', result.rows)).toBe('applied');
    expect(docBare(editor)).toBe('<h1>Bonjour one</h1><p>Bonjour <strong>two</strong></p>');
    // One undo step for the whole apply (the replaceAll law).
    editor.commands.undo();
    expect(docBare(editor)).toBe('<h1>Hello one</h1><p>Hello <strong>two</strong></p>');
  });

  it('interleave: the translation lands as a sibling under EACH block, kind inherited', async () => {
    configureTranslation();
    const editor = makeEditor('<h1>Hello one</h1><p>Hello two</p>');
    mockInstance();
    const result = await runTranslation(editor, { scope: 'document', targetLang: 'en' }, token(), () => {});
    expect(applyTranslation(editor, result.capturedDoc, 'insert-interleaved', result.rows)).toBe('applied');
    expect(docBare(editor)).toBe(
      '<h1>Hello one</h1><h1>Bonjour one</h1><p>Hello two</p><p>Bonjour two</p>',
    );
  });

  it('append: the whole translated copy lands at the END — the original\'s last block is never merged into', async () => {
    configureTranslation();
    const editor = makeEditor('<p>Hello one</p><p>Hello two</p>');
    mockInstance();
    const result = await runTranslation(editor, { scope: 'document', targetLang: 'en' }, token(), () => {});
    expect(applyTranslation(editor, result.capturedDoc, 'insert-appended', result.rows)).toBe('applied');
    expect(docBare(editor)).toBe(
      '<p>Hello one</p><p>Hello two</p><p>Bonjour one</p><p>Bonjour two</p>',
    );
    // The original's last block kept its own text (no merge).
    expect(editor.state.doc.lastChild!.textContent).toBe('Bonjour two');
  });

  it('failed blocks keep their original on every path', async () => {
    configureTranslation();
    const editor = makeEditor('<p>Hello one</p><p>Hello two</p>');
    mockInstance((_html, i) => (i === 1 ? '' : undefined));
    const result = await runTranslation(editor, { scope: 'document', targetLang: 'en' }, token(), () => {});
    expect(applyTranslation(editor, result.capturedDoc, 'replace', result.rows)).toBe('applied');
    expect(docBare(editor)).toBe('<p>Bonjour one</p><p>Hello two</p>');
  });

  it('staleness: a doc changed between run and apply is refused wholesale', async () => {
    configureTranslation();
    const editor = makeEditor('<p>Hello one</p>');
    mockInstance();
    const result = await runTranslation(editor, { scope: 'document', targetLang: 'en' }, token(), () => {});
    editor.commands.setContent('<p>changed doc</p>');
    expect(applyTranslation(editor, result.capturedDoc, 'replace', result.rows)).toBe('stale');
    expect(docBare(editor)).toBe('<p>changed doc</p>');
  });

  it('the parser sanitizes: the wire never writes raw — unknown tags die, known marks live', () => {
    const editor = makeEditor('<p>x</p>');
    const frag = parseBlockHtml(editor, '<p>Hi <script>alert(1)</script><b>bold</b></p>');
    expect(frag).not.toBeNull();
    const json = JSON.stringify(frag!.toJSON());
    expect(json).not.toContain('script');
    expect(json).toContain('bold');
  });
});

// ─── The store (the UI contract seam) ───────────────────────────────────

describe('the translate store', () => {
  it('runs through phases and applies via the panel\'s action path', async () => {
    configureTranslation();
    const editor = makeEditor('<p>Hello one</p>');
    mockInstance();
    const store = useTranslateStore.getState();
    await store.start(editor);
    await flush();
    expect(useTranslateStore.getState().phase).toBe('preview');
    expect(useTranslateStore.getState().rows.length).toBe(1);

    const outcome = useTranslateStore.getState().apply(editor, 'replace');
    expect(outcome).toBe('applied');
    expect(docBare(editor)).toBe('<p>Bonjour one</p>');
    // Applied → the document is the result; back to idle.
    expect(useTranslateStore.getState().phase).toBe('idle');
    expect(useTranslateStore.getState().rows).toEqual([]);
  });
});

// ─── The wiring (the panel command) ─────────────────────────────────────

describe('the wiring', () => {
  it('translateSidebar opens the docked panel (the registry\'s one body)', () => {
    const command = getCommand('translateSidebar');
    expect(command).toBeDefined();
    act_open();
    expect(useSidebarStore.getState().active?.id).toBe('translate');
    useSidebarStore.getState().close();
  });

  function act_open() {
    useSidebarStore.getState().open('translate', 'right');
    void getCommand('translateSidebar')?.run();
  }
});

// The fallback picker is a list of the wire's own shape.
describe('the fallback languages', () => {
  it('speaks the TranslationLanguage wire shape', () => {
    expect(FALLBACK_LANGUAGES.length).toBeGreaterThan(0);
    for (const l of FALLBACK_LANGUAGES) {
      expect(typeof l.code).toBe('string');
      expect(typeof l.name).toBe('string');
    }
  });
});
