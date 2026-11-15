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
import { renderPrintDocument } from './render';
import type { PrintPage } from './types';

/**
 * M-PRINT (#43) — THE PRINT DOCUMENT BUILD: the preview/print path's
 * ONE assembly. Mirrors buildDocxInput's posture (one input shared by
 * every consumer): the REAL metrics singletons (identical layout to
 * the on-screen view — #43's core AC), the RESOLVED registry, the
 * document's pageSetup, and the warm-total field fixpoint.
 *
 * THE FIXPOINT (the PaginatedView two-pass, print-side): pass 1
 * measures fields at the warm guess; the real total resolves off pass
 * 1's page count; a widened placeholder re-converts + re-lays-out
 * (bounded at 2, the M-REFS shape). The walk then runs once on the
 * settled layout.
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

  // THE FIELD FIXPOINT: pass 1 at the warm guess ('8' — one digit, the
  // cheap cold start), pass 2 iff the real total is wider.
  const fieldTotalIn = 8;
  const pass1 = pmDocToSemantic(editor.state.doc, baseStyle, registry, {
    differentFirstPage: doc.headerFooter?.differentFirstPage ?? false,
  }, undefined, fieldTotalIn, pageSetup);
  const result1 = engine.layout(
    config.editor.showHeadersFooters === false
      ? { ...pass1.doc, bands: undefined }
      : pass1.doc,
    // #58 — the sections ride (ONE geometry source: the preview, the
    // print, and the PDF consume the same table).
    { ...layoutOptions, ...(pass1.sections ? { sections: pass1.sections } : {}) },
  );
  const total = result1.pages.length;
  const guess = fieldTotalIn ?? 8;
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

  return { pages, layout, blocks: adapted.blocks, total };
}

/** A "1-3, 7" page-range string → the 0-based index set (the preview's
 *  range filter). Invalid tokens are skipped loudly-quietly (the
 *  input's placeholder documents the format; garbage never crashes). */
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
