import { useEffect, useState, type ReactNode } from 'react';
import { SpellCheck, BookA, CloudOff, HardDriveDownload, Trash2, CircleAlert } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useConfigStore } from '@/lib/config/store';
import { useSpellStore } from '@/lib/editor/spell/store';
import { InstallProgressBar, useSpellLocalInstall } from '@/lib/editor/spell/localInstall';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { SettingsSection } from '@/components/settings/SettingsSection';
import type { SettingsSectionDefinition } from '@/lib/settings/types';

export const PROOFING_PANEL_SECTIONS: SettingsSectionDefinition[] = [
  { id: 'spelling', label: 'Spelling' },
  { id: 'storage', label: 'Local Runtime & Storage' },
];

function Row({ icon, label, description, children }: { icon: ReactNode; label: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 text-muted-foreground">{icon}</div>
        <div>
          <div className="text-sm font-medium">{label}</div>
          {description && <div className="text-xs text-muted-foreground">{description}</div>}
        </div>
      </div>
      {children}
    </div>
  );
}

/** The local sidecar's status, probed when the panel mounts (and after
 *  installs/uninstalls). Non-Tauri environments degrade to "unknown". */
interface SpellStatusDto {
  status: 'stopped' | 'starting' | 'ready' | 'unavailable';
  port: number;
}

function useLocalRuntimeState() {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [status, setStatus] = useState<SpellStatusDto | null>(null);

  const probe = async () => {
    try {
      setInstalled(await invoke<boolean>('spell_local_installed'));
      setStatus(await invoke<SpellStatusDto>('spell_server_status'));
    } catch {
      setInstalled(null);
      setStatus(null);
    }
  };

  useEffect(() => {
    void probe();
  }, []);

  return { installed, status, probe };
}

export function ProofingPanel() {
  const enabled = useConfigStore((s) => s.config.spellCheck.enabled);
  const configured = useConfigStore((s) => s.config.spellCheck.configured);
  const provider = useConfigStore((s) => s.config.spellCheck.provider);
  const setSpellCheckEnabled = useConfigStore((s) => s.setSpellCheckEnabled);
  const setSpellCheckProvider = useConfigStore((s) => s.setSpellCheckProvider);
  const setSpellCheckConfigured = useConfigStore((s) => s.setSpellCheckConfigured);
  const openSetup = useSpellStore((s) => s.openSetup);
  const openDictionary = useSpellStore((s) => s.openDictionary);
  const lastError = useSpellStore((s) => s.lastError);
  const { installed, status, probe } = useLocalRuntimeState();
  const { progress, error: installError, installing, install } = useSpellLocalInstall();

  /** The consent gate — same rule as the ribbon button and F7. */
  function toggle() {
    if (!configured) {
      openSetup();
      return;
    }
    setSpellCheckEnabled(!enabled);
  }

  /** Download right here — the setup dialog is only for the FIRST
   *  enable; by the time the user is in Settings, the Local runtime is
   *  the thing they are acting on, so this installs inline (the shared
   *  spelling: progress, config writes, success toast). */
  async function downloadLocal() {
    const ok = await install();
    if (ok) await probe(); // refresh installed state + server status
  }

  async function uninstallLocal() {
    try {
      await invoke('spell_uninstall_local');
    } catch {
      // The directory may already be gone — the outcome is the same.
    }
    await probe();
  }

  const statusText =
    provider === 'online'
      ? enabled
        ? 'Checking via the LanguageTool cloud (text is sent to their servers).'
        : 'Online checking (no download; text is sent to their servers while enabled).'
      : installed == null
        ? 'Local runtime: unknown (run inside the app to manage it).'
        : installed
          ? status?.status === 'ready'
            ? 'Local LanguageTool process: running on this device.'
            : status?.status === 'starting'
              ? 'Local LanguageTool process: starting…'
              : 'Local LanguageTool runtime installed (starts on first use).'
          : 'Local runtime not downloaded yet.';

  return (
    <div>
      <SettingsSection id="spelling" title="Spelling">
        <Row
          icon={<SpellCheck className="h-4 w-4" />}
          label="Check Spelling"
          description="Off by default — nothing is checked, downloaded, or sent anywhere until it is enabled and a provider is chosen."
        >
          <Switch checked={enabled} onCheckedChange={toggle} data-testid="settings-spell-toggle" />
        </Row>
        <Row
          icon={provider === 'online' ? <CloudOff className="h-4 w-4" /> : <HardDriveDownload className="h-4 w-4" />}
          label="Provider"
          description={
            <>
              <span className="block">{statusText}</span>
              {provider === 'online' && (
                <span className="mt-0.5 block text-foreground/70">
                  Online sends your text to LanguageTool&rsquo;s servers. Local never leaves this
                  device.
                </span>
              )}
              {installed === false && (
                <span className="mt-0.5 block">
                  Local needs its runtime first — download it below.
                </span>
              )}
            </>
          }
        >
          <div className="flex gap-1">
            <Button
              size="sm"
              variant={provider === 'online' ? 'secondary' : 'ghost'}
              className="h-7 px-2 text-xs"
              onClick={() => {
                setSpellCheckProvider('online');
                setSpellCheckConfigured();
              }}
              data-testid="settings-spell-online"
            >
              Online
            </Button>
            <Button
              size="sm"
              variant={provider === 'local' ? 'secondary' : 'ghost'}
              className="h-7 px-2 text-xs"
              onClick={() => {
                setSpellCheckProvider('local');
                setSpellCheckConfigured();
              }}
              // The honest gate: Local is unusable until its runtime is
              // downloaded (download inline below — never a dead end).
              disabled={installed === false}
              data-testid="settings-spell-local"
            >
              Local
            </Button>
          </div>
        </Row>
        <Row
          icon={<BookA className="h-4 w-4" />}
          label="Personal Dictionary"
          description="Words Tensor never flags, saved as plain text in your config folder"
        >
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={openDictionary}
            data-testid="settings-spell-dictionary"
          >
            Manage…
          </Button>
        </Row>
        {lastError && (
          <Row
            icon={<CircleAlert className="h-4 w-4 text-destructive" />}
            label="Last checking error"
            description={<span className="text-destructive">{lastError}</span>}
          >
            <span />
          </Row>
        )}
      </SettingsSection>

      <SettingsSection id="storage" title="Local Runtime & Storage">
        <Row
          icon={<HardDriveDownload className="h-4 w-4" />}
          label="Local checker"
          description={
            installed
              ? 'LanguageTool 6.6 (English) + a Temurin 21 Java runtime — ≈270 MB on disk. Starts automatically on first use; never contacts the network.'
              : 'Not downloaded yet — LanguageTool 6.6 (English) + a Temurin 21 Java runtime. ≈290 MB over the wire once, ≈270 MB on disk, no network afterwards.'
          }
        >
          {installing ? (
            <span className="text-xs text-muted-foreground">Installing…</span>
          ) : installed == null ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => void probe()}
            >
              Refresh
            </Button>
          ) : installed ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => void uninstallLocal()}
              data-testid="settings-spell-uninstall"
            >
              <Trash2 size={12} /> Remove (frees ≈270 MB)
            </Button>
          ) : (
            <Button
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => void downloadLocal()}
              data-testid="settings-spell-download"
            >
              Download
            </Button>
          )}
        </Row>
        {(installing || progress) && (
          <div className="pb-1">
            <InstallProgressBar progress={progress} />
          </div>
        )}
        {installError && (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            data-testid="settings-spell-install-error"
          >
            {installError}
          </div>
        )}
      </SettingsSection>
    </div>
  );
}
