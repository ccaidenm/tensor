import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state';
import type { Mark, Node as PMNode } from '@tiptap/pm/model';
import {
  REFERENCE_KINDS,
  entriesForKind,
  refIdOf,
  scanCollections,
  type CollectionScan,
  type ReferenceKind,
} from './scan';
// The leader adoption: the generator rewrites dots spans to the resolved
// count from the last layout so the entire leader is real, selectable text.
import { adoptedLeaderCount } from '@/lib/paginated/referenceLeaders';

/**
 * The generator: a reference table's entries are real paragraphs —
 * plain body text, natively selectable/formattable — kept in sync with
 * the live scan. Unchanged entries are never rewritten.
 */

const INDENT_STEP = 32; // levels step 32px, matching the list gutter

/**
 * The leader dots: a short dots run after each entry's text — real,
 * selectable text. The paginated engine stretches it to fill the
 * measured gap at the run's own style; pageless shows the seed as-is.
 */
const DOT_SEED = 12;

interface CurrentEntry {
  refId: string | null;
  /** The row's lineHeight attr — the gate compares it so pre-spacing
   *  rows reconvert on first touch. */
  lineHeight: string;
  /** The row's entry text — the leader-dots span (refLeader-marked) is
   *  excluded: the dots are generator-owned ink, not entry content
   *  (their text never participates in the structural compare). */
  text: string;
  /** The written indentLeft attr — compared directly in the gate,
   *  never re-derived into a "level": a derive-then-write round trip
   *  with different conventions loops the generator forever. */
  indentLeft: number;
  /** The row's leader-dots span length (0 = no span). The adoption
   *  rewrites it to the resolved count — the entire leader becomes
   *  real, selectable text. */
  leaderLen: number;
  node: PMNode;
}

function refKindOf(node: PMNode): ReferenceKind {
  return node.attrs.kind === 'figures' || node.attrs.kind === 'index' ? node.attrs.kind : 'toc';
}

/** The container's children as reconciliation facts (paragraphs only —
 * the generator owns the container's paragraph children; anything else
 * a future version embeds is left alone). */
function currentEntries(node: PMNode): CurrentEntry[] {
  const out: CurrentEntry[] = [];
  node.forEach((child) => {
    if (child.type.name !== 'paragraph') return;
    // Entry text = the child's text excluding the refLeader-marked dots
    // span; leaderLen = the span's current length.
    let text = '';
    let leaderLen = 0;
    child.forEach((inline) => {
      if (!inline.isText) return;
      if (inline.marks.some((m) => m.type.name === 'refLeader')) {
        leaderLen += inline.text?.length ?? 0;
        return;
      }
      text += inline.text ?? '';
    });
    out.push({
      refId: typeof child.attrs.refId === 'string' && child.attrs.refId ? child.attrs.refId : null,
      text,
      indentLeft: Math.max(0, typeof child.attrs.indentLeft === 'number' ? child.attrs.indentLeft : 0),
      lineHeight: typeof child.attrs.lineHeight === 'string' ? child.attrs.lineHeight : '',
      leaderLen,
      node: child,
    });
  });
  return out;
}

/**
 * Structural equality — the no-op gate: an unchanged table writes
 * nothing. The compare uses the written attr (indentLeft) on both
 * sides; the empty collection is never equal (caller's placeholder).
 */
function structurallyEqual(
  current: CurrentEntry[],
  desired: ReturnType<typeof entriesForKind>,
  kind: ReferenceKind,
  wantLeaders: boolean,
  blockId: string,
): boolean {
  if (desired.length === 0) return false; // the placeholder branch owns this case
  if (current.length !== desired.length) return false;
  for (let i = 0; i < current.length; i++) {
    const c = current[i]!;
    const d = desired[i]!;
    if (c.refId !== refIdOf(d, kind)) return false;
    if (c.text !== d.text) return false;
    if (c.indentLeft !== Math.max(0, (d.level - 1) * INDENT_STEP)) return false;
    // The leader: presence per the toggle, length per the adoption (a
    // stale seed length ≠ the resolved count → rebuild).
    if (wantLeaders) {
      const adopted = adoptedLeaderCount(blockId, i);
      if (adopted != null ? c.leaderLen !== adopted : c.leaderLen === 0) return false;
    } else if (c.leaderLen !== 0) {
      return false;
    }
    if (c.lineHeight !== '1.5') return false;
  }
  return true;
}

/** Reconcile one container into `tr` (positions valid on tr.doc's
 * pre-replace state — callers go reverse doc order). `forced` bypasses
 * the gate but still reuses untouched entries verbatim. */
function reconcileContainer(
  tr: Transaction,
  node: PMNode,
  pos: number,
  scan: CollectionScan,
  forced = false,
): boolean {
  const kind = refKindOf(node);
  const depth = typeof node.attrs.depth === 'number' ? node.attrs.depth : 3;
  const desired = entriesForKind(scan, kind, depth);
  const current = currentEntries(node);
  // The container's stable id — the adoption's key (resolved dot counts
  // are per container).
  const blockId = String(node.attrs.blockId ?? '');
  // The leaders toggle: rows carry the dots span iff on. The dots'
  // marks stay user-owned once written; their length is the adoption's
  // (the resolved count).
  const wantLeaders = node.attrs.leaders !== false;

  // Structural equality → no-op. The empty collection's desired shape
  // is its one placeholder row (a null-key child carrying the hint
  // text) — equal only in that exact shape.
  if (
    !forced &&
    (structurallyEqual(current, desired, kind, wantLeaders, blockId) ||
      (desired.length === 0 &&
        current.length === 1 &&
        current[0]!.refId === null &&
        current[0]!.text === REFERENCE_KINDS[kind].emptyHint &&
        current[0]!.leaderLen === 0))
  ) {
    return false;
  }

  const schema = tr.doc.type.schema;
  const paragraph = schema.nodes.paragraph;
  const children: PMNode[] = [];
  // Whether this pass actually rebuilds/creates/removes anything —
  // a forced in-sync pass reuses every child and writes nothing.
  let changed = current.length !== desired.length;

  if (desired.length === 0) {
    // The placeholder: one real paragraph, italic-marked (visible in
    // both modes, honest to copy).
    changed = true;
    children.push(
      paragraph.create(
        { refId: null, styleId: 'normal' },
        schema.text(REFERENCE_KINDS[kind].emptyHint, [schema.marks.italic.create()])
      )
    );
  } else {
    for (let i = 0; i < desired.length; i++) {
      const entry = desired[i]!;
      const key = refIdOf(entry, kind);
      const prior = current.find((c) => c.refId === key);
      // Reuse is order-stable: the desired entry at index i must map to
      // the current child at the same index (a reorder reuses all
      // nodes but must still rewrite the sequence).
      if (prior !== current[i]) changed = true;
      const indentLeft = Math.max(0, (entry.level - 1) * INDENT_STEP);
      const attrs = {
        refId: key,
        styleId: 'normal',
        indentLeft,
        // 1.5 leading on every row — the standard ToC look, one fact in
        // both modes (the engine's lineHeight runs through the resolved
        // style; pageless renders it as CSS line-height).
        lineHeight: '1.5',
      };
      // Leader dots carry the prior row's marks (the stretch responds
      // to them); every row carries the link mark `tensor-ref:<blockId>`
      // (internal scheme, never a URL; the first location's blockId).
      const targetBlockId = entry.targets[0]?.blockId ?? '';
      const linkMark = targetBlockId
        ? [schema.marks.link.create({ href: `tensor-ref:${targetBlockId}` })]
        : [];
      const leaderMarksOf = (prior: CurrentEntry | undefined): readonly Mark[] | undefined => {
        if (!prior || !wantLeaders) return undefined;
        let marks: readonly Mark[] | undefined;
        prior.node.forEach((inline) => {
          if (!inline.isText) return;
          if (inline.marks.some((m) => m.type.name === 'refLeader')) marks = inline.marks;
        });
        return marks;
      };
      // The resolved dot count for this row — undefined when no
      // measurement exists (pageless/pre-layout): keep the row's own
      // current length; a new row seeds at DOT_SEED.
      const wantDots = (i: number, prior: CurrentEntry | undefined): number => {
        if (!wantLeaders) return 0;
        const adopted = adoptedLeaderCount(blockId, i);
        if (adopted != null) return adopted;
        // No measurement: keep a positive span (never adopt blind), but
        // a zero-length span re-seeds — the toggle turning on wants dots.
        return prior && prior.leaderLen > 0 ? prior.leaderLen : DOT_SEED;
      };
      const dotsSpan = (prior: CurrentEntry | undefined, count: number) => {
        if (!wantLeaders || count <= 0) return [];
        const marks = leaderMarksOf(prior);
        return [
          schema.text('.'.repeat(count), [
            schema.marks.refLeader.create(),
            ...linkMark,
            ...(marks?.filter((m) => m.type.name !== 'refLeader' && m.type.name !== 'link') ?? []),
          ]),
        ];
      };
      const want = wantDots(i, prior);
      if (
        prior &&
        prior.text === entry.text &&
        prior.indentLeft === indentLeft &&
        prior.leaderLen === want &&
        prior.lineHeight === '1.5'
      ) {
        // Untouched — reuse verbatim (marks preserved). lineHeight and
        // leader length are part of the touch test: pre-spacing rows and
        // stale seed lengths rebuild once.
        children.push(prior.node);
      } else if (prior) {
        changed = true;
        // Changed entry: rebuild. Same key ⇒ the old entry's first-run
        // marks carry to the new text (replacement has no range mapping);
        // the dots span carries its own marks (the leader stays formatted).
        let marks = undefined;
        const firstText = prior.node.childCount > 0 ? prior.node.child(0) : null;
        if (firstText?.isText) marks = firstText.marks;
        // The carried marks LOSE the stale link (the old target) — the
        // fresh link mark (the new target) replaces it below.
        const carried = marks?.filter((m) => m.type.name !== 'link') ?? undefined;
        // Empty text (a heading backspaced bare): schema.text('') throws;
        // an empty entry is an empty paragraph (a blank row — Word keeps
        // empty headings in its ToC).
        children.push(
          entry.text
            ? paragraph.create(attrs, [
                schema.text(entry.text, [...(carried ?? []), ...linkMark]),
                ...dotsSpan(prior, want),
              ])
            : paragraph.create(attrs, dotsSpan(prior, want))
        );
      } else {
        changed = true; // a NEW entry
        children.push(
          entry.text
            ? paragraph.create(attrs, [
                schema.text(entry.text, linkMark),
                ...dotsSpan(prior, want),
              ])
            : paragraph.create(attrs, dotsSpan(prior, want))
        );
      }
    }
  }
  if (!changed) return false;

  // Replace the container's whole content range [pos+1, pos+size−1).
  tr.replaceWith(pos + 1, pos + node.nodeSize - 1, children);
  return true;
}

/** Is the selection inside the referenceTable at [pos, pos+size)? */
function selectionInside(tr: Transaction, pos: number, size: number): boolean {
  const { from, to } = tr.selection;
  return from > pos && to < pos + size;
}

/** Dead entries: rows whose refId no longer exists in the desired set.
 *  They reconcile even with the caret inside — a deferred dead row
 *  would linger as a ghost line swallowing the next keystroke. */
function hasDeadEntry(
  currentRows: CurrentEntry[],
  desired: ReturnType<typeof entriesForKind>,
  kind: ReferenceKind,
): boolean {
  if (desired.length === 0) return currentRows.some((c) => c.refId != null);
  const live = new Set(desired.map((d) => refIdOf(d, kind)));
  return currentRows.some((c) => c.refId != null && !live.has(c.refId));
}

export const ReferenceGeneratorExtension = Extension.create({
  name: 'referenceGenerator',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('referenceGenerator'),
        appendTransaction: (transactions, _oldState, newState) => {
          const containers: Array<{ node: PMNode; pos: number }> = [];
          newState.doc.descendants((node, pos) => {
            if (node.type.name !== 'referenceTable') return;
            containers.push({ node, pos });
          });
          if (containers.length === 0) return null;

          // The doc changed, the selection moved (deferred containers
          // reconcile when the caret leaves), or the user hit refresh —
          // the structural gate makes the no-change pass cost ~nothing.
          const docChanged = transactions.some((t) => t.docChanged);
          const selectionMoved = transactions.some((t) => t.selectionSet);
          const forced = transactions.some((t) => t.getMeta('refRefresh') === true);
          if (!docChanged && !selectionMoved && !forced) return null;

          const scan = scanCollections(newState.doc);
          const tr = newState.tr;
          let wrote = false;
          // Debug seam (both view modes): set
          // window.__tensorPaintDebug = { log: [] } to log generator
          // decisions alongside BlockCanvas paint entries.
          const dbg = (globalThis as { __tensorPaintDebug?: { log: unknown[] } }).__tensorPaintDebug;
          // Reverse document order — a replace never invalidates an
          // earlier container's positions.
          for (let i = containers.length - 1; i >= 0; i--) {
            const { node, pos } = containers[i]!;
            // Defer while inside (never rebuild under the user's
            // caret); dead entries break the deferral — the stale row
            // must go even with the caret inside it.
            const kind = refKindOf(node);
            const depth = typeof node.attrs.depth === 'number' ? node.attrs.depth : 3;
            const desired = entriesForKind(scan, kind, depth);
            const rows = currentEntries(node);
            const dead = hasDeadEntry(rows, desired, kind);
            const inside = selectionInside(tr, pos, node.nodeSize);
            if (dbg) {
              dbg.log.push({
                gen: String(node.attrs?.blockId ?? pos),
                kind,
                inside,
                dead,
                forced,
                rowsN: rows.length,
                desiredN: desired.length,
              });
            }
            // Forced (the Refresh button, the layout presets' attr
            // writes) bypasses the defer too: without this, attr toggles
            // silently no-op while the caret is inside.
            if (!dead && inside && !forced) continue;
            const wroteThis = reconcileContainer(tr, node, pos, scan, forced || dead);
            if (wroteThis) wrote = true;
            // A dead-row removal takes the caret's paragraph with it; PM
            // maps the selection to a boundary position the input path can
            // choke on — set the caret to the first row's text start.
            if (wroteThis && inside) {
              try {
                tr.setSelection(TextSelection.create(tr.doc, pos + 2));
              } catch {
                // A defensive guard — if even this position is somehow
                // invalid, leave PM's mapped selection in place rather
                // than crash the reconcile.
              }
            }
          }
          if (!wrote) return null;
          // Regeneration is a derived write: undo steps never replay it;
          // PM's history rebases over it and the next pass re-syncs.
          tr.setMeta('addToHistory', false);
          return tr;
        },
      }),
    ];
  },
});
