import type { CSSProperties } from 'react';
import type { LayoutResult } from '@tensor-editor/engine';
import { pageTops } from '@/lib/paginated/pageStack';

/**
 * #58 — the BREAK MARKS (the NPC layer): formatting-mark badges for the
 * page/section breaks, painted in the paginated view when
 * config.editor.showNonPrintingChars is on (the same toggle the
 * BlockCanvas's pilcrows/tabs ride — ONE switch, Word's ¶).
 *
 * THE PLACEMENT LAW: a break paints just above the first line of the
 * block it FORCES (the adapter's breakFacts sidecar — the following
 * block's id). A nextPage break's following block opens a page → the
 * badge sits at the top of THAT page (the break's visual effect is the
 * page edge); a continuous break's block flows on the same page → the
 * badge sits mid-flow, exactly where the sections join.
 *
 * COORDINATES: stack-local px (the SelectionHighlights frame — the
 * cumulative page tops + each mark's page's own contentBox origin).
 *
 * VIEW-ONLY INK: this layer never prints — the print/PDF walks read
 * the engine's layout, not this sidecar (the paint law's twin: what
 * prints is what the walk emits; the marks are chrome).
 */

export interface BreakFact {
  kind: 'pageBreak' | 'sectionBreak';
  type: 'nextPage' | 'continuous';
  /** The break atom's PM position. */
  pos: number;
  /** The block the break forces (the marker anchors above its first
   *  line); null when nothing follows (a trailing break — no mark). */
  afterBlockId: string | null;
}

const labelOf = (kind: BreakFact['kind'], type: string): string =>
  kind === 'pageBreak'
    ? 'Page Break'
    : type === 'continuous'
      ? 'Section Break (Continuous)'
      : 'Section Break (Next Page)';

export function BreakMarks({
  facts,
  result,
  pageGap,
}: {
  facts: readonly BreakFact[];
  result: LayoutResult;
  pageGap: number;
}) {
  if (facts.length === 0) return null;
  const tops = pageTops(result.pages, pageGap);
  const marks: { key: string; label: string; style: CSSProperties }[] = [];
  for (const fact of facts) {
    if (!fact.afterBlockId) continue;
    // The following block's FIRST line: the anchor (its top).
    const line = result.lines.find((l) => l.blockId === fact.afterBlockId);
    if (!line) continue; // not laid out (virtualization edge) — skip
    const page = result.pages[line.pageIndex];
    if (!page) continue;
    marks.push({
      key: `${fact.kind}:${fact.pos}`,
      label: labelOf(fact.kind, fact.type),
      style: {
        left: page.contentBox.x,
        // Just above the anchor line (a continuous break sits at the
        // sections' join; a nextPage break at its page's top).
        top: tops[line.pageIndex]! + page.contentBox.y + line.rect.y - 13,
        width: page.contentBox.width,
      },
    });
  }
  if (marks.length === 0) return null;
  return (
    <>
      {marks.map((m) => (
        <div
          key={m.key}
          data-testid={`break-mark-${m.key}`}
          className="pointer-events-none absolute z-10 flex items-center gap-2"
          style={m.style}
        >
          <span
            className="h-0 flex-1"
            style={{
              borderTop: '2px dashed #94a3b8',
              opacity: 0.7,
            }}
          />
          <span className="rounded-[3px] bg-muted px-1.5 py-[1px] text-[9px] font-medium text-muted-foreground">
            {m.label}
          </span>
        </div>
      ))}
    </>
  );
}
