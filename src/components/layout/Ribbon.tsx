import { useEffect, useRef, useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useDocumentStore } from "@/lib/document/store";
import { FontGroup } from "./ribbon/home/groups/FontGroup";
import { TooltipProvider } from "../ui/tooltip";
import { ParagraphGroup } from "./ribbon/home/groups/ParagraphGroup";
import { HistoryGroup } from "./ribbon/home/groups/HistoryGroup";
import { StylesGroup } from "./ribbon/home/groups/StylesGroup";
import { ActionsGroup } from "./ribbon/home/groups/ActionsGroup";
import { PagesGroup } from "./ribbon/insert/groups/PagesGroup";
import { IllustrationsGroup } from "./ribbon/insert/groups/IllustrationsGroup";
import { WatermarkGroup } from "./ribbon/insert/groups/WatermarkGroup";
import { ReferenceTablesGroup } from "./ribbon/insert/groups/ReferenceTablesGroup";
import { TextGroup } from "./ribbon/insert/groups/TextGroup";
import { PageSetupGroup } from "./ribbon/layout/groups/PageSetupGroup";
import { ParagraphSpacingGroup } from "./ribbon/layout/groups/SpacingGroup";
import { ArrangeGroup } from "./ribbon/layout/groups/ArrangeGroup";
import { BreaksGroup } from "./ribbon/insert/groups/BreaksGroup";
import { TitleBarRow } from "./TitleBarRow";
import { ProofingGroup } from "./ribbon/review/groups/ProofingGroup";
import { AccessibilityGroup } from "./ribbon/review/groups/AccessibilityGroup";
import { SearchGroup } from "./ribbon/review/groups/SearchGroup";
import { DisplayGroup } from "./ribbon/review/groups/DisplayGroup";
import { DisplayModeGroup } from "./ribbon/view/groups/DisplayModeGroup";
import { ZoomGroup } from "./ribbon/view/groups/ZoomGroup";
import { ShowGroup } from "./ribbon/view/groups/ShowGroup";
import { WindowGroup } from "./ribbon/view/groups/WindowGroup";
import { useConfigStore } from "@/lib/config/store";
import { useFocusStore } from "@/lib/layout/focusStore";
import { useReducedMotion } from "@/lib/accessibility/useReducedMotion";
import { useRibbonContextStore } from "@/lib/ribbon/contextStore";
import { CONTEXTUAL_TABS, type RibbonContextId } from "@/lib/ribbon/contextualTabs";
import { useSelectionContexts } from "@/lib/ribbon/useRibbonContext";

const RIBBON_TABS = ["Home", "Insert", "Layout", "Review", "View"] as const;
type RibbonTab = (typeof RIBBON_TABS)[number];
/** The switchable tab ids: the static strip plus the contextual tabs. */
type ActiveTab = RibbonTab | RibbonContextId;

export function Ribbon() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("Home");

  const showFloatingToolbar = useConfigStore((s) => s.config.useFloatingToolbar);

  // Entering a context auto-focuses its tab and remembers the tab the
  // user was on; exiting restores it. Clicking a normal tab does NOT
  // exit the context — the trigger stays while the selection kind persists.
  const activeContext = useRibbonContextStore((s) => s.active);
  // Focus Mode hides the ribbon by unmount, not CSS — the contextual
  // producers and tooltips stop with it.
  const focusActive = useFocusStore((s) => s.active);
  const reduceMotion = useReducedMotion();
  const previousTabRef = useRef<ActiveTab | null>(null);
  const lastContextRef = useRef<RibbonContextId | null>(null);
  useEffect(() => {
    if (activeContext && lastContextRef.current !== activeContext) {
      if (!lastContextRef.current) previousTabRef.current = activeTab;
      setActiveTab(activeContext);
    } else if (!activeContext && lastContextRef.current) {
      const prev = previousTabRef.current;
      if (prev) setActiveTab(prev);
      previousTabRef.current = null;
    }
    lastContextRef.current = activeContext;
    // activeTab is intentionally captured per transition, not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeContext]);

  const editor = useDocumentStore((s) => s.editor);
  useSelectionContexts(editor);
  if (!editor || focusActive) return null;

  return (
    <TooltipProvider delay={300} closeDelay={0}>
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as ActiveTab)}
        className="gap-0 bg-card border-b border-border"
      >
        {/* #100/#103 — the titlebar row; the start screen renders the same chrome in its home variant. */}
        <TitleBarRow variant="editor">
          <TabsList
            variant="line"
            className="h-10 gap-1 bg-transparent p-0 group-data-horizontal/tabs:h-10"
          >
            {RIBBON_TABS.map((tab) => (
              <TabsTrigger
                key={tab}
                value={tab}
                className="h-10 flex-none rounded-none border-0 px-3 text-sm hover:bg-muted/50 data-active:hover:bg-muted/50 group-data-horizontal/tabs:after:bottom-0 group-data-horizontal/tabs:after:h-0.5 after:bg-muted-foreground hover:after:opacity-100 data-active:after:bg-foreground"
              >
                {tab}
              </TabsTrigger>
            ))}
            {activeContext && (
              <ContextualTabTrigger id={activeContext} reduceMotion={reduceMotion} />
            )}
          </TabsList>
        </TitleBarRow>

        <TabsContent value="Home" className="m-0 h-14 flex-none px-3">
          <div className="flex h-full items-center">
            <HistoryGroup />
            <StylesGroup editor={editor} />
            <FontGroup />
            <ParagraphGroup />
            {!showFloatingToolbar && <ActionsGroup editor={editor} />}
          </div>
        </TabsContent>

        <TabsContent value="Insert" className="m-0 h-14 flex-none px-3">
          <div className="flex h-full items-center">
            <PagesGroup />
            <IllustrationsGroup editor={editor} />
            <WatermarkGroup />
            <ReferenceTablesGroup editor={editor} />
            <BreaksGroup editor={editor} />
            <TextGroup editor={editor} />
          </div>
        </TabsContent>

        <TabsContent value="Layout" className="m-0 h-14 flex-none px-3">
          <div className="flex h-full items-center">
            <PageSetupGroup />
            <ParagraphSpacingGroup editor={editor} />
            <ArrangeGroup />
          </div>
        </TabsContent>

        <TabsContent value="Review" className="m-0 h-14 flex-none px-3">
          <div className="flex h-full items-center">
            <ProofingGroup />
            <AccessibilityGroup />
            <SearchGroup />
            <DisplayGroup />
          </div>
        </TabsContent>

        <TabsContent value="View" className="m-0 h-14 flex-none px-3">
          <div className="flex h-full items-center">
            <DisplayModeGroup />
            <ZoomGroup />
            <ShowGroup />
            <WindowGroup />
          </div>
        </TabsContent>

        {/* The active context's tab content — comes from the registry, so this block never grows. */}
        {activeContext && (
          <TabsContent value={activeContext} className="m-0 h-14 flex-none px-3">
            <div className="flex h-full items-center">
              <ContextualTabContent id={activeContext} />
            </div>
          </TabsContent>
        )}
      </Tabs>
    </TooltipProvider>
  );
}

/**
 * Contextual trigger keeps accent ink in every state (as Word does):
 * `text-primary!` — the ui/tabs base's data-active:text-foreground beats
 * a plain utility in Tailwind sheet order.
 */
function ContextualTabTrigger({
  id,
  reduceMotion,
}: {
  id: RibbonContextId;
  reduceMotion: boolean;
}) {
  const def = CONTEXTUAL_TABS[id];
  const Icon = def.icon;
  return (
    <TabsTrigger
      key={def.id}
      value={def.id}
      data-testid="contextual-tab-trigger"
      className={
        'flex h-10 flex-none items-center gap-1.5 rounded-none border-0 px-3 text-sm text-primary! hover:bg-muted/50 data-active:hover:bg-muted/50 group-data-horizontal/tabs:after:bottom-0 group-data-horizontal/tabs:after:h-0.5 after:bg-muted-foreground hover:after:opacity-100 data-active:after:bg-primary ' +
        (reduceMotion ? '' : 'tensor-contextual-tab-in')
      }
    >
      <Icon size={14} />
      {def.label}
    </TabsTrigger>
  );
}

/** The contextual tab's panel — the registry's lazy content component. */
function ContextualTabContent({ id }: { id: RibbonContextId }) {
  const Content = CONTEXTUAL_TABS[id].content;
  return <Content />;
}
