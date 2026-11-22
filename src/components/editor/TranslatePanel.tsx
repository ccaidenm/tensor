import { useEffect, useState } from 'react';
import { ArrowRight, Ban, CornerDownRight, Globe, HardDriveDownload, Languages, X } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { useDocumentStore } from '@/lib/document/store';
import { useSidebarStore } from '@/lib/layout/sidebarStore';
import { useConfigStore } from '@/lib/config/store';
import { useTranslateStore } from '@/lib/editor/translate/store';
import { FALLBACK_LANGUAGES, fetchLanguages, providerDestination, requireTranslationConfig } from '@/lib/editor/translate/client';
import type { TranslationProvider } from '@/lib/editor/translate/client';
import { blockKindLabel, hasSelection } from '@/lib/editor/translate/walk';
import { pairLabel, languageName } from '@/lib/editor/translate/local/names';
import { mb } from '@/lib/editor/spell/localInstall';
import type { TranslateDownloadProgress } from '@/lib/editor/translate/local/types';
import type { TranslationLanguage } from '@/lib/editor/translate/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { IconButton } from '@/components/layout/IconButton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from 'cn';

/**
 * The Translate panel — on-demand translation, docked. Scope: the
 * SELECTION (partially selected blocks translate whole, disclosed) or
 * the WHOLE DOCUMENT. An unconfigured panel is the setup surface — no
 * picker, no run, no network (the gate lives in the client module).
 * Apply: REPLACE, or INSERT ALONGSIDE (interleaved or appended for
 * document runs). One run at a time, cancellable, no background. The
 * privacy line ("Sent to <endpoint>") is ALWAYS visible while
 * configured — consent is per-action, not per-session.
 */
export function TranslatePanel() {
  const editor = useDocumentStore((s) => s.editor);
  const isOpen = useSidebarStore((s) => s.active?.id === 'translate');
  const configured = useConfigStore((s) => s.config.translation.configured);
  const provider = useConfigStore((s) => s.config.translation.provider);
  const endpoint = useConfigStore((s) => s.config.translation.endpoint);

  const scope = useTranslateStore((s) => s.scope);
  const targetLang = useTranslateStore((s) => s.targetLang);
  const sourceLang = useTranslateStore((s) => s.sourceLang);
  const phase = useTranslateStore((s) => s.phase);
  const rows = useTranslateStore((s) => s.rows);
  const progress = useTranslateStore((s) => s.progress);
  const detectedLanguage = useTranslateStore((s) => s.detectedLanguage);
  const lastError = useTranslateStore((s) => s.lastError);
  const catalog = useTranslateStore((s) => s.catalog);
  const catalogError = useTranslateStore((s) => s.catalogError);
  const installed = useTranslateStore((s) => s.installed);
  const modelDownload = useTranslateStore((s) => s.modelDownload);
  const setScope = useTranslateStore((s) => s.setScope);
  const setTargetLang = useTranslateStore((s) => s.setTargetLang);
  const start = useTranslateStore((s) => s.start);
  const cancel = useTranslateStore((s) => s.cancel);
  const apply = useTranslateStore((s) => s.apply);
  const reset = useTranslateStore((s) => s.reset);
  const openSetup = useTranslateStore((s) => s.openSetup);
  const loadLocalData = useTranslateStore((s) => s.loadLocalData);
  const downloadPair = useTranslateStore((s) => s.downloadPair);
  const setModelDownload = useTranslateStore((s) => s.setModelDownload);

  const isLocal = provider === 'local';

  // Seed the picker from the remembered choice (reopening lands where
  // you were). Local mode picks PAIRS, not targets — no seed there.
  useEffect(() => {
    if (!isOpen || targetLang || isLocal) return;
    const remembered = useConfigStore.getState().config.translation.lastTargetLang;
    setTargetLang(remembered || 'en');
  }, [isOpen, targetLang, isLocal, setTargetLang]);

  // The instance's own language list — fetched when the panel opens
  // (online providers only); the fallback list covers failures.
  const languages = useLanguages(isOpen && configured && !isLocal);

  // LOCAL MODE: the catalog + the installed pairs (disk truth), loaded
  // when the panel opens.
  useEffect(() => {
    if (!isOpen || !configured || !isLocal) return;
    void loadLocalData();
  }, [isOpen, configured, isLocal, loadLocalData]);

  // LOCAL MODE: the download progress events (Rust emits per file).
  useEffect(() => {
    if (!isOpen || !isLocal) return;
    const unlisten = listen<TranslateDownloadProgress>('translate-download-progress', ({ payload }) => {
      setModelDownload({ ...payload, code: useTranslateStore.getState().modelDownload?.code ?? '' });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [isOpen, isLocal, setModelDownload]);

  // The pair filter (LOCAL MODE) — declared with the other hooks: the
  // panel early-returns below, and hooks may never follow a return.
  const [pairFilter, setPairFilter] = useState('');

  // Re-render on every editor transaction so enablement stays HONEST:
  // the Selection scope button reads the live selection (a caret-touches-
  // nothing selection keeps it disabled; a real selection enables it).
  const [txnTick, setTxnTick] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const bump = () => setTxnTick((t) => t + 1);
    editor.on('transaction', bump);
    return () => {
      editor.off('transaction', bump);
    };
  }, [editor]);
  void txnTick;

  if (!editor) return null;

  const selectionAvailable = hasSelection(editor);
  const translating = phase === 'translating';
  const preview = phase === 'preview';
  const languageList = languages ?? FALLBACK_LANGUAGES;

  // LOCAL MODE derivations: the selected pair, whether it's downloaded,
  // its approximate download size, and the FILTERED list (the panel
  // lists pairs in place — a 115-entry popup is unusable).
  const filter = pairFilter.trim().toLowerCase();
  const matches = (p: { code: string; from: string; to: string }) =>
    !filter || pairLabel(p).toLowerCase().includes(filter) || p.code.includes(filter);
  const installedVisible = installed.filter(matches);
  const availableVisible = (catalog ?? [])
    .filter((p) => !installed.some((i) => i.code === p.code))
    .filter(matches);
  const selectedPairCode = sourceLang && targetLang ? `${sourceLang}-${targetLang}` : '';
  const selectedInstalled = installed.find((p) => p.code === selectedPairCode);
  const selectedCatalog = catalog?.find((p) => p.code === selectedPairCode);
  const selectedPairBytes =
    selectedCatalog?.bytes ?? selectedInstalled?.files.reduce((sum, f) => sum + f.size, 0) ?? 0;
  const targetLabel = isLocal
    ? languageName(targetLang)
    : languageList.find((l) => l.code === targetLang)?.name ?? targetLang;

  const handleClose = () => {
    useSidebarStore.getState().close();
    reset();
  };

  const handleTranslate = () => {
    // The run's committed language becomes the remembered seed.
    useConfigStore.getState().setTranslationLastTargetLang(targetLang);
    void start(editor);
  };

  return (
    <TooltipProvider>
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-sm font-medium">Translate</span>
        <IconButton label="Close" icon={<X className="h-4 w-4" />} onClick={handleClose} />
      </div>

      {!configured ? (
        <div className="flex flex-1 flex-col gap-3 p-3" data-testid="translate-panel-unconfigured">
          <p className="text-sm text-muted-foreground">
            Translation is an online feature: the text you choose is sent to a translation
            instance each time you press Translate. Tensor sends nothing anywhere until you
            connect an instance — and after that, only when you press Translate.
          </p>
          <Button size="sm" className="h-8 self-start" onClick={openSetup} data-testid="translate-panel-setup-btn">
            Set up translation…
          </Button>
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-y-auto">
          <div className="border-b border-border p-3">
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">What to translate</div>
            <div className="flex gap-1" data-testid="translate-scope">
              <Button
                size="sm"
                variant={scope === 'selection' ? 'secondary' : 'ghost'}
                className="h-7 px-2 text-xs"
                disabled={!selectionAvailable || translating}
                onClick={() => setScope('selection')}
                data-testid="translate-scope-selection"
              >
                Selection
              </Button>
              <Button
                size="sm"
                variant={scope === 'document' ? 'secondary' : 'ghost'}
                className="h-7 px-2 text-xs"
                disabled={translating}
                onClick={() => setScope('document')}
                data-testid="translate-scope-document"
              >
                Whole document
              </Button>
            </div>
            {scope === 'selection' && (
              <p className="mt-1.5 text-xs text-muted-foreground" data-testid="translate-scope-hint">
                Translates whole paragraphs the selection touches — a partially selected block
                translates whole.
              </p>
            )}
          </div>

          {/* Target — a language for online providers, an explicit DIRECTION
              for local (Bergamot has no auto-detect). The local picker is
              an IN-PANEL list: 115 pairs need a filter. */}
          <div className="border-b border-border p-3">
            {isLocal ? (
              <>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="translate-pair-filter">
                  Language pair
                </label>
                <Input
                  id="translate-pair-filter"
                  value={pairFilter}
                  onChange={(e) => setPairFilter(e.target.value)}
                  placeholder="Filter languages…"
                  className="h-8"
                  data-testid="translate-pair-filter"
                />
                <div className="mt-2 max-h-44 overflow-y-auto rounded-md border border-border" data-testid="translate-pair-list">
                  {catalogError && !catalog && (
                    <p className="p-2 text-xs text-amber-600" data-testid="translate-catalog-error">
                      Catalog unavailable ({catalogError}) — downloaded pairs still work.
                    </p>
                  )}
                  {catalog === null && !catalogError && (
                    <p className="p-2 text-xs text-muted-foreground" data-testid="translate-catalog-loading">
                      Loading the model catalog…
                    </p>
                  )}
                  {catalog !== null && catalog.length === 0 && (
                    <p className="p-2 text-xs text-muted-foreground" data-testid="translate-catalog-empty">
                      The catalog returned no models — close and reopen the panel to retry.
                    </p>
                  )}
                  {catalog !== null && catalog.length > 0 && (
                    <ul>
                      {installedVisible.length > 0 && (
                        <li className="border-b border-border px-2 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">Downloaded</li>
                      )}
                      {installedVisible.map((p) => (
                        <PairRow key={p.code} pair={p} selected={selectedPairCode === p.code} downloaded />
                      ))}
                      {availableVisible.length > 0 && (
                        <li className="border-b border-border px-2 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">Available to download</li>
                      )}
                      {availableVisible.map((p) => (
                        <PairRow key={p.code} pair={p} selected={selectedPairCode === p.code} />
                      ))}
                      {installedVisible.length === 0 && availableVisible.length === 0 && (
                        <li className="p-2 text-xs text-muted-foreground" data-testid="translate-pair-no-match">
                          No pairs match “{pairFilter}”.
                        </li>
                      )}
                    </ul>
                  )}
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground" data-testid="translate-source-note">
                  Local models translate exact directions — the source is the pair, nothing is sent.
                </p>
                {modelDownload && (
                  <div className="mt-2" data-testid="translate-download-progress">
                    <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
                      <div
                        className="h-full bg-primary transition-[width]"
                        style={{
                          width:
                            modelDownload.total > 0
                              ? `${Math.min(100, (modelDownload.received / modelDownload.total) * 100)}%`
                              : '8%',
                        }}
                      />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Downloading {languageName(modelDownload.code.split('-')[0] ?? '')} → {languageName(modelDownload.code.split('-')[1] ?? '')} ({modelDownload.stage})…
                    </p>
                  </div>
                )}
              </>
            ) : (
              <>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="translate-target">
                  Translate into
                </label>
                <Select value={targetLang} onValueChange={(v) => { if (v != null) setTargetLang(v); }}>
                  <SelectTrigger id="translate-target" className="h-8 w-full text-sm" data-testid="translate-target">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {languageList.map((l) => (
                      <SelectItem key={l.code} value={l.code}>{l.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-1.5 text-xs text-muted-foreground" data-testid="translate-source-note">
                  Source language is detected automatically{detectedLanguage ? ` (detected: ${detectedLanguage})` : ''}.
                </p>
              </>
            )}
          </div>

          {/* Run */}
          <div className="border-b border-border p-3">
            {translating ? (
              <div className="space-y-2">
                <div className="h-1.5 w-full overflow-hidden rounded bg-muted" data-testid="translate-progress">
                  <div
                    className="h-full bg-primary transition-[width]"
                    style={{
                      width:
                        progress && progress.total > 0
                          ? `${Math.min(100, (progress.done / progress.total) * 100)}%`
                          : '8%',
                    }}
                  />
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {progress && progress.total > 0 ? `Block ${progress.done} of ${progress.total}…` : 'Translating…'}
                  </span>
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={cancel} data-testid="translate-cancel">
                    <Ban size={12} /> Cancel
                  </Button>
                </div>
              </div>
            ) : isLocal && selectedPairCode && !selectedInstalled ? (
              // Not downloaded yet — the download IS the next action.
              <Button
                size="sm"
                className="h-8 w-full"
                onClick={() => void downloadPair(selectedPairCode)}
                disabled={preview || !!modelDownload}
                data-testid="translate-download"
              >
                <HardDriveDownload size={14} /> Download model (≈{mb(selectedPairBytes)})
              </Button>
            ) : (
              <Button
                size="sm"
                className="h-8 w-full"
                onClick={handleTranslate}
                disabled={preview || (isLocal && (!selectedPairCode || !!modelDownload))}
                data-testid="translate-run"
              >
                <Languages size={14} /> Translate
              </Button>
            )}
          </div>

          {lastError && (
            <div
              className="border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              data-testid="translate-error"
            >
              {lastError}
            </div>
          )}

          {/* Preview + apply */}
          {preview && (
            <div className="flex flex-1 flex-col" data-testid="translate-preview">
              <div className="flex-1 overflow-y-auto">
                {rows.map((row) => (
                  <div key={row.block.blockId} className="border-b border-border px-3 py-2" data-testid="translate-preview-row">
                    <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      {blockKindLabel(row.block.nodeType)}
                      <ArrowRight size={11} />
                      <span className="truncate">{targetLabel}</span>
                      {row.failed && <span className="text-destructive" data-testid="translate-row-failed">— kept original: {row.failed}</span>}
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs leading-snug">
                      <span className="truncate text-muted-foreground">{row.block.text}</span>
                      <span className={cn(row.failed && 'text-muted-foreground line-through')}>{row.translatedText}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="space-y-2 border-t border-border p-3" data-testid="translate-apply">
                <Button size="sm" className="h-8 w-full" onClick={() => apply(editor, 'replace')} data-testid="translate-apply-replace">
                  Replace original
                </Button>
                {scope === 'document' ? (
                  <div className="flex gap-1" data-testid="translate-insert-layout">
                    <Button size="sm" variant="outline" className="h-8 flex-1 text-xs" onClick={() => apply(editor, 'insert-interleaved')}>
                      <CornerDownRight size={12} /> Insert under each block
                    </Button>
                    <Button size="sm" variant="outline" className="h-8 flex-1 text-xs" onClick={() => apply(editor, 'insert-appended')}>
                      Insert at end
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" className="h-8 w-full text-xs" onClick={() => apply(editor, 'insert-interleaved')} data-testid="translate-apply-insert">
                    Insert after selection
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="h-7 w-full text-xs" onClick={reset} data-testid="translate-discard">
                  Discard
                </Button>
              </div>
            </div>
          )}

          {/* The privacy line — always visible while configured. Local
              never sends: the line says so instead of a destination. */}
          <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground" data-testid="translate-privacy-line">
            {isLocal ? (
              <>
                <HardDriveDownload size={12} className="mr-1 inline-block" />
                <span data-testid="translate-privacy-local">Runs on this device — nothing is sent.</span>
              </>
            ) : (
              <>
                <Globe size={12} className="mr-1 inline-block" /> Sent to <span className="text-foreground/80">{providerDestination(provider as TranslationProvider, endpoint)}</span>
              </>
            )}
          </div>
        </div>
      )}
    </TooltipProvider>
  );
}

/** The instance language list (or null while loading / on failure —
 *  the FALLBACK list covers both). */
function useLanguages(enabled: boolean): TranslationLanguage[] | null {
  const [languages, setLanguages] = useState<TranslationLanguage[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void (async () => {
      try {
        const { provider, endpoint, apiKey } = requireTranslationConfig();
        const langs = await fetchLanguages(provider, endpoint || undefined, apiKey || undefined);
        if (live && langs.length > 0) setLanguages(langs);
      } catch {
        // The fallback list covers unreachable instances (dev mode,
        // offline) — never a dead picker.
      }
    })();
    return () => {
      live = false;
    };
  }, [enabled]);
  return languages;
}

/** One pair row: the direction, its state, click = select. */
function PairRow({ pair, selected, downloaded }: { pair: { code: string; from: string; to: string; bytes?: number }; selected: boolean; downloaded?: boolean }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          const store = useTranslateStore.getState();
          store.setSourceLang(pair.from);
          store.setTargetLang(pair.to);
        }}
        className={cn(
          'flex w-full items-center justify-between gap-2 border-b border-border px-2 py-1.5 text-left text-xs last:border-b-0 hover:bg-muted',
          selected && 'bg-primary/10',
        )}
        data-testid={`translate-pair-row-${pair.code}`}
        aria-pressed={selected}
      >
        <span className="truncate">{pairLabel(pair)}</span>
        <span className="ml-2 shrink-0 text-muted-foreground">
          {downloaded ? <span className="text-primary">Downloaded</span> : <>{pair.bytes != null ? `≈${mb(pair.bytes)}` : ''}</>}
        </span>
      </button>
    </li>
  );
}
