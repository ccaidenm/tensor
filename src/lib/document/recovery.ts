import { exists, mkdir, remove, readDir } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import type { Editor } from '@tiptap/core';
import { assembleDocumentFile, type SaveDocumentOptions } from './fileOperations';
import type { DocumentFile } from './schema';
import { collectReferencedMediaIds, openWpdoc, saveWpdoc } from './wpdoc';

// Stable per-app-launch id, used for recovery files of never-yet-saved
// documents (no real filePath to derive an identity from).
const SESSION_ID = crypto.randomUUID();

async function hashPath(path: string): Promise<string> {
  const data = new TextEncoder().encode(path);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16); // short prefix is plenty, this just needs to avoid collisions
}

async function getRecoveryPath(originalPath: string | null): Promise<string> {
  const dir = await appDataDir();
  const recoveryDir = await join(dir, 'recovery');
  if (!(await exists(recoveryDir))) {
    await mkdir(recoveryDir, { recursive: true });
  }
  const key = originalPath ? await hashPath(originalPath) : SESSION_ID;
  return join(recoveryDir, `${key}.wpdoc`);
}

export async function saveRecoveryCopy(
  editor: Editor,
  originalPath: string | null,
  options: SaveDocumentOptions
): Promise<void> {
  try {
    // M-META: the SAME assembly as saves (snapshot parity — snapshots
    // used to omit styles). The back-pointer rides the options.
    const file = assembleDocumentFile(editor, { ...options, originalPath });
    // M-IMAGES-0: snapshots are v2 containers now — the SAME
    // package command as saves (media rides along, GC'd to the
    // document's references). The path is unchanged.
    const path = await getRecoveryPath(originalPath);
    await saveWpdoc(path, file);
  } catch (err) {
    console.error('Autosave failed:', err);
  }
}

/**
 * M-IMAGES-0: open a recovery snapshot — v2 container, or an OLD
 * (v1 JSON) snapshot via the same permanent converter as
 * openDocument. Restore flows read through this; the formats can
 * never fork.
 */
export async function readRecoveryCopy(path: string): Promise<DocumentFile> {
  return openWpdoc(path);
}

/** Test seam: the GC scan lives in wpdoc.ts; re-exported for the
 * recovery tests' byte-level assertions. */
export { collectReferencedMediaIds };

/**
 * #103 — THE START SCREEN'S RECOVERY LIST: every snapshot on disk
 * with just enough metadata for a card (the display name, the
 * back-pointer, the stamp). Reads each package fully (the recovery
 * dir holds at most one file per path hash + one per session — a
 * handful of small zips, never a scan cost). Corrupt entries drop
 * loudly-quietly (the normalizePageStyles posture — a bad snapshot
 * never crashes the listing).
 */
export interface RecoveryEntry {
  /** The snapshot's own path (the restore action's input). */
  recoveryPath: string;
  /** The card's display name (the original basename / title). */
  name: string;
  /** The back-pointer to the original file, when it had one. */
  originalPath: string | null;
  /** The doc's own stamp (metadata.modifiedAt). */
  modifiedAt: number | null;
}

async function recoveryDirPath(): Promise<string | null> {
  const dir = await appDataDir();
  const recoveryDir = await join(dir, 'recovery');
  if (!(await exists(recoveryDir))) return null;
  return recoveryDir;
}

export async function listRecoveryCopies(): Promise<RecoveryEntry[]> {
  try {
    const dir = await recoveryDirPath();
    if (!dir) return [];
    const entries = await readDir(dir);
    const out: RecoveryEntry[] = [];
    for (const entry of entries) {
      if (!entry.name || !entry.name.endsWith('.wpdoc')) continue;
      const recoveryPath = await join(dir, entry.name);
      try {
        const file = await readRecoveryCopy(recoveryPath);
        const originalPath = file.metadata.originalPath ?? null;
        const modifiedAt = file.metadata.modifiedAt
          ? new Date(file.metadata.modifiedAt).getTime()
          : null;
        const baseName = originalPath
          ? (originalPath.split('/').pop() ?? originalPath)
          : null;
        const name = baseName ?? file.metadata.title ?? 'Untitled draft';
        out.push({ recoveryPath, name, originalPath, modifiedAt });
      } catch {
        // A corrupt snapshot drops from the list (never crashes it);
        // it stays on disk for manual inspection.
      }
    }
    // The freshest work first.
    out.sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
    return out;
  } catch (err) {
    console.error('Failed to list recovery copies:', err);
    return [];
  }
}

export async function clearRecoveryCopy(originalPath: string | null): Promise<void> {
  try {
    const path = await getRecoveryPath(originalPath);
    if (await exists(path)) {
      await remove(path);
    }
  } catch (err) {
    console.error('Failed to clear recovery copy:', err);
  }
}
