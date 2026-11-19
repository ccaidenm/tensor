import { DOMSerializer } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { TranslateBlock } from './types';

/**
 * THE SCOPE WALK — which top-level blocks a translation run covers.
 *
 * THE EXPLICIT CONTRACT (docs/markdown.md's habit — decide and
 * document what travels and what is intentionally left behind):
 *
 *  TRANSLATED: paragraph, heading, blockquote, bullet/ordered list,
 *              code-free table — top-level blocks, HTML-serialized by
 *              the schema's own DOMSerializer so the instance receives
 *              exactly the tags the document model speaks (and the
 *              response re-parses into the same model).
 *
 *  SKIPPED (never sent, never touched): header/footer BAND blocks
 *  (generated chrome), reference tables (generator-owned derived
 *  content), equations (math, not language), code blocks (code, not
 *  prose), page breaks, images, horizontal rules — and any block
 *  whose text is empty.
 *
 * The granularity is TOP-LEVEL blocks: a list's items or a table's
 * cells travel as part of their block, so nothing is ever re-nested
 * by hand and the interleaved insert is a sibling of a valid block.
 */

/** Top-level node types a translation run touches. */
const TRANSLATABLE = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'table',
]);

/** The schema-serialized HTML of one top-level block. */
function blockHtml(editor: Editor, node: PMNode): string {
  const el = document.createElement('div');
  el.appendChild(DOMSerializer.fromSchema(editor.schema).serializeNode(node));
  return el.innerHTML;
}

export type TranslateScope = 'selection' | 'document';

/** Empty-selection check for the panel's enablement (the honest gate:
 *  a disabled button must never promise a selection run). */
export function hasSelection(editor: Editor): boolean {
  const sel = editor.state.selection;
  return !sel.empty;
}

/**
 * Collect the run's blocks. Selection scope covers every TRANSLATABLE
 * top-level block INTERSECTING the selection (a partially selected
 * paragraph translates whole — the panel discloses this). A CARET
 * touches nothing: selection scope with an empty selection collects
 * nothing (the panel's Selection button is disabled, not lying).
 */
export function collectBlocks(editor: Editor, scope: TranslateScope): TranslateBlock[] {
  const blocks: TranslateBlock[] = [];
  const sel = editor.state.selection;
  if (scope === 'selection' && sel.empty) return blocks;
  editor.state.doc.forEach((node, offset) => {
    if (!TRANSLATABLE.has(node.type.name)) return;
    const from = offset;
    const to = offset + node.nodeSize;
    if (scope === 'selection' && (sel.from >= to || sel.to <= from)) return;
    const text = node.textContent.trim();
    if (!text) return; // empty blocks never ride the wire
    const blockId = (node.attrs?.blockId as string | undefined) ?? `pos-${offset}`;
    blocks.push({
      blockId,
      nodeType: node.type.name,
      from,
      to,
      html: blockHtml(editor, node),
      text: node.textContent.replace(/\n+/g, ' '),
    });
  });
  return blocks;
}

/** A short human label for the preview (the block's kind). */
export function blockKindLabel(nodeType: string): string {
  switch (nodeType) {
    case 'paragraph': return 'Paragraph';
    case 'heading': return 'Heading';
    case 'blockquote': return 'Quote';
    case 'bulletList': return 'List';
    case 'orderedList': return 'Numbered list';
    case 'table': return 'Table';
    default: return nodeType;
  }
}
