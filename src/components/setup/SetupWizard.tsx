import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { documentDir } from '@tauri-apps/api/path';
import { readTextFile } from '@tauri-apps/plugin-fs';
import {
  Accessibility as AccessibilityIcon,
  ArrowLeft,
  ArrowRight,
  Check,
  CloudOff,
  FileStack,
  FolderOpen,
  Globe,
  HardDriveDownload,
  Monitor,
  Moon,
  Paintbrush,
  ScrollText,
  ShieldCheck,
  Sun,
  Upload,
  User,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/toast';
import { TensorLogo } from '@/components/icons/TensorIcon';
import { useConfigStore } from '@/lib/config/store';
import { DEFAULT_CONFIG } from '@/lib/config/schema';
import { ACCENTS, type AccentId } from '@/lib/branding/accents';
import { APP_VERSION } from '@/generated/version';
import { inTauriWindow } from '@/lib/window/tauriEnv';
import { useSpellLocalInstall, InstallProgressBar } from '@/lib/editor/spell/localInstall';
import { TranslateSetupForm } from '@/components/dialogs/TranslateSetupDialog';
import { cn } from 'cn';

/**
 * #103 — THE FIRST-RUN SETUP WIZARD: Tensor's installer moment, in-app
 * (the classic .msi walkthrough's honest equivalent — the OS bundle
 * installs the files; THIS personalizes the app). One pass, once:
 * `config.firstRunCompleted` is the gate (absent in every pre-#103
 * config, so existing users get their nostalgic tour too — the
 * ruling), completed OR skipped, never nagging again.
 *
 * MOUNT LAW: App renders this beside the start screen (a dialog OVER
 * it, not a takeover — the start screen + status bar stay live behind,
 * and the theme step re-themes the app in real time through the
 * overlay). The wizard sits at the z-40 tier so the REAL setup dialogs
 * it opens (Spell/Translate, z-50) stack above it, installer-style.
 * Non-dismissable: no overlay-click or Esc exit — Skip is the way
 * out, and every step commits live so nothing is ever lost.
 *
 * STEP LAW: every step writes its choice the MOMENT it's made (the
 * store's existing writers — no draft buffer, no Finish-commit). Back
 * revisits; the config already holds the answer; the step UI reflects
 * the store, so a revisit shows the choice. Import (Welcome) applies a
 * whole exported config the same way — the remaining steps then show
 * the imported values, and the user can adjust or just Finish.
 */

const STEPS = [
  { id: 'welcome', title: 'Welcome to Tensor' },
  { id: 'appearance', title: 'Appearance' },
  { id: 'view', title: 'How do you like to write?' },
  { id: 'spell', title: 'Spell check' },
  { id: 'translate', title: 'Translation' },
  { id: 'privacy', title: 'Privacy' },
  { id: 'accessibility', title: 'Accessibility' },
] as const;

/** The step's one-line framing (DialogDescription's content). */
const STEP_BLURBS: Record<string, string> = {
  welcome: 'A page-perfect word processor. A few quick choices and it’s yours.',
  appearance: 'Live — the app behind this window follows along. Your name personalizes documents and comments.',
  view: 'You can flip between these any time from the View tab.',
  spell: 'Off until you choose. Nothing checks anything by default.',
  translate: 'Off until you choose. Only the text you translate ever leaves this device.',
  privacy: 'Tensor phones home for nothing. You decide what it fetches.',
  accessibility: 'The senses the app adapts to — set here, live everywhere.',
};

function StepDots({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-1.5" aria-hidden="true">
      {STEPS.map((s, i) => (
        <span
          key={s.id}
          className={cn(
            'h-1.5 rounded-full transition-all',
            i === current ? 'w-4 bg-primary' : i < current ? 'w-1.5 bg-primary/50' : 'w-1.5 bg-border',
          )}
        />
      ))}
    </div>
  );
}

/** A compact label + control row (the Privacy step's unit). */
function Row({
  icon,
  label,
  description,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 shrink-0 text-muted-foreground">{icon}</div>
        <div className="min-w-0">
          <div className="text-sm font-medium">{label}</div>
          {description && <div className="break-words text-xs text-muted-foreground">{description}</div>}
        </div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/* ── Step 1: Welcome (+ settings import/export) ─────────────────── */

function WelcomeStep() {
  const setFirstRunCompleted = useConfigStore((s) => s.setFirstRunCompleted);
  const [importError, setImportError] = useState(false);

  async function importSettings() {
    setImportError(false);
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [{ name: 'Tensor Settings', extensions: ['json'] }],
      });
      if (typeof picked !== 'string') return;
      const ok = useConfigStore.getState().importConfig(JSON.parse(await readTextFile(picked)));
      if (ok) {
        toast.add({
          title: 'Settings imported',
          description: 'Your preferences are applied — skim the steps and press Finish.',
          type: 'success',
        });
      } else {
        setImportError(true);
      }
    } catch {
      setImportError(true);
    }
  }

  /** THE DEFAULT PRESET (the user's law): the schema defaults —
   *  System where System exists — with every EXTERNAL gate off
   *  (update checks, link previews, font catalogs, spell/translate
   *  all stay unconfigured), and exports landing in the user's
   *  Documents folder (the one destination a fresh install can
   *  assume). The one-click skip that still installs an honest
   *  config. */
  async function useDefaultSettings() {
    let documentsDir = '';
    try {
      documentsDir = await documentDir();
    } catch {
      documentsDir = ''; // non-Tauri (tests) — the OS dialog's default remains
    }
    useConfigStore.setState({
      config: {
        ...DEFAULT_CONFIG,
        privacy: { ...DEFAULT_CONFIG.privacy, fetchLinkMetadata: false },
        downloadsDir: documentsDir,
        firstRunCompleted: true,
      },
    });
    toast.add({
      title: 'Using default settings',
      description: 'System settings where available; nothing fetches unless you ask.',
    });
    setFirstRunCompleted();
  }

  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-4 text-center"
      data-testid="setup-step-welcome"
    >
      <TensorLogo className="h-14 w-14 text-primary" />
      <div>
        <div className="text-2xl font-semibold tracking-tight">Welcome to Tensor</div>
        <div className="mt-1 text-sm text-muted-foreground">
          A page-perfect word processor for long-form writing — version {APP_VERSION}.
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void importSettings()} data-testid="setup-import">
          <Upload size={14} /> Import settings…
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void useDefaultSettings()}
          data-testid="setup-default-settings"
        >
          <Check size={14} /> Use default settings
        </Button>
      </div>
      {importError && (
        <p className="text-xs text-destructive" data-testid="setup-import-error">
          That file isn’t a valid Tensor settings file — nothing was changed.
        </p>
      )}
    </div>
  );
}

/* ── Step 2: Appearance — theme, accent, and the name (the #102
      pickers, live; the name question rides here) ────────────────── */

function AppearanceStep() {
  const theme = useConfigStore((s) => s.config.theme);
  const setTheme = useConfigStore((s) => s.setTheme);
  const accent = useConfigStore((s) => s.config.accent);
  const setAccent = useConfigStore((s) => s.setAccent);
  const author = useConfigStore((s) => s.config.identity.author);
  const setIdentityAuthor = useConfigStore((s) => s.setIdentityAuthor);
  const [osName, setOsName] = useState<string | null>(null);

  useEffect(() => {
    if (!inTauriWindow()) return;
    invoke<string | null>('current_username')
      .then((name) => {
        if (name && name.trim()) setOsName(name.trim());
      })
      .catch(() => {});
  }, []);

  return (
    <div className="flex flex-col gap-2 py-2" data-testid="setup-step-appearance">
      <Row icon={<Sun className="h-4 w-4" />} label="Theme">
        <div className="flex gap-1" role="group" aria-label="Theme">
          {([
            { value: 'light' as const, label: 'Light', icon: Sun },
            { value: 'dark' as const, label: 'Dark', icon: Moon },
            { value: 'system' as const, label: 'System', icon: Monitor },
          ]).map((option) => (
            <Button
              key={option.value}
              size="sm"
              variant={theme === option.value ? 'secondary' : 'ghost'}
              className="h-7 gap-1"
              aria-pressed={theme === option.value}
              onClick={() => setTheme(option.value)}
              data-testid={`setup-theme-${option.value}`}
            >
              <option.icon className="h-3.5 w-3.5" />
              {option.label}
            </Button>
          ))}
        </div>
      </Row>
      <Row icon={<Paintbrush className="h-4 w-4" />} label="Accent color" description="Carried across the app, the icon, and the logo.">
        <div className="grid grid-cols-6 gap-1.5" role="group" aria-label="Accent color">
          {ACCENTS.map((option) => (
            <Tooltip key={option.id}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`${option.label} accent`}
                    aria-pressed={accent === option.id}
                    data-testid={`setup-accent-${option.id}`}
                    onClick={() => setAccent(option.id as AccentId)}
                    className={cn(
                      'h-6 w-6 rounded-full border border-black/10 transition-transform outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 hover:scale-110',
                      accent === option.id && 'ring-2 ring-ring ring-offset-2 ring-offset-background',
                    )}
                    style={{ backgroundColor: option.hex }}
                  />
                }
              />
              <TooltipContent>{option.label}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </Row>
      <Row
        icon={<User className="h-4 w-4" />}
        label="What should we call you?"
        description="Empty keeps the OS account name as the fallback."
      >
        <Input
          value={author}
          onChange={(e) => setIdentityAuthor(e.target.value)}
          placeholder={osName ?? 'Your name'}
          className="h-8 w-52"
          aria-label="Your name"
          data-testid="setup-name-input"
        />
      </Row>
    </div>
  );
}

/* ── Step 4: Pages vs Pageless ─────────────────────────────────── */

function ViewStep() {
  const layout = useConfigStore((s) => s.config.editor.defaultPageLayout);
  const setDefaultPageLayout = useConfigStore((s) => s.setDefaultPageLayout);

  const cards = [
    {
      value: 'Pages' as const,
      title: 'Pages',
      description: 'Paper, margins, rulers — print-shaped from the first keystroke.',
      icon: FileStack,
    },
    {
      value: 'Pageless' as const,
      title: 'Pageless',
      description: 'One continuous flow — the screen-shaped way to draft.',
      icon: ScrollText,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 py-2" data-testid="setup-step-view" role="radiogroup" aria-label="Default writing view">
      {cards.map((card) => {
        const active = layout === card.value;
        return (
          <button
            key={card.value}
            type="button"
            role="radio"
            aria-checked={active}
            data-testid={`setup-view-${card.value}`}
            onClick={() => setDefaultPageLayout(card.value)}
            className={cn(
              'flex flex-col items-start gap-2 rounded-lg border p-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40',
            )}
          >
            <card.icon size={20} className={active ? 'text-primary' : 'text-muted-foreground'} />
            <div className="text-sm font-medium">{card.title}</div>
            <div className="text-xs text-muted-foreground">{card.description}</div>
            {active && <Check size={14} className="text-primary" />}
          </button>
        );
      })}
    </div>
  );
}

/* ── Step 5: Spell check (the SpellSetupDialog's flow, inline) ─── */

function SpellStep() {
  const setSpellCheckProvider = useConfigStore((s) => s.setSpellCheckProvider);
  const setSpellCheckConfigured = useConfigStore((s) => s.setSpellCheckConfigured);
  const setSpellCheckEnabled = useConfigStore((s) => s.setSpellCheckEnabled);
  const configured = useConfigStore((s) => s.config.spellCheck.configured);
  const provider = useConfigStore((s) => s.config.spellCheck.provider);
  const { progress, error, installing, install } = useSpellLocalInstall();

  function chooseOnline() {
    setSpellCheckProvider('online');
    setSpellCheckConfigured();
    setSpellCheckEnabled(true);
  }

  return (
    <div className="flex flex-col gap-3 py-2" data-testid="setup-step-spell">
      {configured && (
        <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs" data-testid="setup-spell-configured">
          <Check size={14} className="text-primary" />
          Spell check is on ({provider === 'online' ? 'LanguageTool servers' : 'this device'}).
        </div>
      )}
      <div className="rounded-lg border border-border p-3" data-testid="setup-spell-online">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <CloudOff size={16} className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-medium">Check online</div>
              <p className="mt-1 text-xs text-muted-foreground">
                No download. Your text is sent to LanguageTool’s servers for checking.
              </p>
            </div>
          </div>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={chooseOnline} data-testid="setup-spell-choose-online">
            Use online
          </Button>
        </div>
      </div>
      <div className="rounded-lg border border-border p-3" data-testid="setup-spell-local">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <HardDriveDownload size={16} className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-medium">Check on this device</div>
              <p className="mt-1 text-xs text-muted-foreground">
                A one-time ≈290 MB download; fully private afterwards — nothing leaves this device again.
              </p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={() => void install()}
            disabled={installing}
            data-testid="setup-spell-choose-local"
          >
            Download
          </Button>
        </div>
        {installing && (
          <div className="mt-3">
            <InstallProgressBar progress={progress} />
          </div>
        )}
        {error && (
          <p className="mt-2 text-xs text-destructive" data-testid="setup-spell-local-error">
            {error}
          </p>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Skipping is fine — set it up any time from Review → Spelling & Grammar.
      </p>
    </div>
  );
}

/* ── Step 6: Translate (the real setup dialog, opened over) ─────── */

function TranslateStep() {
  return (
    <div className="flex flex-col gap-3 py-2" data-testid="setup-step-translate">
      <div className="flex items-start gap-2 px-1">
        <ShieldCheck size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          Only the text you translate — a selection or the whole document — is sent to the provider
          you choose, each time you press Translate. Nothing is sent otherwise.
        </p>
      </div>
      {/* THE PROVIDER FORM, INLINE — the setup dialog's exact fields
          (the shared TranslateSetupForm; Connect commits live). */}
      <TranslateSetupForm showCancel={false} />
      <p className="text-xs text-muted-foreground">
        Skipping is fine — set it up any time from Review → Translate.
      </p>
    </div>
  );
}

/* ── Step 7: Privacy & features ────────────────────────────────── */

function PrivacyStep({ seedExternals }: { seedExternals: () => void }) {
  const autoCheckForUpdates = useConfigStore((s) => s.config.privacy.autoCheckForUpdates);
  const setAutoCheckForUpdates = useConfigStore((s) => s.setAutoCheckForUpdates);
  const fetchLinkMetadata = useConfigStore((s) => s.config.privacy.fetchLinkMetadata);
  const setFetchLinkMetadata = useConfigStore((s) => s.setFetchLinkMetadata);

  // THE FIRST-VISIT SEED: reaching this step IS the consent moment —
  // the recommended externals arrive pre-checked (untick to refuse).
  // The wizard's ref makes this once-per-run: a revisit after an
  // untick never silently re-enables.
  useEffect(seedExternals, [seedExternals]);
  const allowFontCatalogs = useConfigStore((s) => s.config.privacy.allowFontCatalogs);
  const setAllowFontCatalogs = useConfigStore((s) => s.setAllowFontCatalogs);
  const downloadsDir = useConfigStore((s) => s.config.downloadsDir);
  const setDownloadsDir = useConfigStore((s) => s.setDownloadsDir);

  async function chooseFolder() {
    const dir = await openDialog({ directory: true, multiple: false });
    if (typeof dir === 'string') setDownloadsDir(dir);
  }

  return (
    <div className="flex flex-col py-1" data-testid="setup-step-privacy">
      <Row
        icon={<Globe className="h-4 w-4" />}
        label="Check for updates automatically"
        description="Tensor looks for new releases on startup."
      >
        <Switch
          size="sm"
          checked={autoCheckForUpdates}
          onCheckedChange={(v: boolean) => setAutoCheckForUpdates(v)}
          data-testid="setup-privacy-updates"
        />
      </Row>
      <Row
        icon={<Globe className="h-4 w-4" />}
        label="Fetch link previews"
        description="When inserting a link, fetch its title and icon for a live preview."
      >
        <Switch
          size="sm"
          checked={fetchLinkMetadata}
          onCheckedChange={(v: boolean) => setFetchLinkMetadata(v)}
          data-testid="setup-privacy-link-previews"
        />
      </Row>
      <Row
        icon={<Globe className="h-4 w-4" />}
        label="Browse online font catalogs"
        description="Google Fonts, Font Share, and Fontsource in the font browser."
      >
        <Switch
          size="sm"
          checked={allowFontCatalogs}
          onCheckedChange={(v: boolean) => setAllowFontCatalogs(v)}
          data-testid="setup-privacy-font-catalogs"
        />
      </Row>
      <Row
        icon={<FolderOpen className="h-4 w-4" />}
        label="Default export folder"
        description={downloadsDir ? downloadsDir : 'Exports ask where to save each time.'}
      >
        <div className="flex items-center gap-2">
          {downloadsDir && (
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => setDownloadsDir('')}>
              Reset
            </Button>
          )}
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => void chooseFolder()} data-testid="setup-privacy-folder">
            Choose…
          </Button>
        </div>
      </Row>
    </div>
  );
}

/* ── Step 8: Accessibility (the panel's two laws, live) ─────────── */

function AccessibilityStep() {
  const reduceMotion = useConfigStore((s) => s.config.accessibility.reduceMotion);
  const setReduceMotion = useConfigStore((s) => s.setReduceMotion);
  const grammarDoubleLine = useConfigStore((s) => s.config.accessibility.grammarDoubleLine);
  const setGrammarDoubleLine = useConfigStore((s) => s.setGrammarDoubleLine);

  return (
    <div className="flex flex-col py-1" data-testid="setup-step-accessibility">
      <Row
        icon={<AccessibilityIcon className="h-4 w-4" />}
        label="Reduce motion"
        description="Cuts UI animations (panels, transitions); 'System' follows your OS setting."
      >
        <div className="flex gap-1" role="group" aria-label="Reduce motion">
          {(['system', 'on', 'off'] as const).map((opt) => (
            <Button
              key={opt}
              size="sm"
              variant={reduceMotion === opt ? 'secondary' : 'ghost'}
              className="h-7 capitalize"
              aria-pressed={reduceMotion === opt}
              onClick={() => setReduceMotion(opt)}
              data-testid={`setup-motion-${opt}`}
            >
              {opt}
            </Button>
          ))}
        </div>
      </Row>
      <Row
        icon={<AccessibilityIcon className="h-4 w-4" />}
        label="Grammar double-line"
        description="Flags grammar issues with a double underline in addition to color — the color-blind aid."
      >
        <Switch
          size="sm"
          checked={grammarDoubleLine}
          onCheckedChange={(v: boolean) => setGrammarDoubleLine(v)}
          data-testid="setup-a11y-double-line"
        />
      </Row>
    </div>
  );
}

/* ── The wizard shell ──────────────────────────────────────────── */

export function SetupWizard() {
  const firstRunCompleted = useConfigStore((s) => s.config.firstRunCompleted);
  const setFirstRunCompleted = useConfigStore((s) => s.setFirstRunCompleted);
  const [step, setStep] = useState(0);
  const last = STEPS.length - 1;
  const stepId = STEPS[step]!.id;
  // The privacy step's once-per-run seed (Back must not re-enable).
  const externalsSeeded = useRef(false);
  const seedExternals = useCallback(() => {
    if (externalsSeeded.current) return;
    externalsSeeded.current = true;
    const cfg = useConfigStore.getState();
    cfg.setAutoCheckForUpdates(true);
    cfg.setFetchLinkMetadata(true);
  }, []);

  return (
    <Dialog
      open={!firstRunCompleted}
      onOpenChange={(o) => {
        // NON-DISMISSABLE (the installer posture): overlay clicks and
        // Esc do nothing — Skip/Finish are the only exits, and every
        // choice is already committed live.
        void o;
      }}
    >
      <DialogContent
        className="sm:max-w-lg z-40 flex h-[600px] max-h-[85vh] flex-col"
        overlayClassName="z-40 bg-black/30 backdrop-blur-lg"
        showCloseButton={false}
        data-testid="setup-wizard"
      >
        {step > 0 && (
          <DialogHeader className="shrink-0">
            <DialogTitle className="text-base">{STEPS[step]!.title}</DialogTitle>
            <DialogDescription>{STEP_BLURBS[stepId]}</DialogDescription>
          </DialogHeader>
        )}

        {/* THE FIXED STAGE: the dialog is ONE height — the step swap
            scrolls inside this region, never resizes the window (the
            installer-window posture). Horizontal overflow is dead by
            decree. */}
        <div
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
          data-testid="setup-step-content"
        >
          {stepId === 'welcome' && <WelcomeStep />}
          {stepId === 'appearance' && <AppearanceStep />}
          {stepId === 'view' && <ViewStep />}
          {stepId === 'spell' && <SpellStep />}
          {stepId === 'translate' && <TranslateStep />}
          {stepId === 'privacy' && <PrivacyStep seedExternals={seedExternals} />}
          {stepId === 'accessibility' && <AccessibilityStep />}
        </div>

        {/* THE INSTALLER FOOTER, three zones: Back at the FAR LEFT
            (the user's placement), the dots centered, the actions
            right. Back revisits committed choices; Skip completes
            with what's chosen so far; Next becomes Finish at the end. */}
        <div className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center border-t border-border pt-3">
          <div>
            {step > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setStep((s) => Math.max(0, s - 1))} data-testid="setup-back">
                <ArrowLeft size={14} /> Back
              </Button>
            )}
          </div>
          <div className="justify-self-center">
            <StepDots current={step} />
          </div>
          <div className="flex items-center justify-end gap-2">
            {step > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setFirstRunCompleted()}
                data-testid="setup-skip"
              >
                Skip for now
              </Button>
            )}
            {step < last ? (
              <Button
                size="sm"
                onClick={() => setStep((s) => Math.min(last, s + 1))}
                data-testid="setup-next"
              >
                Next <ArrowRight size={14} />
              </Button>
            ) : (
              <Button size="sm" onClick={() => setFirstRunCompleted()} data-testid="setup-finish">
                Finish
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
