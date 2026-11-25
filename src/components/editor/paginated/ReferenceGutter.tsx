import { Bookmark, BookOpen, List, Image as ImageIcon } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ReferenceKind } from '@/lib/references/scan';

/**
 * Reference-table gutter chrome, mounted INSIDE the sheet in the LINE
 * NUMBER's slot (the covered number hides; icon right-aligned 8px off
 * the content edge, centered on the line box): badges per collection
 * table at its first line (click selects the block), one bookmark per
 * indexEntry-bearing line. Tooltips portal to body — immune to the zoom
 * transform. Pageless has no gutter chrome.
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

/** The NUMBER SLOT position style: the icon's right edge 8px off the
 *  content edge (the number's right edge), box spanning the line's
 *  height with the icon centered. */
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
                // Pointer-events AUTO (tooltip hover), but mousedown
                // FALLS THROUGH to the sheet (no stopPropagation) —
                // an indicator, not a click target.
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
