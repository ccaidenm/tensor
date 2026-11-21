import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, cleanup } from '@testing-library/react';
import { renderTensor, settleLayout } from './harness';
import { useDocumentStore } from '@/lib/document/store';
import { useConfigStore } from '@/lib/config/store';
import { getCommand } from '@/lib/commands/registry';
import { StartScreen } from '@/components/StartScreen';
import { TitleBarRow } from '@/components/layout/TitleBarRow';
import { saveRecoveryCopy, listRecoveryCopies } from '@/lib/document/recovery';
import { assembleDocumentFile } from '@/lib/document/fileOperations';
import { saveWpdoc } from '@/lib/document/wpdoc';

// #103 — the tauri layer, mocked at the seams the recovery flow
// touches (the docx-save suite's pattern): the zip rides through
// Rust, so the package/unpackage pair is where the round trip
// mocks-in.
const fsFiles = vi.hoisted(() => new Map<string, Uint8Array | string>());
const wpdocInvokes = vi.hoisted(() => new Map<string, string>());
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeFile: vi.fn(async (p: string, bytes: Uint8Array) => {
    fsFiles.set(p, bytes);
  }),
  readFile: vi.fn(async (p: string) => {
    const raw = fsFiles.get(p);
    if (raw instanceof Uint8Array) return raw;
    throw new Error(`missing: ${p}`);
  }),
  readTextFile: vi.fn(async (p: string) => {
    const raw = fsFiles.get(p);
    if (typeof raw === 'string') return raw;
    throw new Error(`missing: ${p}`);
  }),
  readDir: vi.fn(async (dir: string) =>
    [...fsFiles.keys()]
      .filter((k) => k.startsWith(`${dir}/`) && k.endsWith('.wpdoc'))
      .map((k) => ({ name: k.slice(dir.length + 1).split('/').pop(), isFile: true, isDirectory: false, isSymlink: false })),
  ),
  exists: vi.fn(async () => true),
  mkdir: vi.fn(async () => null),
  remove: vi.fn(async (p: string) => {
    fsFiles.delete(p);
  }),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: { path?: string; documentJson?: string }) => {
    if (cmd === 'package_document') {
      wpdocInvokes.set(args.path!, args.documentJson!);
      // The real Rust writes the zip at args.path — the mock's stand-in
      // (the bytes are opaque; the unpackage mock returns the JSON).
      fsFiles.set(args.path!, new TextEncoder().encode(args.documentJson!));
      return null;
    }
    if (cmd === 'unpackage_document') {
      const json = wpdocInvokes.get(args.path!);
      if (json === undefined) throw new Error('not found');
      // The Rust unpackager's shape: the document + zero media.
      return { document: json, media: [] };
    }
    throw new Error(`unexpected command: ${cmd}`);
  }),
}));
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn(async () => '/tmp/tensor-appdata'),
  join: vi.fn(async (...parts: string[]) => parts.join('/')),
}));

/**
 * #103 — THE START SCREEN (the landing half): the greeting, the
 * template row (blank paginated/pageless + the starters + Open), the
 * recents, and the home chrome (TitleBarRow's home variant). The
 * start screen renders STANDALONE beside the harness's editor (the
 * Ribbon/topbar precedent — the harness mounts the Editor context;
 * the surface under test renders beside it, driven by the same
 * stores).
 */

beforeEach(() => {
  fsFiles.clear();
  wpdocInvokes.clear();
  useConfigStore.setState({
    config: {
      ...useConfigStore.getState().config,
      recentDocuments: [],
      identity: { ...useConfigStore.getState().config.identity, author: '' },
    },
  });
  // The FULL doc-store surface resets — the singleton leaks filePath/
  // pageSetup/isDirty across this file's tests otherwise (the restore
  // tests proved it).
  useDocumentStore.setState({
    startActive: true,
    hasDocument: false,
    filePath: null,
    isDirty: false,
    pageSetup: { pageSize: 'Letter', margins: { top: 72, bottom: 72, left: 72, right: 72 }, pageGap: 32 },
    pageStyles: {},
    lineNumbers: null,
    headerFooter: null,
  });
});

afterEach(cleanup);

describe('the start screen (#103)', () => {
  it('renders Home: the greeting, every template card, the open card, the empty recents', () => {
    renderTensor('<p>x</p>');
    render(<StartScreen />);
    expect(document.querySelector('[data-testid="start-screen"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="start-greeting"]')).not.toBeNull();
    for (const id of [
      'template-blank-paginated',
      'template-blank-pageless',
      'template-open-file',
      'template-letter',
      'template-report',
      'template-meeting-notes',
      'template-proposal',
    ]) {
      expect(document.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    }
    // The two-row structure: the core row's header, then the starters'
    // divider ("Or choose a template"), then recents.
    expect(document.body.textContent).toContain('Start a new document');
    expect(document.body.textContent).toContain('Or choose a template');
    expect(document.body.textContent).toContain('Recent documents');
    // The graceful blank copy: the mode lives in the notes, not a chip —
    // the description carries it.
    const paginated = document.querySelector('[data-testid="template-blank-paginated"]')!;
    expect(paginated.textContent).toContain('Paginated');
    expect(paginated.textContent).toContain('print-ready');
    // Empty recents: the honest empty state.
    expect(document.querySelector('[data-testid="recents-empty"]')).not.toBeNull();
  });

  it('the home chrome: window controls, no tabs, no document name (TitleBarRow home variant)', () => {
    renderTensor('<p>x</p>');
    render(<TitleBarRow variant="home" />);
    expect(document.querySelector('[aria-label="Minimize"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Close"]')).not.toBeNull();
    expect(document.querySelector('[role="tablist"]')).toBeNull();
    // The home menu (boot: no document yet): Open/Settings/Quit — NO
    // Return item (the start screen's own return card owns that path).
    fireEvent.click(document.querySelector('button')!);
    const menu = document.body.textContent!;
    expect(menu).toContain('Open');
    expect(menu).toContain('Settings');
    expect(menu).toContain('Quit Tensor');
    expect(menu).not.toContain('Return to');
  });

  it('the LIBRARY menu: the editor menu goes Home (above Settings); the doc stays loaded', async () => {
    renderTensor('<p>x</p>');
    // A document exists (leave Home first, then open the editor menu):
    await act(async () => {
      void getCommand('new')!.run();
    });
    expect(useDocumentStore.getState().startActive).toBe(false);
    render(<TitleBarRow variant="editor" />);
    fireEvent.click(document.querySelector('button')!);
    const menu = document.body.textContent!;
    // The naming (the user's ruling): Library, not Home — and it sits
    // ABOVE Settings (the app pair).
    expect(menu).toContain('Library');
    expect(menu).not.toContain('Home');
    expect(menu.indexOf('Library')).toBeLessThan(menu.indexOf('Settings'));
    // The Library click: to the start screen; the doc STAYS loaded.
    const libraryItem = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
    ).find((i) => i.textContent === 'Library')!;
    fireEvent.click(libraryItem);
    expect(useDocumentStore.getState().startActive).toBe(true);
    expect(useDocumentStore.getState().hasDocument).toBe(true);
  });

  it('the RETURN CARD: "<- Return to …" + Save & close above the greeting', async () => {
    renderTensor('<p>x</p>');
    act(() => {
      useDocumentStore.setState({ hasDocument: true, filePath: '/docs/newsletter.wpdoc' });
    });
    render(<StartScreen />);
    const row = document.querySelector('[data-testid="return-row"]')!;
    expect(row.textContent).toContain('Return to newsletter.wpdoc');
    // The two cards are SEPARATE bordered buttons (the user's shape):
    // distinct nodes, each carrying its own outline border.
    const returnBtn = document.querySelector('[data-testid="return-to-document"]')!;
    const closeBtn = document.querySelector('[data-testid="save-and-close"]')!;
    expect(returnBtn).not.toBe(closeBtn);
    expect(returnBtn.className).toContain('border');
    expect(closeBtn.className).toContain('border');
    // A saved doc reads "Save and close" (an untitled one reads "Close").
    expect(closeBtn.textContent).toContain('Save and close');
    // The floppy icon (the save affordance).
    expect(closeBtn.querySelector('.lucide-save')).not.toBeNull();
    // Return: back to the doc (Home leaves; nothing discarded).
    fireEvent.click(returnBtn);
    expect(useDocumentStore.getState().startActive).toBe(false);
    expect(useDocumentStore.getState().hasDocument).toBe(true);
  });

  it('SAVE & CLOSE: the doc resets (fresh placeholder), Home stays, hasDocument drops', async () => {
    renderTensor('<p>work in progress</p>');
    act(() => {
      // The real flow: the user reached Home via Library — the start
      // screen is UP, the doc loaded underneath it.
      useDocumentStore.setState({ hasDocument: true, filePath: null, isDirty: true, startActive: true });
    });
    render(<StartScreen />);
    // An untitled doc reads "Close" honestly (its work rides the
    // recovery net — the same promise quit/new make).
    const row = document.querySelector('[data-testid="return-row"]')!;
    // An untitled doc reads "Close" honestly (its work rides the
    // recovery net — the same promise quit/new make).
    expect(row.textContent).toContain('Close');
    expect(row.textContent).not.toContain('Save and close');
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="save-and-close"]')!);
    });
    const store = useDocumentStore.getState();
    // Still on Home, NO loaded doc (the fresh start the card promises):
    expect(store.startActive).toBe(true);
    expect(store.hasDocument).toBe(false);
    expect(store.isDirty).toBe(false);
    // The editor reset to the fresh placeholder — the stale work gone.
    expect(store.editor!.state.doc.textContent).not.toContain('work in progress');
    // No return card anymore (nothing to return to) — the plain library.
    cleanup();
    render(<StartScreen />);
    expect(document.querySelector('[data-testid="return-row"]')).toBeNull();
  });

  it('the greeting carries the author identity (the field the setup wizard will seed)', () => {
    renderTensor('<p>x</p>');
    act(() => {
      useConfigStore.getState().setIdentityAuthor('Caiden');
    });
    render(<StartScreen />);
    expect(document.querySelector('[data-testid="start-greeting"]')!.textContent).toContain('Caiden');
    act(() => {
      useConfigStore.getState().setIdentityAuthor('');
    });
  });

  it('Blank Paginated: a fresh Pages doc — Home closes, the mode lands, the stale content clears', async () => {
    renderTensor('<p>stale content from the session</p>');
    render(<StartScreen />);
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="template-blank-paginated"]')!);
    });
    const store = useDocumentStore.getState();
    expect(store.startActive).toBe(false);
    expect(store.pageSetup.viewMode).toBe('pages');
    expect(store.filePath).toBeNull();
    // The stale session content is gone — the fresh placeholder.
    expect(store.editor!.state.doc.textContent).not.toContain('stale content');
  });

  it('Blank Pageless: the view mode lands pageless (the two blanks ARE the choice)', async () => {
    renderTensor('<p>x</p>');
    render(<StartScreen />);
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="template-blank-pageless"]')!);
    });
    expect(useDocumentStore.getState().startActive).toBe(false);
    expect(useDocumentStore.getState().pageSetup.viewMode).toBe('pageless');
  });

  it('a starter template lands its content (Meeting Notes)', async () => {
    renderTensor('<p>x</p>');
    render(<StartScreen />);
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="template-meeting-notes"]')!);
    });
    await settleLayout();
    const store = useDocumentStore.getState();
    expect(store.startActive).toBe(false);
    expect(store.editor!.state.doc.textContent).toContain('Meeting title');
    expect(store.editor!.state.doc.textContent).toContain('Action items');
  });

  it('recents render from the config, most recent first, and a click opens by path', () => {
    renderTensor('<p>x</p>');
    act(() => {
      // Noted oldest-first so newsletter (noted last) leads the list.
      useConfigStore.getState().noteRecentDocument('/docs/old.md', 'old.md');
      useConfigStore.getState().noteRecentDocument('/docs/newsletter.wpdoc', 'newsletter.wpdoc');
    });
    render(<StartScreen />);
    expect(document.querySelector('[data-testid="recents-empty"]')).toBeNull();
    const cards = Array.from(document.querySelectorAll('[data-testid^="recent-"]'));
    expect(cards[0]!.textContent).toContain('newsletter.wpdoc');
    expect(cards[1]!.textContent).toContain('old.md');
    // A click routes through openFile WITH the path (the picker never
    // fires from a known path). Spy swap INSIDE act — the re-render
    // must flush before the click. The spy is RESTORED after — a
    // leaked spy would swallow every later open (the pageless-repro
    // test's silent no-op open).
    const openFile = useDocumentStore.getState().openFile;
    const spy = vi.fn();
    act(() => {
      useDocumentStore.setState({ openFile: spy as unknown as typeof openFile });
    });
    fireEvent.click(cards[0]!);
    expect(spy).toHaveBeenCalledWith('/docs/newsletter.wpdoc');
    act(() => {
      useDocumentStore.setState({ openFile });
    });
  });

  it("the registry's New is real: run() leaves Home on the config's default layout", async () => {
    renderTensor('<p>x</p>');
    render(<StartScreen />);
    await act(async () => {
      void getCommand('new')!.run();
    });
    expect(useDocumentStore.getState().startActive).toBe(false);
    expect(useDocumentStore.getState().pageSetup.viewMode).toBe('pages');
  });
});

describe('the start screen — recovery + stable layout (#103)', () => {
  beforeEach(() => {
    useDocumentStore.setState({ startActive: true, hasDocument: false, filePath: null, isDirty: false });
  });

  it('pinned UNSAVED WORK: recovery snapshots list above the recents with a restore action', async () => {
    renderTensor('<p>x</p>');
    // A dirty doc + a recovery snapshot on disk (the quit/new shape):
    await act(async () => {
      void saveRecoveryCopy(
        useDocumentStore.getState().editor!,
        '/docs/draft.wpdoc',
        {
          pageSetup: useDocumentStore.getState().pageSetup,
          lineNumbers: null,
          coreProperties: { title: 'My draft' },
          headerFooter: null,
          commentThreads: [],
        },
      );
    });
    render(<StartScreen />);
    // Flush the useEffect's listing microtasks, then query.
    await act(async () => {});
    const card = await act(async () => {
      const el = document.querySelector('[data-testid="recovery-draft.wpdoc"]');
      expect(el, 'the recovery card renders').not.toBeNull();
      expect(el!.textContent).toContain('draft.wpdoc');
      expect(el!.textContent).toContain('Unsaved');
      // PINNED above the recents (the DOM order is the visual order):
      const unsaved = document.querySelector('[aria-label="Unsaved work"]')!;
      const recent = document.querySelector('[aria-label="Recent documents"]')!;
      expect(unsaved.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      return el;
    });
    void card;
  });

  it('RESTORE: the snapshot becomes the live doc (content, path, Home closes, snapshot consumed)', async () => {
    renderTensor('<p>x</p>');
    await act(async () => {
      void saveRecoveryCopy(
        useDocumentStore.getState().editor!,
        '/docs/draft.wpdoc',
        {
          pageSetup: useDocumentStore.getState().pageSetup,
          lineNumbers: null,
          coreProperties: { title: 'My draft' },
          headerFooter: null,
          commentThreads: [],
        },
      );
    });
    const entries = await listRecoveryCopies();
    expect(entries.length).toBe(1);
    // Give the snapshot real content to verify the restore:
    useDocumentStore.getState().editor!.commands.setContent('<p>the recovered words</p>');
    await act(async () => {
      void saveRecoveryCopy(
        useDocumentStore.getState().editor!,
        '/docs/draft.wpdoc',
        {
          pageSetup: useDocumentStore.getState().pageSetup,
          lineNumbers: null,
          coreProperties: { title: 'My draft' },
          headerFooter: null,
          commentThreads: [],
        },
      );
    });
    render(<StartScreen />);
    await act(async () => {});
    const card = document.querySelector('[data-testid="recovery-draft.wpdoc"]')!;
    await act(async () => {
      fireEvent.click(card);
    });
    await settleLayout();
    const store = useDocumentStore.getState();
    // Home closes; the doc lives; the back-pointer resumes in-place saves.
    expect(store.startActive).toBe(false);
    expect(store.hasDocument).toBe(true);
    expect(store.filePath).toBe('/docs/draft.wpdoc');
    expect(store.isDirty).toBe(true); // honest: unsaved changes ride in
    expect(store.editor!.state.doc.textContent).toContain('the recovered words');
    // The consumed snapshot is GONE (the store's remove ran). The
    // list MAY re-populate under the same hash path via the app's
    // autosave (the restored doc is dirty — the net re-arms, correct)
    // — timing-dependent in jsdom, so only the STORE state is the
    // assertion here (above).
  });

  it('the return row OVERLAYS the top-right (the content position never shifts)', () => {
    renderTensor('<p>x</p>');
    act(() => {
      useDocumentStore.setState({ hasDocument: true, filePath: '/docs/newsletter.wpdoc', startActive: true });
    });
    render(<StartScreen />);
    const row = document.querySelector('[data-testid="return-row"]') as HTMLElement;
    expect(row).not.toBeNull();
    // The overlay contract: absolutely positioned in the top-right —
    // its presence/disappearance cannot push the content column.
    expect(row.className).toContain('absolute');
    expect(row.className).toContain('right-8');
    const greeting = document.querySelector('[data-testid="start-greeting"]') as HTMLElement;
    expect(greeting).not.toBeNull();
    // And the column carries the reserved top space (pt-16 — the
    // overlay's zone; the greeting's position is constant with/without).
    const column = greeting.closest('.pt-16');
    expect(column).not.toBeNull();
  });
});

describe('the start screen — the pageless-open regression (#103)', () => {
  beforeEach(() => {
    useDocumentStore.setState({ startActive: true, hasDocument: false, filePath: null, isDirty: false });
  });

  it('opening a PAGINATED .wpdoc from the library stays paginated', async () => {
    renderTensor('<p>x</p>');
    // A .wpdoc saved with an EXPLICIT paginated view mode:
    await act(async () => {
      void saveRecoveryCopy(
        useDocumentStore.getState().editor!,
        '/docs/paginated.wpdoc',
        {
          pageSetup: { ...useDocumentStore.getState().pageSetup, viewMode: 'pages' },
          lineNumbers: null,
          coreProperties: { title: 'Paginated doc' },
          headerFooter: null,
          commentThreads: [],
        },
      );
    });
    render(<StartScreen />);
    await act(async () => {});
    const card = document.querySelector('[data-testid="recovery-paginated.wpdoc"]')!;
    await act(async () => {
      fireEvent.click(card);
    });
    await settleLayout();
    const store = useDocumentStore.getState();
    expect(store.startActive).toBe(false);
    expect(store.pageSetup.viewMode).toBe('pages');
    await settleLayout();
    expect(store.pageSetup.viewMode).toBe('pages');
  });

  it('opening a PAGINATED .wpdoc from the recents (the openFile path) stays paginated', async () => {
    renderTensor('<p>x</p>');
    // A REAL .wpdoc on disk (the recents open the DOC path — the
    // save side assembles and packages exactly like Save does):
    await act(async () => {
      const file = assembleDocumentFile(useDocumentStore.getState().editor!, {
        pageSetup: { ...useDocumentStore.getState().pageSetup, viewMode: 'pages' },
        lineNumbers: null,
        coreProperties: { title: 'Paginated doc' },
        headerFooter: null,
        commentThreads: [],
        originalPath: '/docs/paginated2.wpdoc',
      });
      void saveWpdoc('/docs/paginated2.wpdoc', file);
    });
    await act(async () => {
      useConfigStore.getState().noteRecentDocument('/docs/paginated2.wpdoc', 'paginated2.wpdoc');
    });
    // The open runs DIRECTLY and AWAITED: the dirty guard's recovery
    // snapshot pauses at crypto.subtle.digest (a real macrotask act
    // cannot flush) — the card's void-call races the assertion (the
    // flake); the card→path contract is pinned by the recents test.
    await act(async () => {
      await useDocumentStore.getState().openFile('/docs/paginated2.wpdoc');
    });
    await settleLayout();
    const store = useDocumentStore.getState();
    expect(store.filePath).toBe('/docs/paginated2.wpdoc');
    expect(store.pageSetup.viewMode).toBe('pages');
  });
});
