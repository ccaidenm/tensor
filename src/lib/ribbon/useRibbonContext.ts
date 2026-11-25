import { useEffect } from 'react';
import type { Editor } from '@tiptap/core';
import type { NodeSelection } from '@tiptap/pm/state';
import { useEditorState } from '@tiptap/react';
import { useRibbonContextStore } from './contextStore';
import type { RibbonContextId } from './contextualTabs';
import { selectionInBand } from '@/lib/editor/headerFooterCommands';

/**
 * The context producer binding: `useRibbonContext(id, isActive)` enters
 * when the signal turns true, exits when false — safe because the
 * store's enter is idempotent/first-come-wins and exit is id-scoped.
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

/** True while the selection has a `table` ancestor (or a NodeSelection
 *  on a table). */
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

/** True while the selection sits inside a referenceTable container (or
 *  a NodeSelection on one). */
export function selectionInReferenceTable(editor: Editor | null): boolean {
  if (!editor) return false;
  const { selection } = editor.state;
  if (isNodeSelection(selection) && selection.node.type.name === 'referenceTable') return true;
  const { $from } = selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'referenceTable') return true;
  }
  return false;
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
 * reports its context's selection kind from PM state via useEditorState
 * (the app's one reactive selection read).
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

  // The headerFooter producer — a band container in the selection's
  // ancestry enters the Header & Footer context; leaving it exits.
  const inBand = useEditorState({
    editor,
    selector: ({ editor: e }) => selectionInBand(e ?? null),
  });
  useRibbonContext('headerFooter', inBand ?? false);

  // The referenceTable producer — inside a collection (or a
  // NodeSelection on one) enters the Reference Table context.
  const inRefTable = useEditorState({
    editor,
    selector: ({ editor: e }) => selectionInReferenceTable(e ?? null),
  });
  useRibbonContext('referenceTable', inRefTable ?? false);
}