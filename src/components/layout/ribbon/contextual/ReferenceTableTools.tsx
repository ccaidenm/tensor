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
 * The reference-table contextual tab. Refresh forces a generator pass;
 * Select Table gives the delete surface (a plain click is a caret in
 * entry text). Presets write the container's attrs (setNodeAttribute).
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
 * Presets shape the visible layout only — the table is always
 * hyperlinked (rows carry the semantic link mark; Ctrl+click follows).
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
  // A getState() snapshot at first render can be null (the tab strip
  // mounts before the editor's onCreate) and never updates — every read
  // would be permanently stale. The subscription re-renders.
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
  /** Two attr writes + the generator's forced pass in ONE transaction:
   *  the attr change alone is deferred while the caret is inside the
   *  table (live-edit protection) — the preset must apply now. */
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
      <div className="flex items-stretch">
        <Button
          variant={currentPreset ? 'secondary' : 'ghost'}
          size="sm"
          className="h-8 gap-1 rounded-r-none px-2"
          disabled={!attrs}
          onClick={() => {
            // Falls back to the default preset when the current state is custom.
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
      {/* The kind's identity chip — display-only; names which table the user is inside. */}
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
