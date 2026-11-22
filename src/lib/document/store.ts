import { create } from 'zustand';
import type { Editor } from '@tiptap/core';
import { message } from '@tauri-apps/plugin-dialog';
import { remove } from '@tauri-apps/plugin-fs';
import { saveDocument, openDocument, chooseSavePath, saveAsDefaultName } from './fileOperations';
import { exportMarkdownFile, markdownDefaultPath } from '@/lib/markdown/exportMarkdown';
import { docxDefaultPath, exportDocxFile, saveDocxToPath } from '@/lib/docx/exportFlow';
import type { DocxExportInput } from '@/lib/docx/export';
import type { JSONContent } from '@tiptap/core';
import { toDocxCoreProperties } from './coreProperties';
import { useMediaStore } from '@/lib/media/store';
import { useImportReportDialogStore } from '@/components/dialogs/ImportReportDialog';
import { clearRecoveryCopy, readRecoveryCopy, saveRecoveryCopy } from './recovery';
import { useConfigStore } from '../config/store';
import { useStyleRegistryStore } from '../styles/registry';
import type { PageSetup, PageStyles } from './pageSetup';
import type { LineNumbersSetting } from './schema';
import { isLegacyHeaderFooter, type HeaderFooterSettings } from './headerFooter';
import { migrateLegacyHeaderFooter } from '@/lib/editor/headerFooterCommands';
import { normalizeCoreProperties, type DocumentCoreProperties } from './coreProperties';
import { useCommentStore } from '@/lib/comments/store';

function defaultPageSetup(): PageSetup {
  const { config } = useConfigStore.getState();
  return {
    pageSize: config.editor.defaultPageSize,
    margins: config.editor.defaultMargins,
    pageGap: config.editor.defaultPageGap,
  };
}

/** The DOCX input: one assembly shared by the Export command, in-place
 *  Save, and Save-As — an export can never drift from what Save writes. */
function buildDocxInput(json: JSONContent): DocxExportInput {
  const { pageSetup, headerFooter, coreProperties } = useDocumentStore.getState();
  return {
    json,
    pageSetup,
    headerFooter,
    coreProperties: toDocxCoreProperties(coreProperties),
    // The resolved registry (code+global+doc) — the styles the
    // document's styleIds reference.
    styleDefinitions: Object.values(useStyleRegistryStore.getState().merged),
    baseStyle: {
      fontFamily: useConfigStore.getState().config.editor.defaultFontFamily,
      fontSize: useConfigStore.getState().config.editor.defaultFontSize,
    },
    media: useMediaStore.getState().entries,
  };
}

/** The in-place dispatch: a .docx document saves itself; everything
 *  else saves Tensor's format (markdown paths never reach here —
 *  markdown is export-only). */
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
  /**
   * #48 — the per-page styles (positional map); {} = none. NOT inside
   * PageSetup on purpose: setups serialize onto section breaks
   * wholesale, and a page-index map must never ride one.
   */
  pageStyles: PageStyles;
  setPageStyles: (pageStyles: PageStyles) => void;
  /** The gutter setting; null = never set (old files) = gutter off.
   *  Writing marks the doc dirty; travels in .wpdoc metadata like pageSetup. */
  lineNumbers: LineNumbersSetting | null;
  setLineNumbers: (setting: LineNumbersSetting | null) => void;
  /** The standard core properties. Writing marks the doc dirty;
   *  travels in .wpdoc metadata like pageSetup. Normalized on write —
   *  the store never holds empty strings. */
  coreProperties: DocumentCoreProperties;
  setCoreProperties: (props: DocumentCoreProperties) => void;
  /** Header/footer settings; null = never set (old files) = off.
   *  Writing marks the doc dirty; travels in .wpdoc metadata like pageSetup. */
  headerFooter: HeaderFooterSettings | null;
  setHeaderFooter: (settings: HeaderFooterSettings | null) => void;
  save: () => Promise<void>;
  saveAs: () => Promise<void>;
  /** #103 — the optional path (the start screen's recents pass one;
   *  absent = the picker dialog). */
  openFile: (path?: string) => Promise<void>;
  /** #103 — true while the start screen owns the window (every launch
   *  opens on Home). */
  startActive: boolean;
  /** #103 — true once a document exists this session (gates Home's
   *  "Return to document" — the doc stays loaded underneath Home). */
  hasDocument: boolean;
  /** #103 — the Tensor menu's Home item: the start screen over the
   *  loaded doc (which stays mounted/hidden — nothing is discarded). */
  goHome: () => void;
  /** #103 — Home's return path: back to the doc that never left. */
  returnToDocument: () => void;
  /** #103 — Home's "Save & close" card: the doc saves (in place, or the
   *  recovery net when untitled) and resets, so a new doc begins
   *  immediately. Home stays. */
  saveAndClose: () => Promise<void>;
  /** #103 — restore a recovery snapshot: the same hydration as openFile's
   *  success path, then the consumed snapshot clears. A dirty current doc
   *  snapshots first. */
  restoreRecovery: (recoveryPath: string) => Promise<void>;
  /** #103 — create a fresh document (viewMode explicit, optional starter
   *  HTML). A dirty current doc is recovery-snapshotted first. */
  newDocument: (viewMode: 'pages' | 'pageless', templateHtml?: string) => Promise<void>;
  /** Export the current document as Markdown. Never mutates filePath/
   *  isDirty — an export is a copy, not a conversion. The lossy confirm
   *  lives inside exportMarkdownFile, so the menu and the palette share
   *  the same body. */
  exportMarkdown: () => Promise<void>;
  /** Export the current document as a Word .docx (#37) — the same
   *  copy-not-conversion posture, same one-body gate. */
  exportDocx: () => Promise<void>;
  pageCount: number;
  currentPage: number;
  setPageInfo: (pageCount: number, currentPage: number) => void;
}

export const useDocumentStore = create<DocumentStore>((set, get) => ({
  editor: null,
  filePath: null,
  // #103 — every launch opens on the start screen.
  startActive: true,
  hasDocument: false,
  isDirty: false,
  revision: 0,
  pageSetup: defaultPageSetup(),
  pageCount: 1,
  currentPage: 1,
  setPageInfo: (pageCount, currentPage) => set({ pageCount, currentPage }),

  setEditor: (editor) => set({ editor }),
  markDirty: () => set((state) => ({ isDirty: true, revision: state.revision + 1 })),
  setPageSetup: (pageSetup) => set({ pageSetup, isDirty: true }),
  pageStyles: {},
  setPageStyles: (pageStyles) => set({ pageStyles, isDirty: true }),
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
    const { editor, filePath, pageSetup, pageStyles, lineNumbers, coreProperties, headerFooter } = get();
    if (!editor) return;
    if (!filePath) {
      await get().saveAs();
      return;
    }
    if (isWordPath(filePath)) {
      // In-place: Save writes the Word file at its own path.
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
    await saveDocument(editor, filePath, {
      pageSetup,
      pageStyles,
      lineNumbers,
      coreProperties,
      headerFooter,
      // Threads read fresh from the comment store at save time.
      commentThreads: useCommentStore.getState().threadsForSave(),
    });
    await clearRecoveryCopy(filePath);
    set({ isDirty: false });
  },

  saveAs: async () => {
    const { editor, filePath, pageSetup, pageStyles, lineNumbers, coreProperties, headerFooter } = get();
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
    await saveDocument(editor, path, {
      pageSetup,
      pageStyles,
      lineNumbers,
      coreProperties,
      headerFooter,
      commentThreads: useCommentStore.getState().threadsForSave(),
    });
    await clearRecoveryCopy(filePath);
    set({ filePath: path, isDirty: false });
  },

  exportMarkdown: async () => {
    const { editor, filePath } = get();
    if (!editor) return;
    try {
      const { watermark } = get().pageSetup;
      await exportMarkdownFile(editor.getJSON(), {
        defaultPath: markdownDefaultPath(filePath),
        hasWatermark: watermark != null && watermark.kind != null,
      });
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

  // #103 — the start screen over the loaded doc; it stays mounted and
  // hidden (never discarded — the next create/open snapshots it if dirty).
  goHome: () => set({ startActive: true }),
  returnToDocument: () => set({ startActive: false }),

  // #103 — the doc saves FIRST (in place when it has a home; the recovery
  // snapshot when untitled), then the store resets to a no-document state.
  // Home never leaves (startActive untouched).
  saveAndClose: async () => {
    const { editor, filePath, isDirty, pageSetup, lineNumbers, coreProperties, headerFooter } = get();
    if (!editor) return;
    if (isDirty) {
      if (filePath) {
        await get().save();
      } else {
        await saveRecoveryCopy(editor, filePath, {
          pageSetup,
          lineNumbers,
          coreProperties,
          headerFooter,
          commentThreads: useCommentStore.getState().threadsForSave(),
        });
      }
    }
    editor.commands.clearContent();
    editor.commands.setContent('<p>Start typing…</p>');
    set({
      hasDocument: false,
      filePath: null,
      isDirty: false,
      pageSetup: defaultPageSetup(),
      pageStyles: {},
      lineNumbers: null,
      coreProperties: normalizeCoreProperties({
        author: useConfigStore.getState().config.identity.author,
      }),
      headerFooter: null,
    });
  },

  // #103 — a dirty current doc snapshots first, then the SAME hydration
  // openFile's success path runs (comments before content), then the
  // consumed snapshot clears.
  restoreRecovery: async (recoveryPath) => {
    const { editor } = get();
    if (!editor) return;
    if (get().isDirty) {
      const { filePath, pageSetup, lineNumbers, coreProperties, headerFooter } = get();
      await saveRecoveryCopy(editor, filePath, {
        pageSetup,
        lineNumbers,
        coreProperties,
        headerFooter,
        commentThreads: useCommentStore.getState().threadsForSave(),
      });
    }
    try {
      const file = await readRecoveryCopy(recoveryPath);
      // Hydrate BEFORE setContent or the tracking janitor eats the fresh anchors.
      useCommentStore.getState().hydrate(file.metadata.commentThreads ?? []);
      editor.commands.setContent(file.docJSON);
      // The legacy snapshot shape migrates exactly like an opened file.
      const metaHF = file.metadata.headerFooter as unknown;
      if (isLegacyHeaderFooter(metaHF)) {
        migrateLegacyHeaderFooter(editor, metaHF);
      }
      // Legacy dim-less images backfill (fire-and-forget).
      void import('@/lib/media/backfill').then(({ backfillImageDims }) =>
        backfillImageDims(editor),
      );
      useStyleRegistryStore
        .getState()
        .applyDocLayer(file.metadata.styles?.definitions ?? []);
      const settings: HeaderFooterSettings | null = isLegacyHeaderFooter(metaHF)
        ? { scope: { kind: 'document' }, differentFirstPage: metaHF.differentFirstPage === true }
        : (metaHF as HeaderFooterSettings | null) ?? null;
      set({
        startActive: false,
        hasDocument: true,
        // The back-pointer becomes the live path: Save continues in
        // place (an untitled draft stays untitled — saveAs owns it).
        filePath: file.metadata.originalPath ?? null,
        isDirty: true,
        pageSetup: file.metadata.pageSetup ?? defaultPageSetup(),
        pageStyles: file.metadata.pageStyles ?? {},
        lineNumbers: file.metadata.lineNumbers ?? null,
        coreProperties: normalizeCoreProperties(file.metadata),
        headerFooter: settings,
      });
      // The snapshot is consumed (it IS the live doc now).
      await remove(recoveryPath);
    } catch (err) {
      await message(err instanceof Error ? err.message : 'Failed to restore document', {
        title: 'Error',
        kind: 'error',
      });
    }
  },

  // #103 — a dirty current doc is recovery-snapshotted first (no confirm
  // dialog — the recovery dir is the safety net), then the store resets to
  // a fresh doc and the content lands (starter HTML or the placeholder).
  newDocument: async (viewMode, templateHtml) => {
    const { editor, filePath, isDirty, pageSetup, lineNumbers, coreProperties, headerFooter } = get();
    if (editor && isDirty) {
      await saveRecoveryCopy(editor, filePath, {
        pageSetup,
        lineNumbers,
        coreProperties,
        headerFooter,
        commentThreads: useCommentStore.getState().threadsForSave(),
      });
    }
    if (filePath) await clearRecoveryCopy(filePath);
    if (editor) {
      if (templateHtml) {
        editor.commands.setContent(templateHtml);
      } else {
        editor.commands.clearContent();
        // The placeholder the Editor boots with (the same fresh-doc
        // look a brand-new file gets).
        editor.commands.setContent('<p>Start typing…</p>');
      }
      editor.commands.focus();
    }
    set({
      startActive: false,
      hasDocument: true,
      filePath: null,
      isDirty: false,
      pageSetup: { ...defaultPageSetup(), viewMode },
      // Fresh-doc metadata: no per-page styles, no line numbers, no bands.
      pageStyles: {},
      lineNumbers: null,
      coreProperties: normalizeCoreProperties({}),
      headerFooter: null,
    });
  },

  openFile: async (path) => {
    const { editor } = get();
    if (!editor) return;
    // #103 — the dirty guard: unsaved work in the CURRENT doc survives the
    // switch (a recovery snapshot, not a confirm). Snapshotted BEFORE the
    // open; a cancelled picker leaves one harmless extra snapshot.
    if (get().isDirty) {
      const { filePath, pageSetup, lineNumbers, coreProperties, headerFooter } = get();
      await saveRecoveryCopy(editor, filePath, {
        pageSetup,
        lineNumbers,
        coreProperties,
        headerFooter,
        commentThreads: useCommentStore.getState().threadsForSave(),
      });
    }
    try {
      const result = await openDocument(editor, path);
      if (result) {
        // The opened file's doc layer replaces the previous document's
        // (the epoch bump relayouts both modes).
        useStyleRegistryStore.getState().applyDocLayer(result.styleDefinitions);
        // #103 — a real file opened: leave the start screen + record
        // the recent (markdown imports carry no file — no recent).
        if (result.path) {
          useConfigStore
            .getState()
            .noteRecentDocument(result.path, result.path.split('/').pop() ?? result.path);
        }
        set({
          startActive: false,
          hasDocument: true,
          filePath: result.path,
          // A markdown import carries real content with no file behind
          // it — unsaved work (and the pristine-config subscription
          // won't reset the page setup under it). A file open is clean.
          isDirty: result.path === null,
          pageSetup: result.pageSetup ?? defaultPageSetup(),
          // #48 — absent = no per-page styles (old files open clean).
          pageStyles: result.pageStyles ?? {},
          lineNumbers: result.lineNumbers ?? null,
          // Normalized in openDocument — {} for old files.
          coreProperties: result.coreProperties,
          // Null = the file predates/never enabled them; the headerFooter
          // store re-syncs its editor instances off this write.
          headerFooter: result.headerFooter,
        });
        // One in-app report dialog naming what changed, after the content lands.
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
      // #103 — a failed recent open drops the stale entry (the list
      // only lists what opens).
      if (path) useConfigStore.getState().removeRecentDocument(path);
      await message(err instanceof Error ? err.message : 'Failed to open document', {
        title: 'Error',
        kind: 'error',
      });
    }
  },
}));

// The store is created at module init, before the persisted config.json
// loads — the initial pageSetup captures pre-load defaults. Re-derive it
// on config change, but only while the document is pristine.
useConfigStore.subscribe(() => {
  const { filePath, isDirty } = useDocumentStore.getState();
  if (!filePath && !isDirty) {
    // A pristine document's author defaults from the app's user identity
    // (Settings > General > User); once saved or edited, the document owns
    // its properties.
    const { author } = useConfigStore.getState().config.identity;
    useDocumentStore.setState({
      pageSetup: defaultPageSetup(),
      coreProperties: author ? { author } : {},
    });
  }
});
