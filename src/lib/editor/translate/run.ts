import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { invoke } from '@tauri-apps/api/core';
import { requireTranslationConfig, translateBatch } from './client';
import { collectBlocks, type TranslateScope } from './walk';
import type { TranslateBlock, TranslatedBlock } from './types';
import type { InstalledPair } from './local/types';
import { translateHtmlsLocal } from './local/engine';

/**
 * THE RUN — batches whole blocks, reports progress per batch, honors the
 * cancel token between batches, captures the doc for the staleness
 * check. Online rides the Rust wire, local the WASM engine.
 */

/** One request's budget (whole blocks per batch; LibreTranslate
 *  instances commonly cap request size — 5k chars is comfortably
 *  inside the default). */
const BATCH_CHARS = 5_000;

export interface TranslateRunOptions {
  scope: TranslateScope;
  targetLang: string;
  sourceLang?: string; // 'auto' (the wire's own default-ish) unless given
}

export interface TranslateRunResult {
  capturedDoc: PMNode;
  rows: TranslatedBlock[];
  detectedLanguage: string | null;
}

export type CancelToken = { cancelled: boolean };

export function makeCancelToken(): CancelToken {
  return { cancelled: false };
}

/** Batch whole blocks under BATCH_CHARS. */
function batch(blocks: TranslateBlock[]): TranslateBlock[][] {
  const batches: TranslateBlock[][] = [];
  let current: TranslateBlock[] = [];
  let len = 0;
  for (const block of blocks) {
    const addition = block.html.length + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && len + addition > BATCH_CHARS) {
      batches.push(current);
      current = [];
      len = 0;
    }
    current.push(block);
    len += addition;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** THE RUN — provider-aware batch translation. */
async function translateGroup(
  provider: 'libretranslate' | 'google' | 'deepl' | 'local',
  endpoint: string,
  apiKey: string,
  source: string,
  target: string,
  group: TranslateBlock[],
): Promise<{ htmls: string[]; detected: string | null }> {
  if (provider === 'local') {
    // The local transport needs the EXPLICIT pair (no auto-detect in
    // Bergamot) and the downloaded model — disk truth via Rust.
    if (!source || source === 'auto') {
      throw new Error('Local translation needs an explicit source language — pick a pair');
    }
    const installed = await invoke<InstalledPair[]>('translate_model_installed');
    const pair = installed.find((p) => p.from === source && p.to === target);
    if (!pair) {
      throw new Error(`No downloaded model for ${source} → ${target} — download it from the panel`);
    }
    const htmls = await translateHtmlsLocal(installed, pair.from, pair.to, group.map((b) => b.html));
    return { htmls, detected: null }; // no detection on-device — the pair IS the source
  }
  return translateBatch(provider, endpoint, apiKey, source, target, group);
}

/**
 * Run a translation. Throws on any failure (the store surfaces it);
 * rows for batches that already landed are reported through onBatch
 * so a mid-run failure still shows what succeeded.
 */
export async function runTranslation(
  editor: Editor,
  opts: TranslateRunOptions,
  cancel: CancelToken,
  onBatch: (rows: TranslatedBlock[], done: number, total: number) => void,
): Promise<TranslateRunResult> {
  // THE GATE — every call site passes through here (the only reader
  // of the network config for translation runs).
  const { provider, endpoint, apiKey } = requireTranslationConfig();

  const capturedDoc = editor.state.doc;
  const all = collectBlocks(editor, opts.scope);
  if (all.length === 0) {
    return { capturedDoc, rows: [], detectedLanguage: null };
  }

  const total = all.length;
  let done = 0;
  let detectedLanguage: string | null = null;
  const rows: TranslatedBlock[] = [];

  for (const group of batch(all)) {
    if (cancel.cancelled) break;
    const { htmls, detected } = await translateGroup(provider, endpoint, apiKey, opts.sourceLang ?? 'auto', opts.targetLang, group);
    if (detected && !detectedLanguage) detectedLanguage = detected;
    for (let i = 0; i < group.length; i++) {
      const block = group[i]!;
      const translatedHtml = htmls[i] ?? '';
      const row: TranslatedBlock = { block, translatedHtml, translatedText: htmlToPlain(translatedHtml) };
      if (!translatedHtml) row.failed = 'The instance returned nothing for this block';
      rows.push(row);
      done++;
    }
    onBatch(rows.slice(), done, total);
  }

  if (cancel.cancelled) {
    return { capturedDoc, rows, detectedLanguage };
  }
  return { capturedDoc, rows, detectedLanguage };
}

/** Plain text for the preview's translated column (the schema never
 *  renders the raw wire HTML; the preview shows text only). */
export function htmlToPlain(html: string): string {
  const el = document.createElement('div');
  el.innerHTML = html;
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}
