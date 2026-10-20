/**
 * M-IMAGES-2 — the shared media bitmap cache. One resolution point for
 * CANVAS painting (the paginated inline draws + the ImageLayer): the
 * MediaStore owns the bytes/URLs; this module owns the DECODED
 * HTMLImageElements, loaded lazily per sha, with a version counter so
 * paint surfaces repaint exactly once when a bitmap lands (the
 * M-IMAGES-1 arrival law — one repaint, no relayout).
 *
 * M-IMAGES-2.2 — FAILURE IS NOT SILENT: the old onerror forgot the
 * load with ZERO diagnostics, so a decode failure (a webview codec
 * gap, a truncated file) painted the pending tint FOREVER — the
 * reported "gray placeholder that never resolves" with no trace of
 * why. Now: a dev diagnostic (sha/ext/bytes/attempts — the loud
 * posture every other failure path in this app follows), a BOUNDED
 * re-kick (transient decode/alloc failures are real; an eternal retry
 * loop is not), and a terminal FAILED state that bumps the version —
 * surfaces paint the failed box (a distinct tint + cross-hatch)
 * instead of the pending tint, and getBitmapFailed() tells them which.
 */

const bitmapCache = new Map<string, HTMLImageElement>();
const pendingLoads = new Map<string, Array<() => void>>();
/** Terminal failures (post-retries) — the failed-box state. */
const failedLoads = new Set<string>();
const retryCounts = new Map<string, number>();
let bitmapVersion = 0;
const versionListeners = new Set<() => void>();

/** Bounded re-kick: two retries, growing backoff. A third failure is
 *  terminal (the failed box paints; no more load churn). */
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 250;

// M-IMAGES-2.2 — the two placeholder states, shared by every paint
// surface (the tint literals were inline at each site before — one
// derivation, no forks): PENDING = a load in flight or unresolved
// media; FAILED = a terminal decode failure (darker + cross-hatch —
// never mistaken for "still loading").
export const PENDING_TINT = 'rgba(0,0,0,0.08)';
export const FAILED_TINT = 'rgba(0,0,0,0.16)';
export const FAILED_HATCH = 'rgba(0,0,0,0.35)';

function loadBitmap(sha: string, url: string): void {
  if (bitmapCache.has(sha) || pendingLoads.has(sha)) return;
  const entry = useMediaStore.getState().entries.get(sha);
  const queue: Array<() => void> = [];
  pendingLoads.set(sha, queue);
  const img = new Image();
  img.onload = () => {
    bitmapCache.set(sha, img);
    pendingLoads.delete(sha);
    retryCounts.delete(sha);
    failedLoads.delete(sha);
    bitmapVersion += 1;
    for (const fn of versionListeners) fn();
    for (const done of queue) done();
  };
  img.onerror = () => {
    pendingLoads.delete(sha);
    const attempt = retryCounts.get(sha) ?? 0;
    if (import.meta.env.DEV) {
      console.error(
        `[media] bitmap decode failed (sha=${sha.slice(0, 12)}…, ext=${entry?.ext ?? '?'}, ` +
          `bytes=${entry?.bytes.length ?? '?'}, attempt=${attempt + 1}/${MAX_RETRIES + 1})` +
          (attempt < MAX_RETRIES ? ' — retrying' : ' — TERMINAL (the failed box paints)'),
      );
    }
    if (attempt < MAX_RETRIES) {
      retryCounts.set(sha, attempt + 1);
      window.setTimeout(() => loadBitmap(sha, url), RETRY_BASE_MS * (attempt + 1));
      return;
    }
    // TERMINAL: the failed state is VISIBLE (version bump — surfaces
    // repaint once into the failed box) and no more loads churn.
    retryCounts.delete(sha);
    failedLoads.add(sha);
    bitmapVersion += 1;
    for (const fn of versionListeners) fn();
    for (const done of queue) done();
  };
  img.src = url;
}

/** The decoded bitmap for a sha, or undefined (paint the tint). */
export function getBitmap(sha: string): HTMLImageElement | undefined {
  return bitmapCache.get(sha);
}

/** M-IMAGES-2.2: TRUE when the sha's load terminally failed — paint
 *  the failed box (distinct from the pending tint), never re-kick. */
export function getBitmapFailed(sha: string): boolean {
  return failedLoads.has(sha);
}

/** Kick a load for every unresolved-but-stored media sha. */
export function ensureBitmap(sha: string, url: string): void {
  if (failedLoads.has(sha)) return; // terminal — no more churn
  loadBitmap(sha, url);
}

/**
 * The PAINT-TIME resolver (M-IMAGES-2.1): the bitmap when decoded;
 * otherwise KICKS the load from the MediaStore URL (if the media is
 * in the store) and returns undefined — the placeholder branch is
 * for THIS pending state only, never a permanent state: when the load
 * lands, bitmapVersion bumps and the subscribers repaint once (the
 * arrival law — one paint, no relayout).
 */
export function resolveMediaBitmap(sha: string): HTMLImageElement | undefined {
  const cached = bitmapCache.get(sha);
  if (cached) return cached;
  const url = mediaStoreUrlRef(sha);
  if (url && !failedLoads.has(sha)) loadBitmap(sha, url);
  return undefined;
}

// Bound at module init (no cycle: the store does not import this
// module).
import { useMediaStore } from './store';
const mediaStoreUrlRef: (sha: string) => string | undefined = (sha) =>
  useMediaStore.getState().entries.get(sha)?.url;

/** Subscribe to bitmap arrivals (repaint-once surfaces). */
export function subscribeBitmaps(fn: () => void): () => void {
  versionListeners.add(fn);
  return () => {
    versionListeners.delete(fn);
  };
}

export function bitmapVersionNow(): number {
  return bitmapVersion;
}

/** TEST SEAM: jsdom never fires img.onload — resolve a sha manually. */
export const __bitmapTestSeam = {
  resolve(sha: string, img: HTMLImageElement): void {
    bitmapCache.set(sha, img);
    pendingLoads.delete(sha);
    bitmapVersion += 1;
    for (const fn of versionListeners) fn();
  },
  /** M-IMAGES-2.2: drive the terminal-failure state from tests. */
  fail(sha: string): void {
    failedLoads.add(sha);
    bitmapVersion += 1;
    for (const fn of versionListeners) fn();
  },
  clear(): void {
    bitmapCache.clear();
    pendingLoads.clear();
    failedLoads.clear();
    retryCounts.clear();
    bitmapVersion += 1;
    for (const fn of versionListeners) fn();
  },
};
