import type { CSSProperties } from 'react';
import type { LayoutResult } from '@tensor-editor/engine';
import { pageTops } from '@/lib/paginated/pageStack';
import { lineColumnFrame } from '@/lib/paginated/positionMap';

/**
 * #58 — break badges for page/section breaks (shown when
 * showNonPrintingChars is on). Each paints just above the first line of
 * the block it FORCES (breakFacts sidecar): nextPage → the top of the
 * page it opens, continuous → the sections' join, #74 columnBreak → the
 * anchor line's COLUMN frame. Stack-local px (cumulative page tops +
 * contentBox origin). Never prints — print/PDF walks read the engine's
 * layout, not this sidecar.
 */

export interface BreakFact {
  kind: 'pageBreak' | 'sectionBreak' | 'columnBreak';
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
    : kind === 'columnBreak'
      ? 'Column Break'
      : type === 'continuous'
        ? 'Section Break (Continuous)'
        : 'Section Break (Next Page)';

export function BreakMarks({
  facts,
  result,
  pageGap,
  tops: topsProp,
}: {
  facts: readonly BreakFact[];
  result: LayoutResult;
  pageGap: number;
  /** #101: the grid's ROW tops (row-mates share a top); absent ≡ the
   *  legacy y-only walk (columns 1 — bit-identical). */
  tops?: number[];
}) {
  if (facts.length === 0) return null;
  const tops = topsProp ?? pageTops(result.pages, pageGap);
  const marks: { key: string; label: string; style: CSSProperties }[] = [];
  for (const fact of facts) {
    if (!fact.afterBlockId) continue;
    // The following block's FIRST line: the anchor (its top).
    const line = result.lines.find((l) => l.blockId === fact.afterBlockId);
    if (!line) continue; // not laid out (virtualization edge) — skip
    const page = result.pages[line.pageIndex];
    if (!page) continue;
    // #74 — the badge's bar spans the anchor line's COLUMN frame
    // (single-column ≡ the content box).
    const frame = lineColumnFrame(page, line);
    marks.push({
      key: `${fact.kind}:${fact.pos}`,
      label: labelOf(fact.kind, fact.type),
      style: {
        left: page.contentBox.x + frame.left,
        // Just above the anchor line (a continuous break sits at the
        // sections' join; a nextPage break at its page's top).
        top: tops[line.pageIndex]! + page.contentBox.y + line.rect.y - 13,
        width: frame.width,
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
