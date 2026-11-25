import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, fireEvent, waitFor } from '@testing-library/react';
import { SetupWizard } from '@/components/setup/SetupWizard';
import { useConfigStore } from '@/lib/config/store';
import { DEFAULT_CONFIG } from '@/lib/config/schema';

/**
 * #103 — the first-run wizard: config-gated (firstRunCompleted), every
 * step commits LIVE through the store's existing writers, and
 * Skip/Finish are the only exits (overlay clicks and Esc do nothing).
 */

const q = (testid: string) => document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;

/* The Tauri seams the wizard touches (import/export pickers + the
   local spell install's invoke). Module-level maps, reset per test. */
let openPath: string | string[] | null = null;
const fsText = new Map<string, string>();

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => openPath),
}));
vi.mock('@tauri-apps/api/path', () => ({
  documentDir: vi.fn(async () => '/home/caiden/Documents'),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(async (p: string) => {
    const v = fsText.get(p);
    if (v === undefined) throw new Error(`missing: ${p}`);
    return v;
  }),
  writeTextFile: vi.fn(async (p: string, t: string) => {
    fsText.set(p, t);
  }),
}));

function freshConfig() {
  return { ...DEFAULT_CONFIG, firstRunCompleted: false };
}

beforeEach(() => {
  fsText.clear();
  openPath = null;
  useConfigStore.setState({ config: freshConfig() });
});

/** The wizard alone — no step opens another dialog anymore. */
function harness() {
  return render(<SetupWizard />);
}

/** Advance to a step by id (Next clicks, jsdom-fast). */
function goto(
  step: 'appearance' | 'view' | 'spell' | 'translate' | 'privacy' | 'accessibility',
) {
  let guard = 0;
  while (!q(`setup-step-${step}`) && guard++ < 11) {
    act(() => {
      fireEvent.click(q('setup-next')!);
    });
  }
  expect(q(`setup-step-${step}`)).not.toBeNull();
}

describe('SetupWizard — the gate', () => {
  it('opens at Welcome on a fresh config; the landing exits via the default preset', async () => {
    harness();
    expect(q('setup-wizard')).not.toBeNull();
    expect(q('setup-step-welcome')).not.toBeNull();
    // The position lives in the header's dots — the footer's redundant
    // count is gone.
    expect(q('setup-step-count')).toBeNull();
    // No close affordance (the installer posture); the landing has NO
    // Skip either — its escape is the preset button. The header is
    // GONE on the landing (the centered hero IS the welcome).
    expect(q('setup-wizard')!.querySelector('[data-slot="dialog-close"]')).toBeNull();
    expect(q('setup-skip')).toBeNull();
    expect(q('setup-wizard')!.querySelector('[data-slot="dialog-title"]')).toBeNull();

    // THE DEFAULT PRESET: schema defaults, every external gate off,
    // flag set, wizard closed. The preset awaits documentDir — an
    // act-cannot-flush microtask (the recovery-suite lesson): await
    // the act.
    await act(async () => {
      fireEvent.click(q('setup-default-settings')!);
    });
    const cfg = useConfigStore.getState().config;
    expect(cfg.firstRunCompleted).toBe(true);
    expect(cfg.theme).toBe('system');
    expect(cfg.accessibility.reduceMotion).toBe('system');
    expect(cfg.privacy.autoCheckForUpdates).toBe(false);
    expect(cfg.privacy.allowFontCatalogs).toBe(false);
    expect(cfg.privacy.fetchLinkMetadata).toBe(false);
    expect(cfg.spellCheck.configured).toBe(false);
    expect(cfg.translation.configured).toBe(false);
    // THE PRESET'S DESTINATION: exports land in Documents.
    expect(cfg.downloadsDir).toBe('/home/caiden/Documents');
    expect(q('setup-wizard')).toBeNull();
  });

  it('does NOT enable externals unless the user continues through the setup', async () => {
    // Skipping at the NAME step (never reaching Privacy): the gates
    // stay at their schema defaults (off).
    harness();
    // Separate acts: Skip only exists once Next's step change lands.
    act(() => {
      fireEvent.click(q('setup-next')!);
    });
    act(() => {
      fireEvent.click(q('setup-skip')!);
    });
    const cfg = useConfigStore.getState().config;
    expect(cfg.privacy.autoCheckForUpdates).toBe(false);
    expect(cfg.privacy.fetchLinkMetadata).toBe(false);
  });

  it('never mounts for a completed first run', () => {
    useConfigStore.setState({ config: { ...DEFAULT_CONFIG, firstRunCompleted: true } });
    const { unmount } = harness();
    expect(q('setup-wizard')).toBeNull();
    unmount();
  });
});

describe('SetupWizard — the flow', () => {
  it('walks all seven steps, committing each choice live, and Finish sets the flag', async () => {
    harness();

    // APPEARANCE: the name question LIVES HERE, beside the theme +
    // accent — all committing live.
    goto('appearance');
    act(() => {
      fireEvent.change(q('setup-name-input')!, { target: { value: 'Caiden' } });
      fireEvent.click(q('setup-theme-dark')!);
      fireEvent.click(q('setup-accent-azure')!);
    });
    const mid = useConfigStore.getState().config;
    expect(mid.identity.author).toBe('Caiden');
    expect(mid.theme).toBe('dark');
    expect(mid.accent).toBe('azure');
    // The accents are a two-row-of-six grid (twelve swatches).
    expect(document.querySelectorAll('[data-testid^="setup-accent-"]')).toHaveLength(12);

    // VIEW: the default writing surface.
    goto('view');
    act(() => {
      fireEvent.click(q('setup-view-Pageless')!);
    });
    expect(useConfigStore.getState().config.editor.defaultPageLayout).toBe('Pageless');

    // SPELL: the online consent writes the three facts.
    goto('spell');
    act(() => {
      fireEvent.click(q('setup-spell-choose-online')!);
    });
    const spell = useConfigStore.getState().config.spellCheck;
    expect(spell.configured).toBe(true);
    expect(spell.provider).toBe('online');
    expect(spell.spelling).toBe(true);
    expect(q('setup-spell-configured')).not.toBeNull();

    // TRANSLATE: the provider form lives INSIDE the wizard (the
    // shared form, no nested dialog). The local card needs no test —
    // Connect commits straight through.
    goto('translate');
    expect(q('setup-wizard')!.querySelector('[data-testid="translate-setup-card-local"]')).not.toBeNull();
    // SEPARATE acts: the card's local-state commit must land before the
    // connect click reads it (batched-in-one-act runs the handler on
    // the stale closure).
    act(() => {
      fireEvent.click(q('translate-setup-card-local')!);
    });
    act(() => {
      fireEvent.click(q('translate-setup-connect')!);
    });
    const tr = useConfigStore.getState().config.translation;
    expect(tr.configured).toBe(true);
    expect(tr.provider).toBe('local');

    // PRIVACY: the first-visit seed arrives PRE-CHECKED (the consent
    // moment — continuing through setup is the choice); unticking
    // stands.
    goto('privacy');
    expect(q('setup-privacy-link-previews')!.getAttribute('aria-checked')).toBe('true');
    expect(q('setup-privacy-updates')!.getAttribute('aria-checked')).toBe('true');
    act(() => {
      fireEvent.click(q('setup-privacy-link-previews')!);
    });
    expect(useConfigStore.getState().config.privacy.fetchLinkMetadata).toBe(false);
    // BACK then forward again: the revisit never re-enables (the
    // wizard's once-per-run seed).
    act(() => {
      fireEvent.click(q('setup-back')!);
      fireEvent.click(q('setup-next')!);
    });
    expect(q('setup-privacy-link-previews')!.getAttribute('aria-checked')).toBe('false');
    expect(useConfigStore.getState().config.privacy.fetchLinkMetadata).toBe(false);

    // ACCESSIBILITY: its OWN step.
    goto('accessibility');
    act(() => {
      fireEvent.click(q('setup-motion-on')!);
      fireEvent.click(q('setup-a11y-double-line')!);
    });
    const cfg = useConfigStore.getState().config;
    expect(cfg.accessibility.reduceMotion).toBe('on');
    expect(cfg.accessibility.grammarDoubleLine).toBe(true);

    // FINISH: the flag, once, ever.
    act(() => {
      fireEvent.click(q('setup-finish')!);
    });
    expect(useConfigStore.getState().config.firstRunCompleted).toBe(true);
    expect(q('setup-wizard')).toBeNull();
  });

  it('Back revisits a step with the committed choice showing', () => {
    harness();
    goto('appearance');
    act(() => {
      fireEvent.change(q('setup-name-input')!, { target: { value: 'Caiden' } });
      fireEvent.click(q('setup-next')!);
      fireEvent.click(q('setup-back')!);
    });
    expect((q('setup-name-input') as HTMLInputElement).value).toBe('Caiden');
  });

  it('Skip completes with whatever was chosen so far (nothing lost)', () => {
    harness();
    goto('appearance');
    act(() => {
      fireEvent.change(q('setup-name-input')!, { target: { value: 'Caiden' } });
      fireEvent.click(q('setup-skip')!);
    });
    const cfg = useConfigStore.getState().config;
    expect(cfg.firstRunCompleted).toBe(true);
    expect(cfg.identity.author).toBe('Caiden');
    expect(q('setup-wizard')).toBeNull();
  });
});

describe('SetupWizard — settings import/export (Welcome)', () => {
  it('imports a valid settings file: applied, wizard stays open, flag preserved', async () => {
    harness();
    const exported = {
      ...DEFAULT_CONFIG,
      identity: { author: 'Imported' },
      accent: 'cobalt',
      firstRunCompleted: true, // a foreign file's flag must NOT close the wizard
    };
    openPath = '/usb/settings.json';
    fsText.set('/usb/settings.json', JSON.stringify(exported));

    await act(async () => {
      fireEvent.click(q('setup-import')!);
    });
    const cfg = useConfigStore.getState().config;
    expect(cfg.identity.author).toBe('Imported');
    expect(cfg.accent).toBe('cobalt');
    // The gate is THIS run's, not the file's.
    expect(cfg.firstRunCompleted).toBe(false);
    expect(q('setup-wizard')).not.toBeNull();
  });

  it('rejects an invalid settings file and changes nothing', async () => {
    harness();
    openPath = '/usb/bad.json';
    fsText.set('/usb/bad.json', '{ this is not json');

    await act(async () => {
      fireEvent.click(q('setup-import')!);
    });
    expect(q('setup-import-error')).not.toBeNull();
    expect(useConfigStore.getState().config.identity.author).toBe('');
    expect(useConfigStore.getState().config.firstRunCompleted).toBe(false);
  });
});

describe('SetupWizard — the spell step machinery', () => {
  it('surfaces the local install failure honestly (the shared hook, non-Tauri)', async () => {
    harness();
    goto('spell');
    await act(async () => {
      fireEvent.click(q('setup-spell-choose-local')!);
    });
    // jsdom has no Tauri: invoke rejects, the hook lands in its error
    // state — the step shows it instead of silently doing nothing.
    await waitFor(() => {
      expect(q('setup-spell-local-error')).not.toBeNull();
    });
    expect(useConfigStore.getState().config.spellCheck.configured).toBe(false);
  });
});
