import { useEffect, useState } from 'react';
import { ArrowRight, Ban, CornerDownRight, Globe, Languages, X } from 'lucide-react';
import { useDocumentStore } from '@/lib/document/store';
import { useSidebarStore } from '@/lib/layout/sidebarStore';
import { useConfigStore } from '@/lib/config/store';
import { useTranslateStore } from '@/lib/editor/translate/store';
import { FALLBACK_LANGUAGES, fetchLanguages, providerDestination, requireTranslationConfig } from '@/lib/editor/translate/client';
import type { TranslationProvider } from '@/lib/editor/translate/client';
import { blockKindLabel, hasSelection } from '@/lib/editor/translate/walk';
import type { TranslationLanguage } from '@/lib/editor/translate/types';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/layout/IconButton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from 'cn';

/**
 * THE TRANSLATE PANEL — the Review tab's on-demand translation, docked
 * beside Find/Table/Accessibility (the same SidebarHost chrome).
 *
 * Posture (the issue's acceptance criteria, spelled out):
 *  - scope: the SELECTION (partially selected blocks translate whole —
 *    disclosed) or the WHOLE DOCUMENT;
 *  - consent: an unconfigured panel is the setup surface — no picker,
 *    no run, no network (the gate lives in the client module);
 *  - apply: REPLACE the original, or INSERT ALONGSIDE — interleaved
 *    (each translation right under its block) or appended (the whole
 *    translated copy at the end) for document runs;
 *  - on-demand only: one run at a time, cancellable, no background.
 *
 * The privacy line is ALWAYS visible while configured: "Sent to
 * <endpoint>" — consent is per-action, not per-session.
 */
export function TranslatePanel() {
  const editor = useDocumentStore((s) => s.editor);
  const isOpen = useSidebarStore((s) => s.active?.id === 'translate');
  const configured = useConfigStore((s) => s.config.translation.configured);
  const provider = useConfigStore((s) => s.config.translation.provider);
  const endpoint = useConfigStore((s) => s.config.translation.endpoint);

  const scope = useTranslateStore((s) => s.scope);
  const targetLang = useTranslateStore((s) => s.targetLang);
  const phase = useTranslateStore((s) => s.phase);
  const rows = useTranslateStore((s) => s.rows);
  const progress = useTranslateStore((s) => s.progress);
  const detectedLanguage = useTranslateStore((s) => s.detectedLanguage);
  const lastError = useTranslateStore((s) => s.lastError);
  const setScope = useTranslateStore((s) => s.setScope);
  const setTargetLang = useTranslateStore((s) => s.setTargetLang);
  const start = useTranslateStore((s) => s.start);
  const cancel = useTranslateStore((s) => s.cancel);
  const apply = useTranslateStore((s) => s.apply);
  const reset = useTranslateStore((s) => s.reset);
  const openSetup = useTranslateStore((s) => s.openSetup);

  // Seed the picker from the remembered choice (the print dialog's
  // lastDestination law — reopening lands where you were).
  useEffect(() => {
    if (!isOpen || targetLang) return;
    const remembered = useConfigStore.getState().config.translation.lastTargetLang;
    setTargetLang(remembered || 'en');
  }, [isOpen, targetLang, setTargetLang]);

  // The instance's own language list — fetched when the panel opens
  // (configured only); the fallback list covers failures.
  const languages = useLanguages(isOpen && configured);

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
          {/* Scope */}
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

          {/* Target language */}
          <div className="border-b border-border p-3">
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
            ) : (
              <Button
                size="sm"
                className="h-8 w-full"
                onClick={handleTranslate}
                disabled={preview}
                data-testid="translate-run"
              >
                <Languages size={14} /> Translate
              </Button>
            )}
          </div>

          {/* Errors */}
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
                      <span className="truncate">{languageList.find((l) => l.code === targetLang)?.name ?? targetLang}</span>
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

          {/* The privacy line — always visible while configured. */}
          <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground" data-testid="translate-privacy-line">
            <Globe size={12} className="mr-1 inline-block" /> Sent to <span className="text-foreground/80">{providerDestination(provider as TranslationProvider, endpoint)}</span>
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
