import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { useReferenceStore } from '@/lib/references/store';
import { navigateToReferenceTarget } from '@/lib/references/navigate';
import { entriesForKind, refIdOf, scanCollections, type ReferenceKind } from '@/lib/references/scan';

/**
 * The reference-table node view: NodeViewContent renders the generator's
 * rows as real, natively selectable content. The gray border is
 * selection-driven — only while IN the table; transparent at rest, no
 * layout shift. Ctrl/Cmd+click navigates the row's target; plain clicks
 * are native text. Store version bumps re-render; content is PM-synced.
 */
export function ReferenceTableNodeView({ node, editor, selected, getPos }: ReactNodeViewProps) {
  useReferenceStore((s) => s.version);
  const { kind, depth } = node.attrs as { kind: ReferenceKind; depth: number };
  const entries = entriesForKind(scanCollections(editor.state.doc), kind, depth);
  // The border shows on NodeSelection on the block, or a caret strictly inside its content.
  const bordered = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const selNode = (e.state.selection as unknown as { node?: { type?: { name?: string } } }).node;
      if (selNode?.type?.name === 'referenceTable') return true;
      const at = typeof getPos === 'function' ? getPos() : undefined;
      if (typeof at !== 'number') return false;
      const self = e.state.doc.nodeAt(at);
      if (!self) return false;
      const end = at + self.nodeSize;
      const { from, to } = e.state.selection;
      return from > at && to < end;
    },
  });

  /** Ctrl/Cmd+click → navigate the clicked row's target (the refId is
   *  the scan join key); plain clicks fall through to native text. */
  function onClick(event: React.MouseEvent) {
    if (!(event.ctrlKey || event.metaKey)) return;
    const target = (() => {
      try {
        const dom = event.target as Node;
        const pos = editor.view.posAtDOM(dom, 0);
        const $pos = editor.state.doc.resolve(pos);
        for (let d = $pos.depth; d >= 1; d--) {
          const ancestor = $pos.node(d);
          if (ancestor.type.name !== 'paragraph') continue;
          const refId = typeof ancestor.attrs.refId === 'string' ? ancestor.attrs.refId : null;
          if (!refId) return null; // the placeholder — never navigable
          const row = entries.find((e) => refIdOf(e, kind) === refId);
          return row?.targets[0] ?? null;
        }
        return null;
      } catch {
        return null; // a click in the frame chrome — no row
      }
    })();
    if (target) {
      event.preventDefault();
      event.stopPropagation();
      navigateToReferenceTarget(editor, target.pos);
    }
  }

  return (
    <NodeViewWrapper
      data-tensor-ref-table-view="true"
      data-kind={kind}
      data-bordered={bordered ? 'true' : 'false'}
      // Selection-driven field border: gray only while IN the table;
      // transparent at rest (no layout shift).
      className={`tensor-ref-table not-prose my-2 rounded-md border px-3 py-2 ${
        bordered ? 'border-border/70' : 'border-transparent'
      } ${selected ? 'ring-2 ring-primary/40' : ''}`}
      onClick={onClick}
    >
      {/* The rows are real PM-synced content — plain, natively selectable body text (the dots included). */}
      <NodeViewContent className="tensor-ref-table-entries" />
    </NodeViewWrapper>
  );
}
