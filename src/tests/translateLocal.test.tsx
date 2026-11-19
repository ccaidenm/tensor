import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_CONFIG } from '@/lib/config/schema';
import { useConfigStore } from '@/lib/config/store';
import { useTranslateStore } from '@/lib/editor/translate/store';
import { buildRegistrySource } from '@/lib/editor/translate/local/engine';
import { pairLabel, languageName } from '@/lib/editor/translate/local/names';
import type { InstalledPair } from '@/lib/editor/translate/local/types';

/**
 * THE LOCAL-MODEL PIECES that don't need the WASM: the registry
 * builder (the wrapper's exact contract), the language names, the
 * store's local actions, and the engine lifecycle. `invoke` and the
 * wrapper module are mocked; the WASM itself has a separate smoke
 * path (scripts + manual, it is a real binary).
 */

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));

// The wrapper is mocked: the engine's lifecycle is what's under test,
// not marian's WASM (proven separately against the real binary).
vi.mock('@browsermt/bergamot-translator/translator.js', () => {
  const instances: Array<{ translate: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> }> = [];
  class BatchTranslator {
    translate: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    constructor() {
      this.translate = vi.fn(async (req: { text: string }) => ({
        request: req,
        target: { text: req.text.replace(/Hello/g, 'Hallo') },
      }));
      this.delete = vi.fn();
      instances.push(this);
    }
  }
  return { BatchTranslator, __instances: instances };
});

import { invoke } from '@tauri-apps/api/core';
import { translateHtmlsLocal, disposeLocalEngine } from '@/lib/editor/translate/local/engine';
import * as wrapper from '@browsermt/bergamot-translator/translator.js';

/** The engine instances the mock built (per-test module registry). */
function engineInstances() {
  return (wrapper as unknown as { __instances: Array<{ translate: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> }> }).__instances;
}

const invokeMock = vi.mocked(invoke);

function installedPair(code = 'en-de'): InstalledPair {
  const [from, to] = code.split('-');
  return {
    code,
    from,
    to,
    files: [
      { kind: 'model', path: `/data/translate-models/${code}/model.bin`, size: 31_561_787, sha256: 'aaa111' },
      { kind: 'lex', path: `/data/translate-models/${code}/lex.bin`, size: 4_347_672, sha256: 'bbb222' },
      { kind: 'vocab', path: `/data/translate-models/${code}/vocab.bin`, size: 810_073, sha256: 'ccc333' },
    ],
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  useConfigStore.setState({ config: DEFAULT_CONFIG });
  useTranslateStore.setState({
    catalog: null,
    catalogError: null,
    installed: [],
    modelDownload: null,
    sourceLang: null,
  });
  disposeLocalEngine();
});

describe('the registry builder', () => {
  it('speaks the wrapper\'s exact contract: key = from+to, files by kind, hashes through', () => {
    const registry = buildRegistrySource([installedPair()], (p) => `asset://${p}`);
    expect(Object.keys(registry)).toEqual(['ende']);
    expect(registry['ende']!.model).toEqual({
      name: 'asset:///data/translate-models/en-de/model.bin',
      size: 31_561_787,
      expectedSha256Hash: 'aaa111',
    });
    expect(registry['ende']!.lex!.expectedSha256Hash).toBe('bbb222');
    expect(registry['ende']!.vocab!.expectedSha256Hash).toBe('ccc333');
    expect(registry['ende']!.srcvocab).toBeUndefined();
  });

  it('carries two-vocab models as srcvocab/trgvocab (the registry\'s alternative)', () => {
    const pair = installedPair('fr-en');
    pair.files = [
      { kind: 'model', path: '/m.bin', size: 1, sha256: 'h1' },
      { kind: 'lex', path: '/l.bin', size: 1, sha256: 'h2' },
      { kind: 'srcvocab', path: '/sv.bin', size: 1, sha256: 'h3' },
      { kind: 'trgvocab', path: '/tv.bin', size: 1, sha256: 'h4' },
    ];
    const registry = buildRegistrySource([pair], (p) => p);
    expect(registry['fren']!.srcvocab!.expectedSha256Hash).toBe('h3');
    expect(registry['fren']!.trgvocab!.expectedSha256Hash).toBe('h4');
    expect(registry['fren']!.vocab).toBeUndefined();
  });

  it('keys multiple pairs independently', () => {
    const registry = buildRegistrySource([installedPair('en-de'), installedPair('es-en')], (p) => p);
    expect(Object.keys(registry).sort()).toEqual(['ende', 'esen']);
  });
});

describe('the engine lifecycle', () => {
  it('reuses one translator for the same installed set; rebuilds when it changes', async () => {
    const pairs = [installedPair()];
    const a = await translateHtmlsLocal(pairs, 'en', 'de', ['<p>Hello</p>']);
    const b = await translateHtmlsLocal(pairs, 'en', 'de', ['<p>Hello again</p>']);
    expect(a).toEqual(['<p>Hallo</p>']);
    expect(b).toEqual(['<p>Hallo again</p>']);
    expect(engineInstances().length).toBe(1);

    // A new pair in the set invalidates the engine (model buffers live
    // in the old worker) — dispose + fresh instance.
    await translateHtmlsLocal([pairs[0]!, installedPair('es-en')], 'es', 'en', ['<p>Hello</p>']);
    expect(engineInstances().length).toBe(2);
    expect(engineInstances()[0]!.delete).toHaveBeenCalled();
  });

  it('refuses to build an engine with nothing installed', async () => {
    await expect(translateHtmlsLocal([], 'en', 'de', ['<p>x</p>'])).rejects.toThrow('No models downloaded');
  });
});

describe('the store\'s local actions', () => {
  it('loadLocalData fetches the catalog + installed pairs (disk truth)', async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === 'translate_model_installed') return [installedPair()];
      if (cmd === 'translate_catalog') return { pairs: [{ code: 'en-de', from: 'en', to: 'de', bytes: 36_719_532 }] };
      throw new Error('unexpected invoke: ' + cmd);
    });
    await useTranslateStore.getState().loadLocalData();
    const state = useTranslateStore.getState();
    expect(state.installed.length).toBe(1);
    expect(state.catalog!.length).toBe(1);
    expect(state.catalogError).toBeNull();
  });

  it('a catalog failure degrades to an error note, installed pairs survive', async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === 'translate_model_installed') return [installedPair()];
      throw new Error('Catalog request failed: offline');
    });
    await useTranslateStore.getState().loadLocalData();
    const state = useTranslateStore.getState();
    expect(state.catalog).toBeNull();
    expect(state.catalogError).toContain('offline');
    expect(state.installed.length).toBe(1);
  });

  it('downloadPair installs, refreshes the registry, and clears progress', async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === 'translate_model_download') return installedPair();
      if (cmd === 'translate_model_installed') return [installedPair()];
      throw new Error('unexpected invoke: ' + cmd);
    });
    const ok = await useTranslateStore.getState().downloadPair('en-de');
    expect(ok).toBe(true);
    expect(useTranslateStore.getState().installed.length).toBe(1);
    expect(useTranslateStore.getState().modelDownload).toBeNull();
  });

  it('a failed download surfaces the error and never fakes an install', async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === 'translate_model_download') throw new Error('model failed its integrity check');
      throw new Error('unexpected invoke: ' + cmd);
    });
    const ok = await useTranslateStore.getState().downloadPair('en-de');
    expect(ok).toBe(false);
    expect(useTranslateStore.getState().lastError).toContain('integrity');
    expect(useTranslateStore.getState().installed).toEqual([]);
  });
});

describe('the language names', () => {
  it('labels pairs through Intl.DisplayNames, falling back to the code', () => {
    expect(languageName('de')).toBe('German');
    expect(languageName('xx')).toBe('xx'); // unknown codes render as codes
    expect(pairLabel({ from: 'en', to: 'de' })).toBe('English → German');
  });
});
