import { useEditorState } from '@tiptap/react';
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  Highlighter,
  MessageSquarePlus,
  TableCellsMerge,
  TableCellsSplit,
  TableProperties,
} from 'lucide-react';

import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { Separator } from '@/components/ui/separator';
import type { FloatingToolbarPosition } from '@/lib/editor/useFloatingToolbar';
import { selectionHasMergedCells } from '@/lib/editor/TableExtensions';
import { getCommand } from '@/lib/commands/registry';

import { useSidebarStore } from '@/lib/layout/sidebarStore';
import { ColorPickerButton } from '../layout/ribbon/ColorPickerButton';
import { LinkButton } from '../layout/ribbon/LinkButton';
import { ClearFormattingButton } from '../layout/ribbon/home/ClearFormattingButton';
import { IconButton } from '../layout/IconButton';

interface FloatingToolbarProps {
  editor: Editor;
  position: FloatingToolbarPosition;
  containerTop: number;
  containerLeft: number;
}

export function FloatingToolbar({ editor, position, containerTop, containerLeft }: FloatingToolbarProps) {
  const attrs = useEditorState({
    editor,
    selector: (ctx) => ({
      isBold: ctx.editor?.isActive('bold') ?? false,
      isItalic: ctx.editor?.isActive('italic') ?? false,
      isUnderline: ctx.editor?.isActive('underline') ?? false,
      isStrike: ctx.editor?.isActive('strike') ?? false,
      // Image-ness (both shapes) gates the text strip — an image
      // NodeSelection shows no text tools (ops live in the context menu).
      isImage: (ctx.editor?.isActive('image') ?? false) || (ctx.editor?.isActive('inlineImage') ?? false),
      // tableOnlySelection: the selection SHAPE is table-shaped (a
      // CellSelection, or a NodeSelection on the table node) — table ops
      // only. Text/caret in a cell: both strips (cell stays editable).
      isTable: ctx.editor?.isActive('table') ?? false,
      tableOnlySelection: (() => {
        const state = ctx.editor?.state;
        if (!state) return false;
        const sel = state.selection;
        if (sel instanceof CellSelection) return true;
        return sel instanceof NodeSelection && sel.node.type.name === 'table';
      })(),
      // A multi-cell CellSelection carries its own Merge⇄Split action;
      // a bare caret never sees it (merge is meaningless on one cell).
      isCellSelection: ctx.editor?.state.selection instanceof CellSelection,
      hasMergedCells: ctx.editor?.state ? selectionHasMergedCells(ctx.editor.state) : false,
    }),
  });

  // The single clearance (position.gap): 'above' lifts the bottom gap
  // over the anchor top; 'below' drops the top gap under the anchor bottom.
  const translateY =
    position.placement === 'above'
      ? `translateY(calc(-100% - ${position.gap}px))`
      : `translateY(${position.gap}px)`;

  // Strip gates: text formatting only for text selections (hidden for
  // image/table-shaped ones); image strip = link/comment/clear only.
  const showTextStrip = !!attrs && !attrs.isImage && !(attrs.isTable && attrs.tableOnlySelection);
  const showImageStrip = !!attrs?.isImage;

  return (
    <div
        data-floating-toolbar
        data-testid="floating-toolbar"
        onMouseDown={(e) => e.preventDefault()}
        className="absolute z-30 flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-md"
        style={{
          left: position.left - containerLeft,
          top: (position.placement === 'above' ? position.top : position.bottom) - containerTop,
          transform: translateY,
        }}
      >
        {/* The table strip: structural ops live in the document context
            menu, the side panel owns fine-tuning; the strip rides alongside
            text formatting while the caret is in a cell. */}
        {attrs?.isTable && (
          <>
            {/* Merge⇄Split when actionable (a multi-cell selection) — the
                same toggle the context menu runs. */}
            {attrs.isCellSelection && (
              <IconButton
                label={attrs.hasMergedCells ? 'Split Cells' : 'Merge Cells'}
                data-testid={attrs.hasMergedCells ? 'toolbar-split' : 'toolbar-merge'}
                icon={
                  attrs.hasMergedCells ? <TableCellsSplit size={14} /> : <TableCellsMerge size={14} />
                }
                onClick={() =>
                  attrs.hasMergedCells
                    ? editor.chain().focus().splitCell().run()
                    : editor.chain().focus().mergeCells().run()
                }
              />
            )}
            <IconButton
              label="Table Properties"
              data-testid="toolbar-table-properties"
              icon={<TableProperties size={14} />}
              onClick={() => useSidebarStore.getState().open('table', 'right')}
            />
            {/* Separator only when a strip follows — no dangling divider
                after a table-only toolbar. */}
            {(showTextStrip || showImageStrip) && (
              <Separator orientation="vertical" className="mx-1 h-6" />
            )}
          </>
        )}


        {showTextStrip && (
          <>
                    <IconButton
          label="Bold"
          icon={<Bold size={16} />}
          active={attrs?.isBold}
          onClick={() => editor.chain().focus().toggleBold().run()}
          shortcutId="bold"
        />

        <IconButton
          label="Italic"
          icon={<Italic size={16} />}
          active={attrs?.isItalic}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          shortcutId="italic"
        />

        <IconButton
          label="Underline"
          icon={<UnderlineIcon size={16} />}
          active={attrs?.isUnderline}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          shortcutId="underline"
        />

        <IconButton
          label="Strikethrough"
          icon={<Strikethrough size={16} />}
          active={attrs?.isStrike}
          onClick={() => editor.chain().focus().toggleStrike().run()}
          shortcutId="strike"
        />

      <Separator orientation="vertical" className="mx-1 h-6" />

      <ColorPickerButton
        label="Text Color"
        icon={<span className="text-sm font-semibold">A</span>}
        onChange={(color) => {
          if (color) editor.chain().focus().setColor(color).run();
          else editor.chain().focus().unsetColor().run();
        }}
      />

      <ColorPickerButton
        label="Highlight Color"
        icon={<Highlighter size={16} />}
        resetLabel="Transparent"
        onChange={(color) => {
          if (color) editor.chain().focus().toggleHighlight({ color }).run();
          else editor.chain().focus().unsetHighlight().run();
        }}
      />

      <Separator orientation="vertical" className="mx-1 h-6" />

      <LinkButton editor={editor} />
      {/* Shares the ONE command body (toolbar, Ctrl+Alt+M, palette:
          EDITOR_COMMAND_MAP.addComment). ALWAYS ENABLED — a bare caret
          anchors the word it sits in. The image strip's stub stays
          disabled (non-text anchors out of scope). */}
      <IconButton
        label="Insert Comment"
        icon={<MessageSquarePlus size={16} />}
        shortcutId="addComment"
        onClick={() => getCommand('addComment')?.run()}
      />
      <ClearFormattingButton editor={editor} />
          </>
        )}

        {/* The IMAGE strip: actions that make sense on a selected image —
            Hyperlink (images can be link targets), the Comment placeholder,
            Clear Formatting (harmless on a bare image, meaningful on a
            marked inline one). */}
        {showImageStrip && (
          <>
            <LinkButton editor={editor} />
            <IconButton
              label="Insert Comment"
              icon={<MessageSquarePlus size={16} />}
              onClick={() => { }}
              disabled
            />
            <ClearFormattingButton editor={editor} />
          </>
        )}

    </div>
  );
}
