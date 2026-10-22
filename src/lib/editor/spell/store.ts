import { create } from 'zustand';
import type { SpellServerStatus } from './types';
import { persistDictionary, loadDictionaryFor } from './dictionary';

/**
 * Spell-check UI state: everything EXCEPT the flagged spans themselves
 * (those live in PM plugin state — the model/UI split the search
 * feature also keeps: SearchExtension holds matches, this-shaped store
 * holds chrome state). One store for both view modes.
 *
 * `localInstalled` is `null` until first probed (the settings surface
 * and the setup dialog trigger the probe via Rust commands).
 */
interface SpellUIState {
  /** LOCAL sidecar lifecycle (the Rust layer's view of the process). */
  serverStatus: SpellServerStatus;
  /** Local runtime present? null = not yet probed. */
  localInstalled: boolean | null;
  /** The personal dictionary (display-sorted; membership checks go
   *  through dictionarySet() — a lowercase Set built on demand). */
  dictionaryWords: string[];
  /** The language the loaded dictionary file is for (guards cross-
   *  language reloads). */
  dictionaryLang: string | null;
  /** "Ignore All" words — session-only, never persisted (lowercased).
   *  Shared by the controller's filter and the bubble's action so
   *  there is one list, not two. */
  sessionIgnored: Set<string>;
  /** "Ignore rule" — session-only, keyed by LT rule id (grammar false
   *  positives are RULE-shaped, not word-shaped). Shared the same way. */
  sessionIgnoredRules: Set<string>;
  /** The last checking failure, for Settings/setup surfacing (a
   *  controller write — never a toast spam channel). */
  lastError: string | null;
  setupOpen: boolean;
  dictionaryOpen: boolean;

  setServerStatus: (s: SpellServerStatus) => void;
  setLocalInstalled: (v: boolean) => void;
  setLastError: (e: string | null) => void;
  openSetup: () => void;
  closeSetup: () => void;
  openDictionary: () => void;
  closeDictionary: () => void;
  /** "Ignore All": flags vanish now and future checks skip the word
   *  for this session. */
  ignoreSessionWord: (word: string) => void;
  /** Grammar's twin: flags for this RULE vanish now and future checks
   *  skip it for this session. */
  ignoreSessionRule: (ruleId: string) => void;

  /** Loads the active language's dictionary once per language. */
  ensureDictionaryLoaded: (lang: string) => Promise<void>;
  /** Adds a word (deduped, case-preserved) and persists. */
  addDictionaryWord: (word: string) => boolean;
  removeDictionaryWord: (word: string) => void;
}

export const useSpellStore = create<SpellUIState>((set, get) => ({
  serverStatus: 'stopped',
  localInstalled: null,
  dictionaryWords: [],
  dictionaryLang: null,
  sessionIgnored: new Set<string>(),
  sessionIgnoredRules: new Set<string>(),
  lastError: null,
  setupOpen: false,
  dictionaryOpen: false,

  setServerStatus: (s) => set({ serverStatus: s }),
  setLocalInstalled: (v) => set({ localInstalled: v }),
  setLastError: (e) => set({ lastError: e }),
  openSetup: () => set({ setupOpen: true }),
  closeSetup: () => set({ setupOpen: false }),
  openDictionary: () => set({ dictionaryOpen: true }),
  closeDictionary: () => set({ dictionaryOpen: false }),

  ignoreSessionWord: (word) => {
    const key = word.trim().toLowerCase();
    if (!key) return;
    const next = new Set(get().sessionIgnored);
    next.add(key);
    set({ sessionIgnored: next });
  },

  ignoreSessionRule: (ruleId) => {
    if (!ruleId) return;
    const next = new Set(get().sessionIgnoredRules);
    next.add(ruleId);
    set({ sessionIgnoredRules: next });
  },

  ensureDictionaryLoaded: async (lang) => {
    const st = get();
    if (st.dictionaryLang === lang) return;
    const words = await loadDictionaryFor(lang);
    // A language switch may have raced us; only commit if still current.
    if (get().dictionaryLang === lang || get().dictionaryLang === null) {
      set({ dictionaryWords: words, dictionaryLang: lang });
    }
  },

  addDictionaryWord: (word) => {
    const w = word.trim();
    if (!w) return false;
    const st = get();
    if (st.dictionaryWords.some((x) => x.toLowerCase() === w.toLowerCase())) return false;
    set({ dictionaryWords: [...st.dictionaryWords, w].sort((a, b) => a.localeCompare(b)) });
    void persistDictionary(st.dictionaryLang, get().dictionaryWords);
    return true;
  },

  removeDictionaryWord: (word) => {
    const st = get();
    set({ dictionaryWords: st.dictionaryWords.filter((x) => x !== word) });
    void persistDictionary(st.dictionaryLang, get().dictionaryWords);
  },
}));

/** Lowercased membership set for the controller's filter (dictionary
 *  sizes are human-scale; building per check run is free). */
export function dictionarySet(): Set<string> {
  return new Set(useSpellStore.getState().dictionaryWords.map((w) => w.toLowerCase()));
}

/** Test/live helper: force-reload the active dictionary from disk. */
export async function reloadDictionary(lang: string): Promise<void> {
  await useSpellStore.getState().ensureDictionaryLoaded(lang);
}
