import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * M-PRINT (#43) — THE TENSOR-NATIVE PIPELINE suite: the TS seam over
 * the Rust commands. The invoke/path/fs mocks stand in for the IPC
 * surface; the CONTRACTS: enumerate's quiet [] (the fallback
 * posture), and the submit's temp-file lifecycle (write → invoke →
 * remove, even on failure — a print job holds its own copy).
 */

const mocks = vi.hoisted(() => {
  const invokeMock = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
  const appCacheDirMock = vi.fn(async () => '/home/caiden/.cache/tensor/');
  const joinMock = vi.fn(async (a: string, b: string) => `${a}${b}`);
  const writeFileMock = vi.fn(async (_path: string, _data: Uint8Array) => undefined);
  const removeMock = vi.fn(async (_path: string) => undefined);
  return { invokeMock, appCacheDirMock, joinMock, writeFileMock, removeMock };
});
const { invokeMock, writeFileMock, removeMock } = mocks;

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: [string, unknown?]) => mocks.invokeMock(...a) }));
vi.mock('@tauri-apps/api/path', () => ({
  appCacheDir: () => mocks.appCacheDirMock(),
  join: (...a: [string, string]) => mocks.joinMock(...a),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeFile: (...a: [string, Uint8Array]) => mocks.writeFileMock(...a),
  remove: (...a: [string]) => mocks.removeMock(...a),
}));

import { enumeratePrinters, printPdfToPrinter } from '@/lib/print/nativePrint';

beforeEach(() => {
  invokeMock.mockReset();
  writeFileMock.mockReset();
  removeMock.mockReset();
});

describe('enumeratePrinters', () => {
  it('returns the command payload (camelCased from Rust)', async () => {
    invokeMock.mockResolvedValue([
      {
        name: 'TestJet',
        systemName: 'TestJet',
        state: 'ready',
        isDefault: true,
        location: 'Desk',
        description: 'TestJet 400',
      },
    ]);
    const list = await enumeratePrinters();
    expect(invokeMock).toHaveBeenCalledWith('enumerate_printers');
    expect(list[0]!.name).toBe('TestJet');
    expect(list[0]!.isDefault).toBe(true);
  });

  it('quietly yields [] outside Tauri (the system-dialog fallback stands)', async () => {
    invokeMock.mockRejectedValue(new Error('no IPC'));
    expect(await enumeratePrinters()).toEqual([]);
  });
});

describe('printPdfToPrinter', () => {
  const BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

  it('writes the temp PDF, submits with CUPS options, removes the file, returns the job id', async () => {
    invokeMock.mockResolvedValue(42);
    const jobId = await printPdfToPrinter({
      printer: 'TestJet',
      bytes: BYTES,
      copies: 3,
      duplex: 'two-sided-long-edge',
      jobBase: 'my paper',
    });
    expect(jobId).toBe(42);
    // the temp file: cache dir + a name safe under the doc's
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(writeFileMock.mock.calls.length).toBe(1);
    const path = String(writeFileMock.mock.calls[0]![0]);
    expect(path).toContain('tensor-print-my paper.pdf');
    expect(writeFileMock.mock.calls[0]![1]).toBe(BYTES);
    // the command: printer, path, copies, CUPS sides spelling
    expect(invokeMock).toHaveBeenCalledWith('print_pdf', {
      printer: 'TestJet',
      path,
      copies: 3,
      duplex: 'two-sided-long-edge',
    });
    // cleanup after success
    expect(removeMock).toHaveBeenCalledWith(path);
  });

  it('removes the temp file even when the job fails (never a straggler)', async () => {
    invokeMock.mockRejectedValue(new Error('printer offline'));
    await expect(
      printPdfToPrinter({ printer: 'TestJet', bytes: BYTES, copies: 1, duplex: 'default', jobBase: 'x' }),
    ).rejects.toThrow('printer offline');
    expect(removeMock).toHaveBeenCalledTimes(1);
  });

  it('sanitizes a hostile jobBase in the temp filename', async () => {
    invokeMock.mockResolvedValue(7);
    await printPdfToPrinter({ printer: 'p', bytes: BYTES, copies: 1, duplex: 'default', jobBase: 'a/b:c*d?' });
    const path2 = String(writeFileMock.mock.calls[0]![0]);
    expect(path2).toContain('tensor-print-a_b_c_d_.pdf');
  });
});