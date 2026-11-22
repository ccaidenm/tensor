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
import { writeTextFile } from '@tauri-apps/plugin-fs';

function App() {
  useConfigPersistence();
  useAutosave();
  useAppShortcuts();
  // The floating symbol picker mounts at App level so it persists
  // across ribbon tab switches.
  const editor = useDocumentStore((s) => s.editor);
  // #103 — the start screen owns the window until a document exists.
  const startActive = useDocumentStore((s) => s.startActive);
  // #103 — the wizard rides beside the start screen until completed
  // or skipped (once, ever).
  const firstRunCompleted = useConfigStore((s) => s.config.firstRunCompleted);
  // Load the global style registry (appConfigDir/styles.json) once at
  // bootstrap; doc layers apply on open.
  useEffect(() => {
    void useStyleRegistryStore.getState().loadGlobal();
  }, []);

  // Kill the WebView's own right-click menu everywhere — the custom
  // DocumentContextMenu and the ruler's band menus own their
  // surfaces.
  useEffect(() => {
    const suppress = (e: MouseEvent) => e.preventDefault();
    window.addEventListener('contextmenu', suppress);
    return () => window.removeEventListener('contextmenu', suppress);
  }, []);

  // Re-register uploaded fonts from appDataDir()/fonts/ once at
  // bootstrap, before the first layout.
  useEffect(() => {
    void useFontRegistryStore.getState().loadFromDisk();
  }, []);

  // Warm the online-catalog metadata once per session when opted in;
  // nothing reaches the network while the toggle is off.
  const allowFontCatalogs = useConfigStore((s) => s.config.privacy.allowFontCatalogs);
  useEffect(() => {
    if (allowFontCatalogs) {
      void prefetchCatalogs();
    }
  }, [allowFontCatalogs]);

  // Differential benchmark. Triggers: URL #bench/?bench, OR five
  // rapid clicks on the StatusBar (mouse-only driving). Output goes
  // to a visible <pre> (AT-SPI readable) + console.
  useEffect(() => {
    const mark = (s: string) => {
      document.title = s.slice(0, 150);
    };
    // Measurement channel: write results into $APPDATA via the fs
    // plugin — readable from the shell regardless of a11y/console/title.
    const writeResult = async (text: string, suffix = '') => {
      try {
        const { appDataDir, join } = await import('@tauri-apps/api/path');
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
        {/* #103 — THE START SCREEN: every launch opens on Home. The
            desk stays mounted but hidden (lifecycle, doc flows, and
            portal targets keep working); before the wizard completes,
            the start screen steps aside too — Finish reveals Home. */}
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
        {/* data-desk-wrapper: the ruler's portal target — static
            overlay chrome, flush under the Ribbon, outside the
            scroller's flow; show/hide reflows nothing. */}
        <div
          data-desk-wrapper
          className={cn('relative flex-1 overflow-hidden', startActive && 'hidden')}
        >
          {/* Desk: the editor scroll surface. data-desk-scroll: the
              ruler reads clientWidth (scrollbar-correct centering) and
              scrollLeft (overflow tracking); pt-8 leaves room for the
              ruler overlay + gap. */}
          <div className="absolute inset-0 overflow-auto bg-muted pt-8 pb-6" data-desk-scroll>
            <Editor />
          </div>
          <SearchPanel />
          <SidebarHost id="search" anchor="right">
            <SearchResultsSidebar />
          </SidebarHost>
          {/* The Table side panel — the same docked-panel
              infrastructure as Find/Replace. */}
          <SidebarHost id="table" anchor="right">
            <TablePanel />
          </SidebarHost>
          {/* The accessibility checker's results list — live while
              open, never in the background. */}
          <SidebarHost id="accessibilityCheck" anchor="right">
            <AccessibilityCheckPanel />
          </SidebarHost>
          {/* The watermark panel: the LIVE editor — the page behind
              the open panel is the preview. */}
          <SidebarHost id="watermark" anchor="right">
            <WatermarkPanel />
          </SidebarHost>
          {/* The Review tab's translate panel (consented runs) + its
              store-driven setup dialog, one mount. */}
          <SidebarHost id="translate" anchor="right">
            <TranslatePanel />
          </SidebarHost>
          {/* The Review tab's statistics dashboard — live while
              open. */}
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
      {/* THE export lossy confirm — one store-driven gate for every
          export flow. */}
      <ExportConfirmDialog />
      {/* The import options surface (the font policy). */}
      <ImportOptionsDialog />
      {/* The import report — what an import dropped or converted. */}
      <ImportReportDialog />
      {/* #43 — the print preview; the palette opens it. */}
      <PrintPreviewDialog />
      {/* #43 — THE PRINT CONTAINER: hidden on screen, revealed by
          @media print; the preview's Print button arms it with the
          same walk. */}
      <PrintContainer />
      {/* The ToC insert dialog (depth picker) — store-driven, one
          mount. */}
      <InsertReferenceTableDialog />
      <DocumentPropertiesDialog />
      <Toaster />
      {editor && <SymbolBubble editor={editor} />}
      {/* Focus Mode's floating exit — the same command body as every
          other surface. */}
      <ExitFocusButton />
      <CustomPageSizeDialog />
      {/* #58 — the one Page Setup dialog (Apply-to scope: document /
          section / point forward). */}
      <PageSetupDialog />
      {/* #74 — the one Columns dialog (the spec with an Apply-to
          scope). */}
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
