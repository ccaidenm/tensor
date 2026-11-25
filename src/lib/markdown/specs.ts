import type { JSONContent, MarkdownParseHelpers, MarkdownToken, MarkdownTokenizer } from '@tiptap/core';
import { ImageNode } from '@/lib/editor/ImageNode';
import { InlineImageNode } from '@/lib/editor/InlineImageNode';
import { EquationNode } from '@/lib/editor/EquationNode';

/**
 * The Markdown mapping specs: handlers ride extensions of the real nodes
 * (registry keys can never drift from schema names); read only by the
 * standalone manager. No spec → stock handlers; no renderMarkdown → ''.
 */

/** Markdown alt-text escaping: the only characters that break
 *  `![alt](src)` are the brackets and the escape itself. */
function escapeImageAlt(alt: string): string {
  return alt.replace(/[\\[\]]/g, (char) => `\\${char}`);
}

/** The shared image render: the `media://<sha256>` placeholder goes out
 *  verbatim — the export flow rewrites the refs to the sibling
 *  `<name>.assets/` paths. A sha256 hex can't be confused with prose. */
function renderImageMarkdown(node: JSONContent): string {
  const src = typeof node.attrs?.src === 'string' ? node.attrs.src : '';
  const alt = typeof node.attrs?.alt === 'string' ? escapeImageAlt(node.attrs.alt) : '';
  return `![${alt}](${src})`;
}

/**
 * marked tokenizes images inline wherever they appear — the spec always
 * produces an inlineImage (valid in flowing text); the manager's
 * promotion pass (manager.ts) lifts standalone shapes into the block node.
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
  // Render only: the 'image' token handler above owns parsing.
  renderMarkdown: renderImageMarkdown,
});

/**
 * Display math rides the `$$…$$` convention via a custom block tokenizer
 * (marked has no native math). Display-only is complete — the node is a
 * block atom; an unclosed `$$` fails the tokenizer and stays prose.
 */
const EQUATION_TOKENIZER: MarkdownTokenizer = {
  name: 'equation',
  level: 'block',
  // Line-start only: marked uses start() to find the next possible block —
  // a mid-line match would slice prose ("costs $$ today" stays prose).
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
