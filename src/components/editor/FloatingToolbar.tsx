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
} from 'lucide-react';
import { getCommand, setImageRadiusOnSelection } from '@/lib/commands/registry';
import type { Editor } from '@tiptap/core';
import { Separator } from '@/components/ui/separator';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { FloatingToolbarPosition } from '@/lib/editor/useFloatingToolbar';
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
        {!attrs?.isImage && (
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
