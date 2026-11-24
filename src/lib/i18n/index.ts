import { create } from 'zustand';
import en from '../../../locales/en.json';

/**
 * THE I18N RUNTIME.
 *
 * `locales/en.json` is the single source of truth: its shape IS the key
 * space. Every other locale must mirror it exactly (the key-parity test
 * in src/tests/i18n.test.ts pins this — a locale file that drifts from
 * en's shape fails the suite, so Weblate PRs can't break the build
 * silently).
 *
 * Locale files are discovered at build time by Vite's glob and loaded
 * on demand: adding `locales/fr.json` registers 'fr' with zero code
 * changes. `t()` resolves dot-paths against the ACTIVE dictionary with
 * English as the fallback — a missing translation degrades to English,
 * never to a blank UI, and warns once per key.
 *
 * Conventions (see docs/i18n.md for the full workflow):
 * - Strings enter the app by moving into en.json first, then a t() call
 *   replaces the literal. Strings migrate as the code that renders them
 *   is touched; no big-bang extraction.
 * - Interpolation uses named {brace} tokens; values are passed as
 *   params, never concatenated into the dictionary.
 */

export type Dictionary = typeof en;

/** Every dot-path into the dictionary — objects nested, leaves included. */
type Paths<T> = T extends object
  ? { [K in keyof T & string]: T[K] extends object ? K | `${K}.${Paths<T[K]>}` : K }[keyof T & string]
  : never;

export type TKey = Paths<Dictionary>;
export type TParams = Record<string, string | number>;

/** Locale code → dictionary. 'en' ships statically; the rest load on demand. */
const dictionaries: Record<string, Dictionary> = { en };

const localeModules = import.meta.glob('/locales/*.json', { import: 'default' }) as Record<
  string,
  () => Promise<unknown>
>;

async function loadDictionary(locale: string): Promise<Dictionary | null> {
  if (dictionaries[locale]) return dictionaries[locale];
  const loader = localeModules[`/locales/${locale}.json`];
  if (!loader) return null;
  try {
    const dict = (await loader()) as Dictionary;
    dictionaries[locale] = dict;
    return dict;
  } catch {
    return null;
  }
}

interface I18nStore {
  /** BCP 47 code matching a locales/<code>.json file ('en' today). */
  locale: string;
  /**
   * Switch the active locale. A locale without a dictionary is refused
   * with a warning — the app never renders against a partial file.
   */
  setLocale: (locale: string) => void;
}

export const useI18n = create<I18nStore>((set) => ({
  locale: 'en',
  setLocale: (locale) => {
    void loadDictionary(locale).then((dict) => {
      if (dict) set({ locale });
      else console.warn(`[i18n] no dictionary for "${locale}" — staying on "${useI18n.getState().locale}"`);
    });
  },
}));

function activeDictionary(): Dictionary {
  return dictionaries[useI18n.getState().locale] ?? dictionaries.en;
}

const warned = new Set<string>();

/**
 * Translate the dot-path `key` against the active dictionary.
 * Missing keys return the key itself (an English-locale key is always
 * a safe fallback rendering) and warn once — loud seams, not silent
 * blanks.
 */
export function t(key: TKey, params?: TParams): string {
  const value = key.split('.').reduce<unknown>((node, segment) => {
    if (node && typeof node === 'object' && segment in node) {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, activeDictionary());
  if (typeof value !== 'string') {
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`[i18n] missing translation: "${key}"`);
    }
    return key;
  }
  if (!params) return value;
  return value.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}
