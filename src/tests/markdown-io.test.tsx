import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { save, message } from '@tauri-apps/plugin-dialog';
import { mkdir, readFile } from '@tauri-apps/plugin-fs';
import type { JSONContent } from '@tiptap/core';
import { exportMarkdownFile, markdownDefaultPath } from '@/lib/markdown/exportMarkdown';
import { importMarkdown } from '@/lib/markdown/importMarkdown';
import { useMediaStore } from '@/lib/media/store';
import { sha256Hex } from '@/lib/media/insert';
import {
  ExportMarkdownDialog,
  useExportMarkdownDialogStore,
} from '@/components/dialogs/ExportMarkdownDialog';

/**
 * M-MD — the file-flow suite: export (confirm gate → save dialog →
 * assets) and import (read → parse → ingest) against the in-memory
 * tauri mock pattern (wpdoc.test.tsx). The gate is the IN-APP shadcn
 * dialog (the developer-mode warning's spelling) driven through its
 * promise-bridge store — the tests settle it the way the dialog's
 * buttons do.
 */

type Stored = string | Uint8Array;
const files = vi.hoisted(() => new Map<string, Stored>());
const dialogState = vi.hoisted(() => ({ savePath: null as string | null }));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(async () => dialogState.savePath),
  message: vi.fn(async () => null),
  open: vi.fn(async () => null),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: vi.fn(async (path: string, content: string) => {
    files.set(path, content);
  }),
  writeFile: vi.fn(async (path: string, data: Uint8Array) => {
    files.set(path, data);
  }),
  mkdir: vi.fn(async () => null),
  readTextFile: vi.fn(async (path: string) => {
    const file = files.get(path);
    if (typeof file !== 'string') throw new Error(`missing text file: ${path}`);
    return file;
  }),
  readFile: vi.fn(async (path: string) => {
    const file = files.get(path);
    if (!(file instanceof Uint8Array)) throw new Error(`missing binary file: ${path}`);
    return file;
  }),
}));

function doc(...children: JSONContent[]): JSONContent {
  return { type: 'doc', content: children };
}

function para(text: string): JSONContent {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

const SHA = 'b'.repeat(64);

beforeEach(() => {
  files.clear();
  dialogState.savePath = null;
  useMediaStore.setState({ entries: new Map() });
  useExportMarkdownDialogStore.setState({ pending: null });
});

describe('markdownDefaultPath', () => {
  it('derives from the open document, or Untitled', () => {
    expect(markdownDefaultPath(null)).toBe('Untitled.md');
    expect(markdownDefaultPath('/home/u/reports/Q3.wpdoc')).toBe('Q3.md');
  });
});

describe('export flow', () => {
  it('a clean document exports with NO confirm and no assets folder', async () => {
    dialogState.savePath = '/home/u/notes/clean.md';
    const outcome = await exportMarkdownFile(doc(para('hello world')), { defaultPath: 'clean.md' });
    expect(outcome).toBe('exported');
    expect(useExportMarkdownDialogStore.getState().pending).toBeNull();
    expect(mkdir).not.toHaveBeenCalled();
    expect(files.get('/home/u/notes/clean.md')).toContain('hello world');
  });

  it('the lossy confirm fires BEFORE the save dialog; cancelling writes nothing', async () => {
    const outcome = exportMarkdownFile(doc(para('x'), { type: 'pageBreak' }), {
      defaultPath: 'X.md',
    });
    // the gate parks the report — the save dialog has NOT opened
    const pending = useExportMarkdownDialogStore.getState().pending;
    expect(pending?.report.pageBreaks).toBe(1);
    expect(save).not.toHaveBeenCalled();
    // the dialog's Cancel settles the gate as declined
    useExportMarkdownDialogStore.getState().settle(false);
    expect(await outcome).toBe('cancelled');
    expect(save).not.toHaveBeenCalled();
    expect([...files.keys()]).toHaveLength(0);
  });

  it('accepting the confirm proceeds to the save dialog and writes', async () => {
    dialogState.savePath = '/home/u/notes/lossy.md';
    const outcome = exportMarkdownFile(
      doc({ type: 'headerBlock', content: [para('band')] }, para('body')),
      { defaultPath: 'lossy.md' },
    );
    const pending = useExportMarkdownDialogStore.getState().pending;
    expect(pending?.report.headerFooterRegions).toBe(1);
    useExportMarkdownDialogStore.getState().settle(true);
    expect(await outcome).toBe('exported');
    expect(files.get('/home/u/notes/lossy.md')).toContain('body');
    expect(files.get('/home/u/notes/lossy.md')).not.toContain('band');
  });

  it('a null save-path aborts (cancelled by the dialog)', async () => {
    const outcome = await exportMarkdownFile(doc(para('x')), { defaultPath: 'x.md' });
    expect(outcome).toBeNull();
  });

  it('rewrites media refs to the assets folder and dedupes the bytes', async () => {
    dialogState.savePath = '/dir/My Doc.md';
    const bytes = new Uint8Array([1, 2, 3, 4]);
    useMediaStore.getState().add(SHA, 'png', bytes);
    const image = (src: string) => ({
      type: 'image',
      attrs: { src, alt: '', width: null, height: null },
    });
    const outcome = await exportMarkdownFile(
      doc(para('a'), image(`media://${SHA}`), para('b'), image(`media://${SHA}`)),
      { defaultPath: 'My Doc.md' },
    );
    expect(outcome).toBe('exported');
    const md = files.get('/dir/My Doc.md') as string;
    expect(md).toContain(`(./My%20Doc.assets/${SHA}.png)`);
    expect(md).not.toContain('media://');
    // the bytes land ONCE (dedupe), under the content-addressed name
    const assetPath = `/dir/My Doc.assets/${SHA}.png`;
    const stored = files.get(assetPath) as Uint8Array;
    expect([...stored]).toEqual([1, 2, 3, 4]);
    expect([...files.keys()].filter((k) => k.endsWith('.png'))).toHaveLength(1);
  });

  it('a missing media entry keeps the placeholder and surfaces the count', async () => {
    dialogState.savePath = '/dir/gone.md';
    await exportMarkdownFile(
      doc({ type: 'image', attrs: { src: `media://${SHA}`, alt: 'gone', width: null, height: null } }),
      { defaultPath: 'gone.md' },
    );
    const md = files.get('/dir/gone.md') as string;
    expect(md).toContain(`media://${SHA}`);
    expect(message).toHaveBeenCalledTimes(1);
  });
});

describe('import flow', () => {
  it('parses, promotes a standalone image, and ingests it into the MediaStore', async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    files.set('/docs/notes.md', `# Title\n\n![pic](./img/pic.png)\n`);
    files.set('/docs/img/pic.png', bytes);
    const { json, skippedImages } = await importMarkdown('/docs/notes.md');
    expect(skippedImages).toBe(0);
    const image = json.content?.[1];
    expect(image?.type).toBe('image'); // promoted
    const id = await sha256Hex(bytes);
    expect(image?.attrs?.src).toBe(`media://${id}`);
    expect(useMediaStore.getState().entries.get(id)?.bytes).toEqual(bytes);
  });

  it('keeps inline images inline and ingests them too', async () => {
    const bytes = new Uint8Array([5]);
    files.set('/d/x.md', 'see ![i](./a.png) now');
    files.set('/d/a.png', bytes);
    const { json, skippedImages } = await importMarkdown('/d/x.md');
    expect(skippedImages).toBe(0);
    const paragraph = json.content?.[0];
    expect(paragraph?.content?.map((c) => c.type)).toEqual(['text', 'inlineImage', 'text']);
    const id = await sha256Hex(bytes);
    expect(paragraph?.content?.[1]?.attrs?.src).toBe(`media://${id}`);
  });

  it('refuses remote images without any fetch and drops them (counted)', async () => {
    files.set('/d/r.md', 'a ![r](https://cdn.example.com/x.png) b');
    const { json, skippedImages } = await importMarkdown('/d/r.md');
    expect(skippedImages).toBe(1);
    const paragraph = json.content?.[0];
    // the image is gone; the text survives on both sides
    expect(paragraph?.content?.map((c) => c.type)).toEqual(['text', 'text']);
    expect(readFile).not.toHaveBeenCalledWith(expect.stringContaining('https'));
  });

  it('drops (and counts) images whose file is missing', async () => {
    files.set('/d/m.md', '![gone](./nothing.png)');
    const { skippedImages } = await importMarkdown('/d/m.md');
    expect(skippedImages).toBe(1);
  });

  it('ingests data-URI images', async () => {
    const bytes = new Uint8Array([77, 88]);
    const b64 = btoa(String.fromCharCode(...bytes));
    files.set('/d/data.md', `![d](data:image/png;base64,${b64})`);
    const { json, skippedImages } = await importMarkdown('/d/data.md');
    expect(skippedImages).toBe(0);
    const id = await sha256Hex(bytes);
    expect(json.content?.[0]?.type).toBe('image');
    expect(json.content?.[0]?.attrs?.src).toBe(`media://${id}`);
  });

  it('equations and structure round-trip through a real file', async () => {
    files.set('/d/eq.md', '# H\n\n$$\nE = mc^2\n$$\n');
    const { json, skippedImages } = await importMarkdown('/d/eq.md');
    expect(skippedImages).toBe(0);
    expect(json.content?.[0]?.type).toBe('heading');
    const eq = json.content?.find((c) => c.type === 'equation');
    expect(eq?.attrs?.latex).toBe('E = mc^2');
  });
});

describe('the export confirm dialog (in-app, M-MD)', () => {
  it('lists only the losses present and settles the gate with its buttons', async () => {
    render(<ExportMarkdownDialog />);
    let answer: boolean | null = null;
    void useExportMarkdownDialogStore
      .getState()
      .requestConfirm({
        headerFooterRegions: 1,
        referenceTables: 0,
        pageBreaks: 2,
        customFormatting: true,
      })
      .then((v) => {
        answer = v;
      });

    expect(await screen.findByText('Export Markdown?')).toBeTruthy();
    // only the PRESENT categories (reference tables absent)
    expect(screen.getByText(/Header\/footer content \(1 region\)/)).toBeTruthy();
    expect(screen.queryByText(/Reference tables/)).toBeNull();
    expect(screen.getByText(/Page breaks \(2\)/)).toBeTruthy();
    expect(screen.getByText(/Custom formatting/)).toBeTruthy();

    // the destructive proceed button (the developer-mode pattern)
    fireEvent.click(screen.getByTestId('export-markdown-accept'));
    await act(async () => {});
    expect(answer).toBe(true);
    expect(useExportMarkdownDialogStore.getState().pending).toBeNull();
  });

  it('a settled-true gate lets the export through; the dialog closes', async () => {
    render(<ExportMarkdownDialog />);
    dialogState.savePath = '/dir/dialog.md';
    const outcome = exportMarkdownFile(doc(para('kept'), { type: 'pageBreak' }), {
      defaultPath: 'dialog.md',
    });
    useExportMarkdownDialogStore.getState().settle(true);
    expect(await outcome).toBe('exported');
    expect(files.get('/dir/dialog.md')).toContain('kept');
  });
});
