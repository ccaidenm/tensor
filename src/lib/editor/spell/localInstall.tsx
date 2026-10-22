import { useCallback, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toast } from '@/components/ui/toast';
import { useConfigStore } from '@/lib/config/store';
import type { SpellInstallProgress } from './types';

/**
 * THE LOCAL-RUNTIME INSTALLER — one spelling shared by the setup
 * dialog and Settings → Proofing (never two flows to keep in sync).
 * Wraps `spell_install_local` (Rust): progress rides the
 * `spell-install-progress` events, success writes the config consent
 * (provider=local, configured, enabled) and fires the confirmation
 * toast; the caller decides what to close afterwards.
 */

export const STAGE_LABELS: Record<string, string> = {
  'download-languagetool': 'Downloading LanguageTool…',
  'download-jre': 'Downloading the Java runtime…',
  extract: 'Extracting (English-only prune)…',
  verify: 'Verifying…',
  done: 'Done',
};

export function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(0)} MB`;
}

/** The install progress bar (stage + MB counters + fill) — rendered by
 *  both surfaces; purely presentational. */
export function InstallProgressBar({ progress }: { progress: SpellInstallProgress | null }) {
  return (
    <div data-testid="spell-install-progress">
      <div className="mb-1 flex justify-between text-xs text-muted-foreground">
        <span>{STAGE_LABELS[progress?.stage ?? ''] ?? 'Working…'}</span>
        {progress && progress.total > 0 && (
          <span>
            {mb(progress.received)} / {mb(progress.total)}
          </span>
        )}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
        <div
          className="h-full bg-primary transition-[width]"
          style={{
            width:
              progress && progress.total > 0
                ? `${Math.min(100, (progress.received / progress.total) * 100)}%`
                : '8%',
          }}
        />
      </div>
    </div>
  );
}

export function useSpellLocalInstall() {
  const [progress, setProgress] = useState<SpellInstallProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const runningRef = useRef(false);

  /** Fresh state (the dialog calls this each time it opens). */
  const reset = useCallback(() => {
    setProgress(null);
    setError(null);
    setInstalling(false);
  }, []);

  /** Runs the install. Resolves true on success (config written, toast
   *  fired); false on failure (error state set). */
  const install = useCallback(async (): Promise<boolean> => {
    if (runningRef.current) return false;
    runningRef.current = true;
    setInstalling(true);
    setError(null);
    setProgress({ stage: 'download-languagetool', received: 0, total: 0 });

    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listen<SpellInstallProgress>('spell-install-progress', (e) => {
        setProgress(e.payload);
      });
    } catch {
      // Non-Tauri (tests, plain browser): the events simply never
      // arrive — the await below surfaces the real failure instead.
    }

    try {
      await invoke('spell_install_local');
      unlisten?.();
      const cfg = useConfigStore.getState();
      cfg.setSpellCheckProvider('local');
      cfg.setSpellCheckConfigured();
      cfg.setSpellCheckEnabled(true);
      toast.add({
        title: 'Local spell check installed',
        description:
          'Checking now happens on this device — no network. The engine starts on first use, so the first flags may take a few seconds.',
        type: 'success',
      });
      setInstalling(false);
      runningRef.current = false;
      return true;
    } catch (err) {
      unlisten?.();
      setError(err instanceof Error ? err.message : String(err));
      setProgress(null);
      setInstalling(false);
      runningRef.current = false;
      return false;
    }
  }, []);

  return { progress, error, installing, install, reset };
}
