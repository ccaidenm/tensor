import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { useReferenceStore } from '@/lib/references/store';
import { navigateToReferenceTarget } from '@/lib/references/navigate';
import { REFERENCE_KINDS, entriesForKind, scanCollections } from '@/lib/references/scan';
import type { ReferenceKind } from '@/lib/references/scan';

/**
 * M-REFS — the reference-table node view: the visible rendering in
 * PAGELESS mode, and the accessibility mirror in paginated (renders
 * invisibly inside the hidden input view — the M5 law: the clickable
 * list lands in the a11y tree exactly like an <img alt>).
 *
 * THE CLICK RULING (Word-style, locked with the user): a PLAIN mouse
 * click on an entry selects the BLOCK (NodeSelection — deletable, one
 * Delete away); Ctrl/Cmd+click NAVIGATES to the entry's target. The
 * ONE keyboard carve-out (the accessibility gate): a focused entry's
 * Enter/Space NAVIGATES — a keyboard user focusing an entry wants to
 * GO, and block selection is already reachable via the editor's own
 * node-selection paths. Location ordinals (index terms with multiple
 * occurrences) ALWAYS navigate — that is their only purpose. Pageless
 * shows NO page numbers (no pages exist — Word's web-view convention;
 * the paginated engine arm right-aligns numbers at the shared text
 * edge).
 *
 * AUTO-UPDATE: entries are recomputed from the LIVE doc at render time
 * (the memoized scan — cheap), and the reference store's version
 * (debounced post-transaction bump) re-renders this view when the
 * document changes. Nothing is stored on the node — the empty state
 * is the document's truth, never a lie.
 */
export function ReferenceTableNodeView({ node, editor, selected, getPos }: ReactNodeViewProps) {
  useReferenceStore((s) => s.version);
  const { kind, depth } = node.attrs as { kind: ReferenceKind; depth: number };
  const meta = REFERENCE_KINDS[kind];
  const entries = entriesForKind(scanCollections(editor.state.doc), kind, depth);

  /** The ruling's mouse arm: plain click selects the block;
   * Ctrl/Cmd+click navigates. Keyboard activation is handled at
   * keydown (below) — a focused entry's Enter/Space navigates, and
   * preventDefault suppresses the button's synthetic click so the
   * action never fires twice. */
  function onTermClick(event: React.MouseEvent, pos: number): void {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      navigateToReferenceTarget(editor, pos);
      return;
    }
    const at = getPos();
    if (typeof at === 'number') {
      event.preventDefault();
      editor.commands.setNodeSelection(at);
    }
  }

  /** The ruling's keyboard arm (the accessibility gate): a keyboard
   * user focusing an entry wants to GO — Enter/Space navigates. Block
   * selection stays reachable via the editor's own node-selection
   * paths (arrow keys, Escape-then-Delete on the selected node). */
  function onTermKeyDown(event: React.KeyboardEvent, pos: number): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    navigateToReferenceTarget(editor, pos);
  }

  return (
    <NodeViewWrapper
      data-tensor-ref-table-view="true"
      data-kind={kind}
      data-count={entries.length}
      // The GDocs field affordance (the user's ask): a light gray
      // border always shows the block's extent; selection strengthens
      // it (ring) — the block reads as a unit at rest AND in hand.
      className={`tensor-ref-table not-prose my-2 select-none rounded-md border border-border/70 px-3 py-2 ${
        selected ? 'ring-2 ring-primary/40' : ''
      }`}
    >
      <div>
        {/* The block's own title — display-only ink, never content
            (the document's headings are the content; this label is how
            the block names itself, per the kind registry). */}
        <p className="mb-1 text-sm font-semibold text-muted-foreground" aria-hidden="true">
          {meta.title}
        </p>
        {entries.length === 0 ? (
          <p
            data-testid="reference-table-empty"
            className="py-2 text-sm italic text-muted-foreground/70"
          >
            {meta.emptyHint}
          </p>
        ) : (
          <ul className="m-0 list-none p-0" role="list" aria-label={meta.title}>
            {entries.map((entry, i) => (
              <li
                key={`${entry.text}-${i}`}
                role="listitem"
                aria-label={entry.text}
                className="text-sm"
              >
                {entry.targets.length === 1 ? (
                  <button
                    type="button"
                    data-testid={`reference-entry-${i}`}
                    className="block w-full cursor-pointer rounded-sm px-1 text-left hover:bg-accent/50 focus-visible:bg-accent focus-visible:outline-none"
                    style={{ paddingLeft: `${(entry.level - 1) * 16 + 4}px` }}
                    onClick={(e) => onTermClick(e, entry.targets[0]!.pos)}
                    onKeyDown={(e) => onTermKeyDown(e, entry.targets[0]!.pos)}
                    title={`${entry.text} — Ctrl+click to go`}
                  >
                    {entry.text}
                  </button>
                ) : (
                  // MULTI-LOCATION (index): the term names the row;
                  // EACH occurrence ordinal is its own navigation
                  // segment (the paginated page numbers' pageless
                  // twin — the acceptance criterion's "multiple
                  // locations", individually clickable).
                  <div
                    className="flex items-baseline gap-1 px-1"
                    style={{ paddingLeft: `${(entry.level - 1) * 16 + 4}px` }}
                  >
                    <span className="min-w-0 break-words">{entry.text}</span>
                    <span aria-hidden="true" className="text-muted-foreground/60">
                      ·
                    </span>
                    {entry.targets.map((target, j) => (
                      <button
                        key={j}
                        type="button"
                        data-testid={`reference-entry-${i}-${j}`}
                        className="cursor-pointer rounded-sm px-0.5 text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:bg-accent focus-visible:outline-none"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          navigateToReferenceTarget(editor, target.pos);
                        }}
                        aria-label={`${entry.text}, occurrence ${j + 1}`}
                        title={`${entry.text}, occurrence ${j + 1}`}
                      >
                        {j + 1}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </NodeViewWrapper>
  );
}
