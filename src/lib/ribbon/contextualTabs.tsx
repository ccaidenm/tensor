import type { ComponentType } from 'react';
import { PanelTop, Table as TableIcon, Image as ImageIcon, BookMarked } from 'lucide-react';
import { RibbonGroup } from '@/components/layout/RibbonGroup';
import { IconButton } from '@/components/layout/IconButton';
import { HeaderFooterTools } from '@/components/layout/ribbon/contextual/HeaderFooterTools';
import { ReferenceTableTools } from '@/components/layout/ribbon/contextual/ReferenceTableTools';

/**
 * M-CONTEXTUAL-RIBBON — the contextual tab registry.
 *
 * Each entry is one contextual ribbon tab, appended to the tab strip by
 * Ribbon.tsx while its context is active (contextStore.ts). The registry
 * is the scaling surface: a new context is a new entry here plus a
 * producer (useRibbonContext.ts) — the Ribbon wiring itself never grows.
 *
 * Compile-time exhaustiveness: `RibbonContextId` is the registry's key
 * union, and `enter()` is typed against it — a context id with no tab
 * definition cannot even be entered.
 *
 * NOTE: the TABLE and IMAGE tabs are STRUCTURAL STARTERS this milestone:
 * the activation paths are real (selection-driven producers, end to
 * end), the group CONTENT is a placeholder stub until their own issues.
 * HEADER/FOOTER is fully live (M-HEADER-FOOTER): its producer binds the
 * header/footer store's activeSurface, and its groups are the real
 * Header & Footer tools.
 */

/**
 * The id union — the compile-time lock between contexts and their tabs:
 * a `useRibbonContext(id, …)` producer can only announce an id that has
 * a tab definition in the registry below.
 */
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

/**
 * A placeholder group: honest stub content for the starter tabs — the
 * tab renders and focuses, its real groups arrive with their issues.
 */
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
    // M-HEADER-FOOTER: the real groups (options / navigation / close).
    // Formatting rides the Home tab via useActiveEditor routing.
    content: HeaderFooterTools,
  },
  referenceTable: {
    id: 'referenceTable',
    label: 'Reference Table',
    icon: BookMarked,
    // M-REFS: Refresh + Select Table (the GDocs-style affordances over
    // the same-tick auto-update; the kind's identity chip inside).
    content: ReferenceTableTools,
  },
} satisfies Record<RibbonContextId, ContextualTabDef>;