import { fetch } from '@tauri-apps/plugin-http';
import { openUrl } from '@tauri-apps/plugin-opener';
import { APP_VERSION } from '@/generated/version';
import { inTauriWindow } from '../window/tauriEnv';
import { useConfigStore } from '../config/store';
import { toast } from '@/components/ui/toast';

/**
 * The update CHECK (#privacy.autoCheckForUpdates): once per launch, if
 * the user opted in, ask GitHub whether a newer release exists and
 * toast a link to it. Never downloads anything — the releases page is
 * the install path. Every failure resolves silent: offline is not a
 * notification.
 */

export const GITHUB_REPO_URL = 'https://github.com/ccaidenm/tensor';

const RELEASES_API = 'https://api.github.com/repos/ccaidenm/tensor/releases/latest';

export interface UpdateNotice {
  /** The release version with any 'v' prefix stripped. */
  version: string;
  /** The release's html_url. */
  url: string;
}

/** Numeric compare of dotted versions; 'v' prefixes tolerated, missing
 *  segments count as zero. Returns >0 when `a` is newer. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .map((part) => parseInt(part, 10) || 0);
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const delta = (A[i] ?? 0) - (B[i] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

/** GitHub's latest-release payload → a notice, or null when the payload
 *  isn't one. */
export function parseRelease(payload: unknown): UpdateNotice | null {
  if (!payload || typeof payload !== 'object') return null;
  const tag = (payload as { tag_name?: unknown }).tag_name;
  const url = (payload as { html_url?: unknown }).html_url;
  if (typeof tag !== 'string' || tag.length === 0) return null;
  return {
    version: tag.replace(/^v/i, ''),
    url: typeof url === 'string' && url.length > 0 ? url : `${GITHUB_REPO_URL}/releases/latest`,
  };
}

/** Ask GitHub whether a newer release than `currentVersion` exists.
 *  A network error or a non-OK response resolves null — the check never
 *  surfaces its own failure. */
export async function checkForUpdate(
  currentVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateNotice | null> {
  let payload: unknown;
  try {
    const response = await fetchImpl(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return null;
    payload = await response.json();
  } catch {
    return null;
  }
  const release = parseRelease(payload);
  if (!release) return null;
  return compareVersions(release.version, currentVersion) > 0 ? release : null;
}

let checkedThisLaunch = false;

/**
 * The launch hook: opt-in gate, one check per launch, a beat after
 * first paint. The toast's action opens the release page — the user
 * installs it, Tensor never does.
 */
export function startUpdateCheck(currentVersion: string = APP_VERSION): void {
  if (checkedThisLaunch || !inTauriWindow()) return;
  checkedThisLaunch = true;
  if (!useConfigStore.getState().config.privacy.autoCheckForUpdates) return;

  window.setTimeout(() => {
    void checkForUpdate(currentVersion).then((notice) => {
      if (!notice) return;
      toast.add({
        title: `Tensor ${notice.version} is available`,
        description: 'Download it from the releases page on GitHub.',
        type: 'info',
        actionProps: {
          children: 'View release',
          onClick: () => {
            void openUrl(notice.url);
          },
        },
      });
    });
  }, 4000);
}
