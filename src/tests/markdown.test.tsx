import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { markdownToJSON, jsonToMarkdown } from '@/lib/markdown/manager';
import {
  analyzeMarkdownLossy,
  hasLossyContent,
  buildLossyWarning,
} from '@/lib/markdown/lossy';
import { renderTensor } from './harness';

/**
 * M-MD — the markdown mapping suite (manager level: parse/serialize are
 * pure functions of their input; no editor, no Tauri). The file-flow
 * suite (markdown-io.test.tsx) owns the dialog/fs behavior; this file
 * owns the mapping + lossy classification + the AC round-trip.
 */

const SHA = 'a'.repeat(64); // valid hex — the content-address shape

function doc(...children: JSONContent[]): JSONContent {
  return { type: 'doc', content: children };
}

function para(text: string, marks?: JSONContent['marks']): JSONContent {
  return {
    type: 'paragraph',
    content: [{ type: 'text', text, ...(marks ? { marks } : []) }],
  };
}

describe('markdown mapping — inline + block (stock handlers)', () => {
  it('serializes headings, bold/italic, links, lists, blockquote, hr', () => {
    const md = jsonToMarkdown(
      doc(
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
        para('plain '),
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' and ' },
            { type: 'text', text: 'linked', marks: [{ type: 'link', attrs: { href: 'https://x.dev' } }] },
          ],
        },
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [para('one')] }, { type: 'listItem', content: [para('two')] }],
        },
        { type: 'blockquote', content: [para('quoted')] },
        { type: 'horizontalRule' },
      ),
    );
    expect(md).toContain('## Title');
    expect(md).toContain('**bold**');
    expect(md).toContain('[linked](https://x.dev)');
    expect(md).toContain('- one');
    expect(md).toContain('> quoted');
    expect(md).toMatch(/---/);
  });

  it('parses markdown back to the equivalent document structure', () => {
    const json = markdownToJSON('# Head\n\nBody **bold** *ital* `code`\n\n- a\n- b\n\n1. one\n2. two\n\n> quote\n\n[link](https://x.dev)');
    const texts = JSON.stringify(json);
    expect(texts).toContain('Head');
    expect(texts).toContain('bold');
    expect(texts).toContain('ital');
    expect(texts).toContain('link');
    // list structure survives
    const types = JSON.stringify(json);
    expect(types).toContain('bulletList');
    expect(types).toContain('orderedList');
    expect(types).toContain('blockquote');
  });

  it('the AC round-trip: parse → serialize → parse is stable', () => {
    const md = '# Title\n\nIntro **bold** and *italic* with `code`.\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n> quoted text\n\n***\n\n[A link](https://example.com)';
    const first = markdownToJSON(md);
    const md2 = jsonToMarkdown(first);
    const second = markdownToJSON(md2);
    expect(second).toEqual(first);
  });

  it('tables export as GFM tables and reimport with structure intact', () => {
    const cell = (text: string, header = false) => ({
      type: header ? 'tableHeader' : 'tableCell',
      content: [para(text)],
    });
    const json = doc({
      type: 'table',
      attrs: { borderStyle: 'all' },
      content: [
        { type: 'tableRow', content: [cell('A', true), cell('B', true)] },
        { type: 'tableRow', content: [cell('1'), cell('2')] },
      ],
    });
    const md = jsonToMarkdown(json);
    expect(md).toContain('|');
    expect(md).toMatch(/-{3,}/); // the GFM header separator
    const back = markdownToJSON(md);
    const table = back.content?.[0];
    expect(table?.type).toBe('table');
    const texts = JSON.stringify(table);
    expect(texts).toContain('A');
    expect(texts).toContain('B');
    expect(texts).toContain('1');
    expect(texts).toContain('2');
  });
});

describe('markdown mapping — images (M-MD specs)', () => {
  it('exports a block image as the media placeholder and reimports it as a block image', () => {
    const json = doc({
      type: 'image',
      attrs: { src: `media://${SHA}`, alt: 'the pic', width: 300, height: 200, align: 'left', keepNext: false, radius: 0 },
    });
    const md = jsonToMarkdown(json);
    expect(md).toContain(`![the pic](media://${SHA})`);

    const back = markdownToJSON(md);
    const image = back.content?.[0];
    expect(image?.type).toBe('image'); // PROMOTED from the inline parse
    expect(image?.attrs?.src).toBe(`media://${SHA}`);
    expect(image?.attrs?.alt).toBe('the pic');
    expect(image?.attrs?.width).toBeNull(); // markdown carries no dims
  });

  it('keeps an inline image inline (no promotion among text)', () => {
    const json = doc({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'see ' },
        { type: 'inlineImage', attrs: { src: `media://${SHA}`, alt: '', width: null, height: null } },
        { type: 'text', text: ' now' },
      ],
    });
    const md = jsonToMarkdown(json);
    expect(md).toContain(`see ![](media://${SHA}) now`);

    const back = markdownToJSON(md);
    const paragraph = back.content?.[0];
    expect(paragraph?.type).toBe('paragraph');
    const types = (paragraph?.content ?? []).map((c) => c.type);
    expect(types).toEqual(['text', 'inlineImage', 'text']);
  });

  it('promotes a standalone image paragraph at the top level', () => {
    const json = markdownToJSON(`before\n\n![pic](media://${SHA})\n\nafter`);
    const types = (json.content ?? []).map((c) => c.type);
    expect(types).toEqual(['paragraph', 'image', 'paragraph']);
  });

  it('escapes alt-text brackets', () => {
    const md = jsonToMarkdown(
      doc({ type: 'image', attrs: { src: `media://${SHA}`, alt: 'a [b] c', width: null, height: null } }),
    );
    expect(md).toContain('![a \\[b\\] c]');
  });
});

describe('markdown mapping — equations ($$ spec)', () => {
  it('round-trips a display equation through a $$ block', () => {
    const json = doc({ type: 'equation', attrs: { latex: 'x^2 + y^2' } });
    const md = jsonToMarkdown(json);
    expect(md).toContain('$$\nx^2 + y^2\n$$');

    const back = markdownToJSON(md);
    expect(back.content?.[0]?.type).toBe('equation');
    expect(back.content?.[0]?.attrs?.latex).toBe('x^2 + y^2');
  });

  it('parses the single-line $$ spelling too', () => {
    const json = markdownToJSON('text\n\n$$E=mc^2$$\n\nmore');
    const types = (json.content ?? []).map((c) => c.type);
    expect(types).toContain('equation');
    const eq = (json.content ?? []).find((c) => c.type === 'equation');
    expect(eq?.attrs?.latex).toBe('E=mc^2');
  });

  it('keeps multi-line latex verbatim', () => {
    const json = markdownToJSON('$$\na \\\\\n  + b\n$$');
    const eq = (json.content ?? []).find((c) => c.type === 'equation');
    expect(eq?.attrs?.latex).toBe('a \\\\\n  + b');
  });

  it('does not tokenize an unclosed $$', () => {
    const json = markdownToJSON('costs $$ today\n\nand tomorrow');
    const text = JSON.stringify(json);
    expect(text).not.toContain('equation');
    expect(text).toContain('costs $$ today');
  });
});

describe('markdown mapping — skipped nodes', () => {
  it('renders band content, reference tables and page breaks as nothing', () => {
    const md = jsonToMarkdown(
      doc(
        {
          type: 'headerBlock',
          content: [para('header text that must not appear')],
        },
        para('body'),
        { type: 'pageBreak' },
        {
          type: 'footerBlock',
          content: [para('footer text that must not appear')],
        },
        {
          type: 'referenceTable',
          attrs: { kind: 'toc', depth: 3 },
          content: [para('1.2 A generated entry')],
        },
        para('tail'),
      ),
    );
    expect(md).toContain('body');
    expect(md).toContain('tail');
    expect(md).not.toContain('header text');
    expect(md).not.toContain('footer text');
    expect(md).not.toContain('generated entry');
  });
});

describe('lossy classification', () => {
  it('a plain document is clean', () => {
    const report = analyzeMarkdownLossy(
      doc(para('hello'), { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'H' }] }),
    );
    expect(report).toEqual({
      headerFooterRegions: 0,
      referenceTables: 0,
      pageBreaks: 0,
      sectionBreaks: 0,
      customFormatting: false,
      watermark: false,
    });
    expect(hasLossyContent(report)).toBe(false);
  });

  it('counts bands with content, but not empty bands', () => {
    const report = analyzeMarkdownLossy(
      doc(
        { type: 'headerBlock', content: [para('real text')] },
        { type: 'footerBlock', content: [{ type: 'paragraph' }] },
      ),
    );
    expect(report.headerFooterRegions).toBe(1);
  });

  it('counts reference tables and page breaks', () => {
    const report = analyzeMarkdownLossy(
      doc({ type: 'pageBreak' }, { type: 'pageBreak' }, { type: 'referenceTable', attrs: { kind: 'toc', depth: 2 } }),
    );
    expect(report.pageBreaks).toBe(2);
    expect(report.referenceTables).toBe(1);
  });

  it('flags dropped marks and style ids; implicit style ids are not a loss', () => {
    const clean = analyzeMarkdownLossy(
      doc({
        type: 'paragraph',
        attrs: { styleId: 'normal' },
        content: [{ type: 'text', text: 'x', marks: [{ type: 'bold' }, { type: 'underline' }, { type: 'highlight' }] }],
      }),
    );
    expect(clean.customFormatting).toBe(false);

    const styled = analyzeMarkdownLossy(
      doc({
        type: 'paragraph',
        attrs: { styleId: 'my-custom-style' },
        content: [{ type: 'text', text: 'x', marks: [{ type: 'charStyle', attrs: { styleId: 's1' } }] }],
      }),
    );
    expect(styled.customFormatting).toBe(true);
  });

  it('flags textStyle colors/fonts, alignment, spacing, indents, tab stops', () => {
    const colored = analyzeMarkdownLossy(
      doc({
        type: 'paragraph',
        content: [{ type: 'text', text: 'x', marks: [{ type: 'textStyle', attrs: { color: '#ff0000' } }] }],
      }),
    );
    expect(colored.customFormatting).toBe(true);

    const aligned = analyzeMarkdownLossy(doc({ type: 'paragraph', attrs: { textAlign: 'center' } }));
    expect(aligned.customFormatting).toBe(true);

    const spaced = analyzeMarkdownLossy(doc({ type: 'paragraph', attrs: { spaceBefore: 12 } }));
    expect(spaced.customFormatting).toBe(true);

    const tabbed = analyzeMarkdownLossy(doc({ type: 'paragraph', attrs: { tabStops: [{ position: 96, alignment: 'left' }] } }));
    expect(tabbed.customFormatting).toBe(true);
  });

  it('object decoration is documented, never warned (the inserted-image rule)', () => {
    // Insert ALWAYS stamps natural dimensions — sizing can never warn,
    // or every document with an image would confirm (the cry-wolf bug).
    const sizedImage = analyzeMarkdownLossy(
      doc({
        type: 'image',
        attrs: { src: `media://${SHA}`, width: 300, height: 200, align: 'center', keepNext: true, radius: 8 },
      }),
    );
    expect(sizedImage.customFormatting).toBe(false);
    const shadedCell = analyzeMarkdownLossy(
      doc({ type: 'tableCell', attrs: { backgroundColor: '#ffeedd' }, content: [] }),
    );
    expect(shadedCell.customFormatting).toBe(false);
    const borderedTable = analyzeMarkdownLossy(
      doc({ type: 'table', attrs: { borderStyle: 'none' }, content: [] }),
    );
    expect(borderedTable.customFormatting).toBe(false);
    const romanList = analyzeMarkdownLossy(
      doc({ type: 'orderedList', attrs: { listStyleType: 'upper-roman' }, content: [] }),
    );
    expect(romanList.customFormatting).toBe(false);
    const styledEquation = analyzeMarkdownLossy(
      doc({ type: 'equation', attrs: { latex: 'x', align: 'left', color: '#ff0000', scale: 2 } }),
    );
    expect(styledEquation.customFormatting).toBe(false);
  });

  it('the warning lists only the categories present', () => {
    const warning = buildLossyWarning({
      headerFooterRegions: 2,
      referenceTables: 0,
      pageBreaks: 1,
      sectionBreaks: 0,
      customFormatting: true,
      watermark: false,
    });
    expect(warning).toContain('Header/footer content (2 regions)');
    expect(warning).toContain('Page breaks (1)');
    expect(warning).toContain('Custom formatting');
    expect(warning).not.toContain('Reference tables');
  });
});

describe('markdown → editor (schema validity, M-MD)', () => {
  it('parsed markdown lands in the production editor with every construct', () => {
    const md = [
      '# Markdown import',
      '',
      'Body **bold** and *italic*.',
      '',
      '$$x^2$$',
      '',
      `- item with text`,
      '',
      `![pic](media://${SHA})`,
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n');
    const json = markdownToJSON(md);
    const { editor } = renderTensor();
    editor.commands.setContent(json);
    const applied = editor.getJSON();
    const types = JSON.stringify(applied);
    expect(types).toContain('"heading"');
    expect(types).toContain('"bold"');
    expect(types).toContain('"equation"');
    expect(types).toContain('"image"');
    expect(types).toContain('"table"');
  });
});
