import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';

/**
 * The wrap conversions: block and inline are different PM shapes —
 * a switch is a replaceWith, never a position transform; all attrs
 * copy both ways, so mode switches never move the image, and each
 * conversion selects its new node (the toolbar stays in image mode).
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
    // The decorative marking survives mode switches.
    decorative: attrs.decorative === true,
    // The float offset rides both directions, inert on the inline
    // node (the adapter never reads it inline): float → inline →
    // float returns the exact offset.
    float: attrs.float ?? null,
  };
}

/** The image's caption, scanning forward: empty paragraphs (insert-
 *  split husks) are skipped; the first styleId-'caption' paragraph
 *  before any other content wins (small window — captions live
 *  beside their image). */
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
  // The caption follows the image through the switch: adjacent, it
  // rides the replaceWith's own mapping; behind husk paragraphs, it
  // is moved beneath (delete + insert).
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
  // The new inline node is selected (one step: the paragraph's child
  // sits at pos+1) — the toolbar stays in image mode across the
  // switch, and Backspace deletes the object as the user expects.
  tr.setSelection(NodeSelection.create(tr.doc, sel.pos + 1));
  editor.view.dispatch(tr);
}

/**
 * inline image → block, extracted in place: [before-text] / image /
 * [after-text]. An object-only paragraph yields the image alone (no
 * empty husk); halves keep the source textblock's type + attrs.
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
  // The caption follows: bonded to the source paragraph, it must end
  // up right beneath the image — the split would otherwise strand it
  // after the after-half (the keepNext bond is vacuous without adjacency).
  const found = findCaptionAfter(doc, contentEnd + 1);
  const tr = editor.state.tr;
  tr.replaceWith(paraStart, paraStart + para.nodeSize, parts);
  // The new block image's position: after the before-half's whole node
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

/** Set the wrap mode on the selected image (any kind): 'inline' →
 *  block→inline (or no-op); 'front'/'behind' → inline→block first if
 *  needed, then float z (dx/dy preserved). */
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
    // Re-resolve — the conversion selected the new block node, so
    // this reads it straight off the selection:
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

/** Float drag commit: dx/dy are anchor-relative — the drag delta
 *  adds to the current offset (the engine clamps the placed rect;
 *  the shell never clamps). Dragging an unfloated image floats it. */
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
