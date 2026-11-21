import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ConfigSchema } from '@/lib/config/schema';
import { ACCENTS } from '@/lib/branding/accents';

// The store + panels import DYNAMICALLY (after the matchMedia stub):
// the theme writer captures window.matchMedia at module load — a
// static import would bind jsdom's real (never-fires) query and the
// 'system' tests could never drive it. resetModules + fresh imports
// under the stub is the vitest pattern for module-init-time globals.
let useConfigStore: (typeof import('@/lib/config/store'))['useConfigStore'];
let GeneralPanel: (typeof import('@/components/settings/panels/GeneralPanel'))['GeneralPanel'];
let AboutPanel: (typeof import('@/components/settings/panels/AboutPanel'))['AboutPanel'];

/**
 * #102 — APP CUSTOMIZATION: the theme system mode (matchMedia
 * resolution + the live OS-scheme listener), the accent picker riding
 * the #97 engine, and the Appearance reorg (selection color moved
 * home).
 *
 * jsdom's matchMedia is stubbed per-test so 'system' is deterministic:
 * the harness controls `matches` and captures the change listeners.
 */

type MqlListener = (event: { matches: boolean }) => void;
let mediaMatches = false;
const mediaListeners = new Set<MqlListener>();

const originalMatchMedia = (window as { matchMedia?: unknown }).matchMedia;

/** Assigns DIRECTLY on the jsdom window: jsdom does not implement
 *  matchMedia, and the store reads window.matchMedia — vi.stubGlobal
 *  would set globalThis and the store would never see it (SEAM1's
 *  "not a function"). The original (absent) is restored per test. */
function stubMatchMedia(): void {
  (window as { matchMedia?: unknown }).matchMedia = vi.fn((query: string) => ({
    // LIVE: a snapshot would freeze the creation-time value (the
    // first run's false) — the getter reads the mutable var.
    get matches() {
      return mediaMatches;
    },
    media: query,
    addEventListener: (_: string, fn: MqlListener) => mediaListeners.add(fn),
    removeEventListener: (_: string, fn: MqlListener) => mediaListeners.delete(fn),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: () => false,
  }));
}

function setSystemScheme(matches: boolean): void {
  mediaMatches = matches;
  for (const fn of [...mediaListeners]) fn({ matches });
}

beforeAll(async () => {
  stubMatchMedia();
  vi.resetModules();
  ({ useConfigStore } = await import('@/lib/config/store'));
  ({ GeneralPanel } = await import('@/components/settings/panels/GeneralPanel'));
  ({ AboutPanel } = await import('@/components/settings/panels/AboutPanel'));
});

beforeEach(() => {
  mediaMatches = false;
  stubMatchMedia();
  // (mediaListeners is NOT cleared: the store binds its OS-scheme
  // listener ONCE at module init — production semantics — and the
  // set is the test's window into it.)
  // The favicon link exists in the real index.html; jsdom's bare head
  // needs it created for the parity-sweep assertion.
  if (!document.querySelector('link[rel="icon"]')) {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = '/favicon.svg';
    document.head.appendChild(link);
  }
  // A fresh store import state: system + ember (the schema defaults —
  // set explicitly so prior tests' choices never leak).
  useConfigStore.setState({ config: { ...useConfigStore.getState().config, theme: 'light', accent: 'ember' } });
});

afterEach(() => {
  (window as { matchMedia?: unknown }).matchMedia = originalMatchMedia;
});

describe('the system theme (#102)', () => {
  it('the schema accepts system and defaults to it (new installs follow the OS)', () => {
    expect(ConfigSchema.shape.theme.parse('system')).toBe('system');
    expect(ConfigSchema.shape.theme.parse(undefined)).toBe('system');
    // The old persisted values ride untouched.
    expect(ConfigSchema.shape.theme.parse('light')).toBe('light');
    expect(ConfigSchema.shape.theme.parse('dark')).toBe('dark');
  });

  it('system resolves SYNCHRONOUSLY against matchMedia (the writer law)', () => {
    // The store module already ran with the stubbed matchMedia present
    // (the test import order) — toggling the store re-applies.
    mediaMatches = true;
    act(() => {
      useConfigStore.getState().setTheme('system');
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    // Every re-assert follows a REAL transition — the writer's
    // change-guard skips no-ops (theme already 'system' would never
    // re-apply, by design).
    mediaMatches = false;
    act(() => {
      useConfigStore.getState().setTheme('light');
    });
    act(() => {
      useConfigStore.getState().setTheme('system');
    });
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('an OS scheme flip re-applies while the theme is system (the live listener)', () => {
    useConfigStore.getState().setTheme('system');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    act(() => {
      setSystemScheme(true);
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    // A light/dark choice DETACHES from the OS (no flip response):
    act(() => {
      useConfigStore.getState().setTheme('light');
    });
    act(() => {
      setSystemScheme(true);
    });
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});

describe('the accent picker (#102)', () => {
  beforeEach(() => {
    useConfigStore.getState().setAccent('ember');
  });

  it('twelve swatches render, one per catalog accent, ember pressed', () => {
    render(<GeneralPanel />);
    for (const accent of ACCENTS) {
      const swatch = document.querySelector(`[data-testid="accent-${accent.id}"]`);
      expect(swatch, accent.id).not.toBeNull();
      // The swatch paints the accent's own hex (the engine's value).
      expect((swatch as HTMLElement).style.backgroundColor.replace(/\s/g, '')).toBe(
        `rgb(${parseInt(accent.hex.slice(1, 3), 16)},${parseInt(accent.hex.slice(3, 5), 16)},${parseInt(accent.hex.slice(5, 7), 16)})`.toLowerCase(),
      );
    }
    expect(document.querySelector('[data-testid="accent-ember"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('a pick updates the store (the writer retunes the tokens + the icons)', () => {
    render(<GeneralPanel />);
    fireEvent.click(screen.getByLabelText('Violet accent'));
    expect(useConfigStore.getState().config.accent).toBe('violet');
    expect(document.documentElement.style.getPropertyValue('--primary').toLowerCase()).toBe('#9a63f8');
    // The favicon follows (the parity sweep).
    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(favicon?.href).toContain('/tensor-logos/tensor-icon-violet.png');
  });
});

describe('the Appearance reorg (#102)', () => {
  it('selection color lives in Appearance (moved from Editor)', () => {
    render(<GeneralPanel />);
    // The scroll-spy sections carry data-section-id — the structural
    // contract the nav keys off.
    const appearance = document.querySelector('[data-section-id="appearance"]')!;
    const editor = document.querySelector('[data-section-id="editor"]')!;
    expect(appearance.textContent).toContain('Selection Color');
    expect(editor.textContent).not.toContain('Selection Color');
    // The Editor section keeps its (renamed-scope) row.
    expect(editor.textContent).toContain('Floating Toolbar');
  });

  it('the theme row offers Light/Dark/System (the graduated control)', () => {
    render(<GeneralPanel />);
    const appearance = document.querySelector('[data-section-id="appearance"]')!;
    expect(appearance.textContent).toContain('Theme');
    expect(appearance.textContent).toContain('System');
    // The old lone "Dark Mode" switch label is retired.
    expect(appearance.textContent).not.toContain('Dark Mode');
  });

  it('the About heart + logo keep following the accent (the parity list)', () => {
    render(<AboutPanel />);
    useConfigStore.getState().setAccent('rose');
    // The About logo rides text-primary — the token carries the accent:
    expect(document.documentElement.style.getPropertyValue('--primary').toLowerCase()).toBe('#fb5266');
    const logo = document.querySelector('.text-primary');
    expect(logo).not.toBeNull();
  });
});
