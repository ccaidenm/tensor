import { useDocumentStore } from '@/lib/document/store';
import { COMMANDS } from './registry';
import type { CommandAction } from './registry';

/** The live, availability-filtered command list for the palette.
 *  Subscribes to the store slices the enablement predicates read;
 *  `revision` bumps on every markDirty — the cheap reactive proxy. */
export function useAppCommands(editorContext: boolean): CommandAction[] {
  // Reactive triggers for the enablement predicates — reading the
  // values (not using them directly) is the point.
  useDocumentStore((s) => s.revision);
  useDocumentStore((s) => s.isDirty);
  useDocumentStore((s) => s.editor);

  return filterCommands(editorContext);
}

/** Pure filter — exported for tests and non-React dispatch surfaces. */
export function filterCommands(editorContext: boolean): CommandAction[] {
  return COMMANDS.filter((c) => {
    const contexts = c.contexts ?? ['app'];
    const contextVisible =
      contexts.includes('app') || (editorContext && contexts.includes('editor'));
    return contextVisible && c.hidden?.() !== true && c.enablement?.() !== false;
  });
}
