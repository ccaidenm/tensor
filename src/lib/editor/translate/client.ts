import { invoke } from '@tauri-apps/api/core';
import { useConfigStore } from '@/lib/config/store';
import type { TranslateBlock, TranslationLanguage } from './types';

/**
 * THE NETWORK MODULE — every call translation ever makes, behind one
 * gate. THE PRIVACY LAW (the catalogsAllowed precedent): nothing
 * here reaches the network unless config.translation.configured is
 * true AND a provider is usable — a call site cannot forget the gate
 * because the gate is the module's entry, not a caller habit.
 *
 * THREE PROVIDERS, ONE CONTRACT (the spell wire law): the Rust layer
 * (src-tauri/src/translate.rs) normalizes every provider's protocol
 * to the same array-in → array-out shape. The WebView never issues
 * cross-origin fetches for this feature (the spell/fetch_url posture
 * — one wire, reqwest, tight CSP).
 */

export class TranslationNotEnabledError extends Error {
  constructor() {
    super('Translation is not set up — configure a provider first');
    this.name = 'TranslationNotEnabledError';
  }
}

export type TranslationProvider = 'libretranslate' | 'google' | 'deepl';

/** Reads + validates the config, or throws. The ONLY way past the gate.
 *  Usability per provider: libretranslate needs an endpoint (self-host
 *  = keyless); google/deepl need an API key (deepl's ':fx' suffix
 *  auto-routes to the free host). */
export function requireTranslationConfig(): {
  provider: TranslationProvider;
  endpoint: string;
  apiKey: string;
} {
  const { provider, endpoint, apiKey } = useConfigStore.getState().config.translation;
  if (!useConfigStore.getState().config.translation.configured) throw new TranslationNotEnabledError();
  if (provider === 'libretranslate' && !endpoint) throw new TranslationNotEnabledError();
  if ((provider === 'google' || provider === 'deepl') && !apiKey) throw new TranslationNotEnabledError();
  return { provider, endpoint, apiKey };
}

/** The provider's own language list (also THE TEST CONNECTION — the
 *  setup dialog's "Test connection" runs exactly this). */
export async function fetchLanguages(provider: TranslationProvider, endpoint?: string, apiKey?: string): Promise<TranslationLanguage[]> {
  return invoke<TranslationLanguage[]>('translate_languages', {
    provider,
    endpoint: endpoint ?? '',
    apiKey: apiKey ?? null,
  });
}

/** One batch: HTML block fragments in, translated HTML fragments out,
 *  1:1 (the Rust layer enforces the array law per provider). */
export async function translateBatch(
  provider: TranslationProvider,
  endpoint: string | undefined,
  apiKey: string | undefined,
  source: string,
  target: string,
  blocks: TranslateBlock[],
): Promise<{ htmls: string[]; detected: string | null }> {
  const res = await invoke<{
    translatedText: string[];
    detectedLanguage: { language: string; confidence?: number } | null;
  }>('translate', {
    provider,
    endpoint: endpoint ?? '',
    apiKey: apiKey ?? null,
    source,
    target,
    blocks: blocks.map((b) => b.html),
  });
  // The Rust layer normalizes the array shape; this is a defensive
  // re-check (deployments that collapse a one-element array).
  const htmls = Array.isArray(res.translatedText)
    ? res.translatedText
    : blocks.length === 1
      ? [res.translatedText]
      : (() => { throw new Error('Provider returned a mismatched translation array'); })();
  if (htmls.length !== blocks.length) {
    throw new Error(`Provider returned ${htmls.length} translations for ${blocks.length} blocks`);
  }
  return { htmls, detected: res.detectedLanguage?.language ?? null };
}

/** Human-readable destinations for the privacy line (per provider —
 *  libretranslate names the user's own instance). */
export function providerDestination(provider: TranslationProvider, endpoint: string): string {
  switch (provider) {
    case 'libretranslate': return endpoint || 'your LibreTranslate instance';
    case 'google': return 'Google Cloud Translation';
    case 'deepl': return 'DeepL';
  }
}

/** The panel's fallback picker list — used when the instance's
 *  /languages can't be reached (the common LibreTranslate languages;
 *  the instance list is authoritative whenever it loads). */
export const FALLBACK_LANGUAGES: TranslationLanguage[] = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'nl', name: 'Dutch' },
  { code: 'ru', name: 'Russian' },
  { code: 'pl', name: 'Polish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'tr', name: 'Turkish' },
  { code: 'ar', name: 'Arabic' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'hi', name: 'Hindi' },
];
