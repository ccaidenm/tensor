import { create } from 'zustand';
import type { Editor } from '@tiptap/core';
import { message } from '@tauri-apps/plugin-dialog';
import { saveDocument, openDocument, chooseSavePath, saveAsDefaultName } from './fileOperations';
import { exportMarkdownFile, markdownDefaultPath } from '@/lib/markdown/exportMarkdown';
import { docxDefaultPath, exportDocxFile, saveDocxToPath } from '@/lib/docx/exportFlow';
import type { DocxExportInput } from '@/lib/docx/export';
import type { JSONContent } from '@tiptap/core';
import { toDocxCoreProperties } from './coreProperties';
import { useMediaStore } from '@/lib/media/store';
import { useImportReportDialogStore } from '@/components/dialogs/ImportReportDialog';
import { clearRecoveryCopy } from './recovery';
import { useConfigStore } from '../config/store';
import { useStyleRegistryStore } from '../styles/registry';
import type { PageSetup } from './pageSetup';
import type { LineNumbersSetting } from './schema';
import type { HeaderFooterSettings } from './headerFooter';
import { normalizeCoreProperties, type DocumentCoreProperties } from './coreProperties';

function defaultPageSetup(): PageSetup {
  const { config } = useConfigStore.getState();
  return {
    pageSize: config.editor.defaultPageSize,
    margins: config.editor.defaultMargins,
    pageGap: config.editor.defaultPageGap,
  };
}

/** THE DOCX INPUT (M-DOCX): one assembly shared by the Export command,
 *  in-place Save, and Save-As — the resolved style registry, the
 *  config-derived base, and the session media ride identically in all
 *  three, so an export can never drift from what Save writes. */
function buildDocxInput(json: JSONContent): DocxExportInput {
  const { pageSetup, headerFooter, coreProperties } = useDocumentStore.getState();
  return {
    json,
    pageSetup,
    headerFooter,
    coreProperties: toDocxCoreProperties(coreProperties),
    // The RESOLVED registry (code+global+doc) — the styles the
    // document's styleIds reference (M-STYLES cascade).
    styleDefinitions: Object.values(useStyleRegistryStore.getState().merged),
    baseStyle: {
      fontFamily: useConfigStore.getState().config.editor.defaultFontFamily,
      fontSize: useConfigStore.getState().config.editor.defaultFontSize,
    },
    media: useMediaStore.getState().entries,
  };
}

/** The in-place dispatch: a .docx document saves ITSELF; everything
 *  else saves Tensor's format. Markdown paths never reach here (the
 *  open flow keeps them filePath-less — markdown is export-only). */
function isWordPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.docx');
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
  /** M-HEADER-FOOTER: the document's header/footer settings; null =
   *  never set (old files) = headers/footers off. Writing marks the
   *  doc dirty — it travels in .wpdoc metadata like pageSetup. */
  headerFooter: HeaderFooterSettings | null;
  setHeaderFooter: (settings: HeaderFooterSettings | null) => void;
  save: () => Promise<void>;
  saveAs: () => Promise<void>;
  openFile: () => Promise<void>;
  /** M-MD: export the current document as Markdown. Never mutates
   *  filePath/isDirty — an export is a copy, not a conversion. The
   *  lossy confirm (ruling 2) lives inside exportMarkdownFile, so the
   *  menu and the palette share the exact same body. */
  exportMarkdown: () => Promise<void>;
  /** M-DOCX: export the current document as a Word .docx (#37) — the
   *  same copy-not-conversion posture and the same one-body gate. */
  exportDocx: () => Promise<void>;
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

  headerFooter: null,
  setHeaderFooter: (settings) =>
    set((state) => ({
      headerFooter: settings,
      isDirty: true,
      revision: state.revision + 1,
    })),

  save: async () => {
    const { editor, filePath, pageSetup, lineNumbers, coreProperties, headerFooter } = get();
    if (!editor) return;
    if (!filePath) {
      await get().saveAs();
      return;
    }
    if (isWordPath(filePath)) {
      // M-DOCX in-place: Save writes the Word file at its own path.
      try {
        const outcome = await saveDocxToPath(buildDocxInput(editor.getJSON()), filePath);
        if (outcome === 'saved') set({ isDirty: false });
      } catch (err) {
        await message(err instanceof Error ? err.message : 'Failed to save Word document', {
          title: 'Error',
          kind: 'error',
        });
      }
      return;
    }
    await saveDocument(editor, filePath, { pageSetup, lineNumbers, coreProperties, headerFooter });
    await clearRecoveryCopy(filePath);
    set({ isDirty: false });
  },

  saveAs: async () => {
    const { editor, filePath, pageSetup, lineNumbers, coreProperties, headerFooter } = get();
    if (!editor) return;
    const path = await chooseSavePath(saveAsDefaultName(filePath));
    if (!path) return;
    if (isWordPath(path)) {
      try {
        const outcome = await saveDocxToPath(buildDocxInput(editor.getJSON()), path);
        if (outcome === 'saved') {
          await clearRecoveryCopy(filePath);
          set({ filePath: path, isDirty: false });
        }
      } catch (err) {
        await message(err instanceof Error ? err.message : 'Failed to save Word document', {
          title: 'Error',
          kind: 'error',
        });
      }
      return;
    }
    await saveDocument(editor, path, { pageSetup, lineNumbers, coreProperties, headerFooter });
    await clearRecoveryCopy(filePath);
    set({ filePath: path, isDirty: false });
  },

  exportMarkdown: async () => {
    const { editor, filePath } = get();
    if (!editor) return;
    try {
      await exportMarkdownFile(editor.getJSON(), { defaultPath: markdownDefaultPath(filePath) });
    } catch (err) {
      await message(err instanceof Error ? err.message : 'Failed to export Markdown', {
        title: 'Error',
        kind: 'error',
      });
    }
  },

  exportDocx: async () => {
    const { editor, filePath } = get();
    if (!editor) return;
    try {
      await exportDocxFile(buildDocxInput(editor.getJSON()), {
        defaultPath: docxDefaultPath(filePath),
      });
    } catch (err) {
      await message(err instanceof Error ? err.message : 'Failed to export Word document', {
        title: 'Error',
        kind: 'error',
      });
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
          // M-MD: a MARKDOWN import carries real content with no file
          // behind it — unsaved work (it also keeps the pristine-config
          // subscription from resetting the page setup under it). A
          // .wpdoc or .docx open is clean: the file IS the document.
          isDirty: result.path === null,
          pageSetup: result.pageSetup ?? defaultPageSetup(),
          lineNumbers: result.lineNumbers ?? null,
          // M-META: normalized in openDocument — {} for old files.
          coreProperties: result.coreProperties,
          // M-HEADER-FOOTER: null = the file predates them / never
          // enabled them. The headerFooter store re-syncs its editor
          // instances off this write (its own subscription).
          headerFooter: result.headerFooter,
        });
        // M-MD/M-DOCX: the LOUD posture — one in-app report dialog
        // naming what changed, after the content has landed (never a
        // crash, never silent loss).
        const notices: string[] = [];
        if (result.skippedImages) {
          notices.push(
            `${result.skippedImages} image${result.skippedImages === 1 ? ' was' : 's were'} not imported — remote, missing, or unreadable sources are refused rather than silently fetched.`,
          );
        }
        if (result.importNotices?.length) notices.push(...result.importNotices);
        if (notices.length) {
          useImportReportDialogStore.getState().show({
            title: result.importNotices ? 'Word import' : 'Markdown import',
            lines: notices,
          });
        }
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
