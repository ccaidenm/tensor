import type { EquationMetrics } from '@tensor-editor/engine';
import { renderEquation } from './render';

/**
 * The EquationMetrics port: dims are a pure (latex, fontSize) function,
 * measured by rendering KaTeX into an offscreen visibility:hidden host
 * (display:none would collapse to zero) under `.tensor-equation`.
 */

let hostEl: HTMLElement | null = null;

function measureHost(): HTMLElement {
  if (hostEl) return hostEl;
  const el = document.createElement('div');
  el.setAttribute('data-tensor-equation-measure', 'true');
  el.setAttribute('aria-hidden', 'true');
  // Out of the app tree, out of flow, invisible, non-interactive; the
  // font-size is set per measurement.
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

/** The app-wide single measurement authority (the getRealMetrics mirror:
 *  one warm ruler, never a second differently-warm instance). The cache
 *  is module-level, so recreation is cheap. */
export function getEquationMetrics(): EquationMetrics {
  if (!metricsSingleton) metricsSingleton = createEquationMetrics();
  return metricsSingleton;
}

// ── KaTeX font epoch ──────────────────────────────────────────────

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
  // 'loadingdone' fires when a batch finishes; only KaTeX_* faces matter —
  // a document font landing must not churn the equation caches.
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
