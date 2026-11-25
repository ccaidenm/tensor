import type { ComponentType } from 'react';
import { PanelTop, Table as TableIcon, Image as ImageIcon, BookMarked } from 'lucide-react';
import { RibbonGroup } from '@/components/layout/RibbonGroup';
import { IconButton } from '@/components/layout/IconButton';
import { HeaderFooterTools } from '@/components/layout/ribbon/contextual/HeaderFooterTools';
import { ReferenceTableTools } from '@/components/layout/ribbon/contextual/ReferenceTableTools';

/**
 * The contextual tab registry: a new context = a new entry here plus a
 * producer (useRibbonContext.ts) — the Ribbon wiring never grows.
 * RibbonContextId keys the union, so an id with no tab cannot be entered.
 */

/** The id union — a producer can only announce an id that has a tab
 *  definition in the registry below. */
export type RibbonContextId = 'table' | 'image' | 'headerFooter' | 'referenceTable';

export interface ContextualTabDef {
  /** Matches a contextStore id — enforced by the RibbonContextId union. */
  id: RibbonContextId;
  /** The strip label, e.g. "Table Tools" (Word's naming). */
  label: string;
  icon: ComponentType<{ size?: number | string; className?: string }>;
  /** Lazy content: mounts only while the tab is active. */
  content: ComponentType;
}

/** A placeholder group: stub content for the starter tabs — the tab
 *  renders and focuses. */
function PlaceholderGroup({
  label,
  icon: Icon,
}: {
  label: string;
  icon: ComponentType<{ size?: number | string; className?: string }>;
}) {
  return (
    <RibbonGroup>
      <IconButton
        label={`${label} tools`}
        icon={<Icon size={16} />}
        onClick={() => {}}
        disabled
      />
    </RibbonGroup>
  );
}

const TableContent = () => <PlaceholderGroup label="Table" icon={TableIcon} />;
const ImageContent = () => <PlaceholderGroup label="Image" icon={ImageIcon} />;

export const CONTEXTUAL_TABS = {
  table: {
    id: 'table',
    label: 'Table',
    icon: TableIcon,
    content: TableContent,
  },
  image: {
    id: 'image',
    label: 'Image',
    icon: ImageIcon,
    content: ImageContent,
  },
  headerFooter: {
    id: 'headerFooter',
    label: 'Header & Footer',
    icon: PanelTop,
    // The real groups (options / navigation / close); formatting
    // rides the Home tab via useActiveEditor routing.
    content: HeaderFooterTools,
  },
  referenceTable: {
    id: 'referenceTable',
    label: 'Reference Table',
    icon: BookMarked,
    // Refresh + Select Table; the kind's identity chip inside.
    content: ReferenceTableTools,
  },
} satisfies Record<RibbonContextId, ContextualTabDef>;