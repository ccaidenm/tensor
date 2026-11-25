import { save, open } from '@tauri-apps/plugin-dialog';
import type { Editor } from '@tiptap/core';
import { CURRENT_DOCUMENT_VERSION, type DocumentFile, type LineNumbersSetting } from './schema';
import type { PageSetup } from './pageSetup';
import { normalizePageStyles, type PageStyles } from './pageSetup';
import { useStyleRegistryStore } from '@/lib/styles/registry';
import type { StyleDefinition } from '@/lib/styles/types';
import { normalizeCoreProperties, type DocumentCoreProperties } from './coreProperties';
import { openWpdoc, saveWpdoc } from './wpdoc';
import { isLegacyHeaderFooter, type HeaderFooterSettings } from './headerFooter';
import { migrateLegacyHeaderFooter } from '@/lib/editor/headerFooterCommands';
import { useCommentStore, type CommentThread } from '@/lib/comments/store';

const FILE_FILTERS = [
  { name: 'Word Processor Document', extensions: ['wpdoc'] },
  { name: 'Markdown', extensions: ['md', 'markdown'] },
  // #38 — the Word format rides the same Open flow.
  { name: 'Word Document', extensions: ['docx'] },
];

/**
 * The document-level bundle that rides .wpdoc metadata.
 * assembleDocumentFile is the ONLY metadata assembly — saves and
 * recovery snapshots can never drift.
 */
export interface SaveDocumentOptions {
  pageSetup: PageSetup;
  /** #48 — the per-page styles (the positional map); {} = none. */
  pageStyles?: PageStyles;
  /** Line numbers: absent/null = never set (old docs / gutter off). */
  lineNumbers?: LineNumbersSetting | null;
  /** Header/footer settings: absent/null = never enabled (old docs). */
  headerFooter?: HeaderFooterSettings | null;
  /** Written normalized — only non-empty fields land in the file;
   *  absent means "never set", empty strings never write. */
  coreProperties?: DocumentCoreProperties | null;
  /** Comment threads' content half (the anchors ride docJSON as
   *  comment marks); absent/null when the document carries none. */
  commentThreads?: CommentThread[] | null;
  /** Recovery snapshots only: the snapshot's back-pointer. */
  originalPath?: string | null;
}

/** The one metadata assembly (see SaveDocumentOptions). */
export function assembleDocumentFile(editor: Editor, options: SaveDocumentOptions): DocumentFile {
  const { pageSetup, pageStyles, lineNumbers, headerFooter, coreProperties, commentThreads, originalPath } = options;
  return {
    version: CURRENT_DOCUMENT_VERSION,
    docJSON: editor.getJSON(),
    metadata: {
      modifiedAt: new Date().toISOString(),
      pageSetup,
      // #48 — per-page styles: absent when empty; numeric keys serialize
      // as JSON strings and normalizePageStyles converts back on open.
      ...(pageStyles && Object.keys(pageStyles).length > 0 ? { pageStyles } : {}),
      // Doc-layer styles round-trip verbatim; global-layer edits live
      // in styles.json, not here.
      styles: { definitions: useStyleRegistryStore.getState().docLayerForSave() },
      // Absent when never set (old docs / gutter off by default).
      ...(lineNumbers ? { lineNumbers } : {}),
      // Absent until first enabled.
      ...(headerFooter ? { headerFooter } : {}),
      // Absent until the first thread.
      ...(commentThreads && commentThreads.length > 0 ? { commentThreads } : {}),
      // normalizeCoreProperties drops whitespace-only values (absent = never set).
      ...normalizeCoreProperties(coreProperties),
      ...(originalPath ? { originalPath } : {}),
    },
  };
}

/**
 * .wpdoc v2: saves write the zip container via the Rust
 * package_document command (atomic temp+rename Rust-side). The media
 * packaged is the document's referenced media only (saveWpdoc's GC).
 */
export async function saveDocument(
  editor: Editor,
  filePath: string,
  options: SaveDocumentOptions,
): Promise<void> {
  await saveWpdoc(filePath, assembleDocumentFile(editor, options));
}

export interface OpenDocumentResult {
  /** NULL for a markdown import: the doc stays Untitled until Save As —
   *  Save must never write a zip container into the .md the user opened. */
  path: string | null;
  /** Markdown imports only — images dropped during ingestion
   *  (remote/missing/unreadable). The open path surfaces the count. */
  skippedImages?: number;
  /** DOCX import notices (dropped fields, tracked changes accepted,
   *  refused images); shown once on open. */
  importNotices?: string[];
  pageSetup: PageSetup | null;
  /** #48 — the file's per-page styles (numeric keys, normalized);
   *  {} = the file predates them or carries none. */
  pageStyles: PageStyles;
  /** Doc-layer style definitions; the store applies them to the
   *  registry (doc overrides global by id). */
  styleDefinitions: StyleDefinition[];
  /** The file's gutter setting; null = predates it or never enabled. */
  lineNumbers: LineNumbersSetting | null;
  /** Core properties, normalized; {} = the file predates them. */
  coreProperties: DocumentCoreProperties;
  /** Header/footer settings; null = the file predates them —
   *  headers/footers off. */
  headerFooter: HeaderFooterSettings | null;
  /** The file's comment threads — already hydrated into the comment
   *  store when this returns (the open path hydrates before setContent). */
  commentThreads: CommentThread[];
}

export async function openDocument(
  editor: Editor,
  /** #103 — the recents pass a known path (no dialog); absent = the
   *  picker (the ribbon/palette flows). */
  knownPath?: string,
): Promise<OpenDocumentResult | null> {
  const path =
    knownPath ??
    (await open({ filters: FILE_FILTERS, multiple: false }) as string | null);
  if (!path || Array.isArray(path)) return null;

  // Extension dispatch: markdown and Word import through the same Open flow.
  const lower = path.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    return openMarkdownDocument(editor, path);
  }
  if (lower.endsWith('.docx')) {
    return openDocxDocument(editor, path);
  }

  // v2 container — or v1 plain JSON via the permanent converter
  // (openWpdoc detects the NOT_ZIP marker). Corrupted files throw
  // here; the store surfaces the error dialog (never silent loss).
  const file = await openWpdoc(path);

  // Hydrate BEFORE setContent: the tracking plugin's janitor strips
  // marks whose threadId has no store record — a late hydrate would
  // destroy the freshly-loaded document's anchors.
  useCommentStore.getState().hydrate(file.metadata.commentThreads ?? []);
  editor.commands.setContent(file.docJSON);
  // The v1→v2 migration: legacy per-region content docs translate into
  // doc-level band containers; differentFirstPage rides the settings below.
  const metaHF = file.metadata.headerFooter as unknown;
  if (isLegacyHeaderFooter(metaHF)) {
    migrateLegacyHeaderFooter(editor, metaHF);
  }
  // Legacy dim-less images backfill — fire-and-forget (see media/backfill.ts).
  void import('@/lib/media/backfill').then(({ backfillImageDims }) =>
    backfillImageDims(editor),
  );
  const { title, author, subject, keywords, comments } = file.metadata;
  const settings: HeaderFooterSettings | null = isLegacyHeaderFooter(metaHF)
    ? {
        scope: { kind: 'document' },
        differentFirstPage: metaHF.differentFirstPage === true,
      }
    : (metaHF as HeaderFooterSettings | null) ?? null;
  return {
    path,
    pageSetup: file.metadata.pageSetup ?? null,
    pageStyles: normalizePageStyles(file.metadata.pageStyles as Record<string, unknown> | undefined),
    styleDefinitions: file.metadata.styles?.definitions ?? [],
    lineNumbers: file.metadata.lineNumbers ?? null,
    coreProperties: normalizeCoreProperties({ title, author, subject, keywords, comments }),
    headerFooter: settings,
    commentThreads: file.metadata.commentThreads ?? [],
  };
}

/** The Save-As surface: .wpdoc or .docx — markdown is export-only
 *  (saving as .md would be lossy on every save); the chosen extension
 *  decides the writer. */
const SAVE_AS_FILTERS = [
  { name: 'Word Processor Document', extensions: ['wpdoc'] },
  { name: 'Word Document', extensions: ['docx'] },
];

/** The Save-As dialog's path (the caller dispatches on the extension). */
export async function chooseSavePath(defaultName: string): Promise<string | null> {
  return save({ filters: SAVE_AS_FILTERS, defaultPath: defaultName });
}

/** The default Save-As name for the current document (its own
 *  extension preserved; Untitled docs default to Tensor's format). */
export function saveAsDefaultName(filePath: string | null): string {
  if (!filePath) return 'Untitled.wpdoc';
  return filePath.split(/[\\/]/).pop() ?? 'Untitled.wpdoc';
}

/**
 * The Word open path (#38): unzip → parse → the font choice (the
 * ImportOptionsDialog fires only for out-of-catalog families) → the
 * inverse mapping → setContent. The .docx file is adopted — filePath
 * becomes the Word file, so Save writes it in place.
 */
async function openDocxDocument(editor: Editor, path: string): Promise<OpenDocumentResult> {
  const { importDocxFile } = await import('@/lib/docx/importFlow');
  const name = path.split(/[\\/]/).pop() ?? 'Untitled';
  const result = await importDocxFile(path, name.replace(/\.docx$/i, ''));
  // A Word file carries no Tensor threads; hydrate empty so the previous
  // document's threads never survive as ghosts.
  useCommentStore.getState().hydrate([]);
  editor.commands.setContent(result.json);
  return {
    path,
    pageSetup: result.pageSetup,
    // DOCX has no per-page style spelling — the map opens empty.
    pageStyles: {},
    styleDefinitions: result.styleDefinitions,
    lineNumbers: result.lineNumbers,
    coreProperties: normalizeCoreProperties({ ...result.coreProperties, title: result.title }),
    headerFooter: result.headerFooter,
    importNotices: result.notices,
    commentThreads: [],
  };
}

async function openMarkdownDocument(editor: Editor, path: string): Promise<OpenDocumentResult> {
  const { importMarkdown } = await import('@/lib/markdown/importMarkdown');
  const { json, skippedImages } = await importMarkdown(path);
  // Markdown carries no threads; hydrate empty so the previous document's
  // threads never survive as ghosts.
  useCommentStore.getState().hydrate([]);
  editor.commands.setContent(json);
  // Markdown carries no image dimensions — the standard backfill measures them.
  void import('@/lib/media/backfill').then(({ backfillImageDims }) =>
    backfillImageDims(editor),
  );
  const name = path.split(/[\\/]/).pop() ?? 'Untitled';
  return {
    path: null,
    pageSetup: null,
    // Markdown carries no document setup at all — page styles open empty.
    pageStyles: {},
    styleDefinitions: [],
    lineNumbers: null,
    coreProperties: { title: name.replace(/\.(md|markdown)$/i, '') },
    headerFooter: null,
    skippedImages,
    // Markdown carries no comment threads (the documented exclusion).
    commentThreads: [],
  };
}
