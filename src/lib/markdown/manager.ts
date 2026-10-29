import { MarkdownManager } from '@tiptap/markdown';
import type { JSONContent } from '@tiptap/core';
import { tensorExtensions } from '@/lib/editor/tensorExtensions';

/**
 * M-MD — the standalone Markdown engine.
 *
 * NO Markdown extension on the production editor: the official
 * extension overrides the content commands and installs `editor.markdown`
 * editor-wide. Tensor's editor speaks HTML/JSON everywhere (.wpdoc,
 * clipboard, header/footer bands) and none of that may change shape, so
 * the manager is built standalone from the SAME extension list
 * (tensorExtensions — the one source the app shell and the test harness
 * already share) and only ever used call-scoped by the import/export
 * flows. registerExtension reads just the markdown fields
 * (parseMarkdown/renderMarkdown/markdownTokenizer) — plugins, commands
 * and node views stay inert.
 *
 * markedOptions: GFM for tables (and task-list tokenization — the
 * schema has no task lists, those degrade to plain list items, a
 * documented loss); breaks stays FALSE so a soft-wrapped source line
 * stays soft (the CommonMark default).
 *
 * The manager is stateless across calls (parse/serialize are pure
 * functions of their input) — one cached instance serves every flow.
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
 * THE PROMOTION PASS. Marked tokenizes images as INLINE tokens, and the
 * image spec (specs.ts) therefore always parses to an inlineImage — the
 * schema's inline group. TWO top-level shapes are the standalone-figure
 * spelling (`![pic](x)` alone on a line) and promote to the BLOCK image
 * node: the bare inlineImage (the paragraph special-case hands it up
 * naked) and the paragraph whose only child is one. Images among text —
 * or nested in list items, blockquotes, cells — stay inline, which is
 * what they are. Top level only — a promotion walk into containers
 * would mutate structure the source never implied.
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
