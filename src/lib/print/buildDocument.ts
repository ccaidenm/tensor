import type { Editor } from '@tiptap/core';
import { createLayoutEngine, type LayoutResult } from '@tensor-editor/engine';
import type { AdapterBlock } from '@/lib/paginated/adapter';
import { pmDocToSemantic } from '@/lib/paginated/adapter';
import { getRealMetrics } from '@/lib/paginated/metrics';
import { getEquationMetrics } from '@/lib/equations/measure';
import { resolveNormalBase } from '@/lib/styles/resolve';
import { useStyleRegistryStore } from '@/lib/styles/registry';
import { useConfigStore } from '@/lib/config/store';
import { useDocumentStore } from '@/lib/document/store';
import { toLayoutOptions } from '@/lib/document/pageSetup';
import { getBitmap } from '@/lib/media/bitmapCache';
import { resolveWatermark } from '@/lib/paginated/watermark';
import type { WatermarkSettings } from '@/lib/document/pageSetup';
import { renderPrintDocument } from './render';
import type { PrintPage } from './types';

/**
 * #43 — the print document build: the real metrics, resolved registry,
 * pageSetup, and field fixpoint — identical layout to the on-screen view.
 */

export interface PrintBuildResult {
  pages: PrintPage[];
  layout: LayoutResult;
  blocks: readonly AdapterBlock[];
  total: number;
}

export function buildPrintDocument(editor: Editor): PrintBuildResult {
  const metrics = getRealMetrics();
  const engine = createLayoutEngine({ metrics, equationMetrics: getEquationMetrics() });

  const registryNow = useStyleRegistryStore.getState();
  const registry = {
    definitions: registryNow.merged,
    epoch: registryNow.epoch,
  };
  const config = useConfigStore.getState().config;
  const doc = useDocumentStore.getState();
  const baseStyle = resolveNormalBase(
    config.editor.defaultFontFamily,
    config.editor.defaultFontSize,
    registry.definitions,
  );
  const pageSetup = doc.pageSetup;
  const layoutOptions = toLayoutOptions(pageSetup);

  // The field fixpoint: pass 1 at the warm one-digit guess, pass 2 iff wider.
  const fieldTotalIn = 8;
  const pass1 = pmDocToSemantic(editor.state.doc, baseStyle, registry, {
    differentFirstPage: doc.headerFooter?.differentFirstPage ?? false,
  }, undefined, fieldTotalIn, pageSetup);
  const result1 = engine.layout(
    config.editor.showHeadersFooters === false
      ? { ...pass1.doc, bands: undefined }
      : pass1.doc,
    // #58 — one geometry source: preview, print, and PDF share the sections table.
    { ...layoutOptions, ...(pass1.sections ? { sections: pass1.sections } : {}) },
  );
  const total = result1.pages.length;
  const guess = fieldTotalIn;
  let adapted = pass1;
  let layout = result1;
  if (String(total).length > String(guess).length) {
    adapted = pmDocToSemantic(editor.state.doc, baseStyle, registry, {
      differentFirstPage: doc.headerFooter?.differentFirstPage ?? false,
    }, undefined, total, pageSetup);
    layout = engine.layout(
      config.editor.showHeadersFooters === false
        ? { ...adapted.doc, bands: undefined }
        : adapted.doc,
      { ...layoutOptions, ...(adapted.sections ? { sections: adapted.sections } : {}) },
    );
  }

  const pages = renderPrintDocument({
    result: layout,
    blocks: adapted.blocks,
    metrics,
    bitmapSrc: (sha) => getBitmap(sha)?.src,
    fieldTotal: total,
  });

  // #48 — background chain: per-page map → section color → doc default;
  // white stays unset (sheet/PDF default).
  const sectionColors: (string | undefined)[] = [];
  editor.state.doc.forEach((node) => {
    if (node.type.name === 'sectionBreak') {
      const color = (node.attrs.setup as { pageColor?: string } | undefined)?.pageColor;
      sectionColors.push(typeof color === 'string' && color ? color : undefined);
    }
  });
  const docPageColor = doc.pageSetup.pageColor || undefined;
  pages.forEach((page, i) => {
    const sectionIndex = layout.pages[i]?.sectionIndex ?? 0;
    const background =
      doc.pageStyles[page.index]?.background ?? sectionColors[sectionIndex] ?? docPageColor;
    if (background) page.background = background;
  });

  // Same chain for watermarks (section override → doc default), resolved
  // here so consumers never re-derive; image spelling carries dual src/sha.
  const sectionWatermarks: (WatermarkSettings | undefined)[] = [];
  editor.state.doc.forEach((node) => {
    if (node.type.name === 'sectionBreak') {
      const wm = (node.attrs.setup as { watermark?: WatermarkSettings | null } | undefined)
        ?.watermark;
      sectionWatermarks.push(wm ?? undefined);
    }
  });
  pages.forEach((page, i) => {
    const sectionIndex = layout.pages[i]?.sectionIndex ?? 0;
    const wm = sectionWatermarks[sectionIndex] ?? doc.pageSetup.watermark;
    if (!wm) return;
    const spec = resolveWatermark(
      wm,
      { width: page.width, height: page.height },
      metrics.measure,
      baseStyle.fontFamily,
    );
    if (!spec) return;
    page.watermark =
      spec.kind === 'text'
        ? spec
        : {
            kind: 'image',
            sha: spec.src.slice('media://'.length),
            src: getBitmap(spec.src.slice('media://'.length))?.src ?? '',
            width: spec.width,
            height: spec.height,
            rotation: spec.rotation,
            opacity: spec.opacity,
          };
  });

  return { pages, layout, blocks: adapted.blocks, total };
}

/** "1-3, 7" page-range string → 0-based index set; invalid tokens
 *  are skipped (garbage never crashes). */
export function parsePageRange(raw: string, total: number): Set<number> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null; // all pages
  const out = new Set<number>();
  for (const token of trimmed.split(',')) {
    const part = token.trim();
    if (!part) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let p = Math.max(1, from); p <= Math.min(total, to); p++) out.add(p - 1);
      continue;
    }
    const single = /^(\d+)$/.exec(part);
    if (single) {
      const p = Number(single[1]);
      if (p >= 1 && p <= total) out.add(p - 1);
    }
  }
  return out.size > 0 ? out : null;
}
