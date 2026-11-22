import { useEffect } from 'react';
import { Editor } from './components/editor/Editor';
import { StartScreen } from './components/StartScreen';
import { TitleBarRow } from './components/layout/TitleBarRow';
import { cn } from 'cn';
import { SearchPanel } from './components/editor/SearchPanel';
import { TablePanel } from './components/editor/TablePanel';
import { SearchResultsSidebar } from './components/editor/SearchResultsSidebar';
import { AccessibilityCheckPanel } from './components/editor/AccessibilityCheckPanel';
import { WatermarkPanel } from './components/editor/WatermarkPanel';
import { TranslatePanel } from './components/editor/TranslatePanel';
import { TranslateSetupDialog } from './components/dialogs/TranslateSetupDialog';
import { StatisticsPanel } from './components/editor/StatisticsPanel';
import { SettingsDialog } from './components/settings/SettingsDialog';
import { DocumentPropertiesDialog } from './components/dialogs/DocumentPropertiesDialog';
import { ColumnsDialog } from './components/dialogs/ColumnsDialog';
import { PageSetupDialog } from './components/dialogs/PageSetupDialog';
import { CustomPageSizeDialog } from './components/dialogs/CustomPageSizeDialog';
import { StyleDialog } from './components/dialogs/StyleDialog';
import { FontBrowserDialog } from './components/dialogs/FontBrowserDialog';
import { AltTextDialog } from './components/dialogs/ImageDialogs';
import { InsertTableDialog } from './components/dialogs/InsertTableDialog';
import { ExportConfirmDialog } from './components/dialogs/ExportConfirmDialog';
import { ImportOptionsDialog } from './components/dialogs/ImportOptionsDialog';
import { ImportReportDialog } from './components/dialogs/ImportReportDialog';
import { PrintPreviewDialog } from './components/dialogs/PrintPreviewDialog';
import { PrintContainer } from '@/lib/print/PrintContainer';
import { InsertReferenceTableDialog } from './components/dialogs/InsertReferenceTableDialog';
import { SpellSetupDialog } from './components/dialogs/SpellSetupDialog';
import { DictionaryDialog } from './components/dialogs/DictionaryDialog';
import { SymbolBubble } from './components/layout/ribbon/insert/SymbolBubble';
import { ExitFocusButton } from './components/layout/ExitFocusButton';
import { Toaster } from '@/components/ui/toast';
import { CommandPalette } from './components/palette/CommandPalette';
import { useConfigStore } from './lib/config/store';
import { SetupWizard } from './components/setup/SetupWizard';
import { useConfigPersistence } from './lib/config/useConfigPersistence';
import './index.css';
import { useAppShortcuts } from './lib/shortcuts/useAppShortcuts';
import { useAutosave } from './lib/document/useAutosave';
import { useStyleRegistryStore } from './lib/styles/registry';
import { useFontRegistryStore } from './lib/fonts/registry';
import { prefetchCatalogs } from './lib/fonts/catalogs';
import { useStyleDialogStore } from './lib/styles/dialogStore';
import { StatusBar } from './components/layout/StatusBar';
import { Ribbon } from './components/layout/Ribbon';
import { SidebarHost } from './lib/layout/sidebar/SidebarHost';
import { useDocumentStore } from './lib/document/store';

function App() {
  useConfigPersistence();
  useAutosave();
  useAppShortcuts();
  // THE SYMBOL BUBBLE'S EDITOR HANDLE: the floating picker mounts at
  // App level (not inside the Insert tab) so it persists across ribbon
  // tab switches — park it in a corner, switch tabs, keep inserting.
  const editor = useDocumentStore((s) => s.editor);
  // #103 — the start screen owns the window until a document exists.
  const startActive = useDocumentStore((s) => s.startActive);
  // #103 — THE FIRST-RUN GATE: the setup wizard rides beside the
  // start screen until completed/skipped (the flag's law: once, ever).
  const firstRunCompleted = useConfigStore((s) => s.config.firstRunCompleted);
  // M-STYLES: load the global registry (appConfigDir/styles.json) once
  // at bootstrap — merges over the code builtins; first run seeds the
  // file (hyperlink custom, builtins.ts). Doc layers apply on open.
  useEffect(() => {
    void useStyleRegistryStore.getState().loadGlobal();
  }, []);

  // M-T4 — the app-wide native-menu REPLACEMENT: the WebView's own
  // right-click menu dies everywhere (document surface, chrome, desk);
  // the custom DocumentContextMenu (Editor.tsx's routing wrap) is the
  // document surface's menu, and the ruler's band menus bring their
  // own handlers. Suppression is inert for both (preventDefault is
  // idempotent).
  useEffect(() => {
    const suppress = (e: MouseEvent) => e.preventDefault();
    window.addEventListener('contextmenu', suppress);
    return () => window.removeEventListener('contextmenu', suppress);
  }, []);

  // M-FONTS-A: re-register uploaded fonts from appDataDir()/fonts/
  // once at bootstrap (fonts.json is the entry list) — before the
  // paginated view's font gate settles its first layout.
  useEffect(() => {
    void useFontRegistryStore.getState().loadFromDisk();
  }, []);

  // M-FONTS-B: when the user has opted into online catalogs, warm the
  // list-all metadata (Google + Fontsource) once per session — the
  // ON-toggle consent ruling. No code path reaches the network while
  // the toggle is off.
  const allowFontCatalogs = useConfigStore((s) => s.config.privacy.allowFontCatalogs);
  useEffect(() => {
    if (allowFontCatalogs) {
      void prefetchCatalogs();
    }
  }, [allowFontCatalogs]);

  // Differential benchmark. Triggers: URL #bench/?bench, OR five
  // rapid clicks on the StatusBar (mouse-only driving — the test box's
  // keyboard injection is unreliable). Output goes to a visible <pre>
  // (readable via AT-SPI from the WebKitGTK app) + console.
  useEffect(() => {
    const mark = (s: string) => {
      document.title = s.slice(0, 150);
    };
    // Measurement channel: write results into $APPDATA via the fs
    // plugin — readable from the shell regardless of a11y/console/title.
    const writeResult = async (text: string, suffix = '') => {
      try {
        const [{ writeTextFile }, { appDataDir, join }] = await Promise.all([
          import('@tauri-apps/plugin-fs'),
          import('@tauri-apps/api/path'),
        ]);
        await writeTextFile(await join(await appDataDir(), `bench-result${suffix}.txt`), text);
      } catch {
        // non-Tauri (plain browser) — console + <pre> still carry it
      }
    };
    const runDifferential = async () => {
      try {
        mark('BENCH:starting');
        const editor = useDocumentStore.getState().editor;
        if (!editor) {
          mark('BENCH:no-editor');
          return;
        }
        mark('BENCH:loading-modules');
        const [{ runBench: rb, formatBench: fb }, { default: perf71 }] = await Promise.all([
          import('@/lib/paginated/bench'),
          import('@/tests/fixtures/perf-71.html?raw'),
        ]);
        mark('BENCH:small-start');
        const small = await rb(editor, '<p>hello world</p>', 'SMALL');
        await writeResult('=== SMALL ===\n' + fb(small), '-small');
        mark('BENCH:big-start');
        const big = await rb(editor, perf71, 'BIG');
        // Global for browser drivers (Brave/Chromium collect via CDP).
        (globalThis as { __benchResult?: unknown }).__benchResult = { small, big };
        const text =
          '=== DIFFERENTIAL ===\n' + fb(small) + '\n' + fb(big);
        await writeResult(text);
        // eslint-disable-next-line no-console
        console.log(text);
        document.getElementById('bench-output')?.remove();
        const pre = document.createElement('pre');
        pre.id = 'bench-output';
        pre.style.cssText = 'position:fixed;top:0;left:0;z-index:9999;background:#fff;color:#000;padding:8px;font-size:11px;max-height:420px;overflow:auto;white-space:pre-wrap;font-family:monospace';
        pre.textContent = text;
        document.body.appendChild(pre);
        // Title channel: the whole result, newline-free, for AT-SPI.
        mark('BENCH-RESULT | ' + text.split('\n').join(' | '));
      } catch (err) {
        mark('BENCH:ERROR ' + (err instanceof Error ? err.message : String(err)).slice(0, 120));
      }
    };
    const armed = () => useDocumentStore.getState().editor !== null;
    const urlTriggered =
      location.hash === '#bench' || new URLSearchParams(location.search).has('bench');
    if (urlTriggered || __BENCH_AUTO__) {
      const poll = () => (armed() ? void runDifferential() : setTimeout(poll, 250));
      poll();
    }
    const onBenchEvent = () => {
      if (armed()) void runDifferential();
      else setTimeout(onBenchEvent, 250);
    };
    window.addEventListener('tensor-bench', onBenchEvent, { once: true });
    return () => window.removeEventListener('tensor-bench', onBenchEvent);
  }, []);

  const styleDialog = useStyleDialogStore();

  return (
    <>
      <main data-screen-chrome className="flex h-screen flex-col bg-background text-foreground">
        {/* #103 — THE START SCREEN: every launch opens on Home (the
            Word/GDocs posture). The TitleBarRow (home variant) keeps
            the window chrome; the ribbon, desk, and status bar step
            aside — the DESK STAYS MOUNTED but hidden (the Editor's
            lifecycle, the doc flows, and every portal target keep
            working; Home is a view state, not a teardown).
            #103 FIRST RUN: before the wizard completes, the start
            screen steps aside TOO — the wizard is the only content
            (the installer posture: a lone window over a quiet desk;
            Finish reveals the now-personalized Home). */}
        {startActive ? (
          <>
            <TitleBarRow variant="home" />
            {firstRunCompleted && <StartScreen />}
          </>
        ) : (
          /* FOCUS MODE — the ribbon and status bar own their own hides
             (component-level gates: any mount context unmounts them;
             nothing hidden keeps running). */
          <Ribbon />
        )}
        {/* data-desk-wrapper: the M-RULER portal target — the ruler bar
            mounts here as static overlay chrome (flush under the Ribbon,
            outside the scroller's flow; show/hide reflows nothing). */}
        <div
          data-desk-wrapper
          className={cn('relative flex-1 overflow-hidden', startActive && 'hidden')}
        >
          {/* Desk: the editor scroll surface — the muted token reads
              as the classic gray desk in light mode and adapts in dark.
              data-desk-scroll: the ruler reads this element's clientWidth
              (scrollbar-correct page centering) and scrollLeft (horizontal
              overflow tracking). pt-8 leaves room for the 18px ruler
              overlay + a 14px gap to the page. */}
          <div className="absolute inset-0 overflow-auto bg-muted pt-8 pb-6" data-desk-scroll>
            <Editor />
          </div>
          <SearchPanel />
          <SidebarHost id="search" anchor="right">
            <SearchResultsSidebar />
          </SidebarHost>
          {/* M-T3c — the Table side panel: the same docked-panel
              infrastructure as Find/Replace (the draggable/resizable
              panel future upgrades once for every panel). */}
          <SidebarHost id="table" anchor="right">
            <TablePanel />
          </SidebarHost>
          {/* M-A11Y — the Accessibility Check panel: the document-content
              checker's results list (the search sidebar's docked-list
              twin; scan runs live while open, never in the background). */}
          <SidebarHost id="accessibilityCheck" anchor="right">
            <AccessibilityCheckPanel />
          </SidebarHost>
          {/* #WATERMARK — the watermark panel: the decorative overlay's
              LIVE editor (paint-only commits — the page behind the open
              panel is the preview). */}
          <SidebarHost id="watermark" anchor="right">
            <WatermarkPanel />
          </SidebarHost>
          {/* TRANSLATE — the Review tab's on-demand translation: the
              consented run panel (scope → run → preview → apply),
              docked beside its Review siblings. The SETUP dialog is
              store-driven with one mount like its spell twin. */}
          <SidebarHost id="translate" anchor="right">
            <TranslatePanel />
          </SidebarHost>
          {/* STATISTICS — the Review tab's dashboard sidebar: the
              headline-number cards + the heading-delimited region list,
              live while open (the StatusBar debounce pattern). */}
          <SidebarHost id="statistics" anchor="right">
            <StatisticsPanel />
          </SidebarHost>
        </div>
        {!startActive && <StatusBar />}
      </main>
      {startActive && <SetupWizard />}
      <SettingsDialog />
      <CommandPalette />
      <StyleDialog state={styleDialog} onClose={styleDialog.close} />
      <FontBrowserDialog />
      <AltTextDialog />
      <InsertTableDialog />
      {/* M-MD/M-DOCX: THE export lossy confirm — one gate for every
          export flow, store-driven, one mount like its
          InsertTableDialog twin (the developer-mode warning's in-app
          spelling; never a native popup). */}
      <ExportConfirmDialog />
      {/* M-DOCX: the import options surface (the font policy) — the
          same promise-bridge pattern, one mount. */}
      <ImportOptionsDialog />
      {/* M-MD/M-DOCX: the import report (what an import dropped or
          converted) — the loud posture's in-app surface. */}
      <ImportReportDialog />
      {/* M-PRINT (#43, Mark 3): the print preview — the palette opens
          it; Mark 2's Print command joins it. */}
      <PrintPreviewDialog />
      {/* M-PRINT (#43, Mark 2): THE PRINT CONTAINER — hidden on
          screen, revealed by @media print (index.css) while
          [data-screen-chrome] hides; the preview's Print button arms
          it with the SAME walk the preview rendered. */}
      <PrintContainer />
      {/* M-REFS: the ToC insert dialog (depth picker) — store-driven,
          one mount like its InsertTableDialog twin. */}
      <InsertReferenceTableDialog />
      <DocumentPropertiesDialog />
      <Toaster />
      {editor && <SymbolBubble editor={editor} />}
      {/* THE EXIT BUTTON — Focus Mode's floating affordance (the same
          command body as every other surface). */}
      <ExitFocusButton />
      <CustomPageSizeDialog />
      {/* #58 — the ONE Page Setup dialog (paper/orientation/margins
          with an Apply-to scope: whole document / this section / this
          point forward). */}
      <PageSetupDialog />
      {/* #74 COLUMNS — the ONE Columns dialog (the spec with an
          Apply-to scope; the ArrangeGroup's "More columns…" opens it). */}
      <ColumnsDialog />
      {/* Spell check: the provider-choice consent surface + the
          personal dictionary manager (both store-driven, one mount). */}
      <SpellSetupDialog />
      <DictionaryDialog />
      {/* Translate: the consent surface (the SpellSetupDialog twin) —
          endpoint + optional key, tested before it can be saved. */}
      <TranslateSetupDialog />
    </>
  );
}

export default App;
