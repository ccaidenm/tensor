import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { APP_VERSION } from '@/generated/version';

/**
 * #97 — version single-sourcing: src-tauri/tauri.conf.json is the ONE
 * source of truth. The generated stamp (src/generated/version.ts, fed
 * by the prebuild's generate-version script) and the two sister
 * version sites (app package, Cargo crate) must never drift — a bump
 * that misses one is the desync this pins.
 */

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), 'utf-8');

describe('version single-sourcing (#97)', () => {
  it('the generated stamp matches tauri.conf.json', () => {
    const conf = JSON.parse(read('../../src-tauri/tauri.conf.json'));
    expect(APP_VERSION).toBe(conf.version);
  });

  it('the app package stays in lockstep', () => {
    const pkg = JSON.parse(read('../../package.json'));
    expect(pkg.version).toBe(APP_VERSION);
    // #97 — the app package is private (never published) and carries
    // the product name, not the old scaffold slug.
    expect(pkg.name).toBe('tensor');
    expect(pkg.private).toBe(true);
  });

  it('the Cargo crate stays in lockstep and carries the identity', () => {
    const cargo = read('../../src-tauri/Cargo.toml');
    expect(cargo).toContain(`version = "${APP_VERSION}"`);
    // The scaffold leftovers are gone (the audit's "A Tauri App"/"you").
    expect(cargo).toContain('name = "tensor"');
    expect(cargo).not.toContain('A Tauri App');
    expect(cargo).not.toContain('"you"');
  });

  it('the window title and productName speak Tensor (the three-way name split is dead)', () => {
    const conf = JSON.parse(read('../../src-tauri/tauri.conf.json'));
    expect(conf.productName).toBe('Tensor');
    expect(conf.app.windows[0].title).toBe('Tensor');
    // The identifier NEVER changes — it owns the appData/config/
    // recovery paths (changing it orphans user data).
    expect(conf.identifier).toBe('com.aestriex.word-processor');
  });
});
