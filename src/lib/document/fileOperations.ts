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
  // M-DOCX: the Word format rides the same Open flow (#38).
  { name: 'Word Document', extensions: ['docx'] },
];

/**
 * M-META: the ONE document-level bundle that rides .wpdoc metadata.
 * saveDocument, saveDocumentAs and saveRecoveryCopy all take it, and
 * assembleDocumentFile is the ONLY metadata assembly — saves and
 * recovery snapshots can never drift (snapshots used to omit styles).
 */
export interface SaveDocumentOptions {
  pageSetup: PageSetup;
  /** #48 — the per-page styles (the positional map); {} = none. */
  pageStyles?: PageStyles;
  /** M-LINENUMS: absent/null = never set (old docs / gutter off). */
  lineNumbers?: LineNumbersSetting | null;
  /** M-HEADER-FOOTER: absent/null = never enabled (old docs). */
  headerFooter?: HeaderFooterSettings | null;
  /** M-META: written normalized — only non-empty fields land in the
   *  file (the lineNumbers conditional-spread precedent: absent means
   *  "never set", empty strings never write). */
  coreProperties?: DocumentCoreProperties | null;
  /** #COMMENTS — the threads' content half; absent/null when the
   *  document carries none (the lineNumbers precedent). The anchors
   *  ride docJSON (the comment mark); the ids join them in the file. */
  commentThreads?: CommentThread[] | null;
  /** Recovery snapshots only: the snapshot's back-pointer. */
  originalPath?: string | null;
}

/** THE metadata assembly (single source — see SaveDocumentOptions). */
export function assembleDocumentFile(editor: Editor, options: SaveDocumentOptions): DocumentFile {
  const { pageSetup, pageStyles, lineNumbers, headerFooter, coreProperties, commentThreads, originalPath } = options;
  return {
    version: CURRENT_DOCUMENT_VERSION,
    docJSON: editor.getJSON(),
    metadata: {
      modifiedAt: new Date().toISOString(),
      pageSetup,
      // #48 — per-page styles: absent when the map is empty (the
      // optional-field precedent). The numeric keys serialize as JSON
      // strings; normalizePageStyles converts them back on open.
      ...(pageStyles && Object.keys(pageStyles).length > 0 ? { pageStyles } : {}),
      // M-STYLES: the doc layer round-trips verbatim — definitions
      // the file carried (or that were applied to it on open) travel
      // with it; global-layer edits live in styles.json, not here.
      styles: { definitions: useStyleRegistryStore.getState().docLayerForSave() },
      // M-LINENUMS: absent when never set (old docs / gutter off by
      // default) — the styles optional-field precedent.
      ...(lineNumbers ? { lineNumbers } : {}),
      // M-HEADER-FOOTER: same precedent — absent until first enabled.
      ...(headerFooter ? { headerFooter } : {}),
      // #COMMENTS: same precedent — absent until the first thread.
      ...(commentThreads && commentThreads.length > 0 ? { commentThreads } : {}),
      // M-META: absent means "never set" — whitespace-only values
      // drop out (normalizeCoreProperties).
      ...normalizeCoreProperties(coreProperties),
      ...(originalPath ? { originalPath } : {}),
    },
  };
}

/**
 * M-IMAGES-0: .wpdoc v2 — saves write the zip container (the Rust
 * package_document command; ATOMIC temp+rename lives Rust-side now,
 * the old writeDocumentAtomic pattern moved with it). The media set
 * packaged is the document's REFERENCED media only (saveWpdoc's GC).
 */
export async function saveDocument(
  editor: Editor,
  filePath: string,
  options: SaveDocumentOptions,
): Promise<void> {
  await saveWpdoc(filePath, assembleDocumentFile(editor, options));
}

export async function saveDocumentAs(
  editor: Editor,
  options: SaveDocumentOptions,
): Promise<string | null> {
  // WPDOC-ONLY: the store's saveAs dispatches .docx to the Word writer
  // — this legacy helper must never write a zip container into a
  // .docx path.
  const path = await save({ filters: [{ name: 'Word Processor Document', extensions: ['wpdoc'] }], defaultPath: 'Untitled.wpdoc' });
  if (!path) return null;
  await saveDocument(editor, path, options);
  return path;
}

export interface OpenDocumentResult {
  /** The document's path — NULL for a markdown import (M-MD ruling 5:
   *  the doc stays Untitled until Save As — Save must never write a
   *  zip container into the .md the user opened). */
  path: string | null;
  /** M-MD: markdown imports only — images dropped during ingestion
   *  (remote/missing/unreadable). The open path surfaces the count. */
  skippedImages?: number;
  /** M-DOCX: the Word import's loud postures (dropped fields, tracked
   *  changes accepted, refused images...). One notice on open. */
  importNotices?: string[];
  pageSetup: PageSetup | null;
  /** #48 — the file's per-page styles (numeric keys, normalized);
   * {} = the file predates them or carries none. */
  pageStyles: PageStyles;
  /** M-STYLES: the file's doc-layer style definitions (may be empty —
   *  pre-styles files). The document store applies them to the
   *  registry (doc overrides global by id). */
  styleDefinitions: StyleDefinition[];
  /** M-LINENUMS: the file's gutter setting; null = the file predates
   *  it or never enabled it. */
  lineNumbers: LineNumbersSetting | null;
  /** M-META: the file's standard core properties, normalized;
   *  {} = the file predates them. */
  coreProperties: DocumentCoreProperties;
  /** M-HEADER-FOOTER: the file's header/footer settings; null = the
   *  file predates them (or never enabled them) — headers/footers off. */
  headerFooter: HeaderFooterSettings | null;
  /** #COMMENTS — the file's comment threads ([] = predates them or
   *  carries none). ALREADY HYDRATED into the comment store by the
   *  time this returns (the open path hydrates BEFORE setContent —
   *  the load-order law; the media-store precedent). */
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

  // M-MD/M-DOCX: extension dispatch — markdown and Word import through
  // the same Open flow, each with its own result shape.
  const lower = path.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    return openMarkdownDocument(editor, path);
  }
  if (lower.endsWith('.docx')) {
    return openDocxDocument(editor, path);
  }

  // M-IMAGES-0: v2 container — or v1 plain JSON via the PERMANENT
  // converter (openWpdoc detects the NOT_ZIP marker). Corrupted files
  // throw here; the store's open path surfaces the LOUD error dialog
  // (never a crash, never silent loss — the corrupted→defaults
  // posture's document-side spelling).
  const file = await openWpdoc(path);

  // #COMMENTS — THE LOAD-ORDER LAW: hydrate BEFORE setContent. The
  // tracking plugin's janitor strips marks whose threadId has no store
  // record; a late hydrate would destroy the freshly-loaded document's
  // anchors. (The media-store precedent: openV2 feeds the MediaStore
  // during open.)
  useCommentStore.getState().hydrate(file.metadata.commentThreads ?? []);
  editor.commands.setContent(file.docJSON);
  // M-HEADER-FOOTER-2: the v1→v2 migration — a legacy metadata shape's
  // per-region content docs translate into doc-level band containers
  // (content rides docJSON now). The differentFirstPage flag rides the
  // settings below; enabling without content has no v2 spelling.
  const metaHF = file.metadata.headerFooter as unknown;
  if (isLegacyHeaderFooter(metaHF)) {
    migrateLegacyHeaderFooter(editor, metaHF);
  }
  // M-IMAGES-1: legacy dim-less images backfill (measure → write attrs
  // → the standard PM-update relayout; see media/backfill.ts for the
  // lineage note). Fire-and-forget — pending images stay in the
  // pageless fallback until the dims land.
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

/**
 * M-MD — the markdown open path (ruling 5): parse + ingest OUTSIDE the
 * editor, then setContent. The format carries no page setup, styles,
 * line numbers or bands — defaults apply; the title is the filename.
 * path is NULL (Untitled until Save As) and skippedImages rides back
 * for the loud notice. The dynamic import keeps marked out of the
 * startup path (the same lazy pattern the backfill uses).
 */
/** The Save-As surface: Tensor's own format OR Word's — markdown is
 *  deliberately absent (an export-only format; saving a document as
 *  .md would be lossy on every save). The chosen extension decides
 *  the writer. */
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
 * M-DOCX — the Word open path (#38a + the in-place ruling): unzip →
 * parse → the font choice (the ImportOptionsDialog fires only for
 * out-of-catalog families) → the inverse mapping → setContent. The
 * doc's OWN settings travel (pageSetup/styles/bands/line numbers/core
 * properties), and the .docx file is ADOPTED — filePath becomes the
 * Word file, so Save writes it in place (the save dispatch owns that
 * path; opening a Word document is opening a document).
 */
async function openDocxDocument(editor: Editor, path: string): Promise<OpenDocumentResult> {
  const { importDocxFile } = await import('@/lib/docx/importFlow');
  const name = path.split(/[\\/]/).pop() ?? 'Untitled';
  const result = await importDocxFile(path, name.replace(/\.docx$/i, ''));
  // #COMMENTS — the load-order law (the wpdoc path's comment): a Word
  // file carries no Tensor threads until the comments.xml importer
  // lands; hydrate empty so the previous document's threads never
  // survive as ghosts.
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
    // #COMMENTS: the DOCX importer fills this in a follow-up commit.
    commentThreads: [],
  };
}

async function openMarkdownDocument(editor: Editor, path: string): Promise<OpenDocumentResult> {
  const { importMarkdown } = await import('@/lib/markdown/importMarkdown');
  const { json, skippedImages } = await importMarkdown(path);
  // #COMMENTS — the load-order law: markdown carries no threads (the
  // documented exclusion), so this is also the stale-state wipe — the
  // previously-open document's threads must never survive as ghosts.
  useCommentStore.getState().hydrate([]);
  editor.commands.setContent(json);
  // M-IMAGES-1: markdown carries no dimensions — the standard dim
  // backfill measures them (the same fire-and-forget pass above).
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
