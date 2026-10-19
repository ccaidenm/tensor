import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';

/**
 * M-IMAGES-2 — the wrap conversions. THE MECHANICS RECEIPT (quoted in
 * InlineImageNode.ts): block and inline are DIFFERENT PM SHAPES —
 * conversion is a node-kind SWITCH (replaceWith), never a position
 * transform. All attrs copy BOTH WAYS (align/keepNext/radius ride
 * inert on the inline node) so block→inline→block returns geometry
 * EXACTLY (the return-exact pin). float rides as an INERT CARRIER on
 * the inline node too (the adapter never reads it inline): float →
 * inline → float returns the EXACT offset — mode switches never move
 * the image.
 *
 * THE 2.1 FIX RECEIPT (the reported "wrap switch mangles the doc"):
 * the old inline→block computed the insert position from the
 * PRE-delete paragraph size — `editor.state.doc` (the pre-transform
 * doc) was read AFTER `tr.delete` had run on the transaction, so the
 * insert landed one position past the (now shorter) paragraph: every
 * switch left TWO empty paragraphs behind and teleported the image to
 * the doc's end, and a last-block image threw RangeError. Both
 * conversions are now SINGLE-STEP replaceWith over a FULLY computed
 * position set — no cross-step position arithmetic — and each selects
 * its new node (the toolbar stays in image mode across the switch;
 * setWrapMode's float commit re-resolves straight off the selection).
 */

type Attrs = Record<string, unknown>;

function selectedImageNode(editor: Editor):
  | { kind: 'image' | 'inlineImage'; pos: number; attrs: Attrs; nodeSize: number }
  | null {
  const sel = editor.state.selection as unknown as {
    node?: { type?: { name?: string }; attrs?: Attrs; nodeSize?: number };
    from?: number;
  };
  const name = sel.node?.type?.name;
  if ((name !== 'image' && name !== 'inlineImage') || typeof sel.from !== 'number') return null;
  return { kind: name, pos: sel.from, attrs: sel.node?.attrs ?? {}, nodeSize: sel.node?.nodeSize ?? 1 };
}

/** The shared attr payload (the round-trip carrier set). */
function carryAttrs(attrs: Attrs): Attrs {
  return {
    src: attrs.src,
    width: attrs.width,
    height: attrs.height,
    alt: attrs.alt ?? '',
    align: attrs.align ?? 'left',
    keepNext: attrs.keepNext === true,
    radius: attrs.radius ?? 0,
    // The float offset rides BOTH directions (inert on the inline
    // node — the adapter never reads it inline): float → inline →
    // float returns the EXACT offset (mode switches never move the
    // image — the E-IMG-3 ruling).
    float: attrs.float ?? null,
  };
}

/** The image's caption, scanning FORWARD: empty paragraphs (insert-
 *  split husks — including ones left by the pre-2.1 conversion bug)
 *  are skipped; the first styleId-'caption' paragraph before any other
 *  content wins. Small window — captions live next to their image. */
function findCaptionAfter(doc: PMNode, fromPos: number): { node: PMNode; pos: number } | null {
  let pos = fromPos;
  for (let i = 0; i < 4; i++) {
    const node = doc.nodeAt(pos);
    if (!node || node.type.name !== 'paragraph') return null;
    if (node.attrs.styleId === 'caption') return { node, pos };
    if (node.content.size > 0) return null; // real content intervenes
    pos += node.nodeSize;
  }
  return null;
}

/** block image → inline (inside a paragraph at its position). */
export function convertBlockToInline(editor: Editor): void {
  const sel = selectedImageNode(editor);
  if (!sel || sel.kind !== 'image') return;
  const doc = editor.state.doc;
  // M-IMAGES-2.2 — the caption FOLLOWS the image through the switch:
  // found ADJACENT it rides the replaceWith's own mapping (the new
  // paragraph is one slot wider — the caption lands right beneath);
  // found behind husk paragraphs it is MOVED beneath (delete + insert).
  const found = findCaptionAfter(doc, sel.pos + sel.nodeSize);
  const tr = editor.state.tr;
  // Replace [pos, pos+nodeSize) with a paragraph wrapping the inline
  // node — the Word placement (the image lands where the block was).
  tr.replaceWith(sel.pos, sel.pos + sel.nodeSize, editor.state.schema.nodes.paragraph!.create(
    { styleId: 'normal' },
    editor.state.schema.nodes.inlineImage!.create(carryAttrs(sel.attrs))
  ));
  const newParaEnd = sel.pos + 3; // p[inlineImage]: content 1 + tokens 2
  if (found && tr.mapping.map(found.pos) !== newParaEnd) {
    const mapped = tr.mapping.map(found.pos);
    tr.delete(mapped, mapped + found.node.nodeSize);
    tr.insert(newParaEnd, found.node);
  }
  // The NEW inline node is selected (one step: the paragraph's child
  // sits at pos+1) — the toolbar stays in image mode across the
  // switch, and Backspace deletes the object as the user expects.
  tr.setSelection(NodeSelection.create(tr.doc, sel.pos + 1));
  editor.view.dispatch(tr);
}

/**
 * inline image → block (EXTRACTED IN PLACE — the paragraph splits
 * around the object): [before-text] / image / [after-text]. A
 * paragraph that held ONLY the object yields the image alone (no
 * empty husk); halves keep the source textblock's TYPE + attrs (the
 * text keeps its style; duplicate blockIds are re-minted by the
 * BlockIdExtension pass — its pinned later-node law).
 */
export function convertInlineToBlock(editor: Editor): void {
  const sel = selectedImageNode(editor);
  if (!sel || sel.kind !== 'inlineImage') return;
  const doc = editor.state.doc;
  const $from = doc.resolve(sel.pos);
  const paraStart = $from.before();
  const para = doc.nodeAt(paraStart);
  // The token sits inside a textblock by schema; a resolve() outside
  // one is a foreign-shape state — refuse (never mangle).
  if (!para || !para.isTextblock) return;
  const contentStart = paraStart + 1;
  const contentEnd = paraStart + para.nodeSize - 1;
  const beforeSize = sel.pos - contentStart;
  const afterSize = contentEnd - (sel.pos + sel.nodeSize);
  const schema = editor.state.schema;
  const image = schema.nodes.image!.create(carryAttrs(sel.attrs));
  const parts: PMNode[] = [];
  if (beforeSize > 0) {
    parts.push(para.type.create(para.attrs, para.content.cut(0, beforeSize)));
  }
  parts.push(image);
  if (afterSize > 0) {
    parts.push(para.type.create(para.attrs, para.content.cut(beforeSize + sel.nodeSize)));
  }
  // M-IMAGES-2.2 — THE CAPTION FOLLOWS: a caption paragraph bonded to
  // the source paragraph must end up RIGHT BENEATH the image. The
  // mid-paragraph split would otherwise strand it after the after-half
  // ([p[hello], image, p[world], caption]) — detached from the image
  // it describes, and the keepNext bond (which the carried attrs
  // preserve) vacuous without adjacency. Found behind husk paragraphs
  // it is gathered too; when the split leaves it already adjacent,
  // nothing moves.
  const found = findCaptionAfter(doc, contentEnd + 1);
  const tr = editor.state.tr;
  tr.replaceWith(paraStart, paraStart + para.nodeSize, parts);
  // The NEW block image's position: after the before-half's whole node
  // (beforePara = content + open/close tokens).
  const beforeParaSize = beforeSize > 0 ? para.content.cut(0, beforeSize).size + 2 : 0;
  const imgPos = paraStart + beforeParaSize;
  const imgEnd = imgPos + image.nodeSize;
  if (found && tr.mapping.map(found.pos) !== imgEnd) {
    // Move: delete the caption from its (mapped) old slot, re-insert
    // directly after the image — [p[hello], image, caption, p[world]].
    // The delete is AFTER imgEnd, so the insert position is stable.
    const mapped = tr.mapping.map(found.pos);
    tr.delete(mapped, mapped + found.node.nodeSize);
    tr.insert(imgEnd, found.node);
  }
  tr.setSelection(NodeSelection.create(tr.doc, imgPos));
  editor.view.dispatch(tr);
}

/** Set the wrap mode on the SELECTED image (any kind):
 *  'inline' → block→inline (or no-op);
 *  'front'/'behind' → inline→block first if needed, then float z
 *  (dx/dy preserved — mode switches never move the image). */
export function setWrapMode(
  editor: Editor,
  mode: 'inline' | 'front' | 'behind'
): void {
  const sel = selectedImageNode(editor);
  if (!sel) return;
  if (mode === 'inline') {
    if (sel.kind === 'image') convertBlockToInline(editor);
    return;
  }
  // Float modes need the BLOCK shape:
  let attrs = sel.attrs;
  if (sel.kind === 'inlineImage') {
    convertInlineToBlock(editor);
    // Re-resolve (the positions moved — the conversion SELECTED the
    // new block node, so this reads it straight off the selection):
    const next = selectedImageNode(editor);
    if (!next || next.kind !== 'image') return;
    attrs = next.attrs;
    sel.pos = next.pos;
  }
  const existing = attrs.float as { dx?: number; dy?: number } | null | undefined;
  const float = {
    dx: existing?.dx ?? 0,
    dy: existing?.dy ?? 0,
    z: mode,
  };
  const tr = editor.state.tr;
  tr.setNodeAttribute(sel.pos, 'float', float);
  editor.view.dispatch(tr);
}

/** Float drag commit: dx/dy are ANCHOR-RELATIVE — the drag delta adds
 *  to the current offset (the engine re-derives + clamps the placed
 *  rect; the shell never clamps). A drag on an unfloated image
 *  FLOATS it (front, Word behavior). */
export function commitFloatDrag(
  editor: Editor,
  pos: number,
  currentFloat: { dx: number; dy: number; z: 'front' | 'behind' } | null,
  dragDx: number,
  dragDy: number
): void {
  const float = {
    dx: (currentFloat?.dx ?? 0) + dragDx,
    dy: (currentFloat?.dy ?? 0) + dragDy,
    z: currentFloat?.z ?? 'front',
  };
  const tr = editor.state.tr;
  tr.setNodeAttribute(pos, 'float', float);
  editor.view.dispatch(tr);
}
