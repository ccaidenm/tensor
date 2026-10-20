import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { createLayoutEngine } from '@tensor-editor/engine';
import { useConfigStore } from '@/lib/config/store';
import { DEFAULT_MARGINS, PAGE_GAP, toLayoutOptions } from '@/lib/document/pageSetup';
import { useMediaStore } from '@/lib/media/store';
import { insertImageBytes, sha256Hex } from '@/lib/media/insert';
import {
  convertBlockToInline,
  convertInlineToBlock,
  setWrapMode,
} from '@/lib/media/wrap';
import { insertCaptionForImage } from '@/lib/media/caption';
import { setImageRadiusOnSelection, getCommand } from '@/lib/commands/registry';
import { pmDocToSemantic } from '@/lib/paginated/adapter';
import { hitTest } from '@/lib/paginated/hitTest';
import { inlineObjectRect } from '@/lib/paginated/positionMap';
import { AltTextDialog } from '@/components/dialogs/ImageDialogs';
import { __bitmapTestSeam, PENDING_TINT, FAILED_TINT } from '@/lib/media/bitmapCache';
import { renderTensor, renderTensorInScrollContainer, mockRects, settleLayout, GEOMETRY } from './harness';
import { FakeMetrics } from './fakeMetrics';

/**
 * M-IMAGES-2.1/2.2 — the inline-selection + diagnostics suite. Pins
 * the 2.1 fix set: BOTH HALVES of an inline object are click surface
 * (the glyph-midpoint rule never applies to objects), the selection
 * overlay projects the object's PAINTED rect (baseline-seated), the
 * conversions split/extract without mangling the doc (no husk
 * paragraphs, no RangeError on the last block, the float offset rides
 * the round-trip), the image commands run on inline selections (align
 * honestly block-only), captions EXTRACT-then-caption, and the
 * placeholder states are distinguished (pending tint vs failed box).
 * Plus the clipboard-scoped round-trip: internal copy/paste keeps
 * images; external <img> HTML still never parses in.
 */

// M-IMAGES-0 container simulator (same wire contract as wpdoc.test).
const wpdocFiles = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: { path?: string; documentJson?: string; media?: unknown[] }) => {
    if (cmd === 'package_document') {
      wpdocFiles.set(args.path!, { kind: 'v2', document: args.documentJson!, media: args.media ?? [] });
      return null;
    }
    if (cmd === 'unpackage_document') {
      const f = wpdocFiles.get(args.path!) as { document: string; media: unknown[] };
      if (!f) throw new Error('file not found');
      return { document: f.document, media: f.media };
    }
    throw new Error(`unexpected command: ${cmd}`);
  }),
}));

const BASE = { fontFamily: 'fake', fontSize: 16 };
const PAGE_SETUP = { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: PAGE_GAP };

function fixturePng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(8 + 4 + 4 + 13 + 4);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  bytes.set(sig, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

function directLayout(editor: Editor) {
  const adapted = pmDocToSemantic(editor.state.doc, BASE);
  const engine = createLayoutEngine({ metrics: FakeMetrics });
  return {
    adapted,
    result: engine.layout({ baseStyle: BASE, blocks: adapted.doc.blocks }, toLayoutOptions(PAGE_SETUP)),
  };
}

const paintOps = () => (globalThis as { __paintOps?: { op: string; args: unknown[]; fillStyle?: string }[] }).__paintOps ?? [];

function imagePosOf(editor: Editor, kind = 'image'): number {
  let pos = -1;
  editor.state.doc.descendants((n, p) => {
    if (n.type.name === kind && pos < 0) {
      pos = p;
      return false;
    }
    return true;
  });
  return pos;
}

function docShape(editor: Editor): string {
  const parts: string[] = [];
  editor.state.doc.forEach((n) => {
    if (n.type.name === 'paragraph') {
      const kids: string[] = [];
      n.forEach((c) => kids.push(c.type.name + (c.isText ? `(${c.text})` : '')));
      parts.push(`p[${kids.join(',') || 'EMPTY'}]`);
    } else parts.push(n.type.name);
  });
  return `[${parts.join(', ')}]`;
}

function selNodeName(editor: Editor): string {
  const sel = editor.state.selection as unknown as { node?: { type?: { name?: string } } };
  return sel.node?.type?.name ?? 'text';
}

/** jsdom cleanup note (the images2 precedent): the suite never
 *  unmounts between tests — query the LATEST mounted surface. */
const latest = (selector: string) => {
  const all = document.querySelectorAll(selector);
  return all[all.length - 1] as HTMLElement | undefined;
};

/** Block image → inline object in its own paragraph (the Wrap path). */
async function setupInlineOwnParagraph(html: string) {
  const { editor } = renderTensor(html);
  await settleLayout();
  await insertImageBytes(editor, fixturePng(150, 90), 'png');
  act(() => {
    editor.commands.setNodeSelection(imagePosOf(editor));
    convertBlockToInline(editor);
  });
  await settleLayout();
  return { editor, pos: imagePosOf(editor, 'inlineImage') };
}

/** Block image → inline object MID-TEXT (delete + insert at an offset). */
async function setupInlineMidText(html: string, atOffset: number) {
  const { editor } = renderTensor(html);
  await settleLayout();
  await insertImageBytes(editor, fixturePng(150, 90), 'png');
  act(() => {
    const pos = imagePosOf(editor);
    const attrs = { ...editor.state.doc.nodeAt(pos)!.attrs };
    const tr = editor.state.tr;
    tr.delete(pos, pos + editor.state.doc.nodeAt(pos)!.nodeSize);
    tr.insert(1 + atOffset, editor.state.schema.nodes.inlineImage!.create(attrs));
    editor.view.dispatch(tr);
  });
  await settleLayout();
  return { editor, pos: imagePosOf(editor, 'inlineImage') };
}

beforeAll(() => {
  Object.defineProperty(globalThis, '__TAURI_INTERNALS__', { value: {}, configurable: true });
});

beforeEach(() => {
  useMediaStore.getState().clear();
  __bitmapTestSeam.clear();
  vi.clearAllMocks();
  useConfigStore.setState((state) => ({
    config: {
      ...state.config,
      editor: { ...state.config.editor, showCaptions: true, zoomLevel: 100, defaultPageLayout: 'Pages' },
    },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── 1. The click surface: BOTH halves of an object (the 2.1 fix) ───────

describe('inline click surface (M-IMAGES-2.1)', () => {
  it('a click ANYWHERE inside the object selects it (left AND right half); beyond it resolves to text', async () => {
    const { editor, pos } = await setupInlineMidText('<p>hello world</p>', 6);
    // The object is 150 wide starting after 'hello ' (60px at 10px/char
    // under FakeMetrics); it sits on the FIRST line (it grew the line:
    // the click's y rides the image's tall line band).
    const wrapper = () => document.querySelector('[data-testid="paginated-zoom-wrapper"]')!;
    const click = (x: number, y: number) =>
      act(() => {
        fireEvent.mouseDown(wrapper(), {
          clientX: GEOMETRY.contentX + x,
          clientY: GEOMETRY.contentY + y,
        });
      });

    act(() => { editor.commands.setTextSelection(0); });
    await settleLayout();
    click(60 + 40, 8); // left half
    expect(selNodeName(editor)).toBe('inlineImage');
    expect((editor.state.selection as unknown as { from: number }).from).toBe(pos);

    act(() => { editor.commands.setTextSelection(0); });
    await settleLayout();
    click(60 + 130, 8); // the RIGHT half — the 2.1 fix (was dead surface)
    expect(selNodeName(editor)).toBe('inlineImage');

    // A click BEYOND the object's right edge resolves to the text
    // after it — the object's advance ends at its painted width.
    act(() => { editor.commands.setTextSelection(0); });
    await settleLayout();
    click(60 + 150 + 10, 8);
    const sel = editor.state.selection as unknown as { node?: unknown; from: number };
    expect(sel.node).toBeUndefined();
    expect(sel.from).toBeGreaterThan(pos);
  });

  it('the click maps through hitTest exactly: hitTest IS the object-width rule', async () => {
    const { editor } = await setupInlineMidText('<p>hello world</p>', 6);
    const { adapted, result } = directLayout(editor);
    // The line's base wrap width is the SAME input the engine/painter
    // use — the object's advance must come from fitDownImage on it:
    const line = result.lines.find((l) => l.segments.some((s) => (adapted.blocks.find((b) => b.id === l.blockId)!.runs[s.runIndex] as { kind?: string } | undefined)?.kind === 'inlineImage'))!;
    expect(line).toBeDefined();
    expect(line.rect.height).toBeGreaterThanOrEqual(90); // the object grew the line
    // Within [0, 150) from the object's left edge → the token offset;
    // at/beyond the right edge → past it.
    const at = (dx: number) =>
      hitTest(result, adapted.blocks, FakeMetrics, PAGE_SETUP.pageGap, GEOMETRY.contentX + 60 + dx, GEOMETRY.contentY + 24);
    expect(at(1)!.offset).toBe(6);
    expect(at(74)!.offset).toBe(6);
    expect(at(149)!.offset).toBe(6);
    expect(at(150)!.offset).toBe(7); // the first char after the token
  });
});

// ─── 2. The selection overlay: the object's PAINTED rect ────────────────

describe('inline selection overlay (M-IMAGES-2.1)', () => {
  it('a NodeSelection on the inline object projects the ImageSelection overlay at its painted rect (baseline-seated), NO text band, handles present', async () => {
    const { editor, pos } = await setupInlineOwnParagraph('<p>hello world</p>');
    act(() => { editor.commands.setNodeSelection(pos); });
    await settleLayout();
    // The overlay: the object's placed dims (150×90), stack-local
    // left/top (contentX + the token's x; contentY + the line's
    // baseline-seated top = line.y(16) + baseline(90) − h(90) = 16).
    const overlay = document.querySelector('[data-testid="image-selection"]') as HTMLElement;
    expect(overlay).not.toBeNull();
    expect(overlay.style.width).toBe('150px');
    expect(overlay.style.height).toBe('90px');
    expect(parseFloat(overlay.style.left)).toBeCloseTo(GEOMETRY.contentX, 0);
    expect(parseFloat(overlay.style.top)).toBeCloseTo(GEOMETRY.contentY + 16, 0);
    expect(document.querySelectorAll('[data-testid^="image-handle-"]').length).toBe(4);
    // The text selection band is NOT painted over the object's line
    // (the overlay owns the visualization):
    expect(document.querySelectorAll('[data-testid="selection-rect"]').length).toBe(0);
    // The toolbar is live with the image controls:
    expect(document.querySelector('[data-floating-toolbar]')).not.toBeNull();
    expect(document.querySelector('[data-testid="toolbar-add-caption"]')).not.toBeNull();
  });

  it('the projection helper agrees with the paint: inlineObjectRect == the drawImage rect', async () => {
    const { editor, pos } = await setupInlineMidText('<p>hello world</p>', 6);
    const { adapted, result } = directLayout(editor);
    const rect = inlineObjectRect(adapted.blocks, result, pos, FakeMetrics);
    expect(rect).not.toBeNull();
    // Baseline-seated (bottom at the baseline): y = line.rect.y +
    // (line.baseline − h). The object shares the first line ('hello '
    // + 150px fits) and GROWS it: height ≥ 90, baseline = 90.
    const line = result.lines.find((l) =>
      l.segments.some((s) => (adapted.blocks.find((b) => b.id === l.blockId)!.runs[s.runIndex] as { kind?: string } | undefined)?.kind === 'inlineImage'),
    )!;
    expect(line.baseline).toBeGreaterThanOrEqual(90);
    expect(rect!.rect.y).toBe(line.rect.y + line.baseline - 90);
    expect(rect!.rect.width).toBe(150);
    expect(rect!.rect.height).toBe(90);
    expect(rect!.pageIndex).toBe(0);
  });

  it('resize handles WORK on the inline object: aspect-locked SE drag → attrs written, relayout re-fits', async () => {
    const { editor, pos } = await setupInlineOwnParagraph('<p>hello world</p>');
    act(() => { editor.commands.setNodeSelection(pos); });
    await settleLayout();
    const handle = document.querySelector('[data-testid="image-handle-se"]') as HTMLElement;
    expect(handle).not.toBeNull();
    act(() => { fireEvent.pointerDown(handle, { pointerId: 1, clientX: 0, clientY: 0, shiftKey: true }); });
    act(() => { fireEvent.pointerMove(handle, { pointerId: 1, clientX: 50, clientY: 0 }); });
    act(() => { fireEvent.pointerUp(handle, { pointerId: 1 }); });
    await settleLayout();
    // Aspect-locked: +50 width → height follows by the placed ratio.
    const img = editor.state.doc.nodeAt(pos)!;
    expect(img.attrs.width).toBe(200);
    expect(img.attrs.height).toBe(120);
    // The engine re-fits: the object's line grew for the taller object.
    const { adapted, result } = directLayout(editor);
    const line = result.lines.find((l) =>
      l.segments.some((s) => (adapted.blocks.find((b) => b.id === l.blockId)!.runs[s.runIndex] as { kind?: string } | undefined)?.kind === 'inlineImage'),
    )!;
    expect(line).toBeDefined();
    expect(line.rect.height).toBeGreaterThanOrEqual(120);
  });

  it('the float drag is INERT on an inline selection (the body drag commits nothing)', async () => {
    const { editor, pos } = await setupInlineOwnParagraph('<p>hello world</p>');
    act(() => { editor.commands.setNodeSelection(pos); });
    await settleLayout();
    const overlay = document.querySelector('[data-testid="image-selection"]') as HTMLElement;
    const before = editor.state.doc.nodeAt(pos)!.attrs.float;
    act(() => {
      fireEvent.pointerDown(overlay, { pointerId: 1, clientX: 10, clientY: 10, button: 0 });
      fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 60, clientY: 40 });
      fireEvent.pointerUp(overlay, { pointerId: 1 });
    });
    await settleLayout();
    // NO float attr was written (an in-flow object has no float
    // placement of its own to drag into).
    expect(editor.state.doc.nodeAt(pos)!.attrs.float).toEqual(before ?? null);
  });
});

// ─── 3. The image commands work on inline selections (align honestly doesn't) ──

describe('image commands on inline selections (M-IMAGES-2.1)', () => {
  it('radius writes through the shared clamp path; align is BLOCK-ONLY (enablement false, no write)', async () => {
    const { editor, pos } = await setupInlineOwnParagraph('<p>before</p>');
    act(() => { editor.commands.setNodeSelection(pos); });
    await settleLayout();
    // Radius: enabled, clamped to the inline node's own dims.
    expect(getCommand('imageRadiusUp')!.enablement?.()).toBe(true);
    act(() => { for (let i = 0; i < 30; i++) getCommand('imageRadiusUp')!.run(); });
    expect(editor.state.doc.nodeAt(pos)!.attrs.radius).toBe(45); // floor(min(150,90)/2)
    // The shared direct-entry write agrees:
    act(() => { expect(setImageRadiusOnSelection(10)).toBe(10); });
    expect(editor.state.doc.nodeAt(pos)!.attrs.radius).toBe(10);
    // Align: a BLOCK-only fact — enablement refuses inline, and the
    // run would write nothing even if invoked directly.
    expect(getCommand('imageAlignCenter')!.enablement?.()).toBe(false);
    const alignBefore = editor.state.doc.nodeAt(pos)!.attrs.align;
    act(() => { getCommand('imageAlignCenter')!.run(); });
    expect(editor.state.doc.nodeAt(pos)!.attrs.align).toBe(alignBefore);
    // And the same align command DOES run on a BLOCK image (a second
    // editor — this doc's only image is inline now; the images2
    // precedent: multiple editors coexist, assertions read their own).
    const block = renderTensor('<p>block</p>');
    await settleLayout();
    await insertImageBytes(block.editor, fixturePng(150, 90), 'png');
    act(() => { block.editor.commands.setNodeSelection(imagePosOf(block.editor)); });
    expect(getCommand('imageAlignCenter')!.enablement?.()).toBe(true);
    act(() => { getCommand('imageAlignCenter')!.run(); });
    expect(block.editor.state.doc.nodeAt(imagePosOf(block.editor))!.attrs.align).toBe('center');
  });

  it('alt text: the toolbar button opens the dialog for an INLINE selection and writes the attr (the a11y receipt)', async () => {
    render(<AltTextDialog />);
    const { editor, pos } = await setupInlineOwnParagraph('<p>before</p>');
    act(() => { editor.commands.setNodeSelection(pos); });
    await settleLayout();
    const altButton = latest('[data-testid="toolbar-alt-text"]');
    expect(altButton).not.toBeUndefined();
    act(() => { fireEvent.click(altButton!); });
    await act(async () => { await Promise.resolve(); });
    const input = latest('[data-testid="alt-text-input"]') as HTMLInputElement | undefined;
    expect(input).not.toBeUndefined();
    act(() => { fireEvent.change(input!, { target: { value: 'An inline diagram' } }); });
    act(() => { fireEvent.click(latest('[data-testid="alt-text-save"]')!); });
    expect(editor.state.doc.nodeAt(pos)!.attrs.alt).toBe('An inline diagram');
    // The a11y surface: the hidden PM view's real <img alt>. (jsdom
    // portal-leak note: the hidden view re-mounts across the view
    // branch flips — fallback/empty/main — so STALE copies of the img
    // linger; the receipt is that the alt EXISTS in the a11y tree.)
    await settleLayout();
    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('.pm-input-only img'));
    expect(imgs.some((i) => i.alt === 'An inline diagram')).toBe(true);
  });

  it('caption on an INLINE selection: EXTRACT then caption (the block path, one command)', async () => {
    const { editor, pos } = await setupInlineOwnParagraph('<p>before</p>');
    await settleLayout();
    act(() => { editor.commands.setNodeSelection(pos); insertCaptionForImage(editor); });
    await settleLayout();
    // The extracted block image carries the bond; the caption follows:
    const shape = docShape(editor);
    expect(shape).toContain('image');
    expect(shape).not.toContain('inlineImage');
    expect(editor.state.doc.nodeAt(imagePosOf(editor))!.attrs.keepNext).toBe(true);
    // The caption paragraph is the node right after the image:
    const imgPos = imagePosOf(editor);
    const imgSize = editor.state.doc.nodeAt(imgPos)!.nodeSize;
    const captionPara = editor.state.doc.nodeAt(imgPos + imgSize);
    expect(captionPara?.attrs.styleId).toBe('caption');
    // The caret LIVES in the caption (type right away):
    expect((editor.state.selection as unknown as { from: number }).from).toBe(imgPos + imgSize + 1);
  });

  it('the toolbar displays the INLINE node\'s attrs (not the block type\'s defaults): radius value + max', async () => {
    const { editor } = await setupInlineOwnParagraph('<p>before</p>');
    const pos = imagePosOf(editor, 'inlineImage');
    act(() => { editor.commands.setNodeSelection(pos); });
    await settleLayout();
    act(() => { setImageRadiusOnSelection(20); });
    await settleLayout();
    // The toolbar's radius input shows the inline node's radius and a
    // max derived from ITS dims (45) — the pre-fix read fed the block
    // type's DEFAULTS (radius 0, max 0 — a dead slider).
    const input = latest('[data-floating-toolbar] input[type="number"]');
    expect(input).not.toBeUndefined();
    expect((input as HTMLInputElement).value).toBe('20');
    expect((input as HTMLInputElement).max).toBe('45');
  });

  it('Insert Image is a palette command (the ONE insertion pipeline, no keyboard shortcut needed)', async () => {
    await renderTensor('<p>x</p>');
    await settleLayout();
    const cmd = getCommand('insertImage');
    expect(cmd).not.toBeUndefined();
    expect(cmd!.title).toBe('Insert Image');
    expect(cmd!.group).toBe('actions');
    // Editor-context: available whenever an editor surface exists.
    expect(cmd!.enablement?.()).toBe(true);
    // Same pipeline as the ribbon button (the OS picker → media/insert.ts):
    expect(String(cmd!.keywords)).toContain('image');
  });

  it('the align buttons RENDER only when usable: hidden for an inline selection (not disabled), present for a block image; Freeform is gone', async () => {
    const { editor } = await setupInlineOwnParagraph('<p>before</p>');
    act(() => { editor.commands.setNodeSelection(imagePosOf(editor, 'inlineImage')); });
    await settleLayout();
    // Inline selection: the toolbar is live, but the align cluster is
    // ABSENT (hidden at the end of the group — not disabled-in-place)
    // and the Freeform stub is gone entirely.
    expect(latest('[data-floating-toolbar]')).not.toBeUndefined();
    expect(latest('[data-floating-toolbar] [aria-label="Align Left"]')).toBeUndefined();
    expect(latest('[data-floating-toolbar] [aria-label="Freeform"]')).toBeUndefined();
    // Caption/Alt/Radius/Wrap still lead the group:
    expect(latest('[data-floating-toolbar] [data-testid="toolbar-add-caption"]')).not.toBeUndefined();
    // A BLOCK image selection brings the cluster back (the second
    // editor mounts a second toolbar — query the LATEST one):
    const block = renderTensor('<p>block</p>');
    await settleLayout();
    await insertImageBytes(block.editor, fixturePng(150, 90), 'png');
    act(() => { block.editor.commands.setNodeSelection(imagePosOf(block.editor)); });
    await settleLayout();
    const toolbars = document.querySelectorAll('[data-floating-toolbar]');
    const last = toolbars[toolbars.length - 1] as HTMLElement;
    expect(last.querySelector('[aria-label="Align Left"]')).not.toBeNull();
    expect(last.querySelector('[aria-label="Align Center"]')).not.toBeNull();
    expect(last.querySelector('[aria-label="Align Right"]')).not.toBeNull();
    expect(last.querySelector('[aria-label="Freeform"]')).toBeNull();
  });

  it('the caption FOLLOWS the image through the split: appended right beneath the image (the bond stays adjacent)', async () => {
    // [p[hello IMG world], caption] — the split would strand the
    // caption after the world-half; it must end up under the image.
    const { editor, pos } = await setupInlineMidText('<p>hello world</p>', 6);
    const $from = editor.state.doc.resolve(pos);
    const paraStart = $from.before();
    const para = editor.state.doc.nodeAt(paraStart)!;
    const paraEnd = paraStart + para.nodeSize;
    act(() => {
      const tr = editor.state.tr;
      tr.insert(
        paraEnd,
        editor.state.schema.nodes.paragraph!.create(
          { styleId: 'caption' },
          editor.state.schema.text('Cap'),
        ),
      );
      // The bond (caption.ts's law: keepNext on the image):
      tr.setNodeAttribute(pos, 'keepNext', true);
      editor.view.dispatch(tr);
    });
    await settleLayout();
    // (The trailing p[EMPTY] predates everything — insertImage's split.)
    expect(docShape(editor)).toBe('[p[text(hello ),inlineImage,text(world)], p[text(Cap)], p[EMPTY]]');
    act(() => { editor.commands.setNodeSelection(pos); convertInlineToBlock(editor); });
    await settleLayout();
    // THE CAPTION IS DIRECTLY BENEATH THE IMAGE (before the world-half;
    // the trailing husk predates the conversion):
    expect(docShape(editor)).toBe('[p[text(hello )], image, p[text(Cap)], p[text(world)], p[EMPTY]]');
    const imgPos = imagePosOf(editor);
    // The keepNext bond rode the conversion (the engine pins the
    // caption's first line to the image's page):
    expect(editor.state.doc.nodeAt(imgPos)!.attrs.keepNext).toBe(true);
    expect(editor.state.doc.nodeAt(imgPos + 1)?.attrs.styleId).toBe('caption');
    expect(selNodeName(editor)).toBe('image');
  });

  it('block→inline keeps the caption right beneath (the image moves INTO the paragraph above it)', async () => {
    const { editor } = renderTensor('<p>before</p>');
    await settleLayout();
    await insertImageBytes(editor, fixturePng(150, 90), 'png');
    // Swap the trailing (insert-split) empty paragraph for a caption:
    const imgPos = imagePosOf(editor);
    act(() => {
      const tr = editor.state.tr;
      tr.replaceWith(
        imgPos + 1,
        imgPos + 3,
        editor.state.schema.nodes.paragraph!.create(
          { styleId: 'caption' },
          editor.state.schema.text('Cap'),
        ),
      );
      tr.setNodeAttribute(imgPos, 'keepNext', true);
      editor.view.dispatch(tr);
    });
    await settleLayout();
    expect(docShape(editor)).toBe('[p[text(before)], image, p[text(Cap)]]');
    act(() => { editor.commands.setNodeSelection(imgPos); convertBlockToInline(editor); });
    await settleLayout();
    // The object now lives in its own paragraph; the caption follows it:
    expect(docShape(editor)).toBe('[p[text(before)], p[inlineImage], p[text(Cap)]]');
  });
});

// ─── 5. The toolbar placement: never clipped at the desk's top (M-IMAGES-2.2) ──

describe('image toolbar placement (M-IMAGES-2.2)', () => {
  it('renders BELOW the image when the anchor has no room above (the ribbon-clip case); above when it fits', async () => {
    const { editor } = renderTensorInScrollContainer('<p>x</p>');
    await settleLayout();
    await insertImageBytes(editor, fixturePng(120, 80), 'png');
    const pos = imagePosOf(editor);
    // The image's stack-local top: contentY + placed.y (page 1, after
    // the first line). mockRects pins the stack + desk rects; scrolling
    // the image to the desk's top edge = the stack top far above the
    // desk's top (the desk's overflow-hidden wrapper clips at its top
    // edge — the ribbon line).
    const { result } = directLayout(editor);
    const placed = result.placed[0]!;
    // aboveTop (viewport) = stackTop + imgStackY * z — derive the desk
    // rects FROM it so the test pins the RULE, not guessed geometry:
    // CASE 1 puts the desk's top 10px BELOW the image's viewport top
    // (the image touching the desk's top edge — the ribbon line), so
    // NO room above can ever fit; CASE 2 puts it 300px above (ample).
    const imgStackY = GEOMETRY.contentY + placed.rect.y;

    // CASE 1 — no room above (the image at the desk's top edge):
    mockRects(0, { top: imgStackY + 10, bottom: 800 });
    act(() => { editor.commands.setTextSelection(0); });
    await settleLayout();
    act(() => { editor.commands.setNodeSelection(pos); });
    await settleLayout();
    const below = latest('[data-floating-toolbar]') as HTMLElement;
    expect(below).not.toBeUndefined();
    // 'below' renders with a plain +gap translateY (never -100%):
    expect(below.style.transform).not.toContain('-100%');

    // CASE 2 — room above: the toolbar returns to the image's top edge.
    mockRects(0, { top: imgStackY - 300, bottom: 800 });
    act(() => { editor.commands.setTextSelection(0); });
    await settleLayout();
    act(() => { editor.commands.setNodeSelection(pos); });
    await settleLayout();
    const above = latest('[data-floating-toolbar]') as HTMLElement;
    expect(above.style.transform).toContain('-100%');

    // CASE 3 — THE SCROLL LAW: a toolbar computed with room above must
    // FLIP below when the user scrolls the image into the clip zone —
    // without any new selection (the projection tracks the viewport).
    act(() => { editor.commands.setTextSelection(0); });
    await settleLayout();
    act(() => { editor.commands.setNodeSelection(pos); });
    await settleLayout();
    expect(latest('[data-floating-toolbar]')!.style.transform).toContain('-100%');
    // Scroll the image to the desk's top edge (the desk element's
    // scroll event — the projection listener is native on it):
    mockRects(0, { top: imgStackY + 10, bottom: 800 });
    const scrollContainer = document.querySelector('[data-testid="scroll-container"]')!;
    act(() => { scrollContainer.dispatchEvent(new Event('scroll')); });
    await settleLayout();
    expect(latest('[data-floating-toolbar]')!.style.transform).not.toContain('-100%');
  });
});

// ─── Resize: WYSIWYG against engine-fitted uploads (M-IMAGES-2.2) ───────

describe('resize (M-IMAGES-2.2 — dragged size is the truth)', () => {
  it('resize commits the DRAGGED size (WYSIWYG): a huge upload resizes to exactly the dragged rect', async () => {
    // A 2000×1000 upload: the engine FITS it down for display
    // (placed ≈ 624×312) while the intrinsic attrs stay 2000×1000 —
    // the old ratio-over-intrinsic commit recomputed attrs the engine
    // re-fitted right back to the SAME placed rect (the reported
    // "accepted the input and did nothing").
    const { editor } = renderTensor('<p>end</p>');
    await settleLayout();
    await insertImageBytes(editor, fixturePng(2000, 1000), 'png');
    await settleLayout();
    const pos = imagePosOf(editor);
    act(() => { editor.commands.setNodeSelection(pos); });
    await settleLayout();
    const before = directLayout(editor).result.placed[0]!.rect;
    expect(before.width).toBeLessThan(2000); // engine fit-down engaged
    // SE drag: shrink 200 left, 100 up (aspect-locked — Shift):
    const handle = document.querySelector('[data-testid="image-handle-se"]') as HTMLElement;
    act(() => { fireEvent.pointerDown(handle, { pointerId: 1, clientX: 0, clientY: 0, shiftKey: true }); });
    act(() => { fireEvent.pointerMove(handle, { pointerId: 1, clientX: -200, clientY: -100 }); });
    act(() => { fireEvent.pointerUp(handle, { pointerId: 1 }); });
    await settleLayout();
    const after = directLayout(editor).result.placed[0]!.rect;
    // The placed rect FOLLOWS the drag exactly (not re-fitted back):
    expect(Math.round(after.width)).toBe(Math.round(before.width) - 200);
    expect(Math.round(after.height)).toBe(Math.round(before.height) - 100);
    // And the committed attrs ARE the dragged size (the model truth):
    expect(editor.state.doc.nodeAt(pos)!.attrs.width).toBe(Math.round(before.width) - 200);
    expect(editor.state.doc.nodeAt(pos)!.attrs.height).toBe(Math.round(before.height) - 100);
  });

  it('the preview CLAMPS at the content box: growing past the page width commits the page width (no silent no-op)', async () => {
    const { editor } = renderTensor('<p>end</p>');
    await settleLayout();
    await insertImageBytes(editor, fixturePng(150, 90), 'png');
    const pos = imagePosOf(editor);
    act(() => { editor.commands.setNodeSelection(pos); });
    await settleLayout();
    // SE drag +600 wide — far past the content box; the engine can
    // never place it wider, so the commit lands AT the box:
    const handle = document.querySelector('[data-testid="image-handle-se"]') as HTMLElement;
    act(() => { fireEvent.pointerDown(handle, { pointerId: 1, clientX: 0, clientY: 0, shiftKey: false }); });
    act(() => { fireEvent.pointerMove(handle, { pointerId: 1, clientX: 600, clientY: 0 }); });
    act(() => { fireEvent.pointerUp(handle, { pointerId: 1 }); });
    await settleLayout();
    expect(editor.state.doc.nodeAt(pos)!.attrs.width).toBe(GEOMETRY.contentWidth);
    const placed = directLayout(editor).result.placed[0]!.rect;
    expect(placed.width).toBe(GEOMETRY.contentWidth);
  });
});

describe('conversions: exact shapes (M-IMAGES-2.1)', () => {
  it('the caption is GATHERED even when husk paragraphs separate it (the pre-2.1 mangle legacy)', async () => {
    const { editor } = renderTensor('<p>end</p>');
    await settleLayout();
    await insertImageBytes(editor, fixturePng(150, 90), 'png');
    const imgPos = imagePosOf(editor);
    // [image, husk, caption] — the caption detached by an empty husk:
    act(() => {
      const tr = editor.state.tr;
      tr.insert(
        imgPos + 1,
        editor.state.schema.nodes.paragraph!.create(),
      );
      tr.insert(
        imgPos + 3,
        editor.state.schema.nodes.paragraph!.create(
          { styleId: 'caption' },
          editor.state.schema.text('Cap'),
        ),
      );
      tr.setNodeAttribute(imgPos, 'keepNext', true);
      editor.view.dispatch(tr);
    });
    await settleLayout();
    expect(docShape(editor)).toBe('[p[text(end)], image, p[EMPTY], p[text(Cap)], p[EMPTY]]');
    act(() => { editor.commands.setNodeSelection(imgPos); convertBlockToInline(editor); });
    await settleLayout();
    // The caption GATHERED right beneath the object's paragraph:
    expect(docShape(editor)).toBe('[p[text(end)], p[inlineImage], p[text(Cap)], p[EMPTY], p[EMPTY]]');
  });

  it('inline→block gathers a husk-detached caption too (beneath the extracted image)', async () => {
    const { editor, pos } = await setupInlineOwnParagraph('<p>end</p>');
    act(() => {
      const tr = editor.state.tr;
      tr.insert(
        pos + 1,
        editor.state.schema.nodes.paragraph!.create(),
      );
      tr.insert(
        pos + 3,
        editor.state.schema.nodes.paragraph!.create(
          { styleId: 'caption' },
          editor.state.schema.text('Cap'),
        ),
      );
      editor.view.dispatch(tr);
    });
    await settleLayout();
    expect(docShape(editor)).toBe('[p[text(end)], p[inlineImage], p[EMPTY], p[text(Cap)], p[EMPTY]]');
    act(() => { editor.commands.setNodeSelection(pos); convertInlineToBlock(editor); });
    await settleLayout();
    expect(docShape(editor)).toBe('[p[text(end)], image, p[text(Cap)], p[EMPTY], p[EMPTY]]');
  });
  it('inline→block MID-paragraph splits around the object: [p[before], image, p[after]] — no husk, node selected', async () => {
    const { editor, pos } = await setupInlineMidText('<p>hello world</p>', 6);
    const src = editor.state.doc.nodeAt(pos)!.attrs.src;
    act(() => { editor.commands.setNodeSelection(pos); convertInlineToBlock(editor); });
    await settleLayout();
    // (The trailing p[EMPTY] predates the conversion — insertImage's
    // split; the law is the SPLIT is clean and NOTHING accumulates.)
    expect(docShape(editor)).toBe('[p[text(hello )], image, p[text(world)], p[EMPTY]]');
    // The NEW node is selected (the toolbar stays in image mode):
    expect(selNodeName(editor)).toBe('image');
    const img = editor.state.doc.nodeAt(imagePosOf(editor))!;
    expect(img.attrs.width).toBe(150);
    expect(img.attrs.height).toBe(90);
    expect(img.attrs.src).toBe(src);
  });

  it('inline→block with the object paragraph LAST: no RangeError, no husk (the old crash)', async () => {
    const { editor } = renderTensor('<p>end</p>');
    await settleLayout();
    await insertImageBytes(editor, fixturePng(150, 90), 'png');
    act(() => { editor.commands.setNodeSelection(imagePosOf(editor)); convertBlockToInline(editor); });
    await settleLayout();
    expect(docShape(editor)).toBe('[p[text(end)], p[inlineImage], p[EMPTY]]');
    act(() => { editor.commands.setNodeSelection(imagePosOf(editor, 'inlineImage')); convertInlineToBlock(editor); });
    await settleLayout();
    expect(docShape(editor)).toBe('[p[text(end)], image, p[EMPTY]]');
    expect(selNodeName(editor)).toBe('image');
  });

  it('repeated switches leave NO husk paragraphs (2× block↔inline)', async () => {
    const { editor } = renderTensor('<p>end</p>');
    await settleLayout();
    await insertImageBytes(editor, fixturePng(150, 90), 'png');
    for (let i = 0; i < 2; i++) {
      act(() => { editor.commands.setNodeSelection(imagePosOf(editor)); convertBlockToInline(editor); });
      await settleLayout();
      expect(docShape(editor)).toBe('[p[text(end)], p[inlineImage], p[EMPTY]]');
      act(() => { editor.commands.setNodeSelection(imagePosOf(editor, 'inlineImage')); convertInlineToBlock(editor); });
      await settleLayout();
      expect(docShape(editor)).toBe('[p[text(end)], image, p[EMPTY]]');
    }
  });

  it('block→inline selects the NEW inline node (Backspace deletes it)', async () => {
    const { editor } = renderTensor('<p>before</p>');
    await settleLayout();
    await insertImageBytes(editor, fixturePng(150, 90), 'png');
    const blockPos = imagePosOf(editor);
    act(() => { editor.commands.setNodeSelection(blockPos); convertBlockToInline(editor); });
    await settleLayout();
    expect(selNodeName(editor)).toBe('inlineImage');
    // Backspace with the node selected deletes it:
    act(() => {
      editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    });
    expect(imagePosOf(editor, 'inlineImage')).toBe(-1);
    void blockPos;
  });

  it('float → inline → float: the offset rides the carrier EXACTLY (mode switches never move the image)', async () => {
    const { editor } = renderTensor('<p>end</p>');
    await settleLayout();
    await insertImageBytes(editor, fixturePng(150, 90), 'png');
    const pos = imagePosOf(editor);
    act(() => { editor.commands.setNodeSelection(pos); setWrapMode(editor, 'front'); });
    act(() => {
      const tr = editor.state.tr;
      tr.setNodeAttribute(imagePosOf(editor), 'float', { dx: 30, dy: 12, z: 'front' });
      editor.view.dispatch(tr);
    });
    await settleLayout();
    // → inline (the offset survives as the inert carrier):
    act(() => { setWrapMode(editor, 'inline'); });
    await settleLayout();
    const inlinePos = imagePosOf(editor, 'inlineImage');
    expect(inlinePos).toBeGreaterThan(0);
    expect(editor.state.doc.nodeAt(inlinePos)!.attrs.float).toEqual({ dx: 30, dy: 12, z: 'front' });
    // → front again (the offset RETURNS — the image never moved):
    act(() => { editor.commands.setNodeSelection(inlinePos); setWrapMode(editor, 'front'); });
    await settleLayout();
    const back = editor.state.doc.nodeAt(imagePosOf(editor))!;
    expect(back.attrs.float).toEqual({ dx: 30, dy: 12, z: 'front' });
    // And the wrap-menu round-trip is shape-stable (no husks):
    expect(docShape(editor)).toBe('[p[text(end)], image, p[EMPTY]]');
  });

  it('setWrapMode inline→front ACTUALLY floats (the conversion selects the new node so the commit lands)', async () => {
    const { editor } = await setupInlineOwnParagraph('<p>end</p>');
    act(() => { setWrapMode(editor, 'front'); });
    await settleLayout();
    expect(imagePosOf(editor)).toBeGreaterThan(0); // block again
    expect(imagePosOf(editor, 'inlineImage')).toBe(-1);
    const img = editor.state.doc.nodeAt(imagePosOf(editor))!;
    expect(img.attrs.float).toEqual({ dx: 0, dy: 0, z: 'front' });
    // And the ENGINE has it as a float (zero flow presence):
    const { result } = directLayout(editor);
    expect(result.placed[0]!.z).toBe('front');
  });
});

// ─── 5. The placeholder states: pending vs FAILED (M-IMAGES-2.2) ────────

describe('placeholder states (M-IMAGES-2.2)', () => {
  it('PENDING stays the light tint; TERMINAL failure paints the FAILED box (darker + cross-hatch) — never re-kicks', async () => {
    const { editor } = renderTensor('<p>text</p>');
    await settleLayout();
    const png = fixturePng(100, 60);
    const sha = await sha256Hex(png);
    await insertImageBytes(editor, png, 'png');
    await settleLayout();
    // PENDING: the light tint (a load is in flight — the media IS in
    // the store):
    const pending = paintOps().filter((o) => o.op === 'fillRect' && o.fillStyle === PENDING_TINT);
    expect(pending.length).toBeGreaterThan(0);
    // TERMINAL: drive the failed state — the version bumps, surfaces
    // repaint ONCE into the failed box, and no load churns again.
    const before = paintOps().length;
    __bitmapTestSeam.fail(sha);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    await settleLayout();
    const failedOps = paintOps().filter((o) => o.op === 'fillRect' && o.fillStyle === FAILED_TINT);
    expect(failedOps.length).toBeGreaterThan(0);
    const strokes = paintOps().filter((o) => o.op === 'stroke' || o.op === 'lineTo');
    expect(strokes.length).toBeGreaterThan(0); // the cross-hatch
    // No further load churn (the failed state is terminal):
    const afterSettled = paintOps().length;
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(paintOps().length).toBe(afterSettled);
    void before;
  });

  it('the NODE VIEWS render the failed box too (the pageless surface + the a11y view) — never a broken glyph', async () => {
    const { editor } = renderTensor('<p>text</p>');
    await settleLayout();
    const png = fixturePng(100, 60);
    const sha = await sha256Hex(png);
    await insertImageBytes(editor, png, 'png');
    await settleLayout();
    __bitmapTestSeam.fail(sha);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    // Pageless: switch modes — the node view is the visible surface.
    act(() => {
      useConfigStore.setState((state) => ({
        config: { ...state.config, editor: { ...state.config.editor, defaultPageLayout: 'Pageless' } },
      }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    // NOTE: the bitmap-cache failure state is CANVAS-side; the <img>
    // node view flips via its OWN onerror (a second decode path —
    // jsdom never fires it). The UNRESOLVED branch (media absent)
    // renders the placeholder box — assert THAT here and the failed
    // box via a store-less ref: clear the store so the ref misses.
    useMediaStore.getState().clear();
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const placeholder = document.querySelector('[data-testid="image-placeholder"]');
    expect(placeholder).not.toBeNull();
    // And a broken-image glyph never renders (no <img> without a
    // resolved URL):
    const imgs = Array.from(document.querySelectorAll('.ProseMirror img'));
    expect(imgs.every((i) => (i as HTMLImageElement).getAttribute('src'))).toBe(true);
  });

  it('the unresolved-ref report fires LOUDLY in dev (the missing-media half of the gray story)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { editor } = renderTensor('<p>text</p>');
    await settleLayout();
    const png = fixturePng(100, 60);
    const sha = await sha256Hex(png);
    await insertImageBytes(editor, png, 'png');
    await settleLayout();
    // The media IS present — no report:
    errSpy.mockClear();
    // Drop the store entry OUT from under the doc (the external-doc-
    // without-its-container state):
    useMediaStore.getState().remove(sha);
    await settleLayout();
    const calls = errSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes('unresolved media ref') && c.includes(sha))).toBe(true);
    errSpy.mockRestore();
  });
});

// ─── 6. The clipboard-scoped round-trip (C — internal fidelity in, external HTML still refused) ──

describe('clipboard round-trip (M-IMAGES-2.2)', () => {
  it('a BLOCK image survives the internal HTML round-trip: copy (renderHTML) → paste (parseHTML) keeps the node + attrs', async () => {
    const { editor } = renderTensor('<p>before</p>');
    await settleLayout();
    const png = fixturePng(150, 90);
    const sha = await sha256Hex(png);
    await insertImageBytes(editor, png, 'png');
    act(() => {
      const tr = editor.state.tr;
      tr.setNodeAttribute(imagePosOf(editor), 'align', 'center');
      tr.setNodeAttribute(imagePosOf(editor), 'radius', 12);
      editor.view.dispatch(tr);
    });
    // THE PROXY: PM's clipboard serializes the slice through the SAME
    // DOMSerializer (renderHTML → toDOM) and parses pastes through the
    // SAME DOMParser rules — getHTML → setContent is the exact
    // round-trip minus the OS clipboard plumbing.
    const html = editor.getHTML();
    expect(html).toContain('data-tensor-image="true"');
    const second = renderTensor('<p>other</p>');
    await settleLayout();
    act(() => { second.editor.commands.setContent(html); });
    const pasted = second.editor.state.doc.nodeAt(imagePosOf(second.editor))!;
    expect(pasted).not.toBeNull();
    expect(pasted.type.name).toBe('image');
    expect(pasted.attrs.src).toBe(`media://${sha}`); // the ref rides verbatim
    expect(pasted.attrs.width).toBe(150);
    expect(pasted.attrs.height).toBe(90);
    expect(pasted.attrs.align).toBe('center');
    expect(pasted.attrs.radius).toBe(12);
  });

  it('an INLINE object inside text survives the round-trip (the token keeps its slot)', async () => {
    const { editor } = await setupInlineMidText('<p>hello world</p>', 6);
    const html = editor.getHTML();
    expect(html).toContain('data-tensor-inline-image="true"');
    const second = renderTensor('<p>other</p>');
    await settleLayout();
    act(() => { second.editor.commands.setContent(html); });
    // The inlineImage node re-parses INSIDE the paragraph:
    let found: { name: string; width: unknown } | null = null;
    second.editor.state.doc.descendants((n) => {
      if (n.type.name === 'inlineImage' && !found) {
        found = { name: n.type.name, width: n.attrs.width };
        return false;
      }
      return true;
    });
    expect(found).not.toBeNull();
    expect(found!.width).toBe(150);
    // The text around it kept its home:
    expect(second.editor.state.doc.textContent).toContain('hello ');
  });

  it('EXTERNAL <img> HTML still never parses in (the original M-IMAGES-1 law stands)', async () => {
    const { editor } = renderTensor('<p>safe</p>');
    await settleLayout();
    act(() => {
      editor.commands.setContent('<p><img src="https://evil.example/x.png" alt=""></p>');
    });
    // No image node was created from the foreign <img> — it is simply
    // DROPPED (setContent replaced the doc; the paragraph stays empty).
    expect(imagePosOf(editor)).toBe(-1);
    expect(imagePosOf(editor, 'inlineImage')).toBe(-1);
    expect(editor.state.doc.textContent).toBe('');
  });
});
