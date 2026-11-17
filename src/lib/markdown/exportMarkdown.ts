import { save } from '@tauri-apps/plugin-dialog';
import { mkdir, writeFile, writeTextFile } from '@tauri-apps/plugin-fs';
import type { JSONContent } from '@tiptap/core';
import { useMediaStore } from '@/lib/media/store';
import { useExportConfirmDialogStore } from '@/components/dialogs/ExportConfirmDialog';
import { useImportReportDialogStore } from '@/components/dialogs/ImportReportDialog';
import { jsonToMarkdown } from './manager';
import { analyzeMarkdownLossy, hasLossyContent, markdownLossyLines } from './lossy';
import { baseName, dirName, joinPath, stripExt } from './paths';

/**
 * M-MD — the export flow. Ruling 2: the lossy confirm gates the save
 * dialog — a document carrying unrepresentable content gets the
 * warning FIRST (the in-app shadcn dialog — the developer-mode
 * warning's spelling), and cancelling never opens the dialog at all.
 * The warning REPLACES any post-export summary (the user already
 * agreed to exactly the losses listed).
 *
 * Image refs go out as `media://<sha256>` placeholders from the
 * serializer; inlineMediaAssets rewrites them to
 * `./<name>.assets/<sha>.<ext>` and writes the referenced bytes
 * (content-addressed, deduped, only ids the markdown actually cites).
 * A placeholder whose MediaStore entry is missing (a stale reference
 * the document no longer has bytes for) stays verbatim and is counted.
 */

export type ExportMarkdownOutcome = 'exported' | 'cancelled' | null;

const MEDIA_REF = /media:\/\/([0-9a-f]{64})/g;

/** The save dialog's default: the open document's name with a .md
 *  tail, or Untitled.md. */
export function markdownDefaultPath(filePath: string | null): string {
  if (!filePath) return 'Untitled.md';
  return `${stripExt(baseName(filePath))}.md`;
}

export async function exportMarkdownFile(
  json: JSONContent,
  options: {
    defaultPath: string;
    /** #WATERMARK — the doc-level watermark flag (a store fact; the
     *  docJSON the classifier walks cannot see it). */
    hasWatermark?: boolean;
  },
): Promise<ExportMarkdownOutcome> {
  // THE GATE (ruling 2): classify BEFORE the dialog; the in-app shadcn
  // confirm parks the report and the dialog's buttons settle the
  // promise. Cancel = no save dialog, no file, no partial state.
  const report = analyzeMarkdownLossy(json, options.hasWatermark === true);
  if (hasLossyContent(report)) {
    const proceed = await useExportConfirmDialogStore.getState().requestConfirm({
      title: 'Export Markdown?',
      lines: markdownLossyLines(report),
    });
    if (!proceed) return 'cancelled';
  }

  const path = await save({
    filters: [{ name: 'Markdown', extensions: ['md'] }],
    defaultPath: options.defaultPath,
  });
  if (!path) return null;

  const { markdown: finalMarkdown, missing } = await inlineMediaAssets(jsonToMarkdown(json), path);
  await writeTextFile(path, finalMarkdown);

  if (missing > 0) {
    // The loud surface is the in-app report dialog (never a native popup).
    useImportReportDialogStore.getState().show({
      title: 'Export Markdown',
      lines: [
        `${missing} image${missing === 1 ? ' reference was' : ' references were'} left as placeholders — the image data is no longer in this session.`,
      ],
    });
  }
  return 'exported';
}

/** Rewrite media:// placeholders to asset-folder paths and write the
 *  cited bytes. Returns the final markdown and the missing-media count. */
async function inlineMediaAssets(
  markdown: string,
  mdPath: string,
): Promise<{ markdown: string; missing: number }> {
  const ids = new Set<string>();
  for (const match of markdown.matchAll(MEDIA_REF)) ids.add(match[1]!);
  if (ids.size === 0) return { markdown, missing: 0 };

  const entries = useMediaStore.getState().entries;
  const assetsName = `${stripExt(baseName(mdPath))}.assets`;
  const assetDir = joinPath(dirName(mdPath), assetsName);
  await mkdir(assetDir, { recursive: true });

  let missing = 0;
  for (const id of ids) {
    const entry = entries.get(id);
    if (!entry) {
      missing += 1;
      continue;
    }
    await writeFile(joinPath(assetDir, `${id}.${entry.ext}`), entry.bytes);
  }

  const finalMarkdown = markdown.replace(MEDIA_REF, (placeholder, id: string) => {
    if (!entries.has(id)) return placeholder; // keep the placeholder verbatim
    // the folder segment is URI-encoded — a destination with a raw
    // space is not a CommonMark link
    return `./${encodeURIComponent(assetsName)}/${id}.${entries.get(id)!.ext}`;
  });
  return { markdown: finalMarkdown, missing };
}
