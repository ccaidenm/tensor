import { MarkdownManager } from '@tiptap/markdown';
import type { JSONContent } from '@tiptap/core';
import { tensorExtensions } from '@/lib/editor/tensorExtensions';

/**
 * The standalone Markdown engine — no markdown extension on the production
 * editor (it overrides content commands editor-wide); built from the same
 * extension list, call-scoped, cached. GFM on; breaks off (CommonMark).
 */

let cached: MarkdownManager | null = null;

function markdownManager(): MarkdownManager {
  if (!cached) {
    cached = new MarkdownManager({
      markedOptions: { gfm: true, breaks: false },
      extensions: tensorExtensions(),
    });
  }
  return cached;
}

/** Markdown → document JSON (the import's parse step). */
export function markdownToJSON(markdown: string): JSONContent {
  return promoteStandaloneImages(markdownManager().parse(markdown));
}

/** Document JSON → Markdown (the export's serialize step). */
export function jsonToMarkdown(json: JSONContent): string {
  return markdownManager().serialize(json);
}

/**
 * Marked tokenizes images inline, so the spec parses to inlineImage; a
 * top-level bare inlineImage (or single-child paragraph) promotes to the
 * block image node. Top level only — deeper walking would mutate structure.
 */
function promoteStandaloneImages(doc: JSONContent): JSONContent {
  if (!Array.isArray(doc.content)) return doc;
  return {
    ...doc,
    content: doc.content.map((child) => {
      const inline = child.type === 'inlineImage'
        ? child
        : child.type === 'paragraph' &&
            Array.isArray(child.content) &&
            child.content.length === 1 &&
            child.content[0].type === 'inlineImage'
          ? child.content[0]
          : null;
      return inline ? { type: 'image', attrs: inline.attrs } : child;
    }),
  };
}
