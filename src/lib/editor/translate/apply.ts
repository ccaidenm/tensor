import { DOMParser } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/core';
import type { Fragment, Node as PMNode } from '@tiptap/pm/model';
import type { TranslatedBlock, TranslateApplyMode } from './types';
import { useDocumentStore } from '@/lib/document/store';

/**
 * THE APPLY STEP — the preview becomes content: 'replace' swaps each
 * block, 'insert-interleaved' inserts after each, 'insert-appended'
 * lands at the end. ONE transaction, DESCENDING positions; stale → refuse.
 */

/** Parse translated HTML into document content, or null on failure.
 *  The schema parser is the sanitizer: only the document model's own
 *  tags/attrs survive; nothing from the wire is ever written raw. */
export function parseBlockHtml(editor: Editor, html: string): Fragment | null {
  try {
    const el = document.createElement('div');
    el.innerHTML = html;
    // An empty or textless translation never replaces the original —
    // the instance failing silently must not erase a block.
    if (!el.textContent?.trim()) return null;
    const parsed = DOMParser.fromSchema(editor.schema).parse(el);
    return parsed.childCount === 0 ? null : parsed.content;
  } catch {
    return null;
  }
}

export type ApplyOutcome = 'applied' | 'stale' | 'nothing';

/**
 * Commit the preview. Returns 'stale' when the document changed since
 * the run began.
 */
export function applyTranslation(
  editor: Editor,
  capturedDoc: PMNode,
  mode: TranslateApplyMode,
  rows: TranslatedBlock[],
): ApplyOutcome {
  if (editor.state.doc !== capturedDoc) return 'stale';

  type Prepared = { row: TranslatedBlock; fragment: Fragment };
  const prepared: Prepared[] = [];
  for (const row of rows) {
    if (row.failed) continue; // failed blocks keep their original
    const fragment = parseBlockHtml(editor, row.translatedHtml);
    if (!fragment) continue;
    prepared.push({ row, fragment });
  }
  if (prepared.length === 0) return 'nothing';

  const tr = editor.state.tr;
  if (mode === 'replace') {
    // Descending: each later replace is at a lower range than the
    // last, so no shift ever invalidates a position.
    for (const { row, fragment } of [...prepared].sort((a, b) => b.row.block.from - a.row.block.from)) {
      tr.replaceWith(row.block.from, row.block.to, fragment);
    }
  } else if (mode === 'insert-interleaved') {
    for (const { row, fragment } of [...prepared].sort((a, b) => b.row.block.from - a.row.block.from)) {
      // Sibling insert AFTER the block (block.to = the position right
      // after its closing token — doc context, so the fragment lands
      // as a sibling, never inside the original).
      tr.replaceWith(row.block.to, row.block.to, fragment);
    }
  } else {
    // Appended: the whole translated copy at the document's end.
    let end = editor.state.doc.content.size;
    for (const { fragment } of prepared) {
      tr.replaceWith(end, end, fragment);
      end += fragment.size;
    }
  }

  editor.view.dispatch(tr);
  useDocumentStore.getState().markDirty();
  return 'applied';
}
