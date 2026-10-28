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
// M-REFS-10: the leader ADOPTION — the resolved dot counts from the
// last layout (the two-pass lag precedent); the generator rewrites
// the spans to the full visible count so the entire leader is real,
// selectable text.
import { adoptedLeaderCount } from '@/lib/paginated/referenceLeaders';

/**
 * M-REFS — THE GENERATOR (the container model's engine): a reference
 * table's entries are REAL paragraphs — plain body text, natively
 * selectable/formattable (the GDocs ruling) — and this plugin keeps
 * them in sync with the live scan. It runs in appendTransaction
 * (before paint, same tick), reconciling CHILDREN against the scan:
 *
 *  - KEYED BY refId (the target's stable blockId; the term for
 *    index): an entry whose key is unchanged is NEVER rewritten —
 *    the user's bold/color/edits on it SURVIVE every refresh. Only
 *    genuinely changed entries get rebuilt (new text carries the old
 *    entry's first-run marks, the closest honest carry).
 *  - REFRESH-WINS (the field law): entry TEXT is owned by the
 *    document — when a heading retitles, its entry's text follows.
 *  - DEFER-WHILE-INSIDE: reconciliation of a container the selection
 *    sits INSIDE is deferred (the user is editing entries; a rebuild
 *    under the caret would fight them). The deferred pass runs on the
 *    next transaction after the selection leaves.
 *  - UNDO-CLEAN: regeneration writes with addToHistory:false — undo
 *    steps never replay regenerations; PM's history rebases over
 *    them, and the next pass re-syncs entries after any undo.
 *
 * Positions: containers reconcile in REVERSE document order (later
 * containers first — a replace never invalidates an earlier one).
 */

const INDENT_STEP = 32; // the list gutter precedent — levels step 32px

/**
 * M-REFS — THE LEADER DOTS: the generator writes a short dots run
 * ('.' × DOT_SEED) after each entry's text — REAL TEXT (the user's
 * ruling: selectable, formattable, normal ink). The paginated ENGINE
 * stretches the painted dots to fill the measured gap at the run's
 * OWN style (smaller font ⇒ more dots — the run responds to its
 * formatting); pageless shows the seeded dots as ordinary text (no
 * page numbers exist there, so there is no gap to fill).
 */
const DOT_SEED = 12;

interface CurrentEntry {
  refId: string | null;
  /** The row's lineHeight attr (the round-7 spacing) — the gate
   *  compares it so pre-spacing rows reconvert on first touch. */
  lineHeight: string;
  /** The row's ENTRY text — the leader-dots span (refLeader-marked) is
   *  EXCLUDED: the dots are generator-owned ink, not entry content
   *  (their text never participates in the structural compare). */
  text: string;
  /** The WRITTEN indentLeft attr — compared DIRECTLY in the structural
   *  gate (never re-derived into a "level": a derive-then-write round
   *  trip with different conventions loops the generator forever —
   *  the app-freeze bug, pinned by the app-flow tests). */
  indentLeft: number;
  /** The row's leader-dots SPAN length (the refLeader-marked text;
   *  0 = no span). The ADOPTION rewrites it to the resolved count —
   *  the entire leader becomes real, selectable text (M-REFS-10). */
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
    // Entry text = the child's text EXCLUDING the refLeader-marked
    // dots span (generator-owned ink the ADOPTION owns the length of);
    // leaderLen = the span's current length.
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

/** Structural equality — the NO-OP gate (the formatting-survival law:
 * an unchanged table writes NOTHING, so user formatting lives on).
 * LOOP-PROOF BY CONSTRUCTION: the compare uses the WRITTEN attr
 * (indentLeft) on both sides — never a re-derived level. The EMPTY
 * collection is NEVER "equal" to a childless container here: its
 * desired shape is the ONE placeholder paragraph (checked by the
 * caller) — a 0===0 equality would starve it of its placeholder. */
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
    // THE LEADER (M-REFS-10): presence per the toggle + LENGTH per the
    // adoption (a stale seed length ≠ the resolved count → rebuild —
    // the entire leader becomes real text at the resolved count).
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

/** Reconcile ONE container into `tr` (positions valid on tr.doc's
 * pre-replace state — callers go reverse doc order). `forced` (the
 * Refresh button) bypasses the structural gate — untouched entries
 * are still reused verbatim, so a refresh reverts stale TEXT but
 * keeps matching formatting (refresh-wins, the field law). Returns
 * whether anything was written. */
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
  // The container's STABLE ID — the adoption's key (the resolved dot
  // counts are per container, M-REFS-10).
  const blockId = String(node.attrs.blockId ?? '');
  // THE LEADERS TOGGLE (the node's attr): rows carry the dots span iff
  // on. The dots' MARKS stay user-owned once written (rebuilds carry
  // the prior row's leader marks — same carry as the entry text);
  // their LENGTH is the ADOPTION's to own (the resolved count — the
  // entire leader becomes real, selectable text).
  const wantLeaders = node.attrs.leaders !== false;

  // Structural equality → NO-OP. The empty collection's desired shape
  // is its ONE placeholder ROW (a null-key child carrying the hint
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
  // Whether THIS pass actually rebuilds/creates/removes anything —
  // a forced in-sync pass reuses every child and writes NOTHING.
  let changed = current.length !== desired.length;

  if (desired.length === 0) {
    // The placeholder: ONE real paragraph, italic-marked (real
    // formatting — visible in both modes, honest to copy).
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
      // ORDER: reuse is order-stable — the desired entry at index i
      // must map to the CURRENT child at the SAME index (a reorder
      // reuses all nodes but must still rewrite the sequence).
      if (prior !== current[i]) changed = true;
      const indentLeft = Math.max(0, (entry.level - 1) * INDENT_STEP);
      const attrs = {
        refId: key,
        styleId: 'normal',
        indentLeft,
        // ROW SPACING (round 7 — the "not a full line per entry"
        // report): 1.5 leading on every row — the standard ToC look,
        // one fact in BOTH modes (the engine's lineHeight runs through
        // the resolved style; pageless renders it as CSS line-height).
        lineHeight: '1.5',
      };
      // THE LEADER DOTS' carry: the prior row's refLeader span keeps
      // the USER's marks on it (size/bold/color — the stretch responds
      // to them); absent rows seed the dots unmarked (normal ink).
      // THE SEMANTIC LINK (M-REFS-11 — the user's ruling: the TOC is
      // ALWAYS a hyperlink, invisible in the editor, Ctrl+click to
      // follow, and the data rides to PDF/DOCX export): every row's
      // runs carry the app's link mark with the INTERNAL scheme
      // `tensor-ref:<targetBlockId>` — never a URL; the bubble's
      // editor refuses it, the adapters recognize it quietly, and the
      // future exporters map it to a real anchor. The target is the
      // entry's FIRST location's stable blockId (index rows: the term
      // has multiple locations — the first is the sane default).
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
      // THE ADOPTED COUNT (M-REFS-10): the resolved dot count for this
      // row — undefined when no measurement exists (pageless, pre-
      // layout, no number) → keep the row's own current length (never
      // adopt blind); a NEW row seeds at DOT_SEED and the next layout
      // adopts the full count.
      const wantDots = (i: number, prior: CurrentEntry | undefined): number => {
        if (!wantLeaders) return 0;
        const adopted = adoptedLeaderCount(blockId, i);
        if (adopted != null) return adopted;
        // No measurement (pageless / pre-layout): KEEP a positive span
        // (never adopt blind), but a ZERO-length span RE-SEEDS — the
        // leaders toggle turning ON wants dots, and the next layout
        // adopts the resolved count.
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
        // UNTOUCHED — reuse the node verbatim (marks preserved). The
        // lineHeight and the leader LENGTH are part of the touch
        // test: pre-spacing rows rebuild once to gain the 1.5
        // leading; a stale seed length rebuilds to the ADOPTED count
        // (the entire leader becomes real text — M-REFS-10).
        children.push(prior.node);
      } else if (prior) {
        changed = true;
        // Changed entry: rebuild. Same key ⇒ the old entry's first-run
        // marks carry to the new text (the closest honest carry —
        // wholesale text replacement has no range mapping); the dots
        // span carries ITS OWN marks (the leader stays formatted).
        let marks = undefined;
        const firstText = prior.node.childCount > 0 ? prior.node.child(0) : null;
        if (firstText?.isText) marks = firstText.marks;
        // The carried marks LOSE the stale link (the old target) — the
        // fresh link mark (the new target) replaces it below.
        const carried = marks?.filter((m) => m.type.name !== 'link') ?? undefined;
        // EMPTY TEXT (a heading backspaced bare — the ghost bug):
        // schema.text('') THROWS; an empty entry is an EMPTY
        // PARAGRAPH (legal, renders as a blank row — Word keeps empty
        // headings in its ToC).
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

/** DEAD entries: current ROWS (title excluded) whose refId no longer
 *  exists in the desired set (their source heading/caption/term is
 *  GONE). Dead rows reconcile EVEN WHILE THE CARET SITS INSIDE — the
 *  defer rule protects the user's LIVE editing, never a stale row:
 *  backspacing a heading bare merges the caret into its entry, and a
 *  deferred dead row would linger as a ghost line that swallows the
 *  next keystroke (the reported bug, pinned by the join test). */
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

          // The doc changed, OR the selection moved (the deferred
          // containers reconcile when the caret leaves them), OR the
          // user hit REFRESH (the contextual tab's button — the
          // GDocs-style belt-and-braces affordance over the same-tick
          // auto-update): the structural gate makes the no-change pass
          // cost ~nothing.
          const docChanged = transactions.some((t) => t.docChanged);
          const selectionMoved = transactions.some((t) => t.selectionSet);
          const forced = transactions.some((t) => t.getMeta('refRefresh') === true);
          if (!docChanged && !selectionMoved && !forced) return null;

          const scan = scanCollections(newState.doc);
          const tr = newState.tr;
          let wrote = false;
          // M-REFS — THE GHOST DEBUG SEAM (fires in BOTH view modes,
          // unlike the canvas-only seam): set
          // window.__tensorPaintDebug = { log: [] } and reproduce —
          // generator decisions land alongside any BlockCanvas
          // entries; an EMPTY canvas section with generator activity
          // proves the stale ink lives in the pageless DOM, not the
          // canvas.
          const dbg = (globalThis as { __tensorPaintDebug?: { log: unknown[] } }).__tensorPaintDebug;
          // REVERSE document order — a replace never invalidates an
          // earlier container's positions.
          for (let i = containers.length - 1; i >= 0; i--) {
            const { node, pos } = containers[i]!;
            // DEFER-WHILE-INSIDE — the LIVE-edit protection: the user
            // is editing this table's entries, never rebuild under
            // their caret. DEAD entries break the deferral (a source
            // heading vanished — the stale row must go even with the
            // caret inside it, or it ghosts on: hasDeadEntry).
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
            // FORCED (the Refresh button, the layout presets' attr
            // writes) bypasses the defer too: explicit user intent —
            // the refresh-wins semantics apply under the caret (the
            // in-progress row edit reverts, GDocs' update-button
            // behavior). Without this, attr toggles silently no-op
            // while the caret is inside — the user's dead-Leaders-
            // button report (the number vanished because it is
            // ADAPTER-side; the dots stayed because they are
            // GENERATOR-side and deferred).
            if (!dead && inside && !forced) continue;
            const wroteThis = reconcileContainer(tr, node, pos, scan, forced || dead);
            if (wroteThis) wrote = true;
            // THE POST-JOIN SELECTION HARDENING (round 7 — the crash
            // at the join point): a DEAD-row removal takes the
            // paragraph HOLDING THE CARET with it; PM maps the
            // selection to the replacement's edge — a boundary
            // position the REAL input path can choke on (typing the
            // first character after backspacing a header bare — the
            // reported app crash). Set the caret EXPLICITLY to the
            // container's first row's text start (reconcileContainer
            // always writes ≥ 1 child): a known-good text target.
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
          // UNDO-CLEAN: regeneration is a derived write — undo steps
          // never replay it; PM's history rebases over it and the
          // next pass re-syncs after any undo.
          tr.setMeta('addToHistory', false);
          return tr;
        },
      }),
    ];
  },
});
