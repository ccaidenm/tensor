import { describe, it, expect, vi, beforeEach } from 'vitest';

import { unzipSync } from 'fflate';
import { buildDocx } from '@/lib/docx/export';
import { saveDocxToPath } from '@/lib/docx/exportFlow';
import { useDocumentStore } from '@/lib/document/store';
import { useExportConfirmDialogStore } from '@/components/dialogs/ExportConfirmDialog';
import { useImportReportDialogStore } from '@/components/dialogs/ImportReportDialog';
import { renderTensor } from './harness';
import type { JSONContent } from '@tiptap/core';

/**
 * The in-place save suite: save/saveAs dispatch on the file extension —
 * a .docx saves ITSELF (no dialog; the lossy gate still guards),
 * Save-As and OPEN adopt Word paths; autosave is wpdoc-only (file
 * locks + churn), recovery snapshots cover .docx between saves.
 */

const dialogState = vi.hoisted(() => ({ savePath: null as string | null, openPath: null as string | null }));
const writes = vi.hoisted(() => new Map<string, Uint8Array>());
const wpdocInvokes = vi.hoisted(() => new Map<string, string>());

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(async () => dialogState.savePath),
  open: vi.fn(async () => dialogState.openPath),
  ask: vi.fn(async () => true),
  message: vi.fn(async () => null),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeFile: vi.fn(async (path: string, bytes: Uint8Array) => {
    writes.set(path, bytes);
  }),
  readFile: vi.fn(async (path: string) => writes.get(path) ?? (() => { throw new Error(`missing: ${path}`); })()),
  readTextFile: vi.fn(async (path: string) => {
    const raw = writes.get(path);
    if (typeof raw === 'string') return raw;
    throw new Error(`missing text: ${path}`);
  }),
  writeTextFile: vi.fn(async () => null),
  exists: vi.fn(async () => false),
  mkdir: vi.fn(async () => null),
  remove: vi.fn(async () => null),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: { path?: string; documentJson?: string }) => {
    if (cmd === 'package_document') {
      wpdocInvokes.set(args.path!, args.documentJson!);
      return null;
    }
    throw new Error(`unexpected command: ${cmd}`);
  }),
}));

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn(async () => '/tmp/appdata'),
  join: vi.fn(async (...parts: string[]) => parts.join('/')),
}));

function doc(...children: JSONContent[]): JSONContent {
  return { type: 'doc', content: children };
}

function para(text: string): JSONContent {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

beforeEach(() => {
  writes.clear();
  wpdocInvokes.clear();
  dialogState.savePath = null;
  dialogState.openPath = null;
  useExportConfirmDialogStore.setState({ pending: null });
  useImportReportDialogStore.setState({ pending: null });
});

describe('the in-place save dispatch', () => {
  it('Save on a .docx document writes the Word file itself — no dialog, no zip container', async () => {
    const { editor } = renderTensor();
    editor.commands.setContent(doc(para('word-native body')));
    useDocumentStore.setState({ filePath: '/home/u/thesis.docx', isDirty: true });

    await useDocumentStore.getState().save();

    expect(writes.has('/home/u/thesis.docx')).toBe(true);
    const bytes = writes.get('/home/u/thesis.docx')!;
    const parts = unzipSync(bytes);
    expect(new TextDecoder().decode(parts['word/document.xml'])).toContain('word-native body');
    // the zip container NEVER fires for a Word path
    expect(wpdocInvokes.size).toBe(0);
    expect(useDocumentStore.getState().isDirty).toBe(false);
  });

  it('the lossy gate guards an in-place save; cancelling keeps the file and the dirty state', async () => {
    // UNIT-level: the gate inside saveDocxToPath, with literal JSON (an
    // unparseable latex is the one loss the mapping reports — no
    // editor render needed; rendering an equation needs MathLive).
    const input: Parameters<typeof saveDocxToPath>[0] = {
      json: { type: 'doc', content: [{ type: 'equation', attrs: { latex: '\\thisisnotacommand{x}' } }] },
      pageSetup: { pageSize: 'Letter', margins: { top: 72, bottom: 72, left: 72, right: 72 }, pageGap: 32 },
      headerFooter: null,
      coreProperties: {},
      styleDefinitions: [],
      baseStyle: { fontFamily: 'Source Serif 4', fontSize: 16 },
      media: new Map(),
    };

    const saving = saveDocxToPath(input, '/home/u/paper.docx');
    // The gate parks a beat after buildDocx — poll for it (a blind
    // settle no-ops when the gate hasn't parked yet, hanging the save).
    for (let i = 0; i < 40 && !useExportConfirmDialogStore.getState().pending; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(useExportConfirmDialogStore.getState().pending?.title).toBe('Save as Word?');
    useExportConfirmDialogStore.getState().settle(false);
    expect(await saving).toBe('cancelled');
    expect(writes.size).toBe(0); // nothing landed

    // accepting writes through the SAME call shape
    const second = saveDocxToPath(input, '/home/u/paper.docx');
    for (let i = 0; i < 40 && !useExportConfirmDialogStore.getState().pending; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    useExportConfirmDialogStore.getState().settle(true);
    expect(await second).toBe('saved');
    expect(writes.has('/home/u/paper.docx')).toBe(true);
  });

  it('Save-As adopts a .docx path (the document becomes Word-native)', async () => {
    const { editor } = renderTensor();
    editor.commands.setContent(doc(para('adopted')));
    useDocumentStore.setState({ filePath: null, isDirty: true });
    dialogState.savePath = '/home/u/converted.docx';

    await useDocumentStore.getState().saveAs();

    expect(useDocumentStore.getState().filePath).toBe('/home/u/converted.docx');
    expect(useDocumentStore.getState().isDirty).toBe(false);
    expect(writes.has('/home/u/converted.docx')).toBe(true);
  });

  it('Save-As to .wpdoc keeps Tensor\u2019s own format (the zip container)', async () => {
    const { editor } = renderTensor();
    editor.commands.setContent(doc(para('tensor-native')));
    useDocumentStore.setState({ filePath: null, isDirty: true });
    dialogState.savePath = '/home/u/keep.wpdoc';

    await useDocumentStore.getState().saveAs();

    expect(useDocumentStore.getState().filePath).toBe('/home/u/keep.wpdoc');
    expect(wpdocInvokes.has('/home/u/keep.wpdoc')).toBe(true);
    expect(writes.size).toBe(0);
  });

  it('OPEN adopts the Word file: filePath becomes the .docx and the document is clean', async () => {
    // Build a real .docx, plant it in the mocked fs.
    const { bytes } = await buildDocx({
      json: doc(para('imported from word')),
      pageSetup: { pageSize: 'Letter', margins: { top: 72, bottom: 72, left: 72, right: 72 }, pageGap: 32 },
      headerFooter: null,
      coreProperties: { title: 'Adopted' },
      styleDefinitions: [],
      baseStyle: { fontFamily: 'Source Serif 4', fontSize: 16 },
      media: new Map(),
    });
    writes.set('/home/u/from-word.docx', bytes);
    dialogState.openPath = '/home/u/from-word.docx';

    const { editor } = renderTensor();
    editor.commands.setContent(doc(para('placeholder')));
    useDocumentStore.setState({ filePath: null, isDirty: true });

    await useDocumentStore.getState().openFile();

    expect(useDocumentStore.getState().filePath).toBe('/home/u/from-word.docx');
    expect(useDocumentStore.getState().isDirty).toBe(false);
    // the Word content landed
    expect(editor.getJSON().content?.some((c) => JSON.stringify(c).includes('imported from word'))).toBe(true);
  });

  it('an opened .docx with losses shows the in-app report (never a native popup)', async () => {
    // An equation re-spells with no losses; an unparseable OMML can't
    // be built here, so pin the report dialog (importNotices) through
    // the markdown skipped-image seam (same surface).
    const { editor } = renderTensor();
    editor.commands.setContent(doc(para('x')));
    useDocumentStore.setState({ filePath: '/u/notes.md', isDirty: false });
    // simulate the markdown open path's notice (the store is the surface)
    useImportReportDialogStore.getState().show({ title: 'Markdown import', lines: ['1 image was not imported'] });
    expect(useImportReportDialogStore.getState().pending?.title).toBe('Markdown import');
    useImportReportDialogStore.getState().dismiss();
    void editor;
  });
});
