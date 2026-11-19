import { convertFileSrc } from '@tauri-apps/api/core';
import { BatchTranslator } from '@browsermt/bergamot-translator/translator.js';
import type { InstalledPair, WrapperRegistry } from './types';

/**
 * THE LOCAL ENGINE — the on-device translation transport (the fourth
 * provider). One BatchTranslator for the app, lazily created, pointed
 * at a registry BLOB the TS side builds from Rust's installed-pair
 * manifests:
 *
 *   installed (disk truth, from Rust)
 *     → wrapper registry JSON (asset URLs + hashes)
 *     → Blob URL (the wrapper fetches it like any registry — but it
 *       only ever addresses LOCAL model bytes; zero translate-time
 *       network)
 *
 * THE REGISTRY-KEY LAW: the wrapper parses keys as
 * substring(0,2)/substring(2,4), so entries are keyed from+to and the
 * catalog only offers 2-letter code pairs (enforced Rust-side).
 *
 * INVALIDATION: the engine caches model buffers per pair inside its
 * worker — a change to the installed set (a download, a removal in
 * Settings) changes the registry key, and the next ensure() disposes
 * the old engine and builds a fresh one.
 */

/** Build the wrapper's registry JSON from Rust's installed manifests.
 *  `toUrl` maps an absolute file path to a fetchable URL (production:
 *  convertFileSrc's asset protocol; tests: a marker). Pure — the blob
 *  assembly is the impure shell around it. */
export function buildRegistrySource(
  installed: InstalledPair[],
  toUrl: (path: string) => string,
): WrapperRegistry {
  const registry: WrapperRegistry = {};
  for (const pair of installed) {
    const entry: WrapperRegistry[string] = {};
    for (const file of pair.files) {
      if (file.kind === 'model' || file.kind === 'lex' || file.kind === 'vocab' || file.kind === 'srcvocab' || file.kind === 'trgvocab') {
        entry[file.kind] = {
          name: toUrl(file.path),
          size: file.size,
          expectedSha256Hash: file.sha256,
        };
      }
    }
    registry[pair.from + pair.to] = entry;
  }
  return registry;
}

/** The engine identity: the sorted installed-pair codes — two engines
 *  with the same key are interchangeable, so no churn on unrelated
 *  updates. */
function registryKey(installed: InstalledPair[]): string {
  return installed.map((p) => p.code).sort().join(',');
}

interface EngineState {
  translator: BatchTranslator | null;
  key: string;
}

let state: EngineState = { translator: null, key: '' };

/** Create (or reuse) the engine for the installed set. */
async function ensureEngine(installed: InstalledPair[]): Promise<BatchTranslator> {
  if (installed.length === 0) throw new Error('No models downloaded yet');
  const key = registryKey(installed);
  if (state.translator && state.key === key) return state.translator;
  if (state.translator) {
    state.translator.delete();
    state.translator = null;
  }
  const source = buildRegistrySource(installed, convertFileSrc);
  const blob = new Blob([JSON.stringify(source)], { type: 'application/json' });
  state.translator = new BatchTranslator({
    registryUrl: URL.createObjectURL(blob),
    workerUrl: '/bergamot/worker/translator-worker.js',
    // Pivoting is deferred (the plan's ruling): a missing direct pair
    // must fail honestly, not silently route through English.
    pivotLanguage: null,
    workers: 1,
    cacheSize: 0,
  });
  state.key = key;
  return state.translator;
}

/** Translate one batch of HTML block fragments with the downloaded
 *  models. The wrapper's html:true preserves inline tags through
 *  alignment (Bergamot's own tag mapping). */
export async function translateHtmlsLocal(
  installed: InstalledPair[],
  from: string,
  to: string,
  htmls: string[],
): Promise<string[]> {
  const translator = await ensureEngine(installed);
  return Promise.all(
    htmls.map((html) =>
      translator
        .translate({ from, to, text: html, html: true })
        .then((r) => r.target.text),
    ),
  );
}

/** Force-rebuild on the next ensure (a model changed on disk outside
 *  the normal installed-set flow). */
export function disposeLocalEngine(): void {
  if (state.translator) state.translator.delete();
  state = { translator: null, key: '' };
}
