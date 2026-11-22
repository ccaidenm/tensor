import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useEditorState } from '@tiptap/react';
import { ALargeSmall, AlignLeft, Timer, WholeWord, X } from 'lucide-react';
import { useDocumentStore } from '@/lib/document/store';
import { useSidebarStore } from '@/lib/layout/sidebarStore';
import {
  getSectionedStats,
  formatReadingTime,
  formatNumber,
  fleschReadingEase,
  fleschKincaidGrade,
  fleschBand,
  fleschBandTone,
  type StatisticsReport,
  type RegionStats,
} from '@/lib/editor/documentStats';
import { IconButton } from '@/components/layout/IconButton';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from 'cn';

/**
 * The Review tab's statistics dashboard: stat cards for the headline
 * numbers, then the heading-delimited region list (every heading
 * starts a region; the Preamble is everything before the first).
 * useEditorState recomputes per transaction; a 300ms debounce commits
 * to render state so typing stays smooth; nothing runs while closed.
 */
export function StatisticsPanel() {
  const editor = useDocumentStore((s) => s.editor);
  const isOpen = useSidebarStore((s) => s.active?.id === 'statistics');

  const raw = useEditorState<StatisticsReport | null>({
    editor,
    selector: (ctx) => (ctx.editor && isOpen ? getSectionedStats(ctx.editor) : null),
  });

  const [report, setReport] = useState<StatisticsReport | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!raw) {
      setReport(null);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setReport(raw), 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [raw]);

  if (!editor) return null;

  const handleClose = () => {
    useSidebarStore.getState().close();
  };

  const navigate = (pos: number) => {
    // Select INSIDE the region's first block: `pos` sits before the node,
    // so step in — unless the block is a leaf (no inside).
    const nodeAfter = editor.state.doc.resolve(pos).nodeAfter;
    const target = nodeAfter && !nodeAfter.isLeaf ? pos + 1 : pos;
    editor.chain().focus().setTextSelection(target).scrollIntoView().run();
  };

  const total = report?.total;
  const regions = report?.regions ?? [];
  const ease = total ? fleschReadingEase(total.words, total.sentences, total.syllables) : null;
  const grade = total ? fleschKincaidGrade(total.words, total.sentences, total.syllables) : null;

  return (
    <TooltipProvider>
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-sm font-medium">Statistics</span>
        <IconButton label="Close" icon={<X className="h-4 w-4" />} onClick={handleClose} />
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto p-3">
        {/* Cards: Characters and Sentences both carry a sub line so the
            pair renders at the same height. */}
        <div className="grid grid-cols-2 gap-2">
          <StatCard label="Words" value={total ? formatNumber(total.words) : '—'} testId="stat-words" icon={<WholeWord className="h-3 w-3" />} />
          <StatCard label="Reading time" value={total ? formatReadingTime(total.words) : '—'} testId="stat-reading-time" icon={<Timer className="h-3 w-3" />} />
          <StatCard
            label="Characters"
            value={total ? formatNumber(total.characters) : '—'}
            sub={total ? `${formatNumber(total.charactersWithSpaces)} with spaces` : undefined}
            testId="stat-characters"
            icon={<ALargeSmall className="h-3 w-3" />}
          />
          <StatCard
            label="Sentences"
            value={total ? formatNumber(total.sentences) : '—'}
            sub={total && total.sentences > 0 ? `≈ ${formatNumber(Math.round(total.words / total.sentences))} words each` : undefined}
            testId="stat-sentences"
            icon={<AlignLeft className="h-3 w-3" />}
          />
        </div>

        {/* Readability: score + band on the easy→difficult gradient —
            the band TEXT carries the meaning, color only reinforces it. */}
        <div className="mt-2 rounded-lg border border-border bg-card p-2.5" data-testid="stat-readability">
          <div className="text-[11px] text-muted-foreground">Readability</div>
          {ease === null || grade === null ? (
            <div className="text-sm text-muted-foreground" data-testid="stat-readability-none">No readable text yet</div>
          ) : (
            <div className="mt-0.5 leading-snug">
              <div className="text-sm font-semibold" data-testid="stat-readability-ease">
                Flesch {ease.toFixed(1)}{' '} —
                <span className={cn('font-normal', BAND_TONE_CLASS[fleschBandTone(ease)])} data-testid="stat-readability-band">
                  &nbsp;{fleschBand(ease)}
                </span>
              </div>
              <div className="text-[11px] text-muted-foreground" data-testid="stat-readability-grade">
                Grade level ≈ {grade.toFixed(1)} · estimated for English text
              </div>
            </div>
          )}
        </div>

        <div className="mt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Sections</div>
        <div className="mt-1.5 flex-1 overflow-y-auto rounded-md border border-border" data-testid="stat-regions">
          {regions.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground" data-testid="stat-regions-empty">
              No headings — the document is one section.
            </p>
          ) : (
            <ul>
              {regions.map((region, i) => (
                <RegionRow key={`${region.title}-${i}`} region={region} onNavigate={navigate} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

/** The band tone → color (the easy→difficult gradient, dark-mode
 *  aware): green for easy reading, amber at "Standard", shading
 *  through orange to red as the text gets harder. */
const BAND_TONE_CLASS: Record<ReturnType<typeof fleschBandTone>, string> = {
  positive: 'text-green-600 dark:text-green-400',
  neutral: 'text-amber-600 dark:text-amber-400',
  caution: 'text-orange-600 dark:text-orange-400',
  warning: 'text-red-500 dark:text-red-400',
  poor: 'text-red-600 dark:text-red-400',
};

/** One headline-number card: icon + label, the value, an optional sub
 *  line (Characters and Sentences both carry one — equal heights). */
function StatCard({ label, value, sub, testId, icon }: { label: string; value: string; sub?: string; testId: string; icon?: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-2.5" data-testid={testId}>
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="text-lg font-semibold leading-tight">{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

/** One region row: indent by heading level, click jumps to it. */
function RegionRow({ region, onNavigate }: { region: RegionStats; onNavigate: (pos: number) => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onNavigate(region.pos)}
        className="flex w-full items-baseline justify-between gap-2 border-b border-border px-2 py-1.5 text-left text-xs last:border-b-0 hover:bg-muted"
        data-testid={`stat-region-${region.pos}`}
        aria-label={`Jump to ${region.title}`}
      >
        <span
          className="flex min-w-0 items-baseline gap-1.5"
          style={{ paddingLeft: ((region.level ?? 1) - 1) * 12 }}
        >
          {region.level != null && (
            <span className="shrink-0 text-[10px] text-muted-foreground" title={`Heading ${region.level}`}>
              H{region.level}
            </span>
          )}
          <span className={cn('truncate', region.level == null && 'italic text-muted-foreground')}>{region.title}</span>
        </span>
        <span className="ml-2 shrink-0 text-muted-foreground">
          {formatNumber(region.words)} w · {formatNumber(region.characters)} ch
        </span>
      </button>
    </li>
  );
}
