import { useEditorState } from '@tiptap/react';
import {
  ArrowUpToLine,
  ArrowDownToLine,
  IndentIncrease,
  IndentDecrease,
  CornerDownRight,
  CornerUpRight,
} from 'lucide-react';
import { RibbonGroup } from '../../../RibbonGroup';
import { RibbonIconInput } from '../../RibbonIconInput';
import { IconButton } from '../../../IconButton';
import type { Editor } from '@tiptap/core';

/** The hanging preset's left indent (px): Word's 0.5" reference-list
 * look on the 32px step grid — first line at the left edge, wrapped
 * lines one gutter in. */
const HANGING_STEP_PX = 32;

/**
 * Layout ▸ Indent & Spacing. Per-paragraph controls commit live (unlike
 * apply-gated document margins). First Line / Hanging are toggle
 * presets; a hanging first line needs a left gutter to hang into.
 */
export function ParagraphSpacingGroup({ editor }: { editor: Editor }) {
  const attrs = useEditorState({
    editor,
    selector: (ctx) => ({
      spaceBefore: ctx.editor?.getAttributes('paragraph').spaceBefore ?? 0,
      spaceAfter: ctx.editor?.getAttributes('paragraph').spaceAfter ?? 0,
      indentLeft: ctx.editor?.getAttributes('paragraph').indentLeft ?? 0,
      indentRight: ctx.editor?.getAttributes('paragraph').indentRight ?? 0,
      firstLineIndent: (ctx.editor?.getAttributes('paragraph').firstLineIndent as number | null) ?? 0,
    }),
  });

  const fli = attrs?.firstLineIndent ?? 0;

  function applyFirstLine() {
    editor.chain().focus().updateAttributes('paragraph', {
      firstLineIndent: fli > 0 ? null : HANGING_STEP_PX,
    }).run();
  }

  function applyHanging() {
    if (fli < 0) {
      // Clearing the preset leaves indentLeft as-is (predictable).
      editor.chain().focus().updateAttributes('paragraph', { firstLineIndent: null }).run();
      return;
    }
    const left = attrs?.indentLeft ?? 0;
    editor.chain().focus().updateAttributes('paragraph', {
      firstLineIndent: -HANGING_STEP_PX,
      // A hanging first line needs a gutter to hang into: raise the
      // left indent to one step when the paragraph has none.
      ...(left < HANGING_STEP_PX ? { indentLeft: HANGING_STEP_PX } : {}),
    }).run();
  }

  return (
    <RibbonGroup>
      <RibbonIconInput
        label="Space Before"
        icon={<ArrowUpToLine size={14} />}
        value={attrs?.spaceBefore ?? 0}
        onCommit={(v) => editor.chain().updateAttributes('paragraph', { spaceBefore: v }).run()}
        showSteppers
      />
      <RibbonIconInput
        label="Space After"
        icon={<ArrowDownToLine size={14} />}
        value={attrs?.spaceAfter ?? 0}
        onCommit={(v) => editor.chain().updateAttributes('paragraph', { spaceAfter: v }).run()}
        showSteppers
      />
      <RibbonIconInput
        label="Indent Left"
        icon={<IndentIncrease size={14} />}
        value={attrs?.indentLeft ?? 0}
        onCommit={(v) => editor.chain().updateAttributes('paragraph', { indentLeft: v }).run()}
        showSteppers
      />
      <RibbonIconInput
        label="Indent Right"
        icon={<IndentDecrease size={14} />}
        value={attrs?.indentRight ?? 0}
        onCommit={(v) => editor.chain().updateAttributes('paragraph', { indentRight: v }).run()}
        showSteppers
      />

      <IconButton
        label="First Line Indent"
        icon={<CornerDownRight size={16} />}
        active={fli > 0}
        onClick={applyFirstLine}
      />
      <IconButton
        label="Hanging Indent"
        icon={<CornerUpRight size={16} />}
        active={fli < 0}
        onClick={applyHanging}
      />
    </RibbonGroup>
  );
}
