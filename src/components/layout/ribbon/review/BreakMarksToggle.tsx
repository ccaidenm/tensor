import { SquareSplitHorizontal } from 'lucide-react';
import { IconButton } from '../../IconButton';
import { useConfigStore } from '@/lib/config/store';

/**
 * #58 — the BREAK MARKS toggle (the structural NPCs): the page/section
 * break badges in the paginated view. DISTINCT from the character-level
 * pilcrows (Show Non-Printing Characters) — a section boundary is
 * meaningful ink, so this defaults ON; Word hides both behind one ¶.
 */
export function BreakMarksToggle() {
  const enabled = useConfigStore((s) => s.config.editor.showBreakMarks);
  const setShowBreakMarks = useConfigStore((s) => s.setShowBreakMarks);

  return (
    <IconButton
      label="Show Break Marks"
      icon={<SquareSplitHorizontal size={16} />}
      active={enabled}
      onClick={() => setShowBreakMarks(!enabled)}
    />
  );
}
