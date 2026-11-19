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
 * THE TRANSLATE PANEL + SETUP DIALOG — the UI half of the issue: the
 * unconfigured panel is the consent surface; a configured panel runs
 * scope → translate → preview → apply, with the privacy line always
 * visible. `invoke` is mocked; no Rust, no instance.
 */

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
const invokeMock = vi.mocked(invoke);

/** Mount the panel the way App.tsx does, opened through the real
 *  command (the a11yCheck mount law). */
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

function configureTranslation(endpoint = 'https://lt.example', apiKey = '', provider: 'libretranslate' | 'google' | 'deepl' = 'libretranslate'): void {
  useConfigStore.setState({
    config: {
      ...DEFAULT_CONFIG,
      translation: { provider, configured: true, endpoint, apiKey, lastTargetLang: 'en' },
    },
  });
}

/** The instance mock: the languages list + the array-in/array-out
 *  translation law. */
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
    // Three provider cards, the trade-offs on the cards themselves.
    expect(document.querySelectorAll('[data-testid^="translate-setup-card-"]').length).toBe(3);

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
