import { Sigma } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import { IconButton } from '../../IconButton';

/**
 * M-EQ — the Insert tab's Equation button (the disabled stub it
 * replaces was the issue's own scoping note). The command inserts an
 * empty display equation and NodeSelections it — the selection is what
 * opens the editor bubble (useEquationEditor's reactive path), so the
 * button, Alt+=, and the palette all land on the same open flow.
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