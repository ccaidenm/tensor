import { useEffect, useState, type ReactNode } from 'react';
import { SpellCheck, BookA, CloudOff, Globe, HardDriveDownload, Languages, Trash2, CircleAlert } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useConfigStore } from '@/lib/config/store';
import { useSpellStore } from '@/lib/editor/spell/store';
import { useTranslateStore } from '@/lib/editor/translate/store';
import { fetchLanguages, providerDestination } from '@/lib/editor/translate/client';
import { InstallProgressBar, useSpellLocalInstall } from '@/lib/editor/spell/localInstall';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsSection } from '@/components/settings/SettingsSection';
import type { SettingsSectionDefinition } from '@/lib/settings/types';

export const PROOFING_PANEL_SECTIONS: SettingsSectionDefinition[] = [
  { id: 'spelling', label: 'Spelling' },
  { id: 'translate', label: 'Translate' },
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
  const configured = useConfigStore((s) => s.config.spellCheck.configured);
  const provider = useConfigStore((s) => s.config.spellCheck.provider);
  const spelling = useConfigStore((s) => s.config.spellCheck.spelling);
  const grammar = useConfigStore((s) => s.config.spellCheck.grammar);
  const setSpellSpelling = useConfigStore((s) => s.setSpellSpelling);
  const setSpellGrammar = useConfigStore((s) => s.setSpellGrammar);
  const setSpellCheckProvider = useConfigStore((s) => s.setSpellCheckProvider);
  const setSpellCheckConfigured = useConfigStore((s) => s.setSpellCheckConfigured);
  const openSetup = useSpellStore((s) => s.openSetup);
  const openDictionary = useSpellStore((s) => s.openDictionary);
  const lastError = useSpellStore((s) => s.lastError);
  const { installed, status, probe } = useLocalRuntimeState();
  const { progress, error: installError, installing, install } = useSpellLocalInstall();

  /** The consent gate — same rule as the ribbon button and F7: the
   *  FIRST enable of either feature opens the setup dialog (one
   *  provider choice covers both). */
  function withConsent(on: boolean, flip: () => void) {
    if (on || configured) {
      flip();
      return;
    }
    openSetup();
  }

  function toggleSpelling() {
    withConsent(spelling, () => setSpellSpelling(!spelling));
  }

  function toggleGrammar() {
    withConsent(grammar, () => setSpellGrammar(!grammar));
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

  const active = spelling || grammar;
  const statusText =
    provider === 'online'
      ? active
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
      <SettingsSection id="spelling" title="Checking">
        <Row
          icon={<SpellCheck className="h-4 w-4" />}
          label="Check Spelling as You Type"
          description="Misspelled words get a red flat line; corrections are a click away. Off by default — nothing is checked, downloaded, or sent anywhere until it is enabled and a provider is chosen."
        >
          <Switch checked={spelling} onCheckedChange={toggleSpelling} data-testid="settings-spell-toggle" />
        </Row>
        <Row
          icon={<CircleAlert className="h-4 w-4" />}
          label="Check Grammar as You Type"
          description="Agreement, punctuation, and common usage errors get an advisory blue line with an explanation and suggested fixes — independent from spelling, so either can run alone."
        >
          <Switch checked={grammar} onCheckedChange={toggleGrammar} data-testid="settings-grammar-toggle" />
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

      <SettingsSection id="translate" title="Translate">
        <TranslateEndpointRow />
      </SettingsSection>
    </div>
  );
}

/** TRANSLATE — the provider/key management (the Privacy panel
 *  documents; this manages). Direct config writes (the measurement
 *  unit's live-write law) — credentials are validated by the test
 *  button, never silently mutated by a typo. The provider choice and
 *  the full informed-consent flow live in the setup dialog
 *  ("Reconfigure…"); this row edits credentials for the CHOSEN
 *  provider. */
function TranslateEndpointRow() {
  const configured = useConfigStore((s) => s.config.translation.configured);
  const provider = useConfigStore((s) => s.config.translation.provider);
  const endpoint = useConfigStore((s) => s.config.translation.endpoint);
  const apiKey = useConfigStore((s) => s.config.translation.apiKey);
  const setTranslationEndpoint = useConfigStore((s) => s.setTranslationEndpoint);
  const setTranslationApiKey = useConfigStore((s) => s.setTranslationApiKey);
  const openSetup = useTranslateStore((s) => s.openSetup);

  const needsEndpoint = provider === 'libretranslate';
  const needsKey = provider === 'google' || provider === 'deepl';
  const [draftEndpoint, setDraftEndpoint] = useState(endpoint);
  const [draftKey, setDraftKey] = useState(apiKey);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState(false);

  // The persisted truth is the draft when the panel isn't being edited
  // (fresh mounts, config reloads).
  useEffect(() => setDraftEndpoint(endpoint), [endpoint]);
  useEffect(() => setDraftKey(apiKey), [apiKey]);

  const canTest = needsEndpoint ? draftEndpoint.trim() : draftKey.trim();

  async function test() {
    setTesting(true);
    setError(null);
    setTested(false);
    try {
      await fetchLanguages(provider, draftEndpoint.trim() || undefined, draftKey.trim() || undefined);
      setTested(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }

  function save() {
    if (needsEndpoint) setTranslationEndpoint(draftEndpoint.trim());
    setTranslationApiKey(draftKey.trim());
    useConfigStore.getState().setTranslationConfigured();
    setTested(false);
  }

  return (
    <div className="py-3" data-testid="settings-translate-endpoint">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 text-muted-foreground"><Globe className="h-4 w-4" /></div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{providerDestination(provider, endpoint)}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {configured
              ? 'The provider translation runs against — where the text you translate is sent.'
              : 'Not set up — the Translate panel’s setup dialog makes the informed choice first.'}
          </p>
          <div className="mt-2 flex flex-col gap-2" data-testid="settings-translate-fields">
            {needsEndpoint && (
              <Input
                value={draftEndpoint}
                onChange={(e) => { setDraftEndpoint(e.target.value); setTested(false); }}
                placeholder="https://libretranslate.com"
                className="h-8"
                aria-label="LibreTranslate instance URL"
                data-testid="settings-translate-endpoint-input"
              />
            )}
            <Input
              value={draftKey}
              onChange={(e) => { setDraftKey(e.target.value); setTested(false); }}
              placeholder={needsKey ? 'API key (required)' : 'API key (optional)'}
              className="h-8"
              aria-label="Translation API key"
              data-testid="settings-translate-key-input"
            />
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => void test()} disabled={testing || !canTest} data-testid="settings-translate-test">
                {testing ? 'Testing…' : 'Test'}
              </Button>
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={save} disabled={!tested} data-testid="settings-translate-save">
                Save
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={openSetup} data-testid="settings-translate-reconfigure">
                <Languages size={12} /> Change provider…
              </Button>
            </div>
            {tested && <span className="text-xs text-muted-foreground" data-testid="settings-translate-tested">Connection ok — provider reached.</span>}
            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" data-testid="settings-translate-error">
                {error}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
