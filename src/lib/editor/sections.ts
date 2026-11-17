import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { useDocumentStore } from '@/lib/document/store';
import { pushPageSetupUndo, PAGE_SETUP_MARKER } from '@/lib/editor/pageSetupHistory';
import type { PageSetup, PageStyles } from '@/lib/document/pageSetup';

/**
 * #58 SECTIONS — the section RESOLUTION helpers (the dialog's and the
 * surfaces' shared facts). ONE derivation of "which section is the
 * caret in" and "which target owns a section's props" — never a
 * second count (the one-derivation law; the adapter and the engine
 * resolve their own views of the same breaks).
 *
 * THE SPELLING (Word's): sectionBreak node ordinal k carries section
 * k's props (the PRECEDING section — everything above it); the
 * store's pageSetup IS the final section's. Section index i:
 *   i < breaks → props live on break node i's attrs.setup
 *   i === breaks (the final) → props live in the store
 */

export interface SectionFacts {
  /** Total sections (breaks + 1). */
  total: number;
  /** The section index (0-based; 0 in a uniform doc). */
  index: number;
  /**
   * The break node POSITION carrying this section's props — null for
   * the FINAL section (the store owns it).
   */
  breakPos: number | null;
  /**
   * #58 — the break whose `type` governs how this section STARTS (the
   * boundary AT the section's begin = the break BEFORE it — a section
   * k's start type lives on break k−1). null for section 0 (the doc
   * start — not editable) and for a uniform doc.
   */
  startBreakPos: number | null;
  /** The section's EFFECTIVE setup (the break's attrs, else the store's). */
  setup: PageSetup;
}

/** The top-level sectionBreak ordinal/position list (one walk). */
function breakOrdinalList(doc: PMNode): { pos: number; before: number }[] {
  const out: { pos: number; before: number }[] = [];
  doc.forEach((node, offset) => {
    if (node.type.name === 'sectionBreak') out.push({ pos: offset, before: out.length });
  });
  return out;
}

/** The caret's section facts (the dialog's open target). A caret
 *  inside any depth (band container, table cell) resolves through its
 *  top-level block — before(1) is the doc child's start either way. A
 *  NodeSelection ON a break resolves to THAT break's section. */
export function sectionAtCaret(editor: Editor | null, storeSetup: PageSetup): SectionFacts {
  if (!editor) return { total: 1, index: 0, breakPos: null, startBreakPos: null, setup: storeSetup };
  const { selection, doc } = editor.state;
  const caretBlockStart = selection.$from.before(1);
  const breaks = breakOrdinalList(doc);
  const total = breaks.length + 1;
  // The caret's section = the breaks strictly before its block (a
  // break at exactly caretBlockStart sits AT the caret's block start —
  // the NodeSelection case resolves to it as the section's props
  // holder, and the section index is its ordinal).
  const index = breaks.filter((b) => b.pos < caretBlockStart).length;
  // The START boundary: break index−1 (the break the section begins
  // after). Section 0 starts at the doc start — not editable.
  const startBreakPos = index > 0 ? breaks[index - 1]!.pos : null;
  if (index >= breaks.length) {
    // The FINAL section: the store owns the props.
    return { total, index, breakPos: null, startBreakPos, setup: storeSetup };
  }
  const target = breaks[index]!;
  const node = doc.nodeAt(target.pos);
  return {
    total,
    index,
    breakPos: target.pos,
    startBreakPos,
    setup: (node?.attrs.setup as PageSetup | null) ?? storeSetup,
  };
}

/** The section facts for an EXPLICIT break position (a marker-driven
 *  open): that break's ordinal is the section index. */
export function sectionAtBreak(editor: Editor | null, pos: number, storeSetup: PageSetup): SectionFacts {
  if (!editor) return { total: 1, index: 0, breakPos: null, startBreakPos: null, setup: storeSetup };
  const breaks = breakOrdinalList(editor.state.doc);
  const ordinal = breaks.findIndex((b) => b.pos === pos);
  if (ordinal < 0) return sectionAtCaret(editor, storeSetup);
  const node = editor.state.doc.nodeAt(pos);
  return {
    total: breaks.length + 1,
    index: ordinal,
    breakPos: pos,
    startBreakPos: ordinal > 0 ? breaks[ordinal - 1]!.pos : null,
    setup: (node?.attrs.setup as PageSetup | null) ?? storeSetup,
  };
}

/** The section FOLLOWING the caret's (the "this point forward"
 *  target): its props holder (the next break's attrs, or the store)
 *  and its effective setup. */
export function sectionAfterCaret(editor: Editor | null, storeSetup: PageSetup): SectionFacts {
  if (!editor) return { total: 1, index: 0, breakPos: null, startBreakPos: null, setup: storeSetup };
  const facts = sectionAtCaret(editor, storeSetup);
  const breaks = breakOrdinalList(editor.state.doc);
  const nextOrdinal = facts.index + 1;
  if (nextOrdinal >= breaks.length) {
    // The caret's section IS the last break-owned one — the following
    // section is the FINAL (the store owns it). Its start = the
    // caret's section's props break (the boundary between them).
    return {
      total: facts.total,
      index: nextOrdinal,
      breakPos: null,
      startBreakPos: facts.breakPos,
      setup: storeSetup,
    };
  }
  const target = breaks[nextOrdinal]!;
  const node = editor.state.doc.nodeAt(target.pos);
  return {
    total: facts.total,
    index: nextOrdinal,
    breakPos: target.pos,
    startBreakPos: facts.breakPos,
    setup: (node?.attrs.setup as PageSetup | null) ?? storeSetup,
  };
}

/**
 * #58 — the APPLY-to-SCOPES (the Page Setup dialog's and the ribbon's
 * ONE write surface; never a second path):
 *  - 'document': the PARTIAL merges into EVERY break's setup (one PM
 *    transaction) + the store — one commit, one reflow. Not added to
 *    the undo history: the store side isn't undoable either (the
 *    margins dialog's standing behavior) — an undo that restored the
 *    breaks but not the store would desync the two sources. (Also what
 *    the RULER's per-frame drag writes — no-history keeps drags out of
 *    the undo stack.)
 *  - 'section': the FULL setup writes the caret's section's props
 *    holder (setNodeMarkup on its break, or the store for the final).
 *  - 'sections': the FULL setup writes EACH chosen section's holder
 *    (`sectionSet` — the dialog's individual-section chooser); the
 *    final section's write merges into the store. One transaction for
 *    the break-owned targets + at most one store write.
 *  - 'forward': inserts a break at the caret (the split-dance, seeded
 *    with the caret's section's EFFECTIVE setup — the content above is
 *    untouched) then writes the FULL setup to the FOLLOWING section's
 *    holder (the next break's attrs, or the store). The inserted
 *    break's `type` = `startType` (how the new section starts). Word's
 *    "this point forward".
 *  - 'page' (#48): writes ONE PAGE STYLE (the positional map — a page
 *    owns DECOR, never geometry; the engine's law). `options.page`
 *    names the 0-based index and the background (null = CLEAR the
 *    entry, back to the section/doc chain). Store-only: the marker tr
 *    + co-undo carry it; one Ctrl+Z reverts it.
 *  - `startType`: when given, ALSO writes the section-start type (the
 *    target's startBreakPos attrs — the break BEFORE the section).
 */
export type PageSetupScope = 'document' | 'section' | 'sections' | 'forward' | 'page';

/** The break ordinals' positions (one walk). */
function breakPositions(editor: Editor): number[] {
  const out: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'sectionBreak') out.push(pos);
    return true;
  });
  return out;
}

export function applyPageSetup(
  scope: PageSetupScope,
  full: PageSetup,
  partial: Partial<PageSetup>,
  options?: {
    sectionSet?: number[];
    startType?: 'nextPage' | 'continuous';
    /** #48 — the 'page' scope's target: the 0-based page index + the
     * background (null = clear the entry). */
    page?: { index: number; background: string | null };
    /** #58 — the store write joins the co-undo (default true): the
     *  RULER's per-frame writes pass false and commit once at drag
     *  end (undoPrev carries the pre-drag setup). */
    pushUndo?: boolean;
    /** The undo entry's PREVIOUS setup (the drag's start state), when
     *  it differs from the store's current value. */
    undoPrev?: PageSetup;
    /** The PM tr's history join (default true; the ruler's frames
     *  pass false — the drag's end commit is the ONE item). */
    addToHistory?: boolean;
  },
): void {
  const store = useDocumentStore.getState();
  const editor = store.editor;
  const pushUndo = options?.pushUndo ?? true;
  const addToHistory = options?.addToHistory ?? true;
  // The PRE-write document (the co-undo's docBefore snapshot — captured
  // BEFORE any dispatch; the writeStore's docAfter reads the post-tr
  // state, which view.dispatch applies synchronously).
  const docBefore = editor?.state.doc ?? null;
  // Whether OUR marker already rode a dispatched tr (the mixed paths);
  // a STORE-ONLY write dispatches a marker-only empty tr so the
  // pending law sees it (the plugin applies to marker-only trs even
  // though history records nothing).
  let markerDispatched = false;
  /** The store write + its co-undo push (AFTER the PM tr dispatches —
   *  the snapshot carries the post-write document; the pageSetupHistory
   *  module's law: one Ctrl+Z reverts the PM part and the store part
   *  together, never half). */
  const writeStore = (next: PageSetup): void => {
    if (pushUndo) {
      if (editor && !markerDispatched) {
        const tr = editor.state.tr;
        tr.setMeta(PAGE_SETUP_MARKER, true);
      markerDispatched = true;
        editor.view.dispatch(tr);
      }
      pushPageSetupUndo(options?.undoPrev ?? store.pageSetup, editor?.state.doc ?? null, docBefore);
    }
    store.setPageSetup(next);
  };
  if (scope === 'page') {
    // #48 — ONE PAGE STYLE (the positional map). Geometry is never
    // page-owned (the engine's law); the dialog disables everything
    // but the background under this scope. Store-only write: the
    // marker-only tr + the co-undo entry carry it (one Ctrl+Z), the
    // same writeStore law — mirrored inline because the payload is
    // the pageStyles map, not the setup.
    const target = options?.page;
    if (!target) return;
    const prevStyles = store.pageStyles;
    const next: PageStyles = target.background
      ? { ...prevStyles, [target.index]: { ...(prevStyles[target.index] ?? {}), background: target.background } }
      : Object.fromEntries(Object.entries(prevStyles).filter(([k]) => Number(k) !== target.index));
    // No-op guard: an Apply that changes nothing writes nothing.
    if (
      Object.keys(next).length === Object.keys(prevStyles).length &&
      Object.entries(next).every(([k, v]) => prevStyles[Number(k)]?.background === v.background)
    ) {
      return;
    }
    if (editor && pushUndo) {
      const tr = editor.state.tr;
      tr.setMeta(PAGE_SETUP_MARKER, true);
      markerDispatched = true;
      editor.view.dispatch(tr);
    }
    if (pushUndo) {
      pushPageSetupUndo(store.pageSetup, editor?.state.doc ?? null, docBefore, prevStyles);
    }
    store.setPageStyles(next);
    return;
  }
  if (scope === 'document') {
    if (editor) {
      const tr = editor.state.tr;
      // The break merges JOIN history by default (one commit = one
      // history item); the co-undo's store restore fires with it
      // (the doc-snapshot correlation). The ruler's frames pass
      // addToHistory false — the drag's end commit is the ONE item.
      if (!addToHistory) tr.setMeta('addToHistory', false);
      // OURS — the co-undo's pending law tracks this tr (the marker
      // rides only the history-joined trs; the ruler's preview frames
      // stay out entirely).
      if (addToHistory) tr.setMeta(PAGE_SETUP_MARKER, true);
      markerDispatched = true;
      for (const pos of breakPositions(editor)) {
        const node = editor.state.doc.nodeAt(pos);
        if (!node) continue;
        // #WATERMARK — a break with NO setup inherits the doc defaults
        // (the two-level model); a PARTIAL merge onto that null base
        // would mint a margins-less setup (the adapter's section
        // geometry reads margins and THROWS). Seed from the store's
        // effective setup when the break carries none — a partial
        // can never strip a required field this way.
        const base = (node.attrs.setup as PageSetup | undefined) ?? store.pageSetup;
        const merged = { ...base, ...partial };
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, setup: merged });
      }
      editor.view.dispatch(tr);
    }
    writeStore({ ...store.pageSetup, ...partial });
    return;
  }
  if (scope === 'sections') {
    const set = options?.sectionSet ?? [];
    if (!editor) {
      // No breaks: every chosen section IS the store's (collapse).
      writeStore({ ...store.pageSetup, ...full });
      return;
    }
    const positions = breakPositions(editor);
    const tr = editor.state.tr;
    tr.setMeta(PAGE_SETUP_MARKER, true);
      markerDispatched = true;
    let touchedStore = false;
    for (const k of set) {
      if (k < positions.length) {
        const pos = positions[k]!;
        const node = editor.state.doc.nodeAt(pos);
        if (node) tr.setNodeMarkup(pos, undefined, { ...node.attrs, setup: full });
      } else {
        touchedStore = true; // the final section
      }
    }
    if (tr.docChanged) editor.view.dispatch(tr);
    if (touchedStore) writeStore({ ...store.pageSetup, ...full });
    return;
  }
  if (scope === 'forward') {
    if (!editor) {
      writeStore({ ...store.pageSetup, ...full });
      return;
    }
    // The caret's section's EFFECTIVE setup seeds the new break (the
    // content above keeps its look); the FOLLOWING section's holder
    // gets the draft. The inserted break's type = startType (how the
    // new section starts).
    const facts = sectionAtCaret(editor, store.pageSetup);
    editor.commands.insertSectionBreak(facts.setup, options?.startType ?? 'nextPage');
    // The insertion shifted the breaks: the following section's
    // holder is now the break at ordinal index + 1 — or the store.
    const positions = breakPositions(editor);
    const targetOrdinal = facts.index + 1;
    if (targetOrdinal < positions.length) {
      const pos = positions[targetOrdinal]!;
      const node = editor.state.doc.nodeAt(pos);
      if (node) {
        const tr = editor.state.tr;
        tr.setMeta(PAGE_SETUP_MARKER, true);
      markerDispatched = true;
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, setup: full });
        editor.view.dispatch(tr);
      }
    } else {
      writeStore({ ...store.pageSetup, ...full });
    }
    return;
  }
  // 'section' — the caret's section by default; an explicit sectionSet
  // (the dialog's auto-selected chips — the user may toggle others)
  // writes each chosen section instead (the chooser power under one
  // scope).
  if (options?.sectionSet && options.sectionSet.length > 0 && editor) {
    const positions = breakPositions(editor);
    const tr = editor.state.tr;
    let touchedStore = false;
    for (const k of options.sectionSet) {
      if (k < positions.length) {
        const pos = positions[k]!;
        const node = editor.state.doc.nodeAt(pos);
        if (node) tr.setNodeMarkup(pos, undefined, { ...node.attrs, setup: full });
      } else {
        touchedStore = true; // the final section
      }
    }
    if (options.startType != null) {
      // The start type rides for EACH chosen break-owned section (the
      // boundary before it); the final's start is the LAST break.
      for (const k of options.sectionSet) {
        if (k > 0 && k <= positions.length) {
          writeStartTypeInTr(tr, editor, positions[k - 1]!, options.startType);
        }
      }
    }
    if (tr.docChanged) editor.view.dispatch(tr);
    if (touchedStore) writeStore({ ...store.pageSetup, ...full });
    return;
  }
  // 'section' — ONE transaction for the setup + the start type (one
  // history item, one co-undo entry; a split would half-undo).
  const facts = sectionAtCaret(editor, store.pageSetup);
  if (editor) {
    const tr = editor.state.tr;
    tr.setMeta(PAGE_SETUP_MARKER, true);
      markerDispatched = true;
    if (options?.startType && facts.startBreakPos != null) {
      writeStartTypeInTr(tr, editor, facts.startBreakPos, options.startType);
    }
    if (facts.breakPos != null) {
      const node = editor.state.doc.nodeAt(facts.breakPos);
      if (node) {
        tr.setNodeMarkup(facts.breakPos, undefined, { ...node.attrs, setup: full });
      }
    }
    if (tr.docChanged) {
      editor.view.dispatch(tr);
      if (pushUndo) {
        pushPageSetupUndo(options?.undoPrev ?? store.pageSetup, editor.state.doc, docBefore);
      }
      return;
    }
  }
  writeStore({ ...store.pageSetup, ...full });
}

/** The start-type write INSIDE an existing transaction (the multi-
 *  section write's helper — one commit for all chosen sections). */
function writeStartTypeInTr(
  tr: import('@tiptap/pm/state').Transaction,
  editor: Editor,
  pos: number,
  type: 'nextPage' | 'continuous',
): void {
  const node = editor.state.doc.nodeAt(pos);
  if (node && node.attrs.type !== type) {
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, type });
  }
}
