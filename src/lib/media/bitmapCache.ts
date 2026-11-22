/**
 * Shared media bitmap cache for canvas painting: the MediaStore owns
 * bytes/URLs; this owns the decoded HTMLImageElements, lazy per sha,
 * with a version counter so surfaces repaint exactly once per arrival.
 * Decode failures retry boundedly, then paint a terminal failed state.
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

// The two placeholder states, shared by every paint surface: PENDING
// = a load in flight or unresolved media; FAILED = a terminal decode
// failure (darker + cross-hatch — never mistaken for "still loading").
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
    // Terminal: the version bump repaints surfaces once into the
    // failed box; no more loads churn.
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

/** True when the sha's load terminally failed — paint the failed
 *  box, never re-kick. */
export function getBitmapFailed(sha: string): boolean {
  return failedLoads.has(sha);
}

/** Kick a load for every unresolved-but-stored media sha. */
export function ensureBitmap(sha: string, url: string): void {
  if (failedLoads.has(sha)) return; // terminal — no more churn
  loadBitmap(sha, url);
}

/**
 * The paint-time resolver: the bitmap when decoded; otherwise kicks
 * the load and returns undefined — the placeholder is pending-only;
 * on arrival bitmapVersion bumps and subscribers repaint once.
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

/** Test seam: jsdom never fires img.onload — resolve a sha manually. */
export const __bitmapTestSeam = {
  resolve(sha: string, img: HTMLImageElement): void {
    bitmapCache.set(sha, img);
    pendingLoads.delete(sha);
    bitmapVersion += 1;
    for (const fn of versionListeners) fn();
  },
  /** Drive the terminal-failure state from tests. */
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
