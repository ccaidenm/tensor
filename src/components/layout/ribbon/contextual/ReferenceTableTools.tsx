import { BookOpen, Ellipsis, Image as ImageIcon, List, RefreshCw, BoxSelect, ChevronDown } from 'lucide-react';
import { useEditorState } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { RibbonGroup } from '@/components/layout/RibbonGroup';
import { IconButton } from '@/components/layout/IconButton';
import { useDocumentStore } from '@/lib/document/store';
import type { ReferenceKind } from '@/lib/references/scan';

/**
 * M-REFS — the contextual tab's tools (the GDocs-style affordances):
 * shown while the selection sits inside a reference table.
 *
 *  - Refresh: forces a generator pass (belt-and-braces over the
 *    same-tick auto-update — refresh-wins reverts stale entry text,
 *    untouched formatting survives, in-sync dispatches nothing).
 *  - Select Table: NodeSelection on the container (the delete/cut
 *    surface — a plain click is a caret in entry text now).
 *  - LAYOUT (M-REFS-9, the user's GDocs+ presets): a popover of the
 *    four number/leader combinations —
 *      Numbers + leading      (numberDisplay plain,  leaders on)
 *      Numbers only           (numberDisplay plain,  leaders off)
 *      No numbers / no leading (numberDisplay none,   leaders off)
 *      Hyperlink numbers      (numberDisplay hyperlink, leaders on)
 *    Both ride the container's attrs (setNodeAttribute — the standard
 *    path); the generator owns the spans' presence, the adapter owns
 *    the numbers, the painter owns the leader ink. Reactivity law:
 *    the editor comes from the SUBSCRIPTION (a getState() snapshot at
 *    first render can be null and never updates — the silent no-op
 *    toggle bug, pinned by the real-mount repro).
 */
const KIND_LABEL: Record<ReferenceKind, string> = {
  toc: 'Table of Contents',
  figures: 'Table of Figures',
  index: 'Index',
};
const KIND_ICON: Record<ReferenceKind, typeof List> = {
  toc: List,
  figures: ImageIcon,
  index: BookOpen,
};

type NumberDisplay = 'plain' | 'none';

interface Preset {
  label: string;
  leaders: boolean;
  numberDisplay: NumberDisplay;
}

/**
 * The presets (M-REFS-11: the 'hyperlink' OPTION is gone — the whole
 * TOC is ALWAYS hyperlinking, invisibly; the rows carry the semantic
 * link mark to their targets and Ctrl+click follows — the presets
 * now only shape the VISIBLE layout).
 */
const PRESETS: Preset[] = [
  { label: 'Numbers and leading', leaders: true, numberDisplay: 'plain' },
  { label: 'Numbers, no leading', leaders: false, numberDisplay: 'plain' },
  { label: 'No leading / no numbers', leaders: false, numberDisplay: 'none' },
];

/** The kind of the referenceTable containing the selection (or
 *  selected) — drives the group's icon + titles. */
function kindOfSelection(editor: Editor | null): ReferenceKind {
  if (!editor) return 'toc';
  const { selection } = editor.state;
  for (let d = selection.$from.depth; d > 0; d--) {
    const ancestor = selection.$from.node(d);
    if (ancestor.type.name !== 'referenceTable') continue;
    const kind = ancestor.attrs.kind;
    return kind === 'figures' || kind === 'index' ? kind : 'toc';
  }
  return 'toc';
}

/** The containing container's POSITION (for attr writes) — the
 *  selection's ancestry, or null when the selection isn't inside. */
function containerPosOf(editor: Editor | null): number | null {
  if (!editor) return null;
  const { selection } = editor.state;
  for (let d = selection.$from.depth; d > 0; d--) {
    if (selection.$from.node(d).type.name !== 'referenceTable') continue;
    return selection.$from.before(d);
  }
  return null;
}

/** The container's live attrs (the preset's current state). */
function attrsOf(editor: Editor | null): { leaders: boolean; numberDisplay: NumberDisplay } {
  if (!editor) return { leaders: true, numberDisplay: 'plain' };
  const { selection } = editor.state;
  for (let d = selection.$from.depth; d > 0; d--) {
    const ancestor = selection.$from.node(d);
    if (ancestor.type.name !== 'referenceTable') continue;
    const nd = ancestor.attrs.numberDisplay;
    return {
      leaders: ancestor.attrs.leaders !== false,
      numberDisplay: nd === 'hyperlink' || nd === 'none' ? nd : 'plain',
    };
  }
  return { leaders: true, numberDisplay: 'plain' };
}

export function ReferenceTableTools() {
  // REACTIVE (the HeaderFooterTools precedent): a getState() snapshot
  // captured at first render can be NULL (the tab strip mounts before
  // the editor's onCreate) and never updates — every read below would
  // be permanently stale (the silent no-op toggle bug). The
  // subscription re-renders when the editor lands.
  const editor = useDocumentStore((s) => s.editor);
  const kind = useEditorState({
    editor,
    selector: ({ editor: e }) => kindOfSelection(e ?? null),
  });
  const attrs = useEditorState({
    editor,
    selector: ({ editor: e }) => attrsOf(e ?? null),
  });

  const refresh = () => {
    // The generator's forced pass (the refRefresh meta).
    editor?.view.dispatch(editor.state.tr.setMeta('refRefresh', true));
  };
  const selectTable = () => {
    const at = containerPosOf(editor);
    if (editor && at != null) editor.commands.setNodeSelection(at);
  };
  /** The attr writes for one preset (two writes, one history step) +
   *  the generator's FORCED pass in the SAME transaction: the attr
   *  change alone is DEFERRED while the caret is inside the table
   *  (the live-edit protection) — the preset must apply NOW (the
   *  user's dead-toggle report: the number vanished (adapter-side)
   *  but the dots stayed (generator-side, deferred)). */
  const applyPreset = (preset: Preset) => {
    const at = containerPosOf(editor);
    if (!editor || at == null) return;
    editor
      .chain()
      .focus()
      .command(({ tr, dispatch }) => {
        if (dispatch) {
          tr.setNodeAttribute(at, 'leaders', preset.leaders);
          tr.setNodeAttribute(at, 'numberDisplay', preset.numberDisplay);
          tr.setMeta('refRefresh', true);
        }
        return true;
      })
      .run();
  };

  const Icon = KIND_ICON[kind ?? 'toc'];
  const currentPreset =
    PRESETS.find(
      (p) => p.leaders === attrs?.leaders && p.numberDisplay === attrs?.numberDisplay,
    ) ?? null;
  return (
    <RibbonGroup>
      <IconButton
        label={`Refresh ${KIND_LABEL[kind ?? 'toc']}`}
        icon={<RefreshCw size={16} />}
        onClick={refresh}
        shortcutId={undefined}
      />
      <IconButton
        label="Select Table"
        icon={<BoxSelect size={16} />}
        onClick={selectTable}
      />
      {/* THE LAYOUT PRESETS (split button — the ListStyleButton
          pattern): the face shows the current preset; the popover
          offers the four GDocs+ combinations. */}
      <div className="flex items-stretch">
        <Button
          variant={currentPreset ? 'secondary' : 'ghost'}
          size="sm"
          className="h-8 gap-1 rounded-r-none px-2"
          disabled={!attrs}
          onClick={() => {
            // The face click cycles to the DEFAULT preset when the
            // current state is custom (or re-applies the current one).
            applyPreset(currentPreset ?? PRESETS[0]!);
          }}
        >
          <Ellipsis size={14} />
          <span className="text-xs">{currentPreset?.label ?? 'Layout'}</span>
        </Button>
        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                className="h-8 w-4 rounded-l-none"
                aria-label="Table layout options"
              >
                <ChevronDown size={10} />
              </Button>
            }
          />
          <PopoverContent className="w-56 p-1">
            <div className="flex flex-col gap-0.5">
              {PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  data-testid={`ref-preset-${preset.numberDisplay}-${preset.leaders ? 'on' : 'off'}`}
                  className="flex items-center justify-between rounded px-2 py-1 text-sm hover:bg-muted"
                  onClick={() => applyPreset(preset)}
                >
                  <span>{preset.label}</span>
                  {currentPreset?.label === preset.label && (
                    <span className="text-xs text-primary" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>
      {/* The kind's identity chip — display-only (the tab label is
          generic; this names WHICH table the user is inside). */}
      <span
        aria-hidden="true"
        className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground"
      >
        <Icon size={12} />
        {KIND_LABEL[kind ?? 'toc']}
      </span>
    </RibbonGroup>
  );
}
