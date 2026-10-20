import { useEditorState } from '@tiptap/react';
import { useState } from 'react';
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  Highlighter,
  MessageSquarePlus,
  MessageSquareText,
  WrapText,
  ArrowRightFromLine,
  ArrowLeftFromLine,
  ChevronsLeftRight,
  PersonStanding,
  SquareRoundCorner,
  BetweenHorizontalStart,
  BetweenHorizontalEnd,
  BetweenVerticalStart,
  BetweenVerticalEnd,
  TableCellsMerge,
  TableCellsSplit,
  Rows3,
  PaintBucket,
  Frame,
  Trash2,
} from 'lucide-react';
import { getCommand, setImageRadiusOnSelection } from '@/lib/commands/registry';
import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { Separator } from '@/components/ui/separator';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { FloatingToolbarPosition } from '@/lib/editor/useFloatingToolbar';
import { selectionHasMergedCells, type TableBorderPreset } from '@/lib/editor/TableExtensions';
import { ColorPickerButton } from '../layout/ribbon/ColorPickerButton';
import { LinkButton } from '../layout/ribbon/LinkButton';
import { ClearFormattingButton } from '../layout/ribbon/home/ClearFormattingButton';
import { IconButton } from '../layout/IconButton';
import { RibbonIconInput } from '../layout/ribbon/RibbonIconInput';

const WRAP_MODES: {
  id: string;
  label: string;
  command: 'Inline' | 'Front' | 'Behind';
  active: (attrs: { isInline: boolean; floatZ: 'front' | 'behind' | null }) => boolean;
}[] = [
  { id: 'inline', label: 'In Line with Text', command: 'Inline', active: (a) => a.isInline },
  { id: 'front', label: 'In Front of Text', command: 'Front', active: (a) => a.floatZ === 'front' },
  { id: 'behind', label: 'Behind Text', command: 'Behind', active: (a) => a.floatZ === 'behind' },
];

interface FloatingToolbarProps {
  editor: Editor;
  position: FloatingToolbarPosition;
  containerTop: number;
  containerLeft: number;
}

export function FloatingToolbar({ editor, position, containerTop, containerLeft }: FloatingToolbarProps) {
  const [wrapOpen, setWrapOpen] = useState(false);
  const attrs = useEditorState({
    editor,
    selector: (ctx) => ({
      isBold: ctx.editor?.isActive('bold') ?? false,
      isItalic: ctx.editor?.isActive('italic') ?? false,
      isUnderline: ctx.editor?.isActive('underline') ?? false,
      isStrike: ctx.editor?.isActive('strike') ?? false,
      // M-IMAGES-1: the selected-image state (a NodeSelection on the
      // image node — the contextual controls replace the text ones).
      // M-IMAGES-2: image-ness spans both shapes (block + inline).
      // M-IMAGES-2.1: attrs read from the ACTIVE node type — the old
      // unconditional getAttributes('image') fed an inline selection
      // the BLOCK type's DEFAULTS (align left, radius 0, max 0), so
      // the radius slider was dead and the state display lied.
      isImage: (ctx.editor?.isActive('image') ?? false) || (ctx.editor?.isActive('inlineImage') ?? false),
      isInline: ctx.editor?.isActive('inlineImage') ?? false,
      imageAlign: ((ctx.editor?.isActive('inlineImage')
        ? ctx.editor?.getAttributes('inlineImage').align
        : ctx.editor?.getAttributes('image').align) ?? 'left') as 'left' | 'center' | 'right',
      imageRadius: ((ctx.editor?.isActive('inlineImage')
        ? ctx.editor?.getAttributes('inlineImage').radius
        : ctx.editor?.getAttributes('image').radius) ?? 0) as number,
      imageMaxRadius:
        Math.floor(
          Math.min(
            ((ctx.editor?.isActive('inlineImage')
              ? ctx.editor?.getAttributes('inlineImage').width
              : ctx.editor?.getAttributes('image').width) as number | undefined) ?? 0,
            ((ctx.editor?.isActive('inlineImage')
              ? ctx.editor?.getAttributes('inlineImage').height
              : ctx.editor?.getAttributes('image').height) as number | undefined) ?? 0,
          ) / 2,
        ),
      // The wrap state lives on the BLOCK node only (float is an inert
      // carrier inline — the adapter never reads it there).
      floatZ: (ctx.editor?.getAttributes('image').float as { z?: 'front' | 'behind' } | null | undefined)?.z ?? null,
      // M-TABLES: in-table state. tableOnlySelection = the selection
      // SHAPE is table-shaped (a CellSelection across cells, or a
      // NodeSelection on the table node itself) — text tools are then
      // meaningless and the strip shows table ops alone. With a text
      // selection (or a bare caret) inside a cell, both strips show:
      // cell content stays editable while the table ops sit alongside.
      isTable: ctx.editor?.isActive('table') ?? false,
      tableOnlySelection: (() => {
        const state = ctx.editor?.state;
        if (!state) return false;
        const sel = state.selection;
        if (sel instanceof CellSelection) return true;
        return sel instanceof NodeSelection && sel.node.type.name === 'table';
      })(),
      // Merge⇄Split is ONE toggle button (Word parity): the presence of
      // merged cells under the selection flips it to Split.
      hasMergedCells: ctx.editor?.state ? selectionHasMergedCells(ctx.editor.state) : false,
      inHeaderRow: ctx.editor?.isActive('tableHeader') ?? false,
    }),
  });

  // The SINGLE clearance (see FloatingToolbarPosition.gap) — above:
  // the toolbar's bottom sits `gap` above the anchor top; below: its
  // top sits `gap` below the anchor bottom.
  const translateY =
    position.placement === 'above'
      ? `translateY(calc(-100% - ${position.gap}px))`
      : `translateY(${position.gap}px)`;

  return (
    <div
        data-floating-toolbar
        onMouseDown={(e) => e.preventDefault()}
        className="absolute z-30 flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-md"
        style={{
          left: position.left - containerLeft,
          top: (position.placement === 'above' ? position.top : position.bottom) - containerTop,
          transform: translateY,
        }}
      >
        {/* M-TABLES — the table context strip. Word parity: table ops
            ride alongside text formatting when a cell is being typed in,
            and REPLACE the text tools when the selection is table-shaped
            (CellSelection / node-selection on the table). */}
        {attrs?.isTable && (
          <>
            <Popover>
              <PopoverTrigger
                render={
                  <IconButton
                    label="Insert Row or Column"
                    icon={<BetweenHorizontalStart size={14} />}
                    onClick={() => {}}
                  />
                }
              />
              <PopoverContent className="w-44 p-1" align="start">
                <button
                  data-testid="table-insert-row-above"
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
                  onClick={() => editor.chain().focus().addRowBefore().run()}
                >
                  <BetweenHorizontalStart size={14} /> Row Above
                </button>
                <button
                  data-testid="table-insert-row-below"
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
                  onClick={() => editor.chain().focus().addRowAfter().run()}
                >
                  <BetweenHorizontalEnd size={14} /> Row Below
                </button>
                <button
                  data-testid="table-insert-column-left"
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
                  onClick={() => editor.chain().focus().addColumnBefore().run()}
                >
                  <BetweenVerticalStart size={14} /> Column Left
                </button>
                <button
                  data-testid="table-insert-column-right"
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
                  onClick={() => editor.chain().focus().addColumnAfter().run()}
                >
                  <BetweenVerticalEnd size={14} /> Column Right
                </button>
              </PopoverContent>
            </Popover>

            <Popover>
              <PopoverTrigger
                render={
                  <IconButton
                    label="Delete"
                    icon={<Trash2 size={14} />}
                    onClick={() => {}}
                  />
                }
              />
              <PopoverContent className="w-44 p-1" align="start">
                <button
                  data-testid="table-delete-row"
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
                  onClick={() => editor.chain().focus().deleteRow().run()}
                >
                  <BetweenHorizontalStart size={14} /> Delete Row
                </button>
                <button
                  data-testid="table-delete-column"
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
                  onClick={() => editor.chain().focus().deleteColumn().run()}
                >
                  <BetweenVerticalStart size={14} /> Delete Column
                </button>
                <button
                  data-testid="table-delete-table"
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm text-destructive hover:bg-muted"
                  onClick={() => editor.chain().focus().deleteTable().run()}
                >
                  <Trash2 size={14} /> Delete Table
                </button>
              </PopoverContent>
            </Popover>

            <Separator orientation="vertical" className="mx-1 h-6" />

            <IconButton
              label={attrs.hasMergedCells ? 'Split Cell' : 'Merge Cells'}
              data-testid={attrs.hasMergedCells ? 'table-split' : 'table-merge'}
              icon={attrs.hasMergedCells ? <TableCellsSplit size={14} /> : <TableCellsMerge size={14} />}
              onClick={() =>
                attrs.hasMergedCells
                  ? editor.chain().focus().splitCell().run()
                  : editor.chain().focus().mergeCells().run()
              }
            />
            <IconButton
              label="Header Row"
              data-testid="table-header-row"
              icon={<Rows3 size={14} />}
              active={attrs.inHeaderRow}
              onClick={() => editor.chain().focus().toggleHeaderRow().run()}
            />

            <ColorPickerButton
              label="Cell Shading"
              icon={<PaintBucket size={14} />}
              resetLabel="No Fill"
              onChange={(color) => {
                editor.chain().focus().setCellBackground(color).run();
              }}
            />

            <Popover>
              <PopoverTrigger
                render={
                  <IconButton
                    label="Borders"
                    icon={<Frame size={14} />}
                    onClick={() => {}}
                  />
                }
              />
              <PopoverContent className="w-44 p-1" align="start">
                {(['all', 'outer', 'none'] as TableBorderPreset[]).map((preset) => (
                  <button
                    key={preset}
                    data-testid={`table-borders-${preset}`}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
                    onClick={() => editor.chain().focus().setTableBorderPreset(preset).run()}
                  >
                    <Frame size={14} />
                    {preset === 'all' ? 'All Borders' : preset === 'outer' ? 'Outer Borders' : 'No Borders'}
                  </button>
                ))}
              </PopoverContent>
            </Popover>

            <Separator orientation="vertical" className="mx-1 h-6" />
          </>
        )}

        {!attrs?.isImage && !(attrs?.isTable && attrs?.tableOnlySelection) && (
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
      <IconButton
        label="Insert Comment"
        icon={<MessageSquarePlus size={16} />}
        onClick={() => { }}
        disabled
      />
      <ClearFormattingButton editor={editor} />
          </>
        )}

      {attrs?.isImage && (
        <>
          <IconButton
            label="Add Caption"
            data-testid="toolbar-add-caption"
            icon={<MessageSquareText size={14} />}
            onClick={() => void getCommand('imageAddCaption')?.run()}
          />
          <IconButton
            label="Add Alt Text"
            data-testid="toolbar-alt-text"
            icon={<PersonStanding size={14} />}
            onClick={() => void getCommand('imageAltText')?.run()}
          />

          <Separator orientation="vertical" className="mx-1 h-6" />

          <RibbonIconInput
            label="Corner Radius"
            icon={<SquareRoundCorner size={12} />}
            value={attrs.imageRadius}
            min={0}
            max={Math.max(0, attrs.imageMaxRadius)}
            width="w-16"
            showSteppers
            stepAmount={4}
            onCommit={(value) => void setImageRadiusOnSelection(value)}
          />

          <Separator orientation="vertical" className="mx-1 h-6" />

          <Popover open={wrapOpen} onOpenChange={setWrapOpen}>
            <PopoverTrigger
              render={
                <IconButton
                  label="Wrap Text"
                  icon={<WrapText size={14} />}
                  active={attrs.isInline || attrs.floatZ != null}
                  onClick={() => {}}
                />
              }
            />
            <PopoverContent className="w-44 p-1" align="start">
              {WRAP_MODES.map((m) => (
                <button
                  key={m.id}
                  data-testid={`wrap-${m.id}`}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted ${
                    m.active(attrs) ? 'bg-muted font-medium' : ''
                  }`}
                  onClick={() => {
                    void getCommand(`imageWrap${m.command}`)?.run();
                    setWrapOpen(false);
                  }}
                >
                  {m.label}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {/* M-IMAGES-2.2: the align cluster is BLOCK-only — it RENDERS
              only when usable (an inline object's align attr is inert —
              the engine seats objects by baseline), never disabled-but-
              visible. It lives at the END of the group so hiding it
              leaves no gap at the start. */}
          {!attrs.isInline && (
            <>
              <Separator orientation="vertical" className="mx-1 h-6" />

              <IconButton
                label="Align Left"
                icon={<ArrowRightFromLine size={14} />}
                active={attrs.imageAlign === 'left'}
                onClick={() => void getCommand('imageAlignLeft')?.run()}
              />
              <IconButton
                label="Align Center"
                icon={<ChevronsLeftRight size={14} />}
                active={attrs.imageAlign === 'center'}
                onClick={() => void getCommand('imageAlignCenter')?.run()}
              />
              <IconButton
                label="Align Right"
                icon={<ArrowLeftFromLine size={14} />}
                active={attrs.imageAlign === 'right'}
                onClick={() => void getCommand('imageAlignRight')?.run()}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
