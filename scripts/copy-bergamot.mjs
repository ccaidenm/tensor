// TRANSLATE (local models): copy the pinned Bergamot WASM artifacts from
// node_modules into public/bergamot/ — the classic-worker files the engine
// loads at runtime (the generate-licenses.mjs precedent: generated assets
// are produced at dev/build time, never committed).
//
// Files (from @browsermt/bergamot-translator, MPL-2.0):
//   worker/translator-worker.js            the package's worker glue (model
//                                          management, gemm fallback wiring)
//   worker/bergamot-translator-worker.js   the emscripten module glue
//   worker/bergamot-translator-worker.wasm the WASM binary itself
//
// The glue loads the .wasm and the emscripten file RELATIVE to itself
// (importScripts + new URL('./…', self.location)), so all three must sit
// in the same directory.

import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const pkgWorker = join(process.cwd(), 'node_modules/@browsermt/bergamot-translator/worker');
const out = join(process.cwd(), 'public/bergamot/worker');

const FILES = [
  'translator-worker.js',
  'bergamot-translator-worker.js',
  'bergamot-translator-worker.wasm',
];

try {
  mkdirSync(out, { recursive: true });
  for (const file of FILES) {
    copyFileSync(join(pkgWorker, file), join(out, file));
  }
  console.log(`[copy-bergamot] copied ${FILES.length} artifacts to public/bergamot/worker/`);
} catch (err) {
  console.error('[copy-bergamot] failed — is @browsermt/bergamot-translator installed?', err.message);
  process.exit(1);
}
