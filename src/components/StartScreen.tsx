import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ArrowLeft,
  BarChart3,
  FileText,
  FileWarning,
  FolderOpen,
  Lightbulb,
  Mail,
  NotebookPen,
  Plus,
  Save,
  ScrollText,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useShortcutDisplay } from '@/lib/useShortcutDisplay';
import { formatShortcutParts } from '@/lib/shortcuts';
import { cn } from 'cn';
import { useDocumentStore } from '@/lib/document/store';
import { listRecoveryCopies, type RecoveryEntry } from '@/lib/document/recovery';
import { toast } from '@/components/ui/toast';
import { useConfigStore } from '@/lib/config/store';
import { BLANKS, STARTERS, type DocTemplate } from '@/lib/document/templates';
import { inTauriWindow } from '@/lib/window/tauriEnv';

/**
 * #103 — THE START SCREEN (the landing half; the setup wizard is the
 * follow-up): the GDocs-postured Home — greeting, the template row
 * (blank paginated + blank pageless + the starters + Open), and the
 * recent documents below. The TitleBarRow (its home variant) owns the
 * chrome above; this component owns everything else.
 *
 * GREETING NAME: the user's author identity first (the field the
 * onboarding will set), the OS username (the Rust command) as the
 * fallback, a graceful no-name spelling last.
 */

/** The template cards' visual map (the catalog is data-only). */
const TEMPLATE_VISUALS: Record<
  string,
  { icon: LucideIcon; tint: string }
> = {
  'blank-paginated': { icon: Plus, tint: 'text-primary' },
  'blank-pageless': { icon: ScrollText, tint: 'text-violet-500' },
  letter: { icon: Mail, tint: 'text-sky-500' },
  report: { icon: BarChart3, tint: 'text-emerald-500' },
  'meeting-notes': { icon: NotebookPen, tint: 'text-rose-500' },
  proposal: { icon: Lightbulb, tint: 'text-amber-500' },
};

function greetingForHour(hour: number): string {
  if (hour < 5) return 'Up late';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** The relative-time spelling for a recent's stamp. */
function relativeTime(openedAt: number): string {
  const ms = Date.now() - openedAt;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(openedAt).toLocaleDateString();
}

export function StartScreen() {
  const newDocument = useDocumentStore((s) => s.newDocument);
  const openFile = useDocumentStore((s) => s.openFile);
  // #103 — the return row: a live document underneath Home gets the
  // "<- Return to …" card + the fresh-start card beside it.
  const hasDocument = useDocumentStore((s) => s.hasDocument);
  const returnToDocument = useDocumentStore((s) => s.returnToDocument);
  const saveAndClose = useDocumentStore((s) => s.saveAndClose);
  const restoreRecovery = useDocumentStore((s) => s.restoreRecovery);
  const loadedName = useDocumentStore((s) =>
    s.filePath ? (s.filePath.split('/').pop() ?? s.filePath) : null,
  );
  const author = useConfigStore((s) => s.config.identity.author);
  const defaultPageLayout = useConfigStore((s) => s.config.editor.defaultPageLayout);
  // The New binding rides the DEFAULT-surface card's tooltip (hoisted:
  // hooks never live inside the map).
  const newBinding = useShortcutDisplay('new');
  const recents = useConfigStore((s) => s.config.recentDocuments);

  // The OS username (the greeting's fallback name — the author config
  // takes precedence). Best-effort, once, outside-Tauri-safe.
  const [osName, setOsName] = useState<string | null>(null);
  useEffect(() => {
    if (!inTauriWindow()) return;
    invoke<string | null>('current_username')
      .then((name) => {
        if (name && name.trim()) setOsName(name.trim());
      })
      .catch(() => {});
  }, []);

  // #103 — the unsaved-work snapshots (pinned above the recents). A
  // re-list after every restore/consume keeps the section honest.
  const [recoveries, setRecoveries] = useState<RecoveryEntry[]>([]);
  const refreshRecoveries = () => {
    void listRecoveryCopies().then(setRecoveries);
  };
  useEffect(() => {
    void listRecoveryCopies().then(setRecoveries);
  }, []);

  const name = (author || osName || '').trim();
  const greeting = `${greetingForHour(new Date().getHours())}${name ? `, ${name}` : ''}`;

  function create(template: DocTemplate) {
    void newDocument(template.viewMode, template.content);
  }

  function restore(entry: RecoveryEntry) {
    void restoreRecovery(entry.recoveryPath).then(() => {
      // The consumed snapshot leaves the list (it IS the live doc).
      refreshRecoveries();
    });
  }

  return (
    <div
      className="relative flex-1 overflow-y-auto bg-background"
      data-testid="start-screen"
    >
      {/* #103 — the RETURN ROW overlays the top-right (the user's
          ruling: the library's content position NEVER shifts — the row
          layers in reserved top space instead of pushing the column). */}
      {hasDocument && (
        <div
          className="absolute right-8 top-4 z-20 flex items-center gap-3"
          data-testid="return-row"
        >
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 bg-card"
            data-testid="return-to-document"
            onClick={returnToDocument}
          >
            <ArrowLeft size={14} />
            Return to {loadedName ?? 'document'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 bg-card"
            data-testid="save-and-close"
            onClick={() => {
              void saveAndClose().then(() => {
                // THE CONFIRMATION: what actually saved — the doc to
                // its file, the draft to the recovery net.
                toast.add({
                  title: loadedName ? `${loadedName} saved` : 'Draft saved to recovery',
                  description: 'It will be here when you need it.',
                });
              });
            }}
          >
            <Save size={14} />
            {loadedName ? 'Save and close' : 'Close'}
          </Button>
        </div>
      )}
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-10 px-8 pt-16 pb-12">
        {/* THE GREETING */}
        <h1 className="text-3xl font-semibold tracking-tight" data-testid="start-greeting">
          {greeting}
        </h1>

        {/* THE CORE ROW — the blanks (Tensor's two identities) + the
            open card (the user's "core three"). */}
        <section aria-label="Start a new document">
          <h2 className="mb-4 text-sm font-medium text-muted-foreground">
            Start a new document
          </h2>
          <div
            className="flex flex-wrap gap-4"
            role="list"
            aria-label="Document templates"
          >
            {BLANKS.map((template) => {
              const visual = TEMPLATE_VISUALS[template.id];
              const Icon = visual?.icon ?? FileText;
              const isBlank = template.kind === 'blank';
              const isDefaultSurface =
                template.id ===
                (defaultPageLayout === 'Pageless' ? 'blank-pageless' : 'blank-paginated');
              return (
                <Tooltip key={template.id}>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        role="listitem"
                        data-testid={`template-${template.id}`}
                        aria-label={`Create ${template.title} (${template.description})`}
                        onClick={() => create(template)}
                        className="group flex w-36 flex-col items-start gap-3 rounded-lg border border-border bg-card p-3 text-left outline-none transition-colors hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring"
                      >
                  {/* The preview block: a tinted page tile per template
                      (the GDocs card posture — icon-forward, honest). */}                  <span
                    aria-hidden="true"
                    className={cn(
                      'flex h-20 w-full items-center justify-center rounded-md',
                      isBlank
                        ? 'border-2 border-dashed border-border group-hover:border-primary/40'
                        : 'bg-muted/60',
                    )}
                  >
                    <Icon size={28} className={cn('text-muted-foreground/60', visual?.tint)} strokeWidth={1.5} />
                  </span>
                  <span>
                    <span className="block text-sm font-medium">
                      {template.title}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {template.description}
                    </span>
                  </span>
                </button>
                    }
                  />
                  <TooltipContent>
                    {isDefaultSurface && (
                      <span className="flex items-center gap-2">
                        {template.title}
                        <KbdGroup>
                          {formatShortcutParts(newBinding ?? '').map((part, i) => (
                            <Kbd key={i}>{part}</Kbd>
                          ))}
                        </KbdGroup>
                      </span>
                    )}
                  </TooltipContent>
                </Tooltip>
              );
            })}
            {/* Open a file — the core row's third card (GDocs's
                gallery tile). */}
            <button
              type="button"
              role="listitem"
              data-testid="template-open-file"
              aria-label="Open an existing document"
              onClick={() => void openFile()}
              className="group flex w-36 flex-col items-start gap-3 rounded-lg border border-border bg-card p-3 text-left outline-none transition-colors hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                aria-hidden="true"
                className="flex h-20 w-full items-center justify-center rounded-md bg-muted/40"
              >
                <FolderOpen size={28} className="text-muted-foreground/60" strokeWidth={1.5} />
              </span>
              <span>
                <span className="block text-sm font-medium">Open a file…</span>
                <span className="block text-xs text-muted-foreground">
                  From this device
                </span>
              </span>
            </button>
          </div>
        </section>

        {/* THE STARTERS — one divider line, then the genres. */}
        <section aria-label="Templates">
          <h2 className="mb-4 text-sm font-medium text-muted-foreground">
            Or choose a template
          </h2>
          <div
            className="flex flex-wrap gap-4"
            role="list"
            aria-label="Document starter templates"
          >
            {STARTERS.map((template) => {
              const visual = TEMPLATE_VISUALS[template.id];
              const Icon = visual?.icon ?? FileText;
              return (
                <button
                  key={template.id}
                  type="button"
                  role="listitem"
                  data-testid={`template-${template.id}`}
                  aria-label={`Create ${template.title} (${template.description})`}
                  onClick={() => create(template)}
                  className="group flex w-36 flex-col items-start gap-3 rounded-lg border border-border bg-card p-3 text-left outline-none transition-colors hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-20 w-full items-center justify-center rounded-md bg-muted/60"
                  >
                    <Icon size={28} className={cn('text-muted-foreground/60', visual?.tint)} strokeWidth={1.5} />
                  </span>
                  <span>
                    <span className="block text-sm font-medium">
                      {template.title}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {template.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* #103 — UNSAVED WORK: the recovery snapshots, PINNED above
            the recents (the user's ruling — unsaved work outranks
            recently opened work). A restore consumes the snapshot
            (it becomes the live doc) and the card leaves. */}
        {recoveries.length > 0 && (
          <section aria-label="Unsaved work">
            <h2 className="mb-4 text-sm font-medium text-muted-foreground">
              Unsaved work
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {recoveries.map((entry) => (
                <button
                  key={entry.recoveryPath}
                  type="button"
                  data-testid={`recovery-${entry.name}`}
                  aria-label={`Restore ${entry.name} — unsaved changes from ${relativeTime(entry.modifiedAt ?? Date.now())}`}
                  onClick={() => restore(entry)}
                  className="flex items-center gap-3 rounded-lg border border-primary/40 bg-card p-3 text-left outline-none transition-colors hover:border-primary focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <FileWarning
                    size={20}
                    className="flex-none text-primary"
                    strokeWidth={1.5}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{entry.name}</span>
                    <span className="block text-xs text-primary/80">
                      Unsaved · {relativeTime(entry.modifiedAt ?? Date.now())}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* RECENT DOCUMENTS */}
        <section aria-label="Recent documents">
          <h2 className="mb-4 text-sm font-medium text-muted-foreground">
            Recent documents
          </h2>
          {recents.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="recents-empty">
              Nothing here yet — documents you open or save will show up here.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {recents.map((recent) => (
                <button
                  key={recent.path}
                  type="button"
                  data-testid={`recent-${recent.name}`}
                  aria-label={`Open ${recent.name}, modified ${relativeTime(recent.openedAt)}`}
                  title={recent.path}
                  onClick={() => void openFile(recent.path)}
                  className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 text-left outline-none transition-colors hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <FileText size={20} className="flex-none text-muted-foreground" strokeWidth={1.5} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{recent.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {relativeTime(recent.openedAt)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
