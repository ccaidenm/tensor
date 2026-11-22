import { create } from 'zustand';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/core';
import { invoke } from '@tauri-apps/api/core';
import type { TranslatedBlock, TranslateApplyMode } from './types';
import type { TranslateScope } from './walk';
import type { CancelToken } from './run';
import type { CatalogPair, InstalledPair, TranslateDownloadProgress } from './local/types';
import { makeCancelToken, runTranslation } from './run';
import { applyTranslation } from './apply';

/**
 * Translate UI state — everything EXCEPT the document content. Phases:
 * idle → translating → preview → apply/cancel/reset → idle; LOCAL MODE
 * adds catalog/installed/modelDownload.
 */
interface TranslateUIState {
  scope: TranslateScope;
  targetLang: string;
  /** The explicit source language (local mode's pair picker sets it —
   *  Bergamot has no auto-detect; online providers ignore it). */
  sourceLang: string | null;
  phase: 'idle' | 'translating' | 'preview';
  rows: TranslatedBlock[];
  progress: { done: number; total: number } | null;
  detectedLanguage: string | null;
  capturedDoc: PMNode | null;
  lastError: string | null;
  /** The consent dialog surface (the spell store's setupOpen twin). */
  setupOpen: boolean;

  /** LOCAL MODE state. */
  catalog: CatalogPair[] | null;
  catalogError: string | null;
  installed: InstalledPair[];
  modelDownload: (TranslateDownloadProgress & { code: string }) | null;

  setScope: (scope: TranslateScope) => void;
  setTargetLang: (lang: string) => void;
  setSourceLang: (lang: string | null) => void;
  openSetup: () => void;
  closeSetup: () => void;
  /** Runs the translation (the pipeline's only entry point). */
  start: (editor: Editor) => Promise<void>;
  cancel: () => void;
  /** Commits the preview; 'stale' surfaces the translate-again error. */
  apply: (editor: Editor, mode: TranslateApplyMode) => 'applied' | 'stale' | 'nothing';
  reset: () => void;
  /** Loads the local-mode data (catalog + installed) — called when the
   *  panel opens with the local provider. */
  loadLocalData: () => Promise<void>;
  /** Downloads a model pair (progress rides the Tauri event the panel
   *  listens for); resolves with the installed pair. */
  downloadPair: (code: string) => Promise<boolean>;
  setModelDownload: (dl: (TranslateDownloadProgress & { code: string }) | null) => void;
}

/** The live cancel token — module-level so cancel() reaches the run
 *  between batches without threading it through the store's shape. */
let activeToken: CancelToken | null = null;

export const useTranslateStore = create<TranslateUIState>((set, get) => ({
  scope: 'document',
  targetLang: '',
  sourceLang: null,
  phase: 'idle',
  rows: [],
  progress: null,
  detectedLanguage: null,
  capturedDoc: null,
  lastError: null,
  setupOpen: false,
  catalog: null,
  catalogError: null,
  installed: [],
  modelDownload: null,

  setScope: (scope) => set({ scope }),
  setTargetLang: (targetLang) => set({ targetLang }),
  setSourceLang: (sourceLang) => set({ sourceLang }),
  openSetup: () => set({ setupOpen: true }),
  closeSetup: () => set({ setupOpen: false }),

  loadLocalData: async () => {
    try {
      const installed = await invoke<InstalledPair[]>('translate_model_installed');
      set({ installed });
    } catch {
      set({ installed: [] });
    }
    try {
      const { pairs } = await invoke<{ pairs: CatalogPair[] }>('translate_catalog');
      set({ catalog: pairs, catalogError: null });
    } catch (err) {
      set({ catalogError: err instanceof Error ? err.message : String(err) });
    }
  },

  downloadPair: async (code) => {
    if (get().modelDownload) return false; // one download at a time
    set({ modelDownload: { code, stage: 'model', received: 0, total: 0 }, lastError: null });
    try {
      await invoke('translate_model_download', { code });
      const installed = await invoke<InstalledPair[]>('translate_model_installed');
      set({ installed, modelDownload: null });
      return true;
    } catch (err) {
      set({
        modelDownload: null,
        lastError: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  },

  setModelDownload: (modelDownload) => set({ modelDownload }),

  start: async (editor) => {
    if (get().phase === 'translating') return; // one run at a time
    set({ phase: 'translating', rows: [], progress: { done: 0, total: 0 }, lastError: null, detectedLanguage: null });
    activeToken = makeCancelToken();
    try {
      const result = await runTranslation(
        editor,
        // sourceLang rides for local (the explicit pair direction);
        // online providers translate with 'auto' when it's absent.
        { scope: get().scope, targetLang: get().targetLang, sourceLang: get().sourceLang ?? undefined },
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
