import { useEffect } from 'react';
import { CloudOff, HardDriveDownload, Languages } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useConfigStore } from '@/lib/config/store';
import { useSpellStore } from '@/lib/editor/spell/store';
import { InstallProgressBar, useSpellLocalInstall } from '@/lib/editor/spell/localInstall';

// Spell-check consent surface: OFF until a provider is chosen. Online sends
// text to LanguageTool's servers — chosen, never defaulted. The install
// flow is shared with Settings → Proofing (useSpellLocalInstall).
export function SpellSetupDialog() {
  const open = useSpellStore((s) => s.setupOpen);
  const closeSetup = useSpellStore((s) => s.closeSetup);
  const setSpellCheckEnabled = useConfigStore((s) => s.setSpellCheckEnabled);
  const setSpellCheckProvider = useConfigStore((s) => s.setSpellCheckProvider);
  const setSpellCheckConfigured = useConfigStore((s) => s.setSpellCheckConfigured);
  const { progress, error, installing, install, reset } = useSpellLocalInstall();

  // Fresh state each time the dialog opens.
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  function chooseOnline() {
    setSpellCheckProvider('online');
    setSpellCheckConfigured();
    setSpellCheckEnabled(true);
    closeSetup();
  }

  async function chooseLocal() {
    const ok = await install();
    if (ok) closeSetup();
  }

  const busy = installing && !error;

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && (o ? null : closeSetup())}>
      <DialogContent className="max-w-lg" data-testid="spell-setup-dialog">
        <DialogHeader>
          <DialogTitle>Enable Spell &amp; Grammar Check</DialogTitle>
          <DialogDescription>
            Choose how spelling and grammar are checked — text goes to the same place for both.
            This can be changed later in Settings → Proofing.
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
              <div className="mt-3">
                <InstallProgressBar progress={progress} />
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
