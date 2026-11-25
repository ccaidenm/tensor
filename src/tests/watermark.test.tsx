import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { unzipSync, strToU8 } from 'fflate';
import { PDFPage, PDFFont } from 'pdf-lib';
import { buildDocx } from '@/lib/docx/export';
import {
  docxImportNoticeLines,
  mapDocxDocument,
  parseDocxTrees,
} from '@/lib/docx/import';
import { buildPrintDocument } from '@/lib/print/buildDocument';
import { PrintContainer, printFromPreview } from '@/lib/print/PrintContainer';
import { exportPdf } from '@/lib/print/pdfExport';
import type { PrintPage } from '@/lib/print/types';
import { analyzeMarkdownLossy, hasLossyContent, markdownLossyLines } from '@/lib/markdown/lossy';





import type { Node as PMNode } from '@tiptap/pm/model';
import { assembleDocumentFile } from '@/lib/document/fileOperations';
import { collectReferencedMediaIds } from '@/lib/document/wpdoc';
import { DocumentFileSchema } from '@/lib/document/schema';
import { DEFAULT_MARGINS, PAGE_GAP, type WatermarkSettings } from '@/lib/document/pageSetup';
import {
  resolveWatermark,
  WATERMARK_DEFAULT_COLOR,
  WATERMARK_DEFAULT_OPACITY,
  WATERMARK_DEFAULT_SCALE,
  WATERMARK_DEFAULT_TEXT_ROTATION,
} from '@/lib/paginated/watermark';
import { useDocumentStore } from '@/lib/document/store';
import { useConfigStore } from '@/lib/config/store';
import { useMediaStore } from '@/lib/media/store';
import { useDocumentStore as _uds } from '@/lib/document/store';
void _uds;
import { useSidebarStore } from '@/lib/layout/sidebarStore';
import { SidebarHost } from '@/lib/layout/sidebar/SidebarHost';
import { WatermarkPanel } from '@/components/editor/WatermarkPanel';
import { getCommand } from '@/lib/commands/registry';

import { renderTensor, settleLayout } from './harness';
import { FakeMetrics } from './fakeMetrics';

/**
 * The watermark suite: the resolver (one derivation), the model's
 * round-trip + save-GC, and the on-screen layer (behind everything by
 * mount order, every page, per-section chain, ink-only display toggle).
 */

const MEASURE = FakeMetrics.measure;
const PAGE = { width: 816, height: 1056 };

const textWatermark = (over: Partial<WatermarkSettings> = {}): WatermarkSettings => ({
  kind: 'text',
  text: 'DRAFT',
  ...over,
});

describe('#WATERMARK: resolveWatermark (the one derivation)', () => {
  it('the text defaults are Word\'s: silver, −45° diagonal, 50% opacity', () => {
    const spec = resolveWatermark(textWatermark(), PAGE, MEASURE, 'fake')!;
    expect(spec).toMatchObject({
      kind: 'text',
      text: 'DRAFT',
      color: WATERMARK_DEFAULT_COLOR,
      rotation: WATERMARK_DEFAULT_TEXT_ROTATION,
      opacity: WATERMARK_DEFAULT_OPACITY,
    });
  });

  it('AUTO size spans ~70% of the page diagonal, measured through the one ruler', () => {
    const spec = resolveWatermark(textWatermark(), PAGE, MEASURE, 'fake')!;
    // FakeMetrics: 'DRAFT' at 16px measures 50px → the auto size scales
    // the probe so the text spans 0.7 × hypot(816, 1056).
    const diagonal = Math.hypot(PAGE.width, PAGE.height);
    expect(spec.kind).toBe('text');
    if (spec.kind !== 'text') return;
    expect(spec.fontSize).toBeCloseTo((diagonal * 0.7 * 16) / 50, 6);
    // An explicit size wins, verbatim.
    const explicit = resolveWatermark(textWatermark({ fontSize: 120 }), PAGE, MEASURE, 'fake')!;
    if (explicit.kind !== 'text') return;
    expect(explicit.fontSize).toBe(120);
  });

  it('an image scales to the page width, aspect from the DOCUMENT-DATA dims; rotation defaults HORIZONTAL (Word\'s posture)', () => {
    const spec = resolveWatermark(
      { kind: 'image', src: 'media://x', width: 200, height: 100 },
      PAGE,
      MEASURE,
      'fake',
    )!;
    expect(spec).toMatchObject({
      kind: 'image',
      src: 'media://x',
      width: PAGE.width * WATERMARK_DEFAULT_SCALE,
      height: (PAGE.width * WATERMARK_DEFAULT_SCALE) / 2,
      rotation: 0,
      opacity: WATERMARK_DEFAULT_OPACITY,
    });
  });

  it('declines, never guesses: blank text, non-media refs, missing/invalid dims', () => {
    expect(resolveWatermark(textWatermark({ text: '   ' }), PAGE, MEASURE, 'fake')).toBeNull();
    expect(
      resolveWatermark({ kind: 'image', src: 'https://x', width: 1, height: 1 }, PAGE, MEASURE, 'fake'),
    ).toBeNull();
    expect(resolveWatermark({ kind: 'image', src: 'media://x' }, PAGE, MEASURE, 'fake')).toBeNull();
    expect(
      resolveWatermark({ kind: 'image', src: 'media://x', width: 0, height: 1 }, PAGE, MEASURE, 'fake'),
    ).toBeNull();
  });
});

describe('#WATERMARK: the model + persistence', () => {
  it('the schema round-trips the watermark (and null = none)', () => {
    const parsed = DocumentFileSchema.parse({
      version: 1,
      docJSON: {},
      metadata: {
        pageSetup: {
          pageSize: 'Letter',
          margins: DEFAULT_MARGINS,
          pageGap: PAGE_GAP,
          watermark: { kind: 'text', text: 'CONFIDENTIAL', opacity: 0.25, rotation: -90 },
        },
      },
    });
    expect(parsed.metadata.pageSetup?.watermark).toEqual({
      kind: 'text',
      text: 'CONFIDENTIAL',
      opacity: 0.25,
      rotation: -90,
    });
    const bare = DocumentFileSchema.parse({
      version: 1,
      docJSON: {},
      metadata: { pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP } },
    });
    expect(bare.metadata.pageSetup?.watermark).toBeUndefined();
  });

  it('assembleDocumentFile carries the watermark through metadata.pageSetup', () => {
    const { editor } = renderTensor('<p>body</p>');
    useDocumentStore.getState().setPageSetup({
      pageSize: 'Letter',
      margins: DEFAULT_MARGINS,
      pageGap: PAGE_GAP,
      watermark: textWatermark({ text: 'DRAFT' }),
    });
    const file = assembleDocumentFile(editor, {
      pageSetup: useDocumentStore.getState().pageSetup,
    });
    expect(file.metadata.pageSetup?.watermark).toEqual({ kind: 'text', text: 'DRAFT' });
  });

  it('THE SAVE-GC: a doc-level watermark image ref in metadata is collected (the whole-file walk)', () => {
    // The GC used to walk docJSON only — a watermark ref living in
    // metadata.pageSetup would be dropped from the saved package.
    const file = {
      version: 1,
      docJSON: { type: 'doc', content: [] },
      metadata: {
        pageSetup: {
          pageSize: 'Letter',
          margins: DEFAULT_MARGINS,
          pageGap: PAGE_GAP,
          watermark: { kind: 'image', src: 'media://deadbeef', width: 10, height: 10 },
        },
      },
    };
    expect(collectReferencedMediaIds(file).has('deadbeef')).toBe(true);
    // And the walk is still conservative: no false refs from geometry.
    expect(collectReferencedMediaIds(file).size).toBe(1);
  });
});

describe('#WATERMARK: the on-screen layer', () => {
  function setDocWatermark(wm: WatermarkSettings | null): void {
    act(() => {
      useDocumentStore.getState().setPageSetup({
        ...useDocumentStore.getState().pageSetup,
        watermark: wm,
      });
    });
  }

  const layers = () => Array.from(document.querySelectorAll('[data-testid="watermark-layer"]'));

  it('a text watermark renders on EVERY page, centered, rotated, behind by mount order', async () => {
    const longText = '<p>' + 'word '.repeat(1500) + '</p>';
    renderTensor(longText);
    await settleLayout();
    setDocWatermark(textWatermark({ text: 'DRAFT' }));
    await settleLayout();

    const sheets = Array.from(document.querySelectorAll('[data-testid="page-sheet"]'));
    expect(sheets.length).toBeGreaterThanOrEqual(3);
    const painted = layers();
    expect(painted).toHaveLength(sheets.length);

    const inner = painted[0]!.firstElementChild as HTMLElement;
    expect(inner.textContent).toBe('DRAFT');
    expect(inner.style.transform).toContain('rotate(-45deg)');
    expect(inner.style.transform).toContain('translate(-50%, -50%)');
    expect(inner.style.opacity).toBe('0.5');
    expect(inner.style.color).toBe('rgb(192, 192, 192)');
    // The layer contract: it paints only — never a pointer target.
    expect(painted[0]!.className).toContain('pointer-events-none');
    expect(painted[0]!.getAttribute('aria-hidden')).toBe('true');
  });

  it('an image watermark paints the <img> scaled to the page', async () => {
    renderTensor('<p>body</p>');
    await settleLayout();
    useMediaStore.getState().add('wm-img', 'png', new Uint8Array([1]));
    setDocWatermark({ kind: 'image', src: 'media://wm-img', width: 400, height: 200 });
    await settleLayout();
    const img = document.querySelector('[data-testid="watermark-layer"] img') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.style.width).toBe(`${816 * WATERMARK_DEFAULT_SCALE}px`);
    expect(img.style.height).toBe(`${(816 * WATERMARK_DEFAULT_SCALE) / 2}px`);
    expect(img.getAttribute('alt')).toBe('');
  });

  it('the per-section chain: a section override beats the doc default; unset inherits it', async () => {
    const longText = '<p>' + 'word '.repeat(700) + '</p>';
    const { editor } = renderTensor(longText + '<div data-section-break></div>' + longText);
    await settleLayout();
    setDocWatermark(textWatermark({ text: 'DOC' }));
    // Section 0 (above the break) carries its own override.
    let bandPos = -1;
    editor.state.doc.forEach((node: PMNode, offset: number) => {
      if (node.type.name === 'sectionBreak' && bandPos < 0) bandPos = offset;
    });
    act(() => {
      const node = editor.state.doc.nodeAt(bandPos)!;
      // The break's setup must be a FULL PageSetup (the adapter's
      // section-geometry reads margins off it).
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(bandPos, undefined, {
          ...node.attrs,
          setup: {
            pageSize: 'Letter',
            margins: DEFAULT_MARGINS,
            pageGap: PAGE_GAP,
            watermark: textWatermark({ text: 'SECRET' }),
          },
        }),
      );
    });
    await settleLayout();

    const texts = layers().map((l) => (l.firstElementChild as HTMLElement).textContent);
    // Page 0 (section 0) wears the override; the final section's pages
    // inherit the doc default.
    expect(texts[0]).toBe('SECRET');
    expect(texts[texts.length - 1]).toBe('DOC');
  });

  it('the display toggle is INK-ONLY: hiding never touches the document', async () => {
    renderTensor('<p>body</p>');
    await settleLayout();
    setDocWatermark(textWatermark());
    await settleLayout();
    expect(layers()).toHaveLength(1);

    act(() => {
      useConfigStore.getState().setShowWatermark(false);
    });
    expect(layers()).toHaveLength(0);
    // The DOCUMENT's watermark survives the hide (display-only, like
    // the captions NPC) — it comes right back with the toggle.
    expect(useDocumentStore.getState().pageSetup.watermark).toEqual({ kind: 'text', text: 'DRAFT' });
    act(() => {
      useConfigStore.getState().setShowWatermark(true);
    });
    expect(layers()).toHaveLength(1);
  });
});

// The panel

vi.mock('@/lib/media/insert', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/insert')>();
  return {
    ...actual,
    registerImageFromPicker: vi.fn(async () => {
      // The jsdom stand-in for the OS picker: register + return (the
      // image infra's own contract, no node insert).
      useMediaStore.getState().add('panel-img', 'png', new Uint8Array([2]));
      return { src: 'media://panel-img', width: 300, height: 100 };
    }),
  };
});

describe('#WATERMARK: the panel', () => {
  beforeEach(() => {
    useSidebarStore.getState().close();
    // The document store is file-global — reset to a clean baseline
    // (the earlier suites' watermarks must not leak in).
    useDocumentStore.getState().setPageSetup({
      pageSize: 'Letter',
      margins: DEFAULT_MARGINS,
      pageGap: PAGE_GAP,
      watermark: null,
    });
  });

  function mountPanel() {
    render(
      <div className="relative">
        <SidebarHost id="watermark" anchor="right">
          <WatermarkPanel />
        </SidebarHost>
      </div>,
    );
    act(() => {
      void getCommand('watermarkPanel')?.run();
    });
    expect(useSidebarStore.getState().active?.id).toBe('watermark');
  }

  it('the command opens the panel; the Text tab LIVE-writes the default DRAFT', async () => {
    renderTensor('<p>body</p>');
    await settleLayout();
    mountPanel();
    expect(useDocumentStore.getState().pageSetup.watermark).toBeNull();
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="watermark-tab-text"]')!);
    });
    expect(useDocumentStore.getState().pageSetup.watermark).toEqual({ kind: 'text', text: 'DRAFT' });
    // Live: the layer paints behind the open panel.
    await settleLayout();
    expect(document.querySelectorAll('[data-testid="watermark-layer"]')).toHaveLength(1);
  });

  it('preset chips + the text input + rotation commit immediately (each one undo step)', async () => {
    const { editor } = renderTensor('<p>body</p>');
    await settleLayout();
    mountPanel();
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="watermark-tab-text"]')!);
    });
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="watermark-preset-confidential"]')!);
    });
    expect(useDocumentStore.getState().pageSetup.watermark).toMatchObject({
      kind: 'text',
      text: 'CONFIDENTIAL',
    });
    // The rotation knob (an explicit commit → co-undo entry).
    const rotation = document.querySelector('input[aria-label="Watermark rotation"]') as HTMLInputElement;
    act(() => {
      fireEvent.change(rotation, { target: { value: '-90' } });
    });
    act(() => {
      fireEvent.keyDown(rotation, { key: 'Enter' });
    });
    expect(useDocumentStore.getState().pageSetup.watermark).toMatchObject({ rotation: -90 });
    // ONE Ctrl+Z reverts the rotation (the store-only co-undo path —
    // the #48 synthetic machinery carries watermark writes too).
    act(() => {
      editor.commands.undo();
    });
    expect(useDocumentStore.getState().pageSetup.watermark).toMatchObject({
      kind: 'text',
      text: 'CONFIDENTIAL',
    });
    expect(useDocumentStore.getState().pageSetup.watermark).not.toHaveProperty('rotation');
    void editor;
  });

  it('the text input accepts CUSTOM typing (the controlled-value law: the draft leads, commit on blur/Enter)', async () => {
    renderTensor('<p>body</p>');
    await settleLayout();
    mountPanel();
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="watermark-tab-text"]')!);
    });
    // The tab commit seeded DRAFT — the field shows it.
    const input = document.querySelector('[data-testid="watermark-text-input"]') as HTMLInputElement;
    expect(input.value).toBe('DRAFT');
    // Typing REPLACES it live (the store must not freeze the field).
    act(() => {
      input.focus();
      fireEvent.change(input, { target: { value: 'DO NOT SHIP' } });
    });
    expect((document.querySelector('[data-testid="watermark-text-input"]') as HTMLInputElement).value).toBe('DO NOT SHIP');
    // Nothing commits mid-typing...
    expect(useDocumentStore.getState().pageSetup.watermark).toMatchObject({ text: 'DRAFT' });
    // ...the blur commits the draft.
    act(() => {
      fireEvent.blur(input);
    });
    expect(useDocumentStore.getState().pageSetup.watermark).toMatchObject({ text: 'DO NOT SHIP' });
    // And the field re-shows the STORE value (the draft cleared).
    expect((document.querySelector('[data-testid="watermark-text-input"]') as HTMLInputElement).value).toBe('DO NOT SHIP');
    await settleLayout();
    expect(
      (document.querySelector('[data-testid="watermark-layer"] div') as HTMLElement).textContent,
    ).toBe('DO NOT SHIP');
  });

  it('the None tab clears; the Image tab registers + sets an image watermark', async () => {
    renderTensor('<p>body</p>');
    await settleLayout();
    mountPanel();
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="watermark-tab-text"]')!);
    });
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="watermark-tab-none"]')!);
    });
    expect(useDocumentStore.getState().pageSetup.watermark).toBeNull();

    act(() => {
      fireEvent.click(document.querySelector('[data-testid="watermark-tab-image"]')!);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(useDocumentStore.getState().pageSetup.watermark).toMatchObject({
      kind: 'image',
      src: 'media://panel-img',
      width: 300,
      height: 100,
    });
    await settleLayout();
    const img = document.querySelector('[data-testid="watermark-layer"] img') as HTMLImageElement;
    expect(img).not.toBeNull();
  });

  it('the SECTION scope writes the caret\'s section\'s holder (the break\'s setup)', async () => {
    const longText = '<p>' + 'word '.repeat(700) + '</p>';
    const { editor } = renderTensor(longText + '<div data-section-break></div>' + longText);
    await settleLayout();
    mountPanel();
    // Park the caret in the FIRST section (TipTap's initial caret sits
    // at the doc END — the final section, whose holder IS the store).
    act(() => {
      editor.commands.setTextSelection(1);
    });
    // Doc-wide first (the default scope): every page shows it.
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="watermark-tab-text"]')!);
    });
    expect(useDocumentStore.getState().pageSetup.watermark).toMatchObject({ text: 'DRAFT' });

    // This section: the caption names it; the commit lands on the
    // caret's section's holder (the break's setup), the doc default
    // stays untouched.
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="watermark-scope-section"]')!);
    });
    expect(document.body.textContent).toContain('Section 1 of 2');
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="watermark-preset-confidential"]')!);
    });
    let breakWatermark: unknown;
    editor.state.doc.forEach((node: PMNode) => {
      if (node.type.name === 'sectionBreak') {
        breakWatermark = (node.attrs.setup as { watermark?: unknown }).watermark;
      }
    });
    expect(breakWatermark).toMatchObject({ kind: 'text', text: 'CONFIDENTIAL' });
    expect(useDocumentStore.getState().pageSetup.watermark).toMatchObject({ text: 'DRAFT' });
  });
});

const LETTER_WM = { width: 816, height: 1056 };

function wmInput(json: Parameters<typeof buildDocx>[0]['json'], overrides: Partial<Parameters<typeof buildDocx>[0]> = {}): Parameters<typeof buildDocx>[0] {
  return {
    json,
    pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP },
    headerFooter: null,
    coreProperties: { title: 'wm', creator: 'Tensor' },
    styleDefinitions: [],
    baseStyle: { fontFamily: 'Source Serif 4', fontSize: 16 },
    media: new Map(),
    ...overrides,
  };
}

// The 1×1 red PNG (docx.test's bytes) + the import-fixture helpers
// (module-local copies — the suites stay self-contained).
const TINY_PNG_WM = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);
const W_DECL_WM = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
function zipPartsWM(entries: Record<string, string | Uint8Array>): Record<string, Uint8Array> {
  const parts: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(entries)) {
    parts[name] = typeof value === 'string' ? strToU8(value) : value;
  }
  return parts;
}
function bodyWM(children: string): string {
  return `${W_DECL_WM}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${children}</w:body></w:document>`;
}
const STYLES_XML_WM = `${W_DECL_WM}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;

// The exports: print, PDF, DOCX

describe('#WATERMARK: print + PDF', () => {
  it('buildPrintDocument resolves the same chain the view paints; the print sheet renders the overlay BEFORE content', async () => {
    const longText = '<p>' + 'word '.repeat(1500) + '</p>';
    const { editor } = renderTensor(longText);
    await settleLayout();
    act(() => {
      useDocumentStore.getState().setPageSetup({
        ...useDocumentStore.getState().pageSetup,
        watermark: { kind: 'text', text: 'DRAFT', fontSize: 96 },
      });
    });
    const build = buildPrintDocument(editor);
    expect(build.pages.length).toBeGreaterThanOrEqual(3);
    for (const page of build.pages) {
      expect(page.watermark).toMatchObject({
        kind: 'text',
        text: 'DRAFT',
        fontSize: 96,
        rotation: -45,
        opacity: 0.5,
      });
    }

    // The print DOM (what window.print hands the OS): the overlay
    // mounts FIRST in the sheet (before the element ink).
    render(<PrintContainer />);
    await act(async () => {
      await printFromPreview(build.pages, useDocumentStore.getState().pageSetup);
    });
    const printSheets = Array.from(
      document.querySelectorAll('[data-testid="print-container"] [data-page-index]'),
    );
    expect(printSheets.length).toBeGreaterThan(0);
    const firstInk = printSheets[0]!.firstElementChild as HTMLElement;
    expect(firstInk.getAttribute('data-testid')).toBe('print-watermark');
    expect(firstInk.style.transform).toContain('rotate(-45deg)');
    expect(firstInk.style.opacity).toBe('0.5');
  });

  it('the PDF draws the rotated translucent text after the paper fill, before the content', async () => {
    const textSpy = vi.spyOn(PDFPage.prototype, 'drawText');
    const rectSpy = vi.spyOn(PDFPage.prototype, 'drawRectangle');
    const fontSpy = vi.spyOn(PDFFont.prototype, 'widthOfTextAtSize');
    const pages: PrintPage[] = [
      {
        index: 0,
        width: LETTER_WM.width,
        height: LETTER_WM.height,
        background: '#ddeeff',
        watermark: {
          kind: 'text',
          text: 'DRAFT',
          fontFamily: 'system-ui',
          fontSize: 96,
          color: '#c0c0c0',
          rotation: -45,
          opacity: 0.5,
        },
        elements: [],
      },
    ];
    const result = await exportPdf({ pages, info: {}, mediaBytes: () => undefined });
    // The paper fill drew; the text overlay drew exactly once, with
    // rotation + opacity + the auto-silver color.
    expect(rectSpy).toHaveBeenCalledTimes(1);
    expect(textSpy).toHaveBeenCalledTimes(1);
    const opts = textSpy.mock.calls[0]![1]!;
    expect(opts.rotate!.angle).toBe(45); // CSS −45 → PDF +45 (the y-up flip)
    expect(opts.opacity).toBe(0.5);
    expect(opts.size).toBeCloseTo(96 * 0.75, 5);
    expect(opts.x).toBeGreaterThanOrEqual(0);
    expect(opts.x).toBeLessThanOrEqual(LETTER_WM.width * 0.75);
    expect(opts.y).toBeGreaterThanOrEqual(0);
    expect(opts.y).toBeLessThanOrEqual(LETTER_WM.height * 0.75);
    // The anchor math consulted the real font metrics (the one metrics
    // source, export included).
    expect(fontSpy).toHaveBeenCalled();
    void result;
  });

  it('an image watermark embeds through the SAME media pipeline (the bytes key), rotated', async () => {
    const imageSpy = vi.spyOn(PDFPage.prototype, 'drawImage');
    const pages: PrintPage[] = [
      {
        index: 0,
        width: LETTER_WM.width,
        height: LETTER_WM.height,
        watermark: {
          kind: 'image',
          sha: 'abc',
          src: '',
          width: 400,
          height: 200,
          rotation: 0,
          opacity: 0.4,
        },
        elements: [],
      },
    ];
    await exportPdf({
      pages,
      info: {},
      // The embed seam: the PNG fixture bytes under the sha.
      mediaBytes: (sha) => (sha === 'abc' ? { bytes: TINY_PNG_WM, ext: 'png' } : undefined),
    });
    expect(imageSpy).toHaveBeenCalledTimes(1);
    const opts = imageSpy.mock.calls[0]![1]!;
    expect(opts.opacity).toBe(0.4);
    expect(opts.width).toBeCloseTo(300, 5); // 400px × 0.75
    expect(opts.height).toBeCloseTo(150, 5);
  });
});

describe('#WATERMARK: the DOCX export (Word\'s native VML watermarks)', () => {
  it('a text watermark rides the section header as the PowerPlusWaterMarkObject VML shape', async () => {
    const { bytes } = await buildDocx(wmInput(
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }] },
      { pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP, watermark: { kind: 'text', text: 'DRAFT' } } },
    ));
    const parts = unzipSync(bytes);
    const text = (part: string) => new TextDecoder().decode(parts[part]!);
    const xml = text('word/header1.xml');
    // Word's own watermark shape id (its remove command greps it).
    expect(xml).toContain('PowerPlusWaterMarkObject');
    expect(xml).toContain('DRAFT');
    // The diagonal: the lib spells CSS-sign degrees in the VML style
    // (rotation:-45 — Word's own documents write the same).
    expect(xml).toContain('rotation:-45');
    // The silver default + Word's semitransparent fill.
    expect(xml).toContain('fillcolor="#c0c0c0"');
    expect(xml).toContain('<v:fill opacity="0.5"/>');
  });

  it('a watermark-ONLY doc still emits its header part (the widened gate)', async () => {
    const { bytes } = await buildDocx(wmInput(
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }] },
      { pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP, watermark: { kind: 'text', text: 'DRAFT' } } },
    ));
    const parts = unzipSync(bytes);
    const text = (part: string) => new TextDecoder().decode(parts[part]!);
    expect(Object.keys(parts).some((k) => k.includes('header'))).toBe(true);
    expect(text('word/header1.xml')).toContain('DRAFT');
  });

  it('per-section watermarks: each section\'s header carries ITS watermark', async () => {
    const { editor } = renderTensor('<p>first</p>');
    await settleLayout();
    const { schema } = editor.state;
    act(() => {
      const brk = schema.nodes.sectionBreak.create({
        type: 'nextPage',
        setup: {
          pageSize: 'Letter',
          margins: DEFAULT_MARGINS,
          pageGap: PAGE_GAP,
          watermark: { kind: 'text', text: 'SECRET' },
        },
      });
      editor.view.dispatch(editor.state.tr.insert(7, brk));
    });
    const input = {
      json: editor.getJSON(),
      pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP },
      headerFooter: null,
      coreProperties: { title: 'wm', creator: 'Tensor' },
      styleDefinitions: [],
      baseStyle: { fontFamily: 'Source Serif 4', fontSize: 16 },
      media: new Map(),
    };
    const { bytes } = await buildDocx(input as never);
    const parts = unzipSync(bytes);
    const decoder = new TextDecoder();
    const headerXmls = Object.keys(parts).filter((k) => /header\d*\.xml$/.test(k));
    const texts = headerXmls.map((k) => decoder.decode(parts[k]!));
    expect(texts.some((xml) => xml.includes('SECRET'))).toBe(true);
  });

  it('no watermark → no VML anywhere (a plain doc exports exactly as before)', async () => {
    const { bytes } = await buildDocx(wmInput(
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }] },
    ));
    const text = (part: string) => new TextDecoder().decode(unzipSync(bytes)[part]!);
    expect(text('word/document.xml')).not.toContain('PowerPlusWaterMarkObject');
  });
});

describe('#WATERMARK: the documented gaps (the loud postures)', () => {
  it('markdown: the watermark is a lossy line + the confirm gate fires', () => {
    const report = analyzeMarkdownLossy({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }] }, true);
    expect(report.watermark).toBe(true);
    expect(hasLossyContent(report)).toBe(true);
    expect(markdownLossyLines(report)).toContain('Watermark (1)');
    // No watermark → no line, no gate.
    const clean = analyzeMarkdownLossy({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }] }, false);
    expect(hasLossyContent(clean)).toBe(false);
  });

  it('docx IMPORT: a Word watermark counts separately (named notice, not a generic shape skip)', () => {
    const parts = zipPartsWM({
      'word/document.xml': bodyWM(
        `<w:p><w:pict><v:shape id="PowerPlusWaterMarkObject1" style="position:absolute"><v:textpath string="DRAFT"/></v:shape></w:pict></w:p>`,
      ),
      'word/styles.xml': STYLES_XML_WM,
    });
    const parsed = mapDocxDocument(parseDocxTrees(parts), { fontPolicy: 'keep', mediaPartToId: new Map() });
    expect(parsed.report.watermarks).toBe(1);
    expect(parsed.report.textboxes).toBe(0);
    const lines = docxImportNoticeLines(parsed.report);
    expect(lines.some((l) => l.includes('Watermark skipped'))).toBe(true);
  });
});
