import { useEffect } from 'react';
import type { Editor } from '@tiptap/core';
import { SpellController } from './controller';

/**
 * Mounts the spell-check controller on the app's single editor — a
 * thin lifecycle wrapper; all reactions (enable/disable, language/
 * provider changes, doc updates) live inside the controller.
 */
export function useSpellCheck(editor: Editor | null): void {
  useEffect(() => {
    if (!editor) return;
    const controller = new SpellController(editor);
    controller.attach();
    return () => controller.detach();
  }, [editor]);
}
