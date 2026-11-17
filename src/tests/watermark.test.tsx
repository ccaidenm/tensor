import { describe, it, expect } from 'vitest';
import { act } from '@testing-library/react';





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

import { renderTensor, settleLayout } from './harness';
import { FakeMetrics } from './fakeMetrics';

/**
 * #WATERMARK — the feature suite: the resolver (one derivation), the
 * model's round-trip + the save-GC fix, and the on-screen layer
 * (behind everything by mount order, every page, per-section chain,
 * the ink-only display toggle). The panel (M2) and the exports (M3)
 * grow their describes here too.
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
      // section-geometry reads margins off it — the setBreakSetup law).
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
    // The DOCUMENT's watermark survives the hide (the captions NPC
    // law) — it comes right back with the toggle.
    expect(useDocumentStore.getState().pageSetup.watermark).toEqual({ kind: 'text', text: 'DRAFT' });
    act(() => {
      useConfigStore.getState().setShowWatermark(true);
    });
    expect(layers()).toHaveLength(1);
  });
});
