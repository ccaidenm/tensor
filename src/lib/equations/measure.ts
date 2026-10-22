import type { EquationMetrics } from '@tensor-editor/engine';
import { renderEquation } from './render';

/**
 * M-EQ-0 — the EquationMetrics PORT's real implementation (the
 * TextMetrics law mirrored: the engine consumes measurement, the shell
 * performs it). An equation's dims are DERIVED facts — a pure function
 * of (latex, fontSize) under the KaTeX fonts — so unlike an image's
 * user-set document data they arrive through this port at layout time.
 *
 * THE MEASUREMENT SURFACE: KaTeX output is HTML+CSS — no canvas ruler
 * can measure it, so the measurer is a DOM one: render into an
 * offscreen fixed-position host (visibility: hidden — never
 * display:none, a hidden element still lays out and measures; display
 * none collapses to zero) and read the wrapper's rect. The wrapper
 * carries the same `.tensor-equation` class the document views use, so
 * the measured box is the PAINTED box by construction (one CSS
 * derivation — the inline-block shrink-wrap and the zeroed
 * .katex-display margins are the measurement face everywhere).
 *
 * FONT EPOCH (the metrics.ts note's equation arm): KaTeX webfonts load
 * ASYNC — a measurement taken before the math fonts land caches
 * fallback-font dims. The measure cache clears and an epoch bumps when
 * a KaTeX_* family finishes loading; PaginatedView subscribes and takes
 * the M-FONTS remedy (re-gate + engine recreate — the engine's walk
 * cache never invalidates on metrics identity, so stale dims would ride
 * spliced entries forever). Self-correcting within one paint; no eager
 * font fetch at startup — the fonts load when an equation first renders.
 */

let hostEl: HTMLElement | null = null;

function measureHost(): HTMLElement {
  if (hostEl) return hostEl;
  const el = document.createElement('div');
  el.setAttribute('data-tensor-equation-measure', 'true');
  el.setAttribute('aria-hidden', 'true');
  // Out of the app tree, out of flow, invisible, non-interactive; the
  // font-size is set PER MEASUREMENT (the port's second key).
  el.style.cssText =
    'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;z-index:-1;';
  document.body.appendChild(el);
  hostEl = el;
  return el;
}

const cache = new Map<string, { width: number; height: number }>();
const CACHE_MAX = 2_000;

function measureOnce(latex: string, fontSize: number): { width: number; height: number } {
  const key = `${fontSize}\u0000${latex}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const host = measureHost();
  const probe = document.createElement('div');
  probe.className = 'tensor-equation tensor-equation-measure';
  // The port's fontSize drives the box (the .katex override inherits
  // it) — the engine's layout facts and the painted math agree.
  probe.style.fontSize = `${fontSize}px`;
  probe.innerHTML = renderEquation(latex);
  host.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  host.removeChild(probe);
  const dims = { width: rect.width, height: rect.height };
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, dims);
  return dims;
}

export function createEquationMetrics(): EquationMetrics {
  return {
    measure: measureOnce,
  };
}

let metricsSingleton: EquationMetrics | null = null;

/** The app-wide single equation measurement authority — the
 *  getRealMetrics mirror (the pairing law: one warm ruler, never a
 *  second differently-warm instance). The underlying cache is
 *  module-level, so recreation is cheap and the measurements survive. */
export function getEquationMetrics(): EquationMetrics {
  if (!metricsSingleton) metricsSingleton = createEquationMetrics();
  return metricsSingleton;
}

// ─── KaTeX font epoch ────────────────────────────────────────────────

let epoch = 0;
const subscribers = new Set<() => void>();
let listening = false;

function ensureFontListener(): void {
  // jsdom's document.fonts is a partial stub (no addEventListener) —
  // the guard covers the API's existence, not just the object's.
  if (
    listening ||
    typeof document === 'undefined' ||
    !document.fonts ||
    typeof document.fonts.addEventListener !== 'function'
  ) {
    return;
  }
  listening = true;
  // FontFaceSet events: 'loadingdone' fires when a batch finishes. Only
  // KaTeX_* faces matter — a document font landing must NOT churn the
  // equation caches (the filter is the churn guard).
  const onDone = (event: FontFaceSetLoadEvent) => {
    const katex = [...event.fontfaces].some((f) => f.family.startsWith('KaTeX_'));
    if (!katex) return;
    cache.clear();
    epoch += 1;
    for (const cb of subscribers) cb();
  };
  document.fonts.addEventListener('loadingdone', onDone);
}

/** Monotonic epoch — bumps whenever KaTeX font faces finish loading
 *  (which invalidates every cached measurement). */
export function katexFontEpochNow(): number {
  ensureFontListener();
  return epoch;
}

export function subscribeKatexFonts(cb: () => void): () => void {
  ensureFontListener();
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** Test seam: drop the singleton-adjacent module state (the cache and
 *  the epoch) so a metrics swap in tests measures fresh. */
export function resetEquationMeasurements(): void {
  cache.clear();
  epoch += 1;
  for (const cb of subscribers) cb();
}