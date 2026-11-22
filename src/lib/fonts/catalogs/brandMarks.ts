import { create } from 'zustand';
import { catalogsAllowed, catalogFetchBytes } from './http';
import type { CatalogId } from './types';

/**
 * Runtime brand marks: each catalog service's own favicon, fetched
 * once per session while opted in. Responses are byte-sniffed (HTML
 * bodies are not marks); failures fall back to the bundled icon.
 */

const FAVICON_URLS: Record<CatalogId, string> = {
  google: 'https://www.google.com/favicon.ico',
  fontshare: 'https://www.fontshare.com/favicon.ico',
  fontsource: 'https://fontsource.org/favicon.ico',
};

/** data-URL per source once fetched; absent = fallback icon.
 *  Reactive so a mark arriving after first paint swaps the
 *  fallback out immediately. */
const useBrandMarkStore = create<{ marks: Partial<Record<CatalogId, string>> }>(() => ({
  marks: {},
}));
/** Attempted within the current ensure round — cleared on failure,
 *  so a bad boot fetch never pins the fallback for a whole session:
 *  the browser retries on every open. */
const attempted = new Set<CatalogId>();

/** Magic-byte sniff — the honest favicon check (content, not URL). */
function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  const [a, b, c, d] = [bytes[0], bytes[1], bytes[2], bytes[3]];
  if (a === 0x00 && b === 0x00 && c === 0x01 && d === 0x00) return 'image/x-icon';
  if (a === 0x89 && b === 0x50 && c === 0x4e && d === 0x47) return 'image/png';
  if (a === 0x47 && b === 0x49 && c === 0x46) return 'image/gif';
  if (a === 0xff && b === 0xd8) return 'image/jpeg';
  if (a === 0x3c && (bytes[1] === 0x73 || bytes[1] === 0x3f)) return 'image/svg+xml'; // '<s' | '<?'
  return null;
}

function toDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${mime};base64,${btoa(binary)}`;
}

/** Fetch any still-missing marks. Called at boot and on every
 *  font-browser open, so the fallback icon is always temporary.
 *  Failures stay silent — the fallback is the design. */
export async function ensureBrandMarks(): Promise<void> {
  if (!catalogsAllowed()) return;
  await Promise.allSettled(
    (Object.keys(FAVICON_URLS) as CatalogId[]).map(async (id) => {
      if (useBrandMarkStore.getState().marks[id]) return; // have it
      if (attempted.has(id)) return; // in-flight or failed this round
      attempted.add(id);
      try {
        const bytes = await catalogFetchBytes(FAVICON_URLS[id]!);
        const mime = sniffMime(bytes);
        if (mime) {
          useBrandMarkStore.setState((s) => ({ marks: { ...s.marks, [id]: toDataUrl(bytes, mime) } }));
        } else {
          attempted.delete(id); // HTML shell — retry on the next ensure
        }
      } catch {
        attempted.delete(id); // network flake — retry on the next ensure
      }
    }),
  );
}

/** The fetched mark as a data URL, or null → render the fallback.
 *  Components re-render when the mark lands. */
export function useBrandMark(id: CatalogId): string | null {
  return useBrandMarkStore((s) => s.marks[id] ?? null);
}

/** Non-hook read (tests). */
export function brandMarkUrl(id: CatalogId): string | null {
  return useBrandMarkStore.getState().marks[id] ?? null;
}

/** Test seam. */
export function resetBrandMarksForTests(): void {
  useBrandMarkStore.setState({ marks: {} });
  attempted.clear();
}
