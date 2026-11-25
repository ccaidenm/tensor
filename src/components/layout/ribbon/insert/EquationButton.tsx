import { Sigma } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import { IconButton } from '../../IconButton';

/**
 * Inserts an empty display equation and NodeSelections it — the
 * selection is what opens the editor bubble (useEquationEditor's
 * reactive path), so every entry surface lands on the same open flow.
 */
export function EquationButton({ editor }: { editor: Editor }) {
  return (
    <IconButton
      label="Equation"
      icon={<Sigma size={16} />}
      onClick={() => editor.commands.insertEquation()}
      shortcutId="insertEquation"
    />
  );
}