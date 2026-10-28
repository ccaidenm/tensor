import { useState, type ReactNode } from 'react';
import { useEditorState } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { NodeSelection as NodeSelectionValue } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  BookmarkPlus,
  ClipboardPaste,
  Copy,
  Frame,
  MessageSquareText,
  Minus,
  PaintBucket,
  PersonStanding,
  Pin,
  Plus,
  RotateCw,
  Scissors,
  SquareRoundCorner,
  SquareTerminal,
  TableCellsMerge,
  TableCellsSplit,
  TableProperties,
  Trash2,
  WrapText,
} from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { useConfigStore } from '@/lib/config/store';
import { pasteFromSystemClipboard } from '@/lib/editor/clipboard';
import {
  findTableUnderSelection,
  selectionHasMergedCells,
  type TableBorderPreset,
} from '@/lib/editor/TableExtensions';
import { clearAllColumnWidths } from '@/lib/editor/tableResize';
import { useSidebarStore } from '@/lib/layout/sidebarStore';
import { COLOR_ROWS, GRAYSCALE_ROW } from '@/lib/colorPalette';
import { getCommand, setImageRadiusOnSelection } from '@/lib/commands/registry';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

/**
 * M-T4 — the DOCUMENT CONTEXT MENU: the app-wide replacement for the
 * WebView's native right-click menu (App.tsx suppresses `contextmenu`
 * globally; this is the custom surface, wrapping BOTH view modes at
 * Editor.tsx's routing — one mount, every mode).
 *
 * The variant reads the LIVE selection at OPEN time (the popup renders
 * on open): a NodeSelection on an image → the image ops; a CellSelection
 * or a caret parked in a table → the table ops; a non-empty text
 * selection → cut/copy/paste + formatting; otherwise the bare paste
 * surface. The FLOATING TOOLBAR keeps text formatting; this menu owns
 * the STRUCTURAL and CONTEXTUAL ops (Word's split).
 *
 * Controlled open: palette swatches are plain buttons (not menu items),
 * so they close the menu manually through the same open state.
 */

type MenuVariant = 'image' | 'table' | 'text' | 'none';

function variantOf(editor: Editor): MenuVariant {
  const { selection } = editor.state;
  if (
    selection instanceof NodeSelectionValue &&
    (selection.node.type.name === 'image' || selection.node.type.name === 'inlineImage')
  ) {
    return 'image';
  }
  if (selection instanceof CellSelection) return 'table';
  if (!selection.empty) return 'text';
  if (findTableUnderSelection(editor.state)) return 'table';
  return 'none';
}

/** The palette swatch grid (the ColorPickerButton popover's contents). */
function SwatchGrid({
  colors,
  onPick,
}: {
  colors: readonly string[];
  onPick: (color: string) => void;
}) {
  return (
    <div className="grid grid-cols-7 gap-1 p-1">
      {colors.map((color) => (
        <button
          key={color}
          type="button"
          aria-label={color}
          className="h-5 w-5 rounded border border-border hover:ring-1 hover:ring-ring"
          style={{ backgroundColor: color }}
          onClick={() => onPick(color)}
        />
      ))}
    </div>
  );
}

/** A color-picking submenu: reset + grayscale + the preset rows. */
function PaletteSub({
  label,
  icon,
  resetLabel,
  onPick,
}: {
  label: string;
  icon: ReactNode;
  resetLabel: string;
  onPick: (color: string | null) => void;
}) {
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        {icon}
        {label}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="max-h-80 overflow-y-auto">
        <ContextMenuItem data-testid="palette-reset" onClick={() => onPick(null)}>
          {resetLabel}
        </ContextMenuItem>
        <SwatchGrid colors={GRAYSCALE_ROW} onPick={onPick} />
        <ContextMenuSeparator />
        <SwatchGrid colors={COLOR_ROWS.flat()} onPick={onPick} />
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

function EditorContextMenuItems({ editor, close }: { editor: Editor; close: () => void }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      variant: e ? variantOf(e) : 'none' as MenuVariant,
      hasMerged: e ? selectionHasMergedCells(e.state) : false,
      inHeaderRow: e?.isActive('tableHeader') ?? false,
      // M-IMAGES-2.2 (carried to the menu surface): align is a
      // BLOCK-only fact — the cluster RENDERS only when usable (an
      // inline object is seated by baseline; its align attr is inert),
      // never disabled-but-visible.
      isInlineImage: e?.isActive('inlineImage') ?? false,
      isBold: e?.isActive('bold') ?? false,
      isItalic: e?.isActive('italic') ?? false,
      isUnderline: e?.isActive('underline') ?? false,
      isStrike: e?.isActive('strike') ?? false,
      border: (() => {
        const found = e ? findTableUnderSelection(e.state) : null;
        const v = found?.node.attrs.borderStyle;
        return v === 'none' || v === 'outer' ? (v as TableBorderPreset) : 'all';
      })(),
    }),
  });

  const chain = () => editor.chain().focus();

  // M-T4 — DEVELOPER MODE (Settings > General > Advanced; gated behind
  // an accepted warning there): Reload + Inspect Element ride the
  // BOTTOM of every variant. Reload is unconditional; Inspect Element
  // goes through the Rust open_devtools command (browser dev runs get
  // an explanatory toast — the tools are Tauri webview features).
  const developerMode = useConfigStore((s) => s.config.developerMode);
  const developerItems = developerMode ? (
    <>
      <ContextMenuSeparator />
      <ContextMenuItem data-testid="ctx-reload" onClick={() => window.location.reload()}>
        <RotateCw size={14} /> Reload
      </ContextMenuItem>
      <ContextMenuItem
        data-testid="ctx-inspect"
        onClick={() => {
          void (async () => {
            try {
              const { invoke } = await import('@tauri-apps/api/core');
              await invoke('open_devtools');
            } catch {
              void toast.add({
                title: 'Inspect Element unavailable',
                description: 'The webview devtools are only available in the desktop app.',
              });
            }
          })();
        }}
      >
        <SquareTerminal size={14} /> Inspect Element
      </ContextMenuItem>
    </>
  ) : null;

  if (state?.variant === 'table') {
    const table = findTableUnderSelection(editor.state);
    const tablePos = table?.pos ?? null;
    return (
      <>
        <ContextMenuGroup>
          <ContextMenuLabel>Table</ContextMenuLabel>
        </ContextMenuGroup>
        <ContextMenuItem data-testid="ctx-insert-row-above" onClick={() => chain().addRowBefore().run()}>
          <Plus size={14} /> Insert Row Above
        </ContextMenuItem>
        <ContextMenuItem data-testid="ctx-insert-row-below" onClick={() => chain().addRowAfter().run()}>
          <Plus size={14} /> Insert Row Below
        </ContextMenuItem>
        <ContextMenuItem data-testid="ctx-insert-col-left" onClick={() => chain().addColumnBefore().run()}>
          <Plus size={14} /> Insert Column Left
        </ContextMenuItem>
        <ContextMenuItem data-testid="ctx-insert-col-right" onClick={() => chain().addColumnAfter().run()}>
          <Plus size={14} /> Insert Column Right
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem data-testid="ctx-delete-row" onClick={() => chain().deleteRow().run()}>
          <Minus size={14} /> Delete Row
        </ContextMenuItem>
        <ContextMenuItem data-testid="ctx-delete-col" onClick={() => chain().deleteColumn().run()}>
          <Minus size={14} /> Delete Column
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="ctx-delete-table"
          variant="destructive"
          onClick={() => chain().deleteTable().run()}
        >
          <Trash2 size={14} /> Delete Table
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          data-testid={state.hasMerged ? 'ctx-split' : 'ctx-merge'}
          onClick={() =>
            state.hasMerged ? chain().splitCell().run() : chain().mergeCells().run()
          }
        >
          {state.hasMerged ? <TableCellsSplit size={14} /> : <TableCellsMerge size={14} />}
          {state.hasMerged ? 'Split Cell' : 'Merge Cells'}
        </ContextMenuItem>
        <ContextMenuItem data-testid="ctx-header-row" onClick={() => chain().toggleHeaderRow().run()}>
          <Pin size={14} fill={state.inHeaderRow ? 'currentColor' : 'none'} />
          {state.inHeaderRow ? 'Unpin Header Row' : 'Make Header Row'}
        </ContextMenuItem>
        <PaletteSub
          label="Cell Shading"
          icon={<PaintBucket size={14} />}
          resetLabel="No Fill"
          onPick={(color) => {
            chain().setCellBackground(color).run();
            close();
          }}
        />
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger data-testid="ctx-borders-menu">
            <Frame size={14} /> Borders
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuRadioGroup
              value={state.border}
              onValueChange={(preset) => {
                void preset;
              }}
            >
              {(['all', 'outer', 'none'] as TableBorderPreset[]).map((preset) => (
                <ContextMenuRadioItem
                  key={preset}
                  value={preset}
                  data-testid={`ctx-borders-${preset}`}
                  onClick={() => chain().setTableBorderPreset(preset).run()}
                >
                  {preset === 'all' ? 'All Borders' : preset === 'outer' ? 'Outer Borders' : 'No Borders'}
                </ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem
          data-testid="ctx-distribute"
          disabled={tablePos == null}
          onClick={() => {
            if (tablePos != null) clearAllColumnWidths(editor, tablePos);
          }}
        >
          <TableProperties size={14} /> Distribute Columns Evenly
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          data-testid="ctx-table-properties"
          onClick={() => useSidebarStore.getState().open('table', 'right')}
        >
          <TableProperties size={14} /> Table Properties…
        </ContextMenuItem>
        {developerItems}
      </>
    );
  }

  if (state?.variant === 'text') {
    return (
      <>
        {/* M-T4 (focused menus): a text selection shows the CLIPBOARD
            group only — formatting lives on the floating toolbar and
            the ribbon, which are selection surfaces already. */}
        <ContextMenuItem data-testid="ctx-cut" onClick={() => void document.execCommand('cut')}>
          <Scissors size={14} /> Cut
        </ContextMenuItem>
        <ContextMenuItem data-testid="ctx-copy" onClick={() => void document.execCommand('copy')}>
          <Copy size={14} /> Copy
        </ContextMenuItem>
        <ContextMenuItem data-testid="ctx-paste" onClick={() => void pasteFromSystemClipboard(editor)}>
          <ClipboardPaste size={14} /> Paste
        </ContextMenuItem>
        {/* M-REFS: the index mark lives here — the STRUCTURAL ops home
            (the floating toolbar keeps formatting). The marked span is
            the term; the same command the palette runs (never a
            re-implementation). */}
        <ContextMenuSeparator />
        <ContextMenuItem data-testid="ctx-mark-index" onClick={() => void getCommand('markIndexEntry')?.run()}>
          <BookmarkPlus size={14} /> Mark as Index Entry
        </ContextMenuItem>
        {developerItems}
      </>
    );
  }

  if (state?.variant === 'image') {
    return (
      <>
        <ContextMenuGroup>
          <ContextMenuLabel>Image</ContextMenuLabel>
        </ContextMenuGroup>
        <ContextMenuItem data-testid="ctx-image-caption" onClick={() => void getCommand('imageAddCaption')?.run()}>
          <MessageSquareText size={14} /> Add Caption
        </ContextMenuItem>
        <ContextMenuItem data-testid="ctx-image-alt" onClick={() => void getCommand('imageAltText')?.run()}>
          <PersonStanding size={14} /> Alt Text
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger data-testid="ctx-wrap-menu">
            <WrapText size={14} /> Text Wrapping
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem data-testid="ctx-wrap-inline" onClick={() => void getCommand('imageWrapInline')?.run()}>
              In Line with Text
            </ContextMenuItem>
            <ContextMenuItem data-testid="ctx-wrap-front" onClick={() => void getCommand('imageWrapFront')?.run()}>
              In Front of Text
            </ContextMenuItem>
            <ContextMenuItem data-testid="ctx-wrap-behind" onClick={() => void getCommand('imageWrapBehind')?.run()}>
              Behind Text
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        {!state.isInlineImage && (
          <ContextMenuSub>
            <ContextMenuSubTrigger data-testid="ctx-align-menu">
              <AlignCenter size={14} /> Alignment
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem data-testid="ctx-align-left" onClick={() => void getCommand('imageAlignLeft')?.run()}>
                <AlignLeft size={14} /> Left
              </ContextMenuItem>
              <ContextMenuItem data-testid="ctx-align-center" onClick={() => void getCommand('imageAlignCenter')?.run()}>
                <AlignCenter size={14} /> Center
              </ContextMenuItem>
              <ContextMenuItem data-testid="ctx-align-right" onClick={() => void getCommand('imageAlignRight')?.run()}>
                <AlignRight size={14} /> Right
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        <ContextMenuSub>
          <ContextMenuSubTrigger data-testid="ctx-radius-menu">
            <SquareRoundCorner size={14} /> Corner Radius
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {[0, 4, 8, 12, 16, 24].map((r) => (
              <ContextMenuItem key={r} data-testid={`ctx-radius-${r}`} onClick={() => void setImageRadiusOnSelection(r)}>
                {r === 0 ? 'None' : `${r}px`}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem data-testid="ctx-delete-image" variant="destructive" onClick={() => chain().deleteSelection().run()}>
          <Trash2 size={14} /> Delete Image
        </ContextMenuItem>
        {developerItems}
      </>
    );
  }

  // The bare surface: paste (the proven middle-click path) + select all.
  return (
    <>
      <ContextMenuItem data-testid="ctx-paste" onClick={() => void pasteFromSystemClipboard(editor)}>
        <ClipboardPaste size={14} /> Paste
      </ContextMenuItem>
      <ContextMenuItem data-testid="ctx-select-all" onClick={() => chain().selectAll().focus().run()}>
        Select All
      </ContextMenuItem>
      {developerItems}
    </>
  );
}

export function DocumentContextMenu({ editor, children }: { editor: Editor; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <ContextMenu open={open} onOpenChange={(o) => setOpen(o)}>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <EditorContextMenuItems editor={editor} close={() => setOpen(false)} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
