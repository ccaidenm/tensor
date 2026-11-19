import { create } from 'zustand';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/core';
import type { TranslatedBlock, TranslateApplyMode } from './types';
import type { TranslateScope } from './walk';
import type { CancelToken } from './run';
import { makeCancelToken, runTranslation } from './run';
import { applyTranslation } from './apply';

/**
 * Translate UI state — the search-store shape: everything EXCEPT the
 * document content itself (the pipeline reads/writes the editor; this
 * store holds chrome). One panel, one run at a time.
 *
 * PHASES: idle → translating → preview → (apply | cancel | reset) →
 * idle. `capturedDoc` pins the run's staleness law: the doc reference
 * at run start is what apply refuses to be stale against.
 */
interface TranslateUIState {
  scope: TranslateScope;
  targetLang: string;
  phase: 'idle' | 'translating' | 'preview';
  rows: TranslatedBlock[];
  progress: { done: number; total: number } | null;
  detectedLanguage: string | null;
  capturedDoc: PMNode | null;
  lastError: string | null;
  /** The consent dialog surface (the spell store's setupOpen twin). */
  setupOpen: boolean;

  setScope: (scope: TranslateScope) => void;
  setTargetLang: (lang: string) => void;
  openSetup: () => void;
  closeSetup: () => void;
  /** Runs the translation (the pipeline's only entry point). */
  start: (editor: Editor) => Promise<void>;
  cancel: () => void;
  /** Commits the preview; 'stale' surfaces the translate-again error. */
  apply: (editor: Editor, mode: TranslateApplyMode) => 'applied' | 'stale' | 'nothing';
  reset: () => void;
}

/** The live cancel token — module-level so cancel() reaches the run
 *  between batches without threading it through the store's shape. */
let activeToken: CancelToken | null = null;

export const useTranslateStore = create<TranslateUIState>((set, get) => ({
  scope: 'document',
  targetLang: '',
  phase: 'idle',
  rows: [],
  progress: null,
  detectedLanguage: null,
  capturedDoc: null,
  lastError: null,
  setupOpen: false,

  setScope: (scope) => set({ scope }),
  setTargetLang: (targetLang) => set({ targetLang }),
  openSetup: () => set({ setupOpen: true }),
  closeSetup: () => set({ setupOpen: false }),

  start: async (editor) => {
    if (get().phase === 'translating') return; // one run at a time
    set({ phase: 'translating', rows: [], progress: { done: 0, total: 0 }, lastError: null, detectedLanguage: null });
    activeToken = makeCancelToken();
    try {
      const result = await runTranslation(
        editor,
        { scope: get().scope, targetLang: get().targetLang },
        activeToken,
        (rows, done, total) => set({ rows, progress: { done, total } }),
      );
      // Cancellation discards the run wholesale (predictable: cancel
      // never shows a half-finished preview).
      if (activeToken?.cancelled) {
        activeToken = null;
        set({ phase: 'idle', rows: [], progress: null, capturedDoc: null });
        return;
      }
      activeToken = null;
      if (result.rows.length === 0) {
        set({ phase: 'idle', progress: null, lastError: 'Nothing to translate — no translatable text found' });
        return;
      }
      set({
        phase: 'preview',
        rows: result.rows,
        capturedDoc: result.capturedDoc,
        detectedLanguage: result.detectedLanguage,
        progress: null,
      });
    } catch (err) {
      activeToken = null;
      set({ phase: 'idle', rows: [], progress: null, lastError: err instanceof Error ? err.message : String(err) });
    }
  },

  cancel: () => {
    if (activeToken) activeToken.cancelled = true;
  },

  apply: (editor, mode) => {
    const { phase, rows, capturedDoc } = get();
    if (phase !== 'preview' || !capturedDoc) return 'nothing';
    const outcome = applyTranslation(editor, capturedDoc, mode, rows);
    if (outcome === 'stale') {
      set({
        lastError: 'The document changed since this translation was made — translate again.',
        phase: 'idle',
        rows: [],
        capturedDoc: null,
      });
      return 'stale';
    }
    if (outcome === 'applied') {
      // Applied: the document itself is the result — back to idle.
      set({ phase: 'idle', rows: [], capturedDoc: null, detectedLanguage: null, lastError: null });
    }
    return outcome;
  },

  reset: () => {
    if (activeToken) activeToken.cancelled = true;
    activeToken = null;
    set({ phase: 'idle', rows: [], progress: null, capturedDoc: null, detectedLanguage: null, lastError: null });
  },
}));
