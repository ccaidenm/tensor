import { useEffect, useState } from 'react';
import { CloudOff, HardDriveDownload, Languages } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toast } from '@/components/ui/toast';
import { useConfigStore } from '@/lib/config/store';
import { useSpellStore } from '@/lib/editor/spell/store';
import type { SpellInstallProgress } from '@/lib/editor/spell/types';

/**
 * SPELL CHECK SETUP — the consent surface (the fonts-catalog precedent,
 * with a storage dimension): spell check is OFF until the user picks a
 * provider, with the trade-offs stated up front:
 *
 *  - ONLINE: no download; text is sent to LanguageTool's servers for
 *    checking. The privacy note is the point — this contradicts the
 *    app's default posture, so it must be chosen, never defaulted.
 *  - LOCAL: a one-time ≈290 MB download (LanguageTool 6.6 + a Temurin
 *    21 JRE, pruned to English on extraction), ≈270 MB on disk, and
 *    zero network afterwards (loopback-only sidecar).
 *
 * Progress rides the Rust layer's `spell-install-progress` events.
 */
const STAGE_LABELS: Record<string, string> = {
  'download-languagetool': 'Downloading LanguageTool…',
  'download-jre': 'Downloading the Java runtime…',
  extract: 'Extracting (English-only prune)…',
  verify: 'Verifying…',
  done: 'Done',
};

function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(0)} MB`;
}

export function SpellSetupDialog() {
  const open = useSpellStore((s) => s.setupOpen);
  const closeSetup = useSpellStore((s) => s.closeSetup);
  const setSpellCheckEnabled = useConfigStore((s) => s.setSpellCheckEnabled);
  const setSpellCheckProvider = useConfigStore((s) => s.setSpellCheckProvider);
  const setSpellCheckConfigured = useConfigStore((s) => s.setSpellCheckConfigured);

  const [progress, setProgress] = useState<SpellInstallProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  // Fresh state each time the dialog opens.
  useEffect(() => {
    if (open) {
      setProgress(null);
      setError(null);
      setInstalling(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const fn = await listen<SpellInstallProgress>('spell-install-progress', (e) => {
          setProgress(e.payload);
        });
        if (cancelled) fn();
        else unlisten = fn;
      } catch {
        // Non-Tauri (tests, plain browser): events just never arrive.
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [open]);

  function chooseOnline() {
    setSpellCheckProvider('online');
    setSpellCheckConfigured();
    setSpellCheckEnabled(true);
    closeSetup();
  }

  async function chooseLocal() {
    setInstalling(true);
    setError(null);
    setProgress({ stage: 'download-languagetool', received: 0, total: 0 });
    try {
      await invoke('spell_install_local');
      setSpellCheckProvider('local');
      setSpellCheckConfigured();
      setSpellCheckEnabled(true);
      toast.add({
        title: 'Local spell check installed',
        description:
          'Checking now happens on this device — no network. The engine starts on first use, so the first flags may take a few seconds.',
        type: 'success',
      });
      closeSetup();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setInstalling(false);
      setProgress(null);
    }
  }

  const busy = installing && !error;

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && (o ? null : closeSetup())}>
      <DialogContent className="max-w-lg" data-testid="spell-setup-dialog">
        <DialogHeader>
          <DialogTitle>Enable Spell Check</DialogTitle>
          <DialogDescription>
            Choose how spelling is checked. This can be changed later in Settings → Proofing.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* ONLINE — the no-download, text-leaves-the-device option. */}
          <div className="rounded-lg border border-border p-3" data-testid="spell-setup-online">
            <div className="flex items-start gap-2">
              <CloudOff size={16} className="mt-0.5 shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-medium">Check online (LanguageTool cloud)</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  No download. <span className="text-foreground/80">Your text is sent to
                  LanguageTool&rsquo;s servers</span> for checking — nothing is stored by them, but it
                  does leave this device.
                </p>
              </div>
            </div>
            <Button
              size="sm"
              className="mt-2 h-7 px-2 text-xs"
              onClick={chooseOnline}
              disabled={busy}
              data-testid="spell-setup-online-btn"
            >
              Use Online Checking
            </Button>
          </div>

          {/* LOCAL — the download, never-phones-again option. */}
          <div className="rounded-lg border border-border p-3" data-testid="spell-setup-local">
            <div className="flex items-start gap-2">
              <HardDriveDownload size={16} className="mt-0.5 shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-medium">Check on this device</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Fully private after setup: the checker runs as a local process and never touches
                  the network again. <span className="text-foreground/80">Downloads ≈290 MB once
                  (uses ≈270 MB on disk)</span> — LanguageTool (LGPL) and a Java runtime.
                </p>
              </div>
            </div>
            {busy ? (
              <div className="mt-3" data-testid="spell-install-progress">
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
            ) : (
              <Button
                size="sm"
                className="mt-2 h-7 px-2 text-xs"
                onClick={() => void chooseLocal()}
                data-testid="spell-setup-local-btn"
              >
                Download &amp; Enable
              </Button>
            )}
          </div>

          {error && (
            <div
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              data-testid="spell-setup-error"
            >
              {error}
            </div>
          )}

          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Languages size={13} />
            English (US) — more languages arrive with grammar checking.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
