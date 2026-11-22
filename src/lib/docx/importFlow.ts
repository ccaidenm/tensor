import { readFile } from '@tauri-apps/plugin-fs';
import { unzipSync } from 'fflate';
import { useImportOptionsDialogStore } from '@/components/dialogs/ImportOptionsDialog';
import { useMediaStore } from '@/lib/media/store';
import {
  collectFontFamilies,
  docxImportNoticeLines,
  ingestDocxMedia,
  mapDocxDocument,
  parseDocxTrees,
} from './import';
import type { PageSetup } from '@/lib/document/pageSetup';
import type { HeaderFooterSettings } from '@/lib/document/headerFooter';
import type { LineNumbersSetting } from '@/lib/document/schema';
import type { DocumentCoreProperties } from '@/lib/document/coreProperties';
import type { StyleDefinition } from '@/lib/styles/types';
import type { JSONContent } from '@tiptap/core';

/**
 * The DOCX import flow: read → unzip → parse → the font choice (the
 * dialog fires only for out-of-catalog families) → media ingest → the
 * inverse mapping → the result with its notices.
 */

export interface DocxImportResult {
  json: JSONContent;
  pageSetup: PageSetup;
  styleDefinitions: StyleDefinition[];
  coreProperties: DocumentCoreProperties;
  headerFooter: HeaderFooterSettings;
  lineNumbers: LineNumbersSetting | null;
  /** The title from core properties, or the filename. */
  title: string;
  /** Import notices — surfaced by the open path as one notice. */
  notices: string[];
}

export async function importDocxFile(path: string, titleFallback: string): Promise<DocxImportResult> {
  const bytes = await readFile(path);
  const parts = unzipSync(new Uint8Array(bytes));
  const trees = parseDocxTrees(parts);

  const { unknown } = collectFontFamilies(trees);
  const fontPolicy = unknown.length
    ? await useImportOptionsDialogStore.getState().requestFontPolicy(unknown)
    : 'keep';

  const { partToId, entries } = await ingestDocxMedia(parts);
  const mediaStore = useMediaStore.getState();
  for (const entry of entries) mediaStore.add(entry.id, entry.ext, entry.bytes);

  const parsed = mapDocxDocument(trees, { fontPolicy, mediaPartToId: partToId });

  return {
    json: parsed.json,
    pageSetup: parsed.pageSetup,
    styleDefinitions: parsed.styleDefinitions,
    coreProperties: parsed.coreProperties,
    headerFooter: parsed.headerFooter,
    lineNumbers: parsed.lineNumbers,
    title: parsed.coreProperties.title ?? titleFallback,
    notices: docxImportNoticeLines(parsed.report),
  };
}
