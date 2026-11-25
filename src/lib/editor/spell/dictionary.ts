import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { appConfigDir, join } from '@tauri-apps/api/path';

/**
 * The PERSONAL DICTIONARY — plain text, one word per line, at
 * {appConfigDir}/spell/dictionary-<lang>.txt: a file, not a config key
 * (unbounded user content), one per language. Outside Tauri: no-op.
 */

const SPELL_DIR = 'spell';

function inTauri(): boolean {
  return '__TAURI_INTERNALS__' in globalThis;
}

async function dictionaryPath(lang: string): Promise<string> {
  return join(await appConfigDir(), SPELL_DIR, `dictionary-${lang}.txt`);
}

/** Parse the file body: one word per line, trimmed, non-empty,
 *  de-duplicated case-insensitively (first spelling wins). */
export function parseDictionary(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const w = line.trim();
    if (!w) continue;
    const key = w.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/** Serialize: one word per line, trailing newline ( POSIX text-file
 *  convention; the file stays line-diffable). */
export function serializeDictionary(words: readonly string[]): string {
  return [...words].sort((a, b) => a.localeCompare(b)).join('\n') + '\n';
}

export async function loadDictionaryFor(lang: string): Promise<string[]> {
  if (!inTauri()) return [];
  try {
    const path = await dictionaryPath(lang);
    if (!(await exists(path))) return [];
    return parseDictionary(await readTextFile(path));
  } catch (err) {
    console.error('[spell] dictionary load failed:', err);
    return [];
  }
}

export async function persistDictionary(lang: string | null, words: readonly string[]): Promise<void> {
  if (!inTauri() || !lang) return;
  try {
    const dir = await join(await appConfigDir(), SPELL_DIR);
    if (!(await exists(dir))) await mkdir(dir, { recursive: true });
    await writeTextFile(await dictionaryPath(lang), serializeDictionary(words));
  } catch (err) {
    // A failed dictionary write loses nothing but persistence — the
    // in-memory store still unflags words this session.
    console.error('[spell] dictionary save failed:', err);
  }
}
