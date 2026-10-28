import { Bookmark, BookOpen, List, Image as ImageIcon } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ReferenceKind } from '@/lib/references/scan';

/**
 * M-REFS / M-GUTTER — the reference-table gutter chrome, mounted
 * INSIDE the page sheet in the LINE NUMBER's slot (the contextual-
 * replacement law: an icon renders exactly where the covered line's
 * number would sit — right-aligned 8px off the content edge,
 * vertically centered on the line box — and the number hides):
 *
 *  - ReferenceTableBadges: one icon per collection table, at its
 *    FIRST line (wherever it starts — mid-page included), naming the
 *    kind at a glance. Clicking the badge selects the block.
 *  - IndexLineMarks: one bookmark per LINE containing an indexEntry
 *    mark (GDocs bookmarks) — the marked terms in the tooltip.
 *
 * Tooltips are the shadcn/base-ui surface (portaled to body — immune
 * to the zoom transform). Pageless has no gutter chrome (the NPC
 * dotted underline is the pageless mark affordance).
 */

export interface ReferenceTableBadge {
  blockId: string;
  /** PM position of the block (the badge's click → NodeSelection). */
  pos: number;
  kind: ReferenceKind;
  pageIndex: number;
  /** The first line's top y, content-relative. */
  y: number;
  /** The first line's line-box height (the slot's vertical extent). */
  height: number;
}

export interface IndexLineMark {
  id: string;
  pageIndex: number;
  /** The line's top y, content-relative. */
  y: number;
  /** The line's line-box height (the slot's vertical extent). */
  height: number;
  /** The marked terms on that line (tooltip + aria). */
  terms: string[];
}

const KIND_ICON: Record<ReferenceKind, typeof List> = {
  toc: List,
  figures: ImageIcon,
  index: BookOpen,
};

const KIND_LABEL: Record<ReferenceKind, string> = {
  toc: 'Table of Contents',
  figures: 'Table of Figures',
  index: 'Index',
};

interface GeometryLike {
  index: number;
  contentBox: { x: number; y: number };
}

/** THE NUMBER SLOT (M-GUTTER): the shared position style — the icon's
 *  right edge 8px off the content edge (the number's right edge), the
 *  box spanning the line's height with the icon centered. */
const slotStyle = (geometry: GeometryLike, y: number, height: number) => ({
  left: `${geometry.contentBox.x - 28}px`,
  top: `${geometry.contentBox.y + y}px`,
  height: `${height}px`,
  width: '20px',
});

export function ReferenceTableBadges({
  geometry,
  badges,
  onSelect,
}: {
  geometry: GeometryLike;
  badges: readonly ReferenceTableBadge[];
  onSelect: (pos: number) => void;
}) {
  const pageBadges = badges.filter((b) => b.pageIndex === geometry.index);
  if (pageBadges.length === 0) return null;
  return (
    <>
      {pageBadges.map((badge) => {
        const Icon = KIND_ICON[badge.kind];
        return (
          <Tooltip key={badge.blockId}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  data-testid="ref-table-badge"
                  data-kind={badge.kind}
                  aria-label={`Select ${KIND_LABEL[badge.kind]}`}
                  className="pointer-events-auto absolute flex items-center justify-end rounded text-muted-foreground"
                  style={slotStyle(geometry, badge.y, badge.height)}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(badge.pos);
                  }}
                />
              }
            >
              <Icon size={12} />
            </TooltipTrigger>
            <TooltipContent>{KIND_LABEL[badge.kind]}</TooltipContent>
          </Tooltip>
        );
      })}
    </>
  );
}

export function IndexLineMarks({
  geometry,
  marks,
}: {
  geometry: GeometryLike;
  marks: readonly IndexLineMark[];
}) {
  const pageMarks = marks.filter((m) => m.pageIndex === geometry.index);
  if (pageMarks.length === 0) return null;
  return (
    <>
      {pageMarks.map((mark) => (
        <Tooltip key={mark.id}>
          <TooltipTrigger
            render={
              <span
                data-testid="index-line-mark"
                aria-label={`Index entries on this line: ${mark.terms.join(', ')}`}
                // Pointer-events AUTO (hover for the tooltip) but the
                // mousedown FALLS THROUGH to the sheet (no
                // stopPropagation): the bookmark is an indicator, not a
                // click target — a click passes through like any
                // margin click (the gutter contract).
                className="pointer-events-auto absolute flex items-center justify-end text-muted-foreground/70"
                style={slotStyle(geometry, mark.y, mark.height)}
              />
            }
          >
            <Bookmark size={12} />
          </TooltipTrigger>
          <TooltipContent>{`Index: ${mark.terms.join(', ')}`}</TooltipContent>
        </Tooltip>
      ))}
    </>
  );
}
