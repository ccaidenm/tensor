/**
 * M-PRINT (#43) — THE TENSOR-NATIVE PRINT PIPELINE. The OS dialog's
 * replacement, end to end:
 *
 *     the walk → PDF bytes (exportPdf) → temp file → CUPS job
 *
 * LANDSCAPE INHERITS NATIVELY: the PDF carries the exact page
 * dimensions (the original motivation — the OS dialog lost
 * orientation on the way through; a CUPS job never does).
 *
 * The Rust seam (src-tauri/src/print.rs): `enumerate_printers` →
 * Vec<PrinterInfo> and `print_pdf(printer, path, copies, duplex)` →
 * job id, through the `printers` crate (CUPS on unix, winspool on
 * Windows). `duplex` spells CUPS's `sides` job option.
 *
 * NOT-TAURI (tests/plain web): `invoke` throws (no IPC) — enumerate
 * quietly yields [] (the modal falls back to the system dialog, its
 * own entry in the picker), and printing throws (the toast's failure
 * path).
 */

import { invoke } from '@tauri-apps/api/core';
import { appCacheDir, join } from '@tauri-apps/api/path';
import { writeFile, remove } from '@tauri-apps/plugin-fs';

/** The webview's printer shape (Rust's PrinterInfo, camelCased on the
 *  wire by serde rename_all — the field names are the IPC contract). */
export interface NativePrinter {
  /** Display name — the picker's label AND the print command's key. */
  name: string;
  /** Name exactly as the system spells it (the CUPS -d argument). */
  systemName: string;
  /** ready | offline | paused | printing | unknown. */
  state: string;
  /** The system default — preselected in the picker. */
  isDefault: boolean;
  /** e.g. "Office desk 2" — shown muted under the name. */
  location: string;
  /** e.g. "HP LaserJet Pro M402" — shown muted under the name. */
  description: string;
}

/** Duplex, spelled as CUPS spells the `sides` job option. */
export type DuplexSetting =
  | 'default'
  | 'one-sided'
  | 'two-sided-long-edge'
  | 'two-sided-short-edge';

/** Every system printer (the picker's options). [] outside Tauri. */
export async function enumeratePrinters(): Promise<NativePrinter[]> {
  try {
    return await invoke<NativePrinter[]>('enumerate_printers');
  } catch {
    // No IPC (tests/plain web) or CUPS unreachable — the modal's
    // system-dialog fallback stands.
    return [];
  }
}

/** THE SUBMIT: PDF bytes → temp file → CUPS job → job id. The temp
 *  file lives in the app's cache dir (never the document's folder,
 *  never the Downloads default) and is removed after submission —
 *  a print job holds its own copy. */
export async function printPdfToPrinter(options: {
  printer: string;
  bytes: Uint8Array;
  copies: number;
  duplex: DuplexSetting;
  /** A stable base for the temp filename AND the queue's job name. */
  jobBase: string;
}): Promise<number> {
  const { printer, bytes, copies, duplex, jobBase } = options;
  const dir = await appCacheDir();
  const safe = jobBase.replace(/[\\/:*?"<>|]/g, '_') || 'document';
  const path = await join(dir, `tensor-print-${safe}.pdf`);
  let jobId: number;
  try {
    await writeFile(path, bytes);
    jobId = await invoke<number>('print_pdf', {
      printer,
      path,
      copies,
      duplex,
    });
  } finally {
    // Best-effort cleanup — a failed remove never fails the print
    // that already succeeded.
    try {
      await remove(path);
    } catch {
      // the OS reaps cache dirs
    }
  }
  return jobId;
}