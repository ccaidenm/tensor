import { create } from 'zustand';
import type { Editor } from '@tiptap/core';
import { message } from '@tauri-apps/plugin-dialog';
import { saveDocument, saveDocumentAs, openDocument } from './fileOperations';
import { clearRecoveryCopy } from './recovery';
import { useConfigStore } from '../config/store';
import { useStyleRegistryStore } from '../styles/registry';
import type { PageSetup } from './pageSetup';
import type { LineNumbersSetting } from './schema';
import { normalizeCoreProperties, type DocumentCoreProperties } from './coreProperties';

function defaultPageSetup(): PageSetup {
  const { config } = useConfigStore.getState();
  return {
    pageSize: config.editor.defaultPageSize,
    margins: config.editor.defaultMargins,
    pageGap: config.editor.defaultPageGap,
  };
}

interface DocumentStore {
  editor: Editor | null;
  filePath: string | null;
  isDirty: boolean;
  revision: number;
  pageSetup: PageSetup;
  setEditor: (editor: Editor | null) => void;
  markDirty: () => void;
  setPageSetup: (pageSetup: PageSetup) => void;
  /** M-LINENUMS: the document's gutter setting; null = never set
   *  (old files) = gutter off. Writing it marks the doc dirty —
   *  it travels in .wpdoc metadata like pageSetup. */
  lineNumbers: LineNumbersSetting | null;
  setLineNumbers: (setting: LineNumbersSetting | null) => void;
  /** M-META: the document's standard core properties (title, author,
   *  subject, keywords, comments). Writing marks the doc dirty — they
   *  travel in .wpdoc metadata like pageSetup/lineNumbers. Normalized
   *  on write: the store never holds empty strings. */
  coreProperties: DocumentCoreProperties;
  setCoreProperties: (props: DocumentCoreProperties) => void;
  save: () => Promise<void>;
  saveAs: () => Promise<void>;
  openFile: () => Promise<void>;
  pageCount: number;
  currentPage: number;
  setPageInfo: (pageCount: number, currentPage: number) => void;
}

export const useDocumentStore = create<DocumentStore>((set, get) => ({
  editor: null,
  filePath: null,
  isDirty: false,
  revision: 0,
  pageSetup: defaultPageSetup(),
  pageCount: 1,
  currentPage: 1,
  setPageInfo: (pageCount, currentPage) => set({ pageCount, currentPage }),

  setEditor: (editor) => set({ editor }),
  markDirty: () => set((state) => ({ isDirty: true, revision: state.revision + 1 })),
  setPageSetup: (pageSetup) => set({ pageSetup, isDirty: true }),
  lineNumbers: null,
  setLineNumbers: (setting) => set((state) => ({ lineNumbers: setting, isDirty: true, revision: state.revision + 1 })),

  coreProperties: {},
  setCoreProperties: (props) =>
    set((state) => ({
      coreProperties: normalizeCoreProperties(props),
      isDirty: true,
      revision: state.revision + 1,
    })),

  save: async () => {
    const { editor, filePath, pageSetup, lineNumbers, coreProperties } = get();
    if (!editor) return;
    if (!filePath) {
      await get().saveAs();
      return;
    }
    await saveDocument(editor, filePath, { pageSetup, lineNumbers, coreProperties });
    await clearRecoveryCopy(filePath);
    set({ isDirty: false });
  },

  saveAs: async () => {
    const { editor, filePath: oldPath, pageSetup, lineNumbers, coreProperties } = get();
    if (!editor) return;
    const newPath = await saveDocumentAs(editor, { pageSetup, lineNumbers, coreProperties });
    if (newPath) {
      await clearRecoveryCopy(oldPath);
      set({ filePath: newPath, isDirty: false });
    }
  },

  openFile: async () => {
    const { editor } = get();
    if (!editor) return;
    try {
      const result = await openDocument(editor);
      if (result) {
        // M-STYLES: the opened file's doc layer replaces whatever the
        // previous document carried (doc overrides global by id at
        // merge; the epoch bump relayouts both modes).
        useStyleRegistryStore.getState().applyDocLayer(result.styleDefinitions);
        set({
          filePath: result.path,
          isDirty: false,
          pageSetup: result.pageSetup ?? defaultPageSetup(),
          lineNumbers: result.lineNumbers ?? null,
          // M-META: normalized in openDocument — {} for old files.
          coreProperties: result.coreProperties,
        });
      }
    } catch (err) {
      await message(err instanceof Error ? err.message : 'Failed to open document', {
        title: 'Error',
        kind: 'error',
      });
    }
  },
}));

// The store above is created at module init — before the persisted
// config.json is loaded by useConfigPersistence — so the initial
// pageSetup captures pre-load defaults. Re-derive it from the config
// store whenever that changes, but only while the document is pristine:
// once a file is opened (it carries its own pageSetup) or the current
// one is edited, the document owns its setup.
useConfigStore.subscribe(() => {
  const { filePath, isDirty } = useDocumentStore.getState();
  if (!filePath && !isDirty) {
    // M-META: a pristine document's author defaults from the app's
    // user identity (Settings > General > User) — the same posture
    // as defaultPageSetup: visible and editable in the Properties
    // dialog; once saved or edited, the document owns its properties.
    // (Pre-release onboarding will seed the identity; the setting
    // itself lives in config permanently.)
    const { author } = useConfigStore.getState().config.identity;
    useDocumentStore.setState({
      pageSetup: defaultPageSetup(),
      coreProperties: author ? { author } : {},
    });
  }
});
