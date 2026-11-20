import { useEffect, useRef, useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { TensorLogo } from "../icons/TensorIcon";
import { ProofingGroup } from "./ribbon/review/groups/ProofingGroup";
import { AccessibilityGroup } from "./ribbon/review/groups/AccessibilityGroup";
import { SearchGroup } from "./ribbon/review/groups/SearchGroup";
import { TrackingGroup } from "./ribbon/review/groups/TrackingGroup";
import { DisplayGroup } from "./ribbon/review/groups/DisplayGroup";
import { DisplayModeGroup } from "./ribbon/view/groups/DisplayModeGroup";
import { ZoomGroup } from "./ribbon/view/groups/ZoomGroup";
import { ShowGroup } from "./ribbon/view/groups/ShowGroup";
import { ModeGroup } from "./ribbon/view/groups/ModeGroup";
import { WindowGroup } from "./ribbon/view/groups/WindowGroup";
import { useConfigStore } from "@/lib/config/store";
import { useFocusStore } from "@/lib/layout/focusStore";
import { useSettingsDialogStore } from "@/lib/settings/store";
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
  const filePath = useDocumentStore((s) => s.filePath);
  const isDirty = useDocumentStore((s) => s.isDirty);
  const save = useDocumentStore((s) => s.save);
  const saveAs = useDocumentStore((s) => s.saveAs);
  const openFile = useDocumentStore((s) => s.openFile);
  const exportMarkdown = useDocumentStore((s) => s.exportMarkdown);
  const exportDocx = useDocumentStore((s) => s.exportDocx);

  const showFloatingToolbar = useConfigStore((s) => s.config.useFloatingToolbar);

  // M-CONTEXTUAL-RIBBON — the contextual interplay lives HERE, next to
  // the tab state it acts on (the store stays producer-facing). Entering
  // a context appends + auto-focuses its tab and remembers the tab the
  // user was on; exiting restores it. Clicking a NORMAL tab does NOT
  // exit — the trigger lingers in the strip while the selection kind
  // persists, and a fresh enter re-focuses it.
  const activeContext = useRibbonContextStore((s) => s.active);
  // FOCUS MODE: the ribbon owns its own hide (unmount, not CSS — the
  // contextual producers, tooltips, everything stops with it). The
  // component-level gate means ANY mount context hides correctly, not
  // just App's.
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

  const displayName = filePath ? filePath.split("/").pop() : "Untitled";

  const editor = useDocumentStore((s) => s.editor);
  // M-CONTEXTUAL-RIBBON — the selection producers (table / image;
  // header/footer stubs until its milestone).
  useSelectionContexts(editor);
  if (!editor || focusActive) return null;

  return (
    <TooltipProvider delay={300} closeDelay={0}>
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as ActiveTab)}
        className="gap-0 bg-card border-b border-border"
      >
        <div className="relative h-10">
          <div className="relative z-10 flex h-10 items-center justify-between px-1">
            <div className="flex h-10 items-center">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-10 flex-none rounded-none px-3 text-primary text-sm hover:text-primary"
                    >
                      <TensorLogo size={16} />
                      Tensor
                    </Button>
                  }
                />
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onClick={openFile}>Open…</DropdownMenuItem>
                  <DropdownMenuItem onClick={save}>Save</DropdownMenuItem>
                  <DropdownMenuItem onClick={saveAs}>Save As…</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {/* M-MD/M-DOCX: the export surface — Markdown and Word
                      now; PDF joins when #39 lands. */}
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Export</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem onClick={exportMarkdown}>Markdown (.md)…</DropdownMenuItem>
                      <DropdownMenuItem onClick={exportDocx}>Word Document (.docx)…</DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => useSettingsDialogStore.getState().open()}>Settings</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

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
                  <ContextualTabTrigger
                    id={activeContext}
                    reduceMotion={reduceMotion}
                  />
                )}
              </TabsList>
            </div>

            <span className="pr-2 text-sm text-muted-foreground">
              {displayName}
              {isDirty ? " •" : ""}
            </span>
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-0.5 bg-border" />
        </div>

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
            <TrackingGroup />
            <DisplayGroup />
          </div>
        </TabsContent>

        <TabsContent value="View" className="m-0 h-14 flex-none px-3">
          <div className="flex h-full items-center">
            <DisplayModeGroup />
            <ZoomGroup />
            <ShowGroup />
            <ModeGroup />
            <WindowGroup />
          </div>
        </TabsContent>

        {/* M-CONTEXTUAL-RIBBON — the active context's tab content. Same
            wrapper chrome as the static tabs (h-14 flex-none px-3) — the
            content comes from the registry, so this block never grows. */}
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
 * M-CONTEXTUAL-RIBBON — the contextual strip trigger. Accent (primary)
 * ink in EVERY state — hover, active, dark mode — by design: the
 * contextual tab announces itself against the neutral static strip
 * (Word colors its contextual tabs). `text-primary!` (important) is
 * deliberate: the ui/tabs base classes carry `data-active:text-foreground`
 * and `dark:data-active:text-foreground`, and a variant utility beats a
 * plain one in Tailwind's sheet order — the plain `text-primary` lost
 * exactly there (the "turns neutral once active" bug). The entrance
 * animation is applied ONLY when motion is allowed (useReducedMotion:
 * the accessibility 'on' override and the system preference both
 * suppress it — instant appear instead).
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
