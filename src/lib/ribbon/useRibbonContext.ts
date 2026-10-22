import { useEffect } from 'react';
import type { Editor } from '@tiptap/core';
import type { NodeSelection } from '@tiptap/pm/state';
import { useEditorState } from '@tiptap/react';
import { useRibbonContextStore } from './contextStore';
import type { RibbonContextId } from './contextualTabs';

/**
 * M-CONTEXTUAL-RIBBON — the context producer binding.
 *
 * `useRibbonContext(id, isActive)` ENTERS the context when the signal
 * turns true and EXITS it when it turns false — the whole activation
 * contract, drop-in for any future context (image, table, header/footer,
 * …). The Ribbon wiring in Ribbon.tsx handles what "entered" means (tab
 * appended + auto-focused + previous tab restored on exit); producers
 * only ever report selection kind. The store's guards make this safe:
 * enter is idempotent per id and first-come-wins across ids; exit is
 * id-scoped, so a stale producer can't tear down a newer context.
 */
export function useRibbonContext(id: RibbonContextId, isActive: boolean) {
  const enter = useRibbonContextStore((s) => s.enter);
  const exit = useRibbonContextStore((s) => s.exit);

  useEffect(() => {
    if (isActive) enter(id);
    else exit(id);
    return () => exit(id);
    // enter/exit are stable zustand actions; id flips are the real deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isActive]);
}

/**
 * True while the selection sits inside a table: the caret (or any
 * selection) with a `table` ancestor, or a NodeSelection ON a table.
 */
export function selectionInTable(editor: Editor | null): boolean {
  if (!editor) return false;
  const { selection } = editor.state;
  if (isNodeSelection(selection)) {
    if (selection.node.type.name === 'table') return true;
  }
  const { $from } = selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'table') return true;
  }
  return false;
}

/** True while an image/inlineImage node is selected. */
export function imageSelected(editor: Editor | null): boolean {
  if (!editor) return false;
  const { selection } = editor.state;
  if (!isNodeSelection(selection)) return false;
  return selection.node.type.name === 'image' || selection.node.type.name === 'inlineImage';
}

function isNodeSelection(selection: unknown): selection is NodeSelection {
  return (
    typeof selection === 'object' &&
    selection !== null &&
    'node' in selection &&
    (selection as { node?: unknown }).node != null
  );
}

/**
 * The built-in selection producers, mounted once by the Ribbon. Each
 * reports its context's selection kind from PM state (via useEditorState,
 * the app's reactive selection read — never a separate subscription
 * model).
 */
export function useSelectionContexts(editor: Editor | null) {
  const inTable = useEditorState({
    editor,
    selector: ({ editor: e }) => selectionInTable(e ?? null),
  });
  useRibbonContext('table', inTable ?? false);

  const imageActive = useEditorState({
    editor,
    selector: ({ editor: e }) => imageSelected(e ?? null),
  });
  useRibbonContext('image', imageActive ?? false);

  // M-HEADER-FOOTER: the headerFooter producer is a stub until the
  // headers/footers milestone wires `activeSurface` to it.
  useRibbonContext('headerFooter', false);
}