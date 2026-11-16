import { useMemo, useState } from 'react';
import { useEditorState } from '@tiptap/react';
import {
  ChevronDown,
  CircleAlert,
  Contrast as ContrastIcon,
  ImageOff,
  ListTree,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useDocumentStore } from '@/lib/document/store';
import { useConfigStore } from '@/lib/config/store';
import { useSidebarStore } from '@/lib/layout/sidebarStore';
import { useStyleRegistryStore } from '@/lib/styles/registry';
import { useAltTextStore } from '@/components/dialogs/ImageDialogs';
import { scanAccessibility } from '@/lib/a11yCheck/scan';
import type { A11yIssue, A11yIssueKind } from '@/lib/a11yCheck/types';
import { navigateToReferenceTarget } from '@/lib/references/navigate';
import { Badge } from '@/components/ui/badge';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { IconButton } from '@/components/layout/IconButton';
import { cn } from 'cn';

/**
 * M-A11Y — the Accessibility Check panel: the document-content
 * checker's results list, docked through the same SidebarHost
 * infrastructure as Find/Replace and the Table panel (the
 * SearchResultsSidebar is the list blueprint — count header, click-to-
 * navigate rows; the Table panel's close pattern — focus returns to
 * the document).
 *
 * LIVE WHILE OPEN (the locked rescan ruling): the scan runs on open
 * and re-runs when the doc/style-registry/page background change
 * while the panel is visible — the scan module's WeakMap memo means a
 * re-scan walks nothing until something actually changed. Nothing at
 * all runs while the panel is closed (the "not continuously in the
 * background" AC is the closed-panel law).
 *
 * THE JUMP (each row navigates to its flagged location, both view
 * modes): images select the NODE (the floating toolbar and alt dialog
 * become reachable), headings place the caret through the references
 * scan's ONE navigation path, contrast spans select the flagged
 * range. All three ride PM's scroll-into-view intent — the ScrollGuard
 * routes it per view mode.
 */

const GROUPS: Array<{ kind: A11yIssueKind; label: string; icon: typeof ImageOff }> = [
  { kind: 'altText', label: 'Alt text', icon: ImageOff },
  { kind: 'headingHierarchy', label: 'Heading structure', icon: ListTree },
  { kind: 'contrast', label: 'Color contrast', icon: ContrastIcon },
];

const severityIcon = (issue: A11yIssue) =>
  issue.severity === 'error' ? (
    <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
  ) : (
    <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
  );

export function AccessibilityCheckPanel() {
  const editor = useDocumentStore((s) => s.editor);
  const isOpen = useSidebarStore((s) => s.active?.id === 'accessibilityCheck');
  const definitions = useStyleRegistryStore((s) => s.merged);
  const defaultFontFamily = useConfigStore((s) => s.config.editor.defaultFontFamily);
  const defaultFontSize = useConfigStore((s) => s.config.editor.defaultFontSize);
  const pageSetup = useDocumentStore((s) => s.pageSetup);

  // The doc reference changes on every edit (structural sharing) — the
  // live re-scan's tick.
  const docRef = useEditorState({ editor, selector: (ctx) => ctx.editor?.state.doc });

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const scanResult = useMemo(() => {
    if (!isOpen || !editor || !docRef) return null;
    return scanAccessibility(docRef, {
      definitions,
      baseFontFamily: defaultFontFamily,
      baseFontSize: defaultFontSize,
      pageColor: pageSetup?.pageColor,
    });
  }, [isOpen, editor, docRef, definitions, defaultFontFamily, defaultFontSize, pageSetup]);

  if (!isOpen || !scanResult) return null;

  const issues = scanResult.issues;
  const total = issues.length;

  /** THE JUMP — three shapes, one scroll law (the panel header
   * comment): node selection / caret-through-the-references-path /
   * range selection, every one via PM's scroll-into-view intent. */
  const jumpTo = (issue: A11yIssue): void => {
    if (!editor) return;
    if (issue.kind === 'altText') {
      editor.chain().focus().setNodeSelection(issue.pos).scrollIntoView().run();
    } else if (issue.kind === 'headingHierarchy') {
      navigateToReferenceTarget(editor, issue.pos + 1);
    } else if (issue.to != null) {
      editor.chain().focus().setTextSelection({ from: issue.pos, to: issue.to }).scrollIntoView().run();
    } else {
      navigateToReferenceTarget(editor, issue.pos);
    }
  };

  /** The alt rows' assist (the locked ruling): SELECTING is the jump's
   * job; the dialog is where the user writes the fix — assisted, never
   * automated. */
  const openAltDialog = (issue: A11yIssue): void => {
    // Flagged images are never decorative (decorative ones are exempt
    // by definition) — the store's default-off covers the toggle.
    useAltTextStore.getState().open(issue.pos, '', issue.src ?? null);
  };

  const handleClose = () => {
    useSidebarStore.getState().close();
    editor?.commands.focus();
  };

  return (
    <div className="flex h-full flex-col" data-testid="a11y-panel">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Accessibility</span>
          {total > 0 && <Badge variant="destructive" data-testid="a11y-count">{total}</Badge>}
        </div>
        <IconButton label="Close" icon={<X className="h-4 w-4" />} onClick={handleClose} />
      </div>

      <div className="flex-1 overflow-y-auto">
        {total === 0 ? (
          <Empty className="m-3" data-testid="a11y-empty">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-4">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </EmptyMedia>
              <EmptyTitle>No issues found</EmptyTitle>
              <EmptyDescription>
                Alt text, heading structure, and color contrast all pass the accessibility checks.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          GROUPS.map(({ kind, label, icon: Icon }) => {
            const groupIssues = issues.filter((i) => i.kind === kind);
            if (groupIssues.length === 0) return null;
            const open = !collapsed[kind];
            return (
              <Collapsible
                key={kind}
                open={open}
                onOpenChange={(next: boolean) => setCollapsed((c) => ({ ...c, [kind]: !next }))}
              >
                <CollapsibleTrigger
                  className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-sm font-medium hover:bg-muted"
                  data-testid={`a11y-group-${kind}`}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1">{label}</span>
                  <Badge variant="secondary">{groupIssues.length}</Badge>
                  <ChevronDown
                    className={cn(
                      'size-4 shrink-0 text-muted-foreground transition-transform',
                      open ? 'rotate-180' : 'rotate-0',
                    )}
                  />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  {groupIssues.map((issue, i) => (
                    <div
                      key={`${kind}:${issue.pos}:${i}`}
                      className="flex items-start gap-1 border-b border-border pr-2 hover:bg-muted"
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2 text-left"
                        data-testid={`a11y-row-${kind}-${i}`}
                        onClick={() => jumpTo(issue)}
                      >
                        {severityIcon(issue)}
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm leading-snug">{issue.message}</span>
                          {issue.detail && (
                            <span className="block truncate text-xs text-muted-foreground">
                              {issue.detail}
                            </span>
                          )}
                        </span>
                      </button>
                      {issue.kind === 'altText' && (
                        <button
                          type="button"
                          className="mt-1.5 shrink-0 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                          data-testid={`a11y-alt-action-${i}`}
                          onClick={() => openAltDialog(issue)}
                        >
                          Add alt text…
                        </button>
                      )}
                    </div>
                  ))}
                </CollapsibleContent>
              </Collapsible>
            );
          })
        )}
      </div>

      {scanResult.skippedRuns > 0 && (
        <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground" data-testid="a11y-skipped">
          {scanResult.skippedRuns} text {scanResult.skippedRuns === 1 ? 'run' : 'runs'} skipped —
          unsupported color format
        </div>
      )}
    </div>
  );
}
