import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, waitFor, act } from '@testing-library/react';
import { SidebarHost } from '@/lib/layout/sidebar/SidebarHost';
import { TranslatePanel } from '@/components/editor/TranslatePanel';
import { TranslateSetupDialog } from '@/components/dialogs/TranslateSetupDialog';
import { getCommand } from '@/lib/commands/registry';
import { useSidebarStore } from '@/lib/layout/sidebarStore';
import { useConfigStore } from '@/lib/config/store';
import { DEFAULT_CONFIG } from '@/lib/config/schema';
import { useTranslateStore } from '@/lib/editor/translate/store';
import { renderTensor } from './harness';

/**
 * The translate panel + setup dialog — the UI half: the unconfigured
 * panel is the consent surface; a configured panel runs scope →
 * translate → preview → apply, with the privacy line always visible.
 * `invoke` is mocked; no Rust, no instance.
 */

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock('@/lib/editor/translate/local/engine', () => ({
  translateHtmlsLocal: vi.fn(async (_installed: unknown, _from: string, _to: string, htmls: string[]) =>
    htmls.map((h) => h.replace(/Hello/g, 'Hallo')),
  ),
  disposeLocalEngine: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
const invokeMock = vi.mocked(invoke);

/** Mount the panel the way App.tsx does, opened through the real command. */
function mountPanel() {
  render(
    <>
      <div className="relative">
        <SidebarHost id="translate" anchor="right">
          <TranslatePanel />
        </SidebarHost>
      </div>
      {/* One mount, one store — the dialog rides along for the setup flow. */}
      <TranslateSetupDialog />
    </>,
  );
  act(() => {
    void getCommand('translateSidebar')?.run();
  });
  expect(useSidebarStore.getState().active?.id).toBe('translate');
}

function configureTranslation(endpoint = 'https://lt.example', apiKey = '', provider: 'libretranslate' | 'google' | 'deepl' | 'local' = 'libretranslate'): void {
  useConfigStore.setState({
    config: {
      ...DEFAULT_CONFIG,
      translation: { provider, configured: true, endpoint, apiKey, lastTargetLang: 'en' },
    },
  });
}

/** The instance mock: the languages list + the array-in/array-out
 *  translation body. */
function mockInstance(): void {
  invokeMock.mockImplementation(async (cmd, args) => {
    if (cmd === 'translate_languages') {
      return [
        { code: 'en', name: 'English' },
        { code: 'fr', name: 'French' },
        { code: 'de', name: 'German' },
      ];
    }
    if (cmd === 'translate') {
      const blocks = (args as { blocks: string[] }).blocks;
      return {
        translatedText: blocks.map((html) => html.replace(/Hello/g, 'Bonjour')),
        detectedLanguage: { language: 'en', confidence: 1 },
      };
    }
    throw new Error('unexpected invoke: ' + cmd);
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

beforeEach(() => {
  invokeMock.mockReset();
  useConfigStore.setState({ config: DEFAULT_CONFIG });
  useSidebarStore.getState().close();
  // The store persists scope as a session preference — tests start clean.
  useTranslateStore.setState({ scope: 'document', targetLang: '' });
  useTranslateStore.getState().reset();
});

describe('the unconfigured panel', () => {
  it('is the consent surface — a picker, no run, and a setup button', () => {
    const { editor } = renderTensor('<p>Hello</p>');
    void editor;
    mountPanel();
    expect(document.querySelector('[data-testid="translate-panel-unconfigured"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="translate-run"]')).toBeNull();
  });

  it('the setup flow: state the trade-off, test the provider, then connect', async () => {
    renderTensor('<p>Hello</p>');
    mountPanel();
    expect(useTranslateStore.getState().setupOpen).toBe(false);
    fireEvent.click(document.querySelector('[data-testid="translate-panel-setup-btn"]')!);
    expect(useTranslateStore.getState().setupOpen).toBe(true);
    expect(document.querySelector('[data-testid="translate-setup-dialog"]')).not.toBeNull();
    // Four provider cards, the trade-offs on the cards themselves.
    expect(document.querySelectorAll('[data-testid^="translate-setup-card-"]').length).toBe(4);

    // Connect is refused until the provider tested OK (a half-working
    // destination is worse than none).
    const connect = document.querySelector('[data-testid="translate-setup-connect"]') as HTMLButtonElement;
    expect(connect.disabled).toBe(true);

    mockInstance();
    fireEvent.click(document.querySelector('[data-testid="translate-setup-test"]')!);
    await waitFor(() => expect(document.querySelector('[data-testid="translate-setup-tested"]')).not.toBeNull());

    fireEvent.change(document.querySelector('[data-testid="translate-setup-endpoint"] input')!, {
      target: { value: 'https://my.self.host' },
    });
    // The test result dies with an edit — re-test before connect.
    expect((document.querySelector('[data-testid="translate-setup-connect"]') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(document.querySelector('[data-testid="translate-setup-test"]')!);
    await waitFor(() => expect(document.querySelector('[data-testid="translate-setup-tested"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-testid="translate-setup-connect"]')!);

    const { translation } = useConfigStore.getState().config;
    expect(translation.configured).toBe(true);
    expect(translation.provider).toBe('libretranslate');
    expect(translation.endpoint).toBe('https://my.self.host');
    // The panel now runs.
    expect(document.querySelector('[data-testid="translate-panel-unconfigured"]')).toBeNull();
    expect(document.querySelector('[data-testid="translate-run"]')).not.toBeNull();
  });

  it('switching provider cards swaps the credentials and routes the consent write', async () => {
    renderTensor('<p>Hello</p>');
    mountPanel();
    fireEvent.click(document.querySelector('[data-testid="translate-panel-setup-btn"]')!);

    // DeepL: no endpoint field, the key is REQUIRED for the test.
    fireEvent.click(document.querySelector('[data-testid="translate-setup-card-deepl"]')!);
    expect(document.querySelector('[data-testid="translate-setup-endpoint"]')).toBeNull();
    expect((document.querySelector('[data-testid="translate-setup-test"]') as HTMLButtonElement).disabled).toBe(true);

    mockInstance();
    fireEvent.change(document.querySelector('[data-testid="translate-setup-api-key"] input')!, {
      target: { value: 'key:fx' },
    });
    fireEvent.click(document.querySelector('[data-testid="translate-setup-test"]')!);
    await waitFor(() => expect(document.querySelector('[data-testid="translate-setup-tested"]')).not.toBeNull());
    // The ':fx' free-tier key rode the wire (the Rust layer routes on it).
    const call = invokeMock.mock.calls.find(([cmd]) => cmd === 'translate_languages')!;
    expect(call[1]).toMatchObject({ provider: 'deepl', apiKey: 'key:fx' });
    fireEvent.click(document.querySelector('[data-testid="translate-setup-connect"]')!);

    const { translation } = useConfigStore.getState().config;
    expect(translation.provider).toBe('deepl');
    expect(translation.apiKey).toBe('key:fx');
    expect(translation.endpoint).toBe(''); // deepl owns its host — no user endpoint
  });
});

describe('the configured panel', () => {
  it('runs document scope → preview → apply, with the privacy line naming the destination', async () => {
    const { editor } = renderTensor('<p>Hello one</p><p>Hello two</p>');
    configureTranslation('https://lt.example');
    mockInstance();
    mountPanel();
    expect(document.querySelector('[data-testid="translate-privacy-line"]')!.textContent).toContain('https://lt.example');
    expect(document.querySelector('[data-testid="translate-panel-setup-btn"]')).toBeNull();

    fireEvent.click(document.querySelector('[data-testid="translate-run"]')!);
    await flush();
    await waitFor(() => expect(document.querySelector('[data-testid="translate-preview"]')).not.toBeNull());

    const rows = [...document.querySelectorAll('[data-testid="translate-preview-row"]')];
    expect(rows.length).toBe(2);
    expect(rows[0]!.textContent).toContain('Bonjour one');

    fireEvent.click(document.querySelector('[data-testid="translate-apply-replace"]')!);
    await flush();
    expect(editor.getHTML()).toContain('Bonjour one');
    expect(editor.getHTML()).toContain('Bonjour two');
    // Applied → the document is the result; the panel returns to idle.
    expect(useTranslateStore.getState().phase).toBe('idle');
  });

  it('insert-alongside via the UI: interleaved puts each translation under its block', async () => {
    const { editor } = renderTensor('<p>Hello one</p><p>Hello two</p>');
    configureTranslation('https://lt.example');
    mockInstance();
    mountPanel();
    fireEvent.click(document.querySelector('[data-testid="translate-run"]')!);
    await flush();
    await waitFor(() => expect(document.querySelector('[data-testid="translate-preview"]')).not.toBeNull());

    // Whole-document scope offers the interleaved layout.
    fireEvent.click(document.querySelector('[data-testid="translate-insert-layout"]')!.firstElementChild!);
    await flush();
    const html = editor.getHTML();
    expect(html).toContain('<p blockid');
    expect(html).toMatch(/Hello one<\/p><p blockid/); // the translation sits under its block
  });

  it('selection scope only sends the selected blocks', async () => {
    const { editor } = renderTensor('<p>Hello one</p><p>Hello two</p>');
    configureTranslation('https://lt.example');
    mockInstance();
    mountPanel();
    // Select "two" (the second paragraph's content — 6..9).
    act(() => {
      editor.commands.setTextSelection({ from: 6, to: 9 });
    });
    fireEvent.click(document.querySelector('[data-testid="translate-scope-selection"]')!);
    fireEvent.click(document.querySelector('[data-testid="translate-run"]')!);
    await flush();
    await waitFor(() => expect(document.querySelector('[data-testid="translate-preview"]')).not.toBeNull());
    expect(document.querySelectorAll('[data-testid="translate-preview-row"]').length).toBe(1);
  });

  it('cancel discards the run wholesale', async () => {
    renderTensor('<p>Hello one</p>');
    configureTranslation('https://lt.example');
    mountPanel();
    // A pending invoke (never resolved) + cancel mid-flight.
    let release: (() => void) | undefined;
    invokeMock.mockImplementation(
      (_cmd, _args) =>
        new Promise((resolve) => {
          release = () => resolve({ translatedText: ['x'], detectedLanguage: null });
        }),
    );
    fireEvent.click(document.querySelector('[data-testid="translate-run"]')!);
    await flush();
    expect(useTranslateStore.getState().phase).toBe('translating');
    fireEvent.click(document.querySelector('[data-testid="translate-cancel"]')!);
    release?.();
    await flush();
    expect(useTranslateStore.getState().phase).toBe('idle');
    expect(useTranslateStore.getState().rows).toEqual([]);
  });

  it('an unreachable instance surfaces the error, never a toast, and the fallback picker stays usable', async () => {
    renderTensor('<p>Hello one</p>');
    configureTranslation('https://lt.example');
    mountPanel();
    invokeMock.mockImplementation(async () => {
      throw new Error('Connection failed: refused');
    });
    fireEvent.click(document.querySelector('[data-testid="translate-run"]')!);
    await flush();
    await waitFor(() => expect(document.querySelector('[data-testid="translate-error"]')).not.toBeNull());
    expect(document.querySelector('[data-testid="translate-error"]')!.textContent).toContain('Connection failed');
    expect(useTranslateStore.getState().phase).toBe('idle');
    // The language picker kept its fallback list (still a real list).
    expect(document.querySelector('[data-testid="translate-target"]')).not.toBeNull();
  });
});

describe('the local panel', () => {
  function configureLocal(): void {
    configureTranslation('', '', 'local');
  }

  /** The disk-backed invoke surface: the pair installs only after the
   *  download command runs. */
  function mockDisk(withInstalledPair: boolean): void {
    const installedNow = vi.fn(() => (withInstalledPair
      ? [{ code: 'en-de', from: 'en', to: 'de', files: [{ kind: 'model', path: '/m', size: 36_000_000, sha256: 'h' }] }]
      : []));
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === 'translate_model_installed') return installedNow();
      if (cmd === 'translate_catalog') {
        return {
          pairs: [
            { code: 'en-de', from: 'en', to: 'de', bytes: 36_719_532 },
            { code: 'fr-en', from: 'fr', to: 'en', bytes: 30_000_000 },
          ],
        };
      }
      if (cmd === 'translate_model_download') {
        withInstalledPair = true;
        return { code: 'en-de', from: 'en', to: 'de', files: [{ kind: 'model', path: '/m', size: 36_000_000, sha256: 'h' }] };
      }
      throw new Error('unexpected invoke: ' + cmd);
    });
  }

  it('picks a pair, downloads it on demand, runs offline, and never claims to send', async () => {
    const { editor } = renderTensor('<p>Hello one</p>');
    configureLocal();
    mockDisk(false);
    mountPanel();

    // The local picker + the offline privacy line.
    expect(document.querySelector('[data-testid="translate-pair-list"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="translate-privacy-local"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="translate-privacy-line"]')!.textContent).toContain('Runs on this device');
    await waitFor(() => expect(document.querySelector('[data-testid="translate-catalog-loading"]')).toBeNull());
    // The catalog's pairs are IN the panel (no popup to lose).
    expect(document.querySelectorAll('[data-testid^="translate-pair-row-"]').length).toBe(2);

    // Choosing an UNINSTALLED pair arms the download (the honest next
    // action — the run button would be a lie).
    fireEvent.click(document.querySelector('[data-testid="translate-pair-row-en-de"]')!);
    await flush();
    expect(useTranslateStore.getState().sourceLang).toBe('en');
    expect(useTranslateStore.getState().targetLang).toBe('de');
    const download = document.querySelector('[data-testid="translate-download"]') as HTMLButtonElement;
    expect(download).not.toBeNull();
    expect(download.textContent).toContain('Download model');

    fireEvent.click(download);
    await flush();
    await waitFor(() => expect(document.querySelector('[data-testid="translate-download"]')).toBeNull());
    // Installed: the run button replaces the download affordance.
    const run = document.querySelector('[data-testid="translate-run"]') as HTMLButtonElement;
    expect(run).not.toBeNull();
    expect(run.disabled).toBe(false);

    fireEvent.click(run);
    await flush();
    await waitFor(() => expect(document.querySelector('[data-testid="translate-preview"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-testid="translate-apply-replace"]')!);
    await flush();
    expect(editor.getHTML()).toContain('Hallo one');
  });

  it('an already-downloaded pair skips straight to the run', async () => {
    renderTensor('<p>Hello one</p>');
    configureLocal();
    mockDisk(true);
    mountPanel();
    await waitFor(() => expect(document.querySelector('[data-testid="translate-catalog-loading"]')).toBeNull());
    fireEvent.click(document.querySelector('[data-testid="translate-pair-row-en-de"]')!);
    await flush();
    expect(document.querySelector('[data-testid="translate-download"]')).toBeNull();
    const run = document.querySelector('[data-testid="translate-run"]') as HTMLButtonElement;
    expect(run.disabled).toBe(false);
    fireEvent.click(run);
    await flush();
    await waitFor(() => expect(document.querySelector('[data-testid="translate-preview"]')).not.toBeNull());
  });
});
