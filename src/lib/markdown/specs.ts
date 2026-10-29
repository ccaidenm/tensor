import type { JSONContent, MarkdownParseHelpers, MarkdownToken, MarkdownTokenizer } from '@tiptap/core';
import { ImageNode } from '@/lib/editor/ImageNode';
import { InlineImageNode } from '@/lib/editor/InlineImageNode';
import { EquationNode } from '@/lib/editor/EquationNode';

/**
 * M-MD — the Markdown mapping specs. Handlers are attached by EXTENDING
 * the real nodes, so the registry keys (the extension NAME) can never
 * drift from the schema node names. The fields are inert in the
 * production editor (nothing there builds a manager) — they are read
 * only by the standalone MarkdownManager (lib/markdown/manager.ts).
 *
 * Tensor nodes with NO spec here ride the stock handlers (paragraph,
 * heading, bold/italic/strike/code, lists, links, blockquote, hr, hard
 * break, highlight, underline, tables) and skip cleanly: nodes without
 * a renderMarkdown handler render '' (headerBlock, footerBlock,
 * referenceTable, pageBreak) — lossy.ts counts them so the export
 * warning can name what is being left behind.
 */

/** Markdown alt-text escaping: the only characters that break
 *  `![alt](src)` are the brackets and the escape itself. */
function escapeImageAlt(alt: string): string {
  return alt.replace(/[\\[\]]/g, (char) => `\\${char}`);
}

/** THE image render (block image and inlineImage share it): the
 *  `media://<sha256>` placeholder goes out verbatim — the export flow
 *  (lib/markdown/exportMarkdown.ts) rewrites the refs to the sibling
 *  `<name>.assets/` paths when writing the file. A content-addressed
 *  sha256 hex can never be confused with prose, so the placeholder is
 *  unambiguous and the rewrite is a plain string pass. */
function renderImageMarkdown(node: JSONContent): string {
  const src = typeof node.attrs?.src === 'string' ? node.attrs.src : '';
  const alt = typeof node.attrs?.alt === 'string' ? escapeImageAlt(node.attrs.alt) : '';
  return `![${alt}](${src})`;
}

/**
 * THE image parse. marked tokenizes images as INLINE tokens wherever
 * they appear, and one token type cannot know its future parent — so
 * the spec always produces an inlineImage (the schema's inline group),
 * which is valid inside flowing text. The manager's PROMOTION pass
 * (manager.ts) lifts a top-level paragraph whose ONLY child is an
 * inlineImage into the block image node — a standalone `![pic](x)`
 * line round-trips as the block figure; images nested in list items,
 * blockquotes or cells stay inline, which is what they are.
 */
function parseImageToken(token: MarkdownToken, helpers: MarkdownParseHelpers): JSONContent {
  const shape = token as { href?: unknown; text?: unknown };
  return helpers.createNode('inlineImage', {
    src: typeof shape.href === 'string' ? shape.href : '',
    alt: typeof shape.text === 'string' ? shape.text : '',
    // Markdown carries no dimensions — the import flow ingests the
    // image and the standard dim backfill (media/backfill.ts) fills
    // these in, exactly like legacy documents on open.
    width: null,
    height: null,
  });
}

export const MarkdownImageNode = ImageNode.extend({
  markdownTokenName: 'image',
  parseMarkdown: parseImageToken,
  renderMarkdown: renderImageMarkdown,
});

export const MarkdownInlineImageNode = InlineImageNode.extend({
  // RENDER only: the 'image' token handler above owns parsing — a
  // second handler under the same token name would be dead weight.
  renderMarkdown: renderImageMarkdown,
});

/**
 * THE equation spec: display math rides the `$$…$$` convention
 * (Obsidian/Joplin/Pandoc territory) via a custom block tokenizer —
 * marked has no native math syntax. Display-only is COMPLETE, not a
 * subset: the equation node IS a block atom, there is no inline math
 * in the model. The latex body travels verbatim (trimmed); a `$$`
 * without a closing fence fails the tokenizer and stays prose.
 */
const EQUATION_TOKENIZER: MarkdownTokenizer = {
  name: 'equation',
  level: 'block',
  // LINE-START only: marked uses start() to know where the next
  // possible block begins — a mid-line match would slice prose mid-line
  // ("costs $$ today" must stay prose). A $$ at a line start is where
  // a display-math block can legally begin.
  start: (src) => {
    const match = /(^|\n)\$\$/.exec(src);
    return match ? match.index + match[1].length : -1;
  },
  tokenize(src) {
    const match = /^\$\$([\s\S]*?)\$\$/.exec(src);
    if (!match) return undefined;
    return { type: 'equation', raw: match[0], text: match[1].trim() };
  },
};

export const MarkdownEquationNode = EquationNode.extend({
  markdownTokenName: 'equation',
  parseMarkdown: (token, helpers) =>
    helpers.createNode('equation', {
      latex: String((token as { text?: unknown }).text ?? '').trim(),
    }),
  renderMarkdown: (node) => `$$\n${String(node.attrs?.latex ?? '').trim()}\n$$`,
  markdownTokenizer: EQUATION_TOKENIZER,
});
