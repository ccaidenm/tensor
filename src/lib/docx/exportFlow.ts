import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { useExportConfirmDialogStore } from '@/components/dialogs/ExportConfirmDialog';
import { buildDocx, docxReportLines, type DocxExportInput } from './export';
import { baseName, stripExt } from '@/lib/markdown/paths';

/**
 * M-DOCX — the DOCX export flow: build (the mapping, fully tested) →
 * the lossy confirm gate (ruling 2's posture — the SAME in-app shadcn
 * dialog the markdown flow uses, now generalized) → save dialog →
 * write. Never mutates filePath/isDirty — an export is a copy.
 *
 * The gate fires only when the report carries losses; a document whose
 * content maps 1:1 exports with NO dialog (the classifier decides,
 * never a hardcoded list of file types).
 */

export type ExportDocxOutcome = 'exported' | 'cancelled' | null;

/** The save dialog's default: the open document's name with a .docx
 *  tail, or Untitled.docx. */
export function docxDefaultPath(filePath: string | null): string {
  if (!filePath) return 'Untitled.docx';
  return `${stripExt(baseName(filePath))}.docx`;
}

/** THE IN-PLACE SAVE (the user's vision): write the Word file at ITS
 *  OWN path — no dialog, the document's file IS the target. The lossy
 *  gate still runs (a document carrying unrepresentable content gets
 *  the shadcn confirm before bytes land — cancelling leaves the file
 *  and the dirty state untouched). */
export async function saveDocxToPath(
  input: DocxExportInput,
  path: string,
  opts: { confirmLosses?: boolean } = {},
): Promise<'saved' | 'cancelled'> {
  const { bytes, report } = await buildDocx(input);
  if (opts.confirmLosses !== false) {
    const lines = docxReportLines(report);
    if (lines.length > 0) {
      const proceed = await useExportConfirmDialogStore.getState().requestConfirm({
        title: 'Save as Word?',
        lines,
      });
      if (!proceed) return 'cancelled';
    }
  }
  await writeFile(path, bytes);
  return 'saved';
}

export async function exportDocxFile(
  input: DocxExportInput,
  options: { defaultPath: string },
): Promise<ExportDocxOutcome> {
  const { bytes, report } = await buildDocx(input);

  const lines = docxReportLines(report);
  if (lines.length > 0) {
    const proceed = await useExportConfirmDialogStore.getState().requestConfirm({
      title: 'Export Word Document?',
      lines,
    });
    if (!proceed) return 'cancelled';
  }

  const path = await save({
    filters: [{ name: 'Word Document', extensions: ['docx'] }],
    defaultPath: options.defaultPath,
  });
  if (!path) return null;

  await writeFile(path, bytes);
  return 'exported';
}
