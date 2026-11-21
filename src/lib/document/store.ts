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
  /**
   * #48 — the per-page styles (the positional map; the PageSetup
   * comment block in pageSetup.ts is the ruling). {} = none. Writing
   * marks the doc dirty — travels in .wpdoc metadata like pageSetup.
   * NOT inside PageSetup on purpose: setups serialize onto section
   * breaks wholesale, and a page-index map must never ride one.
   */
  pageStyles: PageStyles;
  setPageStyles: (pageStyles: PageStyles) => void;
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
  /** #103 — the optional path (the start screen's recents pass one;
   *  absent = the picker dialog). */
  openFile: (path?: string) => Promise<void>;
  /** #103 — TRUE while the start screen owns the window (every launch
   *  opens on Home; creating/opening a document leaves it — and the
   *  Tensor menu's Home item returns). */
  startActive: boolean;
  /** #103 — TRUE once a document exists this session (Home's "Return
   *  to document" is gated on it; a doc STAYS LOADED underneath Home
   *  — going Home never discards). */
  hasDocument: boolean;
  /** #103 — the Tensor menu's Home item: the start screen over the
   *  loaded doc (which stays mounted/hidden — nothing is discarded). */
  goHome: () => void;
  /** #103 — Home's return path: back to the doc that never left. */
  returnToDocument: () => void;
  /** #103 — Home's "Save & close" card: the doc saves (in place when
   *  it has a home; the recovery net when untitled — honestly labeled
   *  "Close" there) and RESETS, so a new doc begins immediately. Home
   *  stays (startActive untouched). */
  saveAndClose: () => Promise<void>;
  /** #103 — restore a recovery snapshot (the start screen's pinned
   *  unsaved-work cards): the same hydration as openFile's success
   *  path, then the consumed snapshot clears (the net becomes the
   *  live doc). A dirty current doc snapshots first (the guard law). */
  restoreRecovery: (recoveryPath: string) => Promise<void>;
  /** #103 — create a fresh document (the registry's New, the start
   *  screen's blank/template cards): viewMode explicit (the two blank
   *  cards), optional starter HTML. A dirty current doc is snapshotted
   *  to recovery first (the quit law — the work survives the switch). */
  newDocument: (viewMode: 'pages' | 'pageless', templateHtml?: string) => Promise<void>;
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
  // #103 — every launch opens on the start screen (the Word/GDocs
  // posture: Home until a document exists).
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
    await saveDocument(editor, filePath, {
      pageSetup,
      pageStyles,
      lineNumbers,
      coreProperties,
      headerFooter,
      // #COMMENTS: the threads ride .wpdoc metadata (the lineNumbers
      // precedent) — read fresh from the comment store at save time.
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

  // #103 — HOME: the start screen over the loaded doc. The doc stays
  // mounted and hidden (the view-state law — going Home never
  // discards; the next create/open snapshots it if dirty).
  goHome: () => set({ startActive: true }),
  returnToDocument: () => set({ startActive: false }),

  // #103 — SAVE & CLOSE: the start screen's fresh-start card. The doc
  // saves FIRST (in place when it has a home; the recovery snapshot
  // when untitled — the same net quit/new use, why the card reads
  // just "Close" there), then the editor resets to the fresh
  // placeholder and the store drops to a no-document state: the New
  // cards are one click away. Home never leaves (startActive
  // untouched — the card lives ON the start screen).
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
      coreProperties: normalizeCoreProperties({}),
      headerFooter: null,
    });
  },

  // #103 — RESTORE RECOVERY: the pinned unsaved-work card's action.
  // The guard law first (a dirty current doc snapshots), then the
  // SAME hydration openFile's success path runs (the load-order law:
  // comments before content), then the store takes the restored doc
  // and the consumed snapshot clears — the net BECAME the live doc.
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
      // #COMMENTS — the load-order law (openDocument's): hydrate
      // BEFORE setContent or the janitor eats the fresh anchors.
      useCommentStore.getState().hydrate(file.metadata.commentThreads ?? []);
      editor.commands.setContent(file.docJSON);
      // M-HEADER-FOOTER-2: the legacy snapshot shape migrates exactly
      // like an opened file (the openDocument twin).
      const metaHF = file.metadata.headerFooter as unknown;
      if (isLegacyHeaderFooter(metaHF)) {
        migrateLegacyHeaderFooter(editor, metaHF);
      }
      // M-IMAGES-1: legacy dim-less images backfill (fire-and-forget —
      // pending images stay in the pageless fallback until the dims land).
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

  // #103 — NEW DOCUMENT: the registry's New, the start screen's
  // blank/template cards. A DIRTY current doc is snapshotted to
  // recovery first (the quit law: unsaved work survives the switch —
  // no confirm dialog, the recovery dir IS the safety net); then the
  // store resets to a fresh doc (defaults + the chosen view mode) and
  // the content lands (starter HTML or the empty placeholder).
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
      // Fresh-doc metadata: no per-page styles, no line numbers, the
      // identity-seeded core properties, no bands.
      pageStyles: {},
      lineNumbers: null,
      coreProperties: normalizeCoreProperties({}),
      headerFooter: null,
    });
  },

  openFile: async (path) => {
    const { editor } = get();
    if (!editor) return;
    // #103 — THE DIRTY GUARD (the newDocument law): unsaved work in
    // the CURRENT doc survives the switch (a recovery snapshot, not a
    // confirm — the same safety net quit/new use; this also closed
    // the pre-existing Ctrl+O window). Snapshotted BEFORE the open
    // (openDocument replaces the content in-place); a cancelled picker
    // leaves the still-open doc with one harmless extra snapshot.
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
        // M-STYLES: the opened file's doc layer replaces whatever the
        // previous document carried (doc overrides global by id at
        // merge; the epoch bump relayouts both modes).
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
          // M-MD: a MARKDOWN import carries real content with no file
          // behind it — unsaved work (it also keeps the pristine-config
          // subscription from resetting the page setup under it). A
          // .wpdoc or .docx open is clean: the file IS the document.
          isDirty: result.path === null,
          pageSetup: result.pageSetup ?? defaultPageSetup(),
          // #48 — absent = no per-page styles (old files open clean).
          pageStyles: result.pageStyles ?? {},
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
      // #103 — a failed RECENT open (the path was passed) drops the
      // stale entry — the list stays honest about what opens.
      if (path) useConfigStore.getState().removeRecentDocument(path);
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
