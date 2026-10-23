import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { useDocumentStore } from '@/lib/document/store';
import { useConfigStore } from '@/lib/config/store';
import { useRibbonContextStore } from '@/lib/ribbon/contextStore';
import {
  enableRegion,
  focusBand,
  blurToBody,
  setDifferentFirstPage,
  selectionInBand,
  hasBandContainer,
  findBandContainer,
} from '@/lib/editor/headerFooterCommands';
import { openDocument } from '@/lib/document/fileOperations';
import { DocumentFileSchema } from '@/lib/document/schema';
import { DEFAULT_MARGINS, PAGE_GAP } from '@/lib/document/pageSetup';
import { Ribbon } from '@/components/layout/Ribbon';
import { deriveRulerModel } from '@/lib/paginated/ruler';
import { renderTensor, settleLayout, GEOMETRY } from './harness';

// ─── .wpdoc simulation (the wpdoc.test simulator, trimmed) ────────────────

type Stored =
  | { kind: 'v2'; document: string; media: { id: string; ext: string; bytesB64: string }[] }
  | { kind: 'v1'; raw: string };

const wpdocFiles = vi.hoisted(() => new Map<string, Stored>());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: { path?: string; documentJson?: string; media?: unknown[] }) => {
    if (cmd === 'package_document') {
      wpdocFiles.set(args.path!, {
        kind: 'v2',
        document: args.documentJson!,
        media: (args.media ?? []) as { id: string; ext: string; bytesB64: string }[],
      });
      return null;
    }
    if (cmd === 'unpackage_document') {
      const file = wpdocFiles.get(args.path!);
      if (!file) throw new Error('file not found');
      if (file.kind === 'v1') throw new Error('NOT_ZIP: not a v2 container (v1 plain-JSON file?)');
      return { document: file.document, media: file.media };
    }
    throw new Error(`unexpected command: ${cmd}`);
  }),
}));

const dialogMocks = vi.hoisted(() => ({ openPath: null as string | null }));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => dialogMocks.openPath),
  save: vi.fn(async () => null),
  message: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: vi.fn(async () => {}),
  readTextFile: vi.fn(async (path: string) => {
    const file = wpdocFiles.get(path);
    if (file?.kind === 'v1') return file.raw;
    throw new Error('not a text file');
  }),
  exists: vi.fn(async () => false),
  mkdir: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn(async () => '/appdata'),
  join: vi.fn(async (...parts: string[]) => parts.join('/')),
}));

vi.mock('@/lib/document/recovery', () => ({
  clearRecoveryCopy: vi.fn(async () => {}),
  saveRecoveryCopy: vi.fn(async () => {}),
}));

// A 40-line paragraph × 3 → exactly 3 pages under FakeMetrics.
const longParagraph = `<p>${'a'.repeat(GEOMETRY.charsPerLine * 40)}</p>`;
const threePageDoc = longParagraph.repeat(3);

const PAGE_SETUP = { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP };

beforeEach(() => {
  useDocumentStore.setState({
    pageSetup: { ...PAGE_SETUP },
    headerFooter: null,
    filePath: null,
  });
  useRibbonContextStore.setState({ active: null });
  useConfigStore.getState().setShowHeadersFooters(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function settle() {
  await settleLayout();
}

const bandCanvases = () =>
  Array.from(document.querySelectorAll('canvas[data-band]')) as HTMLElement[];
const slotFor = (which: 'header' | 'footer') =>
  document.querySelector(`[data-testid="hf-slot-${which}"]`) as HTMLElement | null;

/** The first BODY canvas's top on page 0 (the reservation moves it). */
const firstBodyCanvasTop = (): number => {
  const page0 = document.querySelector('[data-page-index="0"]') as HTMLElement;
  const canvases = Array.from(page0.querySelectorAll('canvas:not([data-band])')) as HTMLElement[];
  const tops = canvases.map((c) => parseFloat(c.style.top)).filter((t) => !Number.isNaN(t));
  return Math.min(...tops);
};

// ─── Commands ────────────────────────────────────────────────────────────

describe('M-HEADER-FOOTER-2 commands', () => {
  it('a. enableRegion inserts the container + focuses its end (presence IS enablement)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { editor } = renderTensor(threePageDoc);
    await settle();

    expect(hasBandContainer(editor, 'header')).toBe(false);
    act(() => {
      enableRegion(editor, 'header');
    });
    await settle();

    expect(hasBandContainer(editor, 'header')).toBe(true);
    expect(hasBandContainer(editor, 'footer')).toBe(false);
    // The selection landed INSIDE the container (its end).
    expect(selectionInBand(editor)).toBe(true);
    // Re-enabling does NOT duplicate (find-then-insert).
    const count = editor.state.doc.childCount;
    act(() => {
      enableRegion(editor, 'header');
    });
    expect(editor.state.doc.childCount).toBe(count);
  });

  it('b. blurToBody hands the selection back to the first body block', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { editor } = renderTensor(threePageDoc);
    await settle();
    act(() => {
      enableRegion(editor, 'footer');
    });
    expect(selectionInBand(editor)).toBe(true);
    act(() => {
      blurToBody(editor);
    });
    expect(selectionInBand(editor)).toBe(false);
    // Focus lands in the FIRST body block (the header container comes
    // before it when present; footer after).
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');
  });
});

// ─── Paint + reservation (the unified pipeline) ───────────────────────────

describe('M-HEADER-FOOTER-2 paint + reservation', () => {
  it('c. a typed header paints on EVERY page and reserves body space', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { editor } = renderTensor(threePageDoc);
    await settle();

    const topBefore = firstBodyCanvasTop();
    act(() => {
      enableRegion(editor, 'header');
    });
    // An EMPTY band still paints its (empty) line — the anchor strip.
    await settle();

    // Type into the header.
    act(() => {
      editor.commands.insertContent('Chapter One');
    });
    await settle();

    // The body moved DOWN by the reservation (36pt→48px anchor + the
    // measured header line, max'd with the 96px margin; a one-line
    // header at 16px ⇒ 48+24 = 72 < 96 ⇒ margin still wins... the
    // reservation is max(margin, need): assert >= topBefore).
    const topAfter = firstBodyCanvasTop();
    expect(topAfter).toBeGreaterThanOrEqual(topBefore);

    // Band paint: a canvas per band block PER PAGE — 3 pages × 1
    // header paragraph = 3 band canvases (testid'd via the muted pass).
    expect(bandCanvases()).toHaveLength(3);
  });

  it('d. the View toggle hides the bands AND gives back the reservation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { editor } = renderTensor(threePageDoc);
    await settle();
    const topBefore = firstBodyCanvasTop();

    act(() => {
      enableRegion(editor, 'header');
    });
    await settle();
    expect(bandCanvases().length).toBeGreaterThan(0);

    act(() => {
      useConfigStore.getState().setShowHeadersFooters(false);
    });
    await settle();
    expect(bandCanvases()).toHaveLength(0);
    // The body reclaimed the band's reservation.
    expect(firstBodyCanvasTop()).toBe(topBefore);
    // The settings/model are untouched (display rides the layout only).
    expect(hasBandContainer(editor, 'header')).toBe(true);

    act(() => {
      useConfigStore.getState().setShowHeadersFooters(true);
    });
    await settle();
    expect(bandCanvases().length).toBeGreaterThan(0);
  });

  it('e. differentFirstPage: page 1 paints the first region, later pages the default', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { editor } = renderTensor(threePageDoc);
    await settle();

    act(() => {
      enableRegion(editor, 'header');
    });
    act(() => {
      setDifferentFirstPage(true);
    });
    await settle();

    // Insert the first-page variant container at the doc start (before
    // the default header), then focus it and type FIRST-only content.
    act(() => {
      editor.commands.insertContentAt(0, {
        type: 'headerBlock',
        attrs: { variant: 'first' },
        content: [{ type: 'paragraph' }],
      });
    });
    act(() => {
      focusBand(editor, 'header', 'first');
    });
    act(() => {
      editor.commands.insertContent('FIRST');
    });
    act(() => {
      focusBand(editor, 'header', 'default');
    });
    act(() => {
      editor.commands.insertContent('REST');
    });
    await settle();

    // The doc carries both variants; page 1 paints FIRST, pages 2..3 REST.
    const doc = editor.state.doc;
    const firstVariants: string[] = [];
    const defaultVariants: string[] = [];
    doc.forEach((node) => {
      if (node.type.name !== 'headerBlock') return;
      (node.attrs.variant === 'first' ? firstVariants : defaultVariants).push(
        node.textContent,
      );
    });
    expect(firstVariants.join('')).toContain('FIRST');
    expect(defaultVariants.join('')).toContain('REST');
    expect(useDocumentStore.getState().headerFooter?.differentFirstPage).toBe(true);
  });

  it('f. the double-click slot inserts (Word: double-click in the header area)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { editor } = renderTensor(threePageDoc);
    await settle();

    expect(slotFor('header')).not.toBeNull();
    fireEvent.dblClick(slotFor('header')!);
    await settle();

    expect(hasBandContainer(editor, 'header')).toBe(true);
    expect(selectionInBand(editor)).toBe(true);
    // The slot vanishes once the container exists.
    expect(slotFor('header')).toBeNull();
  });

  it('g. hit-test: a click in the header strip lands the caret IN the band', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { editor } = renderTensor(threePageDoc);
    await settle();
    act(() => {
      enableRegion(editor, 'header');
    });
    act(() => {
      editor.commands.insertContent('Chapter One');
    });
    await settle();

    // Click in the header strip on page 2: y ≈ 48px (the anchor) +
    // page-2 offset, x mid-page. resolveStackCoordinates-style math is
    // the harness's; use the stack's own hit path via dispatching a
    // mousedown with computed coords (GEOMETRY + zoom 1).
    const stack = document.querySelector('[data-testid="paginated-stack"]') as HTMLElement;
    const stackRect = { left: 0, top: 0 };
    // jsdom: getBoundingClientRect is mocked zero; the handler converts
    // (clientX - rect.left)/zoom — pass client coords directly.
    const page = 1;
    const y =
      stackRect.top + page * (GEOMETRY.pageHeight + PAGE_GAP) + 50;
    const x = stackRect.left + GEOMETRY.contentX + 40;
    fireEvent.mouseDown(stack, { clientX: x, clientY: y });
    await settle();

    expect(selectionInBand(editor)).toBe(true);
    const headerNode = editor.state.doc.child(0);
    expect(editor.state.selection.from).toBeLessThan(headerNode.nodeSize);
  });
});

// ─── Persistence ──────────────────────────────────────────────────────────

describe('M-HEADER-FOOTER-2 persistence', () => {
  it('h. content rides docJSON; settings ride metadata; round-trip identical', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { editor } = renderTensor(threePageDoc);
    await settle();

    act(() => {
      enableRegion(editor, 'header');
    });
    act(() => {
      editor.commands.insertContent('Chapter One');
    });
    act(() => {
      setDifferentFirstPage(true);
    });
    useDocumentStore.setState({ filePath: '/x/a.wpdoc', isDirty: false });
    await act(async () => {
      await useDocumentStore.getState().save();
    });

    // Save carries the settings + the node content (docJSON).
    const stored = wpdocFiles.get('/x/a.wpdoc')!;
    expect(stored.kind).toBe('v2');
    const file = JSON.parse((stored as { document: string }).document);
    const parsed = DocumentFileSchema.parse(file);
    expect(parsed.metadata.headerFooter?.differentFirstPage).toBe(true);
    expect(JSON.stringify(parsed.docJSON)).toContain('headerBlock');

    // Open it back: nodes + settings land.
    dialogMocks.openPath = '/x/a.wpdoc';
    const result = await act(async () => {
      return openDocument(editor);
    });
    expect(result!.headerFooter!.differentFirstPage).toBe(true);
    expect(hasBandContainer(editor, 'header')).toBe(true);
    expect(JSON.stringify(editor.getJSON())).toContain('Chapter One');
  });

  it('i. the v1 legacy migration translates region docs into nodes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { editor } = renderTensor('<p>hello</p>');
    await settle();

    const legacyDoc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Legacy header text' }] },
      ],
    };
    wpdocFiles.set('/x/legacy.wpdoc', {
      kind: 'v1',
      raw: JSON.stringify({
        version: 1,
        docJSON: { type: 'doc', content: [{ type: 'paragraph' }] },
        metadata: {
          headerFooter: {
            scope: { kind: 'document' },
            headerEnabled: true,
            footerEnabled: false,
            differentFirstPage: true,
            header: { doc: legacyDoc },
            footer: { doc: null },
            firstHeader: { doc: null },
            firstFooter: { doc: null },
          },
        },
      }),
    });
    dialogMocks.openPath = '/x/legacy.wpdoc';
    const result = await act(async () => {
      return openDocument(editor);
    });

    // The legacy region doc became a headerBlock node; the flag rides
    // the settings; enables are gone (presence IS enablement).
    expect(result!.headerFooter!.differentFirstPage).toBe(true);
    expect(hasBandContainer(editor, 'header')).toBe(true);
    expect(JSON.stringify(editor.getJSON())).toContain('Legacy header text');
    expect(JSON.stringify(editor.getJSON())).toContain('headerBlock');
  });

  it('j. an old file (no headerFooter metadata) opens with settings null', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { editor } = renderTensor('<p>hello</p>');
    await settle();

    wpdocFiles.set('/x/old.wpdoc', {
      kind: 'v1',
      raw: JSON.stringify({ version: 1, docJSON: {}, metadata: {} }),
    });
    dialogMocks.openPath = '/x/old.wpdoc';
    const result = await act(async () => {
      return openDocument(editor);
    });
    expect(result!.headerFooter).toBeNull();
  });
});

// ─── Ribbon ───────────────────────────────────────────────────────────────

describe('M-HEADER-FOOTER-2 ribbon', () => {
  it('k. the contextual tab follows the selection into a band and back', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { editor } = renderTensor(threePageDoc);
    await settle();
    render(<Ribbon />);

    expect(useRibbonContextStore.getState().active).toBeNull();
    act(() => {
      enableRegion(editor, 'header');
    });
    await settle();
    expect(useRibbonContextStore.getState().active).toBe('headerFooter');
    const trigger = document.querySelector('[data-testid="contextual-tab-trigger"]') as HTMLElement;
    expect(trigger.className).toContain('text-primary!');

    act(() => {
      blurToBody(editor);
    });
    await settle();
    expect(useRibbonContextStore.getState().active).toBeNull();
  });
});
// ─── M-HEADER-FOOTER-3: the echo-projection fixes (end to end) ────────────

describe('M-HEADER-FOOTER-3 echo fixes', () => {
  const STRIDE = GEOMETRY.pageHeight + PAGE_GAP; // 1088
  const stack = () =>
    document.querySelector('[data-testid="paginated-zoom-wrapper"]') as HTMLElement;
  const selRects = () =>
    [...document.querySelectorAll('[data-testid="selection-rect"]')] as HTMLElement[];
  const caret = () =>
    document.querySelector('[data-testid="synthetic-caret"]') as HTMLElement | null;

  /** Header with 'Chapter One' on a 3-page doc, settled. */
  async function docWithHeader() {
    const { editor } = renderTensor(threePageDoc);
    await settle();
    act(() => {
      enableRegion(editor, 'header');
    });
    act(() => {
      editor.commands.insertContent('Chapter One');
    });
    await settle();
    return { editor };
  }

  it('band-extent rule: clicks ON the band route to it; margin clicks fall to the body', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { editor } = await docWithHeader();
    const x = GEOMETRY.contentX + 15;

    // ON the band (page 2's echo, page-relative y=50): the header takes it.
    fireEvent.mouseDown(stack(), { clientX: x, clientY: STRIDE + 50 });
    await settle();
    expect(selectionInBand(editor)).toBe(true);

    // BELOW the band, still in the top margin (page-relative y=85): the
    // body's nearest-line clamp (the pre-band behavior) — the v2 strip
    // rule swallowed these.
    fireEvent.mouseDown(stack(), { clientX: x, clientY: STRIDE + 85 });
    await settle();
    expect(selectionInBand(editor)).toBe(false);

    // ABOVE the band (page-relative y=20) — also body.
    fireEvent.mouseDown(stack(), { clientX: x, clientY: STRIDE + 20 });
    await settle();
    expect(selectionInBand(editor)).toBe(false);
  });

  it('the caret projects onto the CLICKED page echo (not page 0)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { editor } = await docWithHeader();
    fireEvent.mouseDown(stack(), { clientX: GEOMETRY.contentX + 15, clientY: STRIDE + 50 });
    await settle();
    expect(selectionInBand(editor)).toBe(true);
    // Caret top = stride·1 + contentBox.y(96) + band rect.y(48−96) = 1136.
    expect(caret()?.style.top).toBe(`${STRIDE + 96 - 48}px`);
  });

  it('dblclick word-select works in the band and paints ONE page echo only', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { editor } = await docWithHeader();
    const x = GEOMETRY.contentX + 5;
    const y = STRIDE + 50;
    // The double click: two mousedowns at the same spot inside 500ms.
    fireEvent.mouseDown(stack(), { clientX: x, clientY: y });
    fireEvent.mouseDown(stack(), { clientX: x, clientY: y });
    await settle();

    // PM word range selected, inside the band container.
    expect(selectionInBand(editor)).toBe(true);
    expect(editor.state.selection.from).toBeLessThan(editor.state.selection.to);
    // Painted selection: ONE rect — on the CLICKED page's echo, with
    // the word's width ('Chapter' = 7 chars × 10px), never the
    // all-pages echoes or a full-width stripe.
    const rects = selRects();
    expect(rects).toHaveLength(1);
    expect(parseFloat(rects[0].style.top)).toBe(STRIDE + 96 - 48);
    expect(parseFloat(rects[0].style.width)).toBe(70);
  });

  it('differentFirstPage: the page-0 slot dblclick creates + focuses the FIRST variant', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { editor } = renderTensor(threePageDoc);
    await settle();
    act(() => {
      enableRegion(editor, 'header');
    });
    act(() => {
      setDifferentFirstPage(true);
    });
    await settle();

    // Page 0 paints the (absent) first variant → its slot is live.
    const slot = document.querySelector('[data-testid="hf-slot-header"]') as HTMLElement | null;
    expect(slot).not.toBeNull();
    fireEvent.dblClick(slot!);
    await settle();

    expect(findBandContainer(editor, 'header', 'first') != null).toBe(true);
    expect(selectionInBand(editor)).toBe(true);
    // The selection sits in the FIRST variant container.
    const { $from } = editor.state.selection;
    let variant: string | null = null;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === 'headerBlock') {
        variant = $from.node(d).attrs.variant ?? 'default';
      }
    }
    expect(variant).toBe('first');
  });

  it('cross-surface selection (body anchor → band head) paints the BODY side only', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { editor } = await docWithHeader();
    // Anchor inside the first BODY paragraph, head inside the header.
    const headerTextStart = 2; // container open + paragraph open + 1
    const bodyTextStart = 16; // past the header container (nodeSize 14 for 12 chars) + body <p>
    act(() => {
      editor.commands.setTextSelection({ from: bodyTextStart + 2, to: headerTextStart + 3 });
    });
    await settle();
    // PM carries the full range; the PAINT clamps to the anchor's
    // surface: every rect is a body line (top ≥ the content box top),
    // never a band echo (top < content box).
    const rects = selRects();
    expect(rects.length).toBeGreaterThan(0);
    for (const r of rects) {
      expect(parseFloat(r.style.top)).toBeGreaterThanOrEqual(96);
    }
  });
});

// ─── M-HEADER-FOOTER-3: tab stops in bands + margin-scaled anchors ────────

describe('M-HEADER-FOOTER-3 final fixes', () => {
  const caretEl = () =>
    document.querySelector('[data-testid="synthetic-caret"]') as HTMLElement | null;

  it('tab stops work in band paragraphs (ruler model + command + engine advance)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { editor } = renderTensor(threePageDoc);
    await settle();
    act(() => {
      enableRegion(editor, 'header');
    });
    act(() => {
      editor.commands.insertContent('Chapter One');
    });
    await settle();

    // The ruler MODEL derives from the band paragraph (the v2 spelling
    // read the CONTAINER at depth 1 and went margins-only).
    const model = deriveRulerModel(editor.state);
    expect(model).not.toBeNull();

    // The command targets the band PARAGRAPH (the v2 spelling hit the
    // container and no-oped — "clicking the ruler never inserts").
    act(() => {
      editor.commands.setTabStops([{ position: 200, alignment: 'left' }]);
    });
    const headerPara = editor.state.doc.nodeAt(1);
    expect(headerPara?.type.name).toBe('paragraph');
    expect(headerPara?.attrs.tabStops).toEqual([{ position: 200, alignment: 'left' }]);

    // The ENGINE advances a typed \t to the stop: caret lands at x=200
    // (contentBox-relative) — the band line's placed pen jumps there.
    act(() => {
      editor.commands.insertContent('\t');
    });
    await settle();
    // Caret left = contentBox.x(96) + stop(200); the band is on page 0
    // (the viewport fallback — no band click in this test).
    expect(parseFloat(caretEl()!.style.left)).toBe(96 + 200);
  });

  it('bands scale with the margins (the anchor clamps down)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { editor } = renderTensor(threePageDoc);
    await settle();
    act(() => {
      enableRegion(editor, 'header');
    });
    act(() => {
      editor.commands.insertContent('Chapter One');
    });
    await settle();

    // Default margins (96px) leave the band at its 48px anchor.
    const bandCanvas = document.querySelector('canvas[data-band]') as HTMLElement;
    expect(bandCanvas.style.top).toBe('48px');

    // Top margin dragged to 0: the band hugs the page edge (anchor
    // clamps to 0) and the body starts right below the band's need.
    act(() => {
      const ps = useDocumentStore.getState().pageSetup;
      useDocumentStore.getState().setPageSetup({
        ...ps,
        margins: { ...ps.margins, top: 0 },
      });
    });
    await settle();
    const bandAfter = document.querySelector('canvas[data-band]') as HTMLElement;
    expect(bandAfter.style.top).toBe('0px');
    const bodyCanvas = document.querySelector(
      '[data-page-index="0"] canvas:not([data-band])',
    ) as HTMLElement;
    // Body top = the band's 16px line height (FakeMetrics) — no gap at
    // margin 0, the band's own reservation.
    expect(parseFloat(bodyCanvas.style.top)).toBe(16);
  });
});
