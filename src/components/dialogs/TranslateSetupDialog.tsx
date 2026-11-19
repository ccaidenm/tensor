import { useEffect, useState } from 'react';
import { Globe, HardDriveDownload, Languages, ShieldCheck, Sparkles, Waypoints } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConfigStore } from '@/lib/config/store';
import { useTranslateStore } from '@/lib/editor/translate/store';
import { fetchLanguages } from '@/lib/editor/translate/client';
import type { TranslationProvider } from '@/lib/editor/translate/client';
import type { TranslationLanguage } from '@/lib/editor/translate/types';
import { cn } from 'cn';

/**
 * TRANSLATE SETUP — the consent surface (the SpellSetupDialog twin):
 * translation is OFF until the user configures a provider with the
 * trade-offs stated up front. THE PROVIDER CARDS (the spell setup's
 * online/local card pattern):
 *
 *   - LibreTranslate: the open engine. Self-hosted = free + keyless
 *     (the privacy-first choice — the user's own instance is the
 *     destination). The hosted instance needs a PAID key; its language
 *     list answers keyless, so Test works either way.
 *   - Google Cloud Translation: an API key with billing; text goes to
 *     Google's cloud.
 *   - DeepL: an API key; free tier keys (ending ':fx') auto-route to
 *     the free host; 500k chars/month on the free tier.
 *
 * A fourth card — LOCAL MODELS — runs translation ON DEVICE through
 * downloaded per-pair models (Mozilla's registry, ≈25MB each): nothing
 * is ever sent, downloads happen only when the user picks a pair. Its
 * Connect needs no test (there is no destination to verify — the card
 * IS the informed choice; the catalog fetch + pair downloads come
 * later, on demand).
 */

const PROVIDERS: Array<{
  id: TranslationProvider;
  name: string;
  blurb: string;
  note: string;
  icon: typeof Globe;
}> = [
  {
    id: 'libretranslate',
    name: 'LibreTranslate',
    blurb: 'The open-source engine. Self-hosted is free and needs no key.',
    note: 'Text is sent to YOUR instance. The hosted libretranslate.com requires a paid key.',
    icon: Globe,
  },
  {
    id: 'google',
    name: 'Google Cloud Translation',
    blurb: 'Google Cloud Translation API v2 — needs an API key with billing enabled.',
    note: 'Text is sent to Google Cloud.',
    icon: Sparkles,
  },
  {
    id: 'deepl',
    name: 'DeepL',
    blurb: 'DeepL API v2 — a free tier (500k chars/month) with a DeepL account.',
    note: 'Text is sent to DeepL. Free-tier keys end with :fx and are routed automatically.',
    icon: Waypoints,
  },
  {
    id: 'local',
    name: 'On this device',
    blurb: 'Downloaded models translate OFFLINE — nothing is ever sent.',
    note: 'Models (≈25MB per language pair) download on demand from Mozilla’s model registry; a small catalog (~0.2MB) loads when the panel opens.',
    icon: HardDriveDownload,
  },
];

export function TranslateSetupDialog() {
  const open = useTranslateStore((s) => s.setupOpen);
  const closeSetup = useTranslateStore((s) => s.closeSetup);
  const setTranslationConfigured = useConfigStore((s) => s.setTranslationConfigured);
  const setTranslationProvider = useConfigStore((s) => s.setTranslationProvider);
  const setTranslationEndpoint = useConfigStore((s) => s.setTranslationEndpoint);
  const setTranslationApiKey = useConfigStore((s) => s.setTranslationApiKey);

  const [provider, setProvider] = useState<TranslationProvider>('libretranslate');
  const [endpoint, setEndpoint] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<TranslationLanguage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fresh state each time the dialog opens (the spell setup law),
  // seeded from the current config for re-configuration.
  useEffect(() => {
    if (open) {
      const current = useConfigStore.getState().config.translation;
      setProvider(current.provider);
      setEndpoint(current.endpoint || 'https://libretranslate.com');
      setApiKey(current.apiKey);
      setTested(null);
      setError(null);
      setTesting(false);
    }
  }, [open]);

  /** An edit to this provider's credentials kills the test result. */
  function touch(edit: () => void) {
    edit();
    setTested(null);
  }

  async function test() {
    setTesting(true);
    setError(null);
    setTested(null);
    try {
      const langs = await fetchLanguages(provider, endpoint.trim() || undefined, apiKey.trim() || undefined);
      setTested(langs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }

  function connect() {
    if (needsTest && !tested) return;
    setTranslationProvider(provider);
    setTranslationEndpoint(provider === 'libretranslate' ? endpoint.trim() : '');
    setTranslationApiKey(needsKey ? apiKey.trim() : '');
    setTranslationConfigured();
    closeSetup();
  }

  const active = PROVIDERS.find((p) => p.id === provider)!;
  const needsEndpoint = provider === 'libretranslate';
  const needsKey = provider === 'google' || provider === 'deepl';
  // Local has no destination to verify — the card itself is the
  // informed choice; the catalog and pair downloads come later.
  const needsTest = provider !== 'local';

  return (
    <Dialog open={open} onOpenChange={(o) => !testing && (o ? null : closeSetup())}>
      <DialogContent className="max-w-lg" data-testid="translate-setup-dialog">
        <DialogHeader>
          <DialogTitle>Set Up Translation</DialogTitle>
          <DialogDescription>
            Translate a selection or the whole document on demand. This is an online feature —
            pick a provider to get started. Can be changed later in Settings → Proofing.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-lg border border-border p-3" data-testid="translate-setup-privacy">
            <div className="flex items-start gap-2">
              <ShieldCheck size={16} className="mt-0.5 shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-medium">Where your text goes</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Only the text you translate — a selection or the whole document — is sent to the
                  provider configured here, each time you press Translate. Nothing is sent until
                  you press Translate.
                </p>
              </div>
            </div>
          </div>

          {/* THE PROVIDER CARDS — one informed choice, the trade-offs
              stated on the card itself. */}
          <div className="space-y-2" data-testid="translate-setup-providers">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => { setProvider(p.id); setTested(null); setError(null); }}
                className={cn(
                  'flex w-full items-start gap-2 rounded-lg border p-3 text-left transition-colors',
                  provider === p.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50',
                )}
                data-testid={`translate-setup-card-${p.id}`}
              >
                <p.icon size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="text-sm font-medium">{p.name}</div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{p.blurb}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground/80">{p.note}</p>
                </div>
              </button>
            ))}
          </div>

          {needsEndpoint && (
            <label className="block" data-testid="translate-setup-endpoint">
              <span className="text-xs font-medium text-muted-foreground">Instance URL</span>
              <Input
                value={endpoint}
                onChange={(e) => touch(() => setEndpoint(e.target.value))}
                placeholder="https://libretranslate.com"
                className="mt-1 h-8"
              />
            </label>
          )}

          <label className="block" data-testid="translate-setup-api-key">
            <span className="text-xs font-medium text-muted-foreground">
              {needsKey ? 'API key' : 'API key (optional — self-hosted usually needs none)'}
            </span>
            <Input
              value={apiKey}
              onChange={(e) => touch(() => setApiKey(e.target.value))}
              placeholder={needsKey ? 'Required' : 'Only if your instance requires one'}
              className="mt-1 h-8"
            />
          </label>

          {needsTest && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => void test()} disabled={testing || (needsKey && !apiKey.trim()) || (needsEndpoint && !endpoint.trim())} data-testid="translate-setup-test">
                {testing ? 'Testing…' : 'Test connection'}
              </Button>
              {tested && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="translate-setup-tested">
                  <Languages size={13} /> {tested.length} languages available
                </span>
              )}
            </div>
          )}

          {error && (
            <div
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              data-testid="translate-setup-error"
            >
              {error}
            </div>
          )}

          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <active.icon size={13} />
            {active.name} — the destination of every translation run.
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={closeSetup} disabled={testing}>
            Cancel
          </Button>
          <Button size="sm" onClick={connect} disabled={(needsTest && !tested) || testing} data-testid="translate-setup-connect">
            Connect
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
