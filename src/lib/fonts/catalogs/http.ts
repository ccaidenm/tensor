import { invoke } from '@tauri-apps/api/core';
import { useConfigStore } from '@/lib/config/store';

/**
 * The only module that talks to fetch_url (the Rust reqwest command —
 * same client, same UA policy, system proxy). The privacy gate lives
 * here at the entry so no call site can forget it.
 */

export class CatalogsOfflineError extends Error {
  constructor() {
    super('Online font catalogs are off (privacy.allowFontCatalogs)');
    this.name = 'CatalogsOfflineError';
  }
}

export function catalogsAllowed(): boolean {
  return useConfigStore.getState().config.privacy.allowFontCatalogs;
}

function assertAllowed(): void {
  if (!catalogsAllowed()) throw new CatalogsOfflineError();
}

/** Raw bytes via the binary IPC channel. */
export async function catalogFetchBytes(url: string, ua?: string): Promise<Uint8Array> {
  assertAllowed();
  const result = await invoke<ArrayBuffer | Uint8Array | number[]>('fetch_url', { url, ua });
  if (result instanceof Uint8Array) return result;
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  return Uint8Array.from(result);
}

export async function catalogFetchText(url: string, ua?: string): Promise<string> {
  const bytes = await catalogFetchBytes(url, ua);
  return new TextDecoder().decode(bytes);
}

/** Google's css2 API serves woff2 (not ttf) only to modern-browser
 *  UAs. */
export const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
