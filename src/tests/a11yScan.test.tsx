import { describe, it, expect } from 'vitest';
import { act } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { builtinDefinitionsById } from '@/lib/styles/builtins';
import { DEFAULT_MARGINS, PAGE_GAP } from '@/lib/document/pageSetup';
import { scanAccessibility } from '@/lib/a11yCheck/scan';
import type { A11yScanContext } from '@/lib/a11yCheck/types';
import { renderTensor, settleLayout } from './harness';

/**
 * The scan suite: the three content checks over real PM docs (the
 * harness editor; the scan itself is pure). Band alt/contrast INCLUDED,
 * band headings EXCLUDED from the hierarchy walk. (The panel/trigger
 * suite: a11yCheck.test.tsx; the pure WCAG vectors: a11yContrast.test.ts.)
 */

const baseCtx = (over: Partial<A11yScanContext> = {}): A11yScanContext => ({
  definitions: builtinDefinitionsById(),
  baseFontFamily: 'fake',
  baseFontSize: 16,
  ...over,
});

function scan(editor: Editor, ctx: A11yScanContext = baseCtx()) {
  return scanAccessibility(editor.state.doc, ctx);
}

function insertNode(editor: Editor, node: PMNode, pos: number): void {
  act(() => {
    editor.view.dispatch(editor.state.tr.insert(pos, node));
  });
}

function blockImage(editor: Editor, alt: string): PMNode {
  const { schema } = editor.state;
  return schema.nodes.image.create({ src: 'media://img', width: 10, height: 10, alt });
}

function addColorMark(editor: Editor, from: number, to: number, color: string): void {
  act(() => {
    const mark = editor.state.schema.marks.textStyle.create({ color });
    editor.view.dispatch(editor.state.tr.addMark(from, to, mark));
  });
}

function textPos(editor: Editor, text: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text === text) found = pos;
  });
  return found;
}

describe('the alt check', () => {
  it('a block image with empty or whitespace alt is flagged; a described one is not', async () => {
    const { editor } = renderTensor('<p>one</p>');
    await settleLayout();
    insertNode(editor, blockImage(editor, ''), 0);
    let result = scan(editor);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ kind: 'altText', severity: 'error', pos: 0 });
    expect(result.issues[0]!.src).toBe('media://img');

    // Whitespace is still missing (a NON-decorative image's '' alt is
    // unwritten — decorative is the explicit intent spelling, tested
    // in its own case below).
    editor.view.dispatch(
      editor.state.tr.setNodeAttribute(0, 'alt', '   '),
    );
    result = scan(editor);
    expect(result.issues).toHaveLength(1);

    // A real description clears it.
    editor.view.dispatch(editor.state.tr.setNodeAttribute(0, 'alt', 'a diagram'));
    result = scan(editor);
    expect(result.issues).toHaveLength(0);
  });

  it('INLINE images carry alt identically — flagged the same way', async () => {
    const { editor } = renderTensor('<p>hello</p>');
    await settleLayout();
    const { schema } = editor.state;
    const inline = schema.nodes.inlineImage.create({
      src: 'media://inline',
      width: 10,
      height: 10,
      alt: '',
    });
    insertNode(editor, inline, 3); // inside the text — the inline seat
    const result = scan(editor);
    expect(result.issues.filter((i) => i.kind === 'altText')).toHaveLength(1);
    expect(result.issues[0]!.kind).toBe('altText');
  });

  it('BAND content is INCLUDED — an image in a header is flagged (the locked band ruling)', async () => {
    const { editor } = renderTensor('<p>one</p>');
    await settleLayout();
    const { schema } = editor.state;
    const band = schema.nodes.headerBlock.create({}, [
      schema.nodes.paragraph.create({}, schema.text('band body')),
    ]);
    insertNode(editor, band, 0);
    // An image inside the band (schema: headerBlock content is block+).
    const img = blockImage(editor, '');
    insertNode(editor, img, 1); // inside the band, before its paragraph
    const result = scan(editor);
    expect(result.issues.filter((i) => i.kind === 'altText')).toHaveLength(1);
  });
});

describe('the heading hierarchy check', () => {
  it('H3 directly under H1 is flagged as a skipped level', async () => {
    const { editor } = renderTensor('<h1>Title</h1><h3>Deep</h3>');
    await settleLayout();
    const result = scan(editor);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      kind: 'headingHierarchy',
      severity: 'warning',
      pos: 7, // the H3 node (nodeSize math: h1 open+5+close = 7)
    });
    expect(result.issues[0]!.message).toContain('H3 follows H1');
  });

  it('multiple H1s are flagged — every one after the first', async () => {
    const { editor } = renderTensor('<h1>First</h1><h1>Second</h1><h1>Third</h1>');
    await settleLayout();
    const result = scan(editor);
    const h1Issues = result.issues.filter((i) => i.message.includes('Multiple H1'));
    expect(h1Issues).toHaveLength(2);
    // Flagged on the 2nd and 3rd, never the first (nodeSize 7, 8).
    expect(h1Issues[0]!.pos).toBe(7);
    expect(h1Issues[1]!.pos).toBe(15);
  });

  it('a clean hierarchy and DESCENDING levels never flag', async () => {
    const { editor } = renderTensor('<h1>a</h1><h2>b</h2><h3>c</h3><h2>d</h2>');
    await settleLayout();
    expect(scan(editor).issues).toHaveLength(0);
  });

  it('BAND headings are EXCLUDED (chrome, never body outline); cell headings COUNT', async () => {
    const { editor } = renderTensor('<h1>Body</h1>');
    await settleLayout();
    const { schema } = editor.state;
    // A level-2 heading inside a header band: not in the walk.
    const band = schema.nodes.headerBlock.create({}, [
      schema.nodes.heading.create({ level: 2 }, schema.text('band head')),
    ]);
    insertNode(editor, band, 0);
    expect(scan(editor).issues).toHaveLength(0); // H1 then (excluded) H2 — clean

    // An H3 inside a table cell: real content — the skip fires.
    const cellHeading = schema.nodes.heading.create({ level: 3 }, schema.text('cell head'));
    const cell = schema.nodes.tableCell.create({}, [cellHeading]);
    const row = schema.nodes.tableRow.create({}, [cell]);
    const table = schema.nodes.table.create({}, [row]);
    insertNode(editor, table, editor.state.doc.content.size);
    const result = scan(editor);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.message).toContain('H3 follows H1');
  });
});

describe('the contrast check', () => {
  it('the baseline (black on white) never flags — zero noise on plain docs', async () => {
    const { editor } = renderTensor('<p>plain text</p><h1>heading</h1>');
    await settleLayout();
    expect(scan(editor).issues).toHaveLength(0);
  });

  it('#777777 on white fails AA by a hair (4.48:1) — the canonical boundary pair', async () => {
    const { editor } = renderTensor('<p>gray text</p>');
    await settleLayout();
    const pos = textPos(editor, 'gray text');
    addColorMark(editor, pos, pos + 'gray text'.length, '#777777');
    const result = scan(editor);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ kind: 'contrast', severity: 'warning' });
    expect(result.issues[0]!.message).toContain('4.48');
    expect(result.issues[0]!.detail).toBe('gray text');
    // The flagged span covers the whole marked range.
    expect(result.issues[0]!.to).toBe(pos + 9);
  });

  it('adjacent leaves with the same verdict MERGE into one issue (a formatting boundary is not two findings)', async () => {
    // 'ab' colored gray, then 'b' also italic — two text nodes, one
    // resolved color/bold/size tuple: ONE span.
    const { editor } = renderTensor('<p>ab</p>');
    await settleLayout();
    addColorMark(editor, 1, 3, '#777777');
    const italic = editor.state.schema.marks.italic.create();
    act(() => {
      editor.view.dispatch(editor.state.tr.addMark(2, 3, italic));
    });
    const result = scan(editor);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.to).toBe(3);
  });

  it('LARGE TEXT rides the 3:1 tier — #8a8a8a (3.45:1) passes on a 24px bold heading, fails on body text', async () => {
    const { editor } = renderTensor('<h2>big</h2><p>small</p>');
    await settleLayout();
    const big = textPos(editor, 'big');
    const small = textPos(editor, 'small');
    addColorMark(editor, big, big + 3, '#8a8a8a');
    addColorMark(editor, small, small + 5, '#8a8a8a');
    const result = scan(editor);
    // Only the body text flags — the heading-2 (24px bold via the
    // style cascade) satisfies the large-text threshold.
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.pos).toBe(small);
  });

  it('the HIGHLIGHT is the background layer (opaque fillRect covers the page)', async () => {
    const { editor } = renderTensor('<p>marked</p>');
    await settleLayout();
    const pos = textPos(editor, 'marked');
    act(() => {
      const mark = editor.state.schema.marks.highlight.create({ color: '#1e293b' });
      editor.view.dispatch(editor.state.tr.addMark(pos, pos + 6, mark));
    });
    // Black on #1e293b ≈ 1.44:1 — flagged.
    const result = scan(editor);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.message).toContain('1.44');
  });

  it('the TABLE CELL FILL is the background when no highlight — gray that passes on white fails on the fill', async () => {
    const { editor } = renderTensor(
      '<table><tr><td data-cell-background="#333333">gray text</td></tr></table>'
    );
    await settleLayout();
    const pos = textPos(editor, 'gray text');
    addColorMark(editor, pos, pos + 9, '#666666');
    const result = scan(editor);
    // #666666 is 5.74:1 on white (passes) but ~2.20:1 on #333333 —
    // flagged ONLY because the cell layer was used.
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.message).toContain('2.20');
  });

  it('the SECTION PAGE COLOR resolves per section — a dark section flags its own text only', async () => {
    const { editor } = renderTensor('<p>first</p><p>second</p>');
    await settleLayout();
    const { schema } = editor.state;
    // Word's sectPr spelling: break k carries SECTION k's props — the
    // section ABOVE it. 'first' paints the break's setup; 'second'
    // (the final section) paints the store's (white here). The setup
    // is a FULL PageSetup — the adapter's section geometry reads it
    // on relayout (margins included).
    const brk = schema.nodes.sectionBreak.create({
      type: 'nextPage',
      setup: {
        pageSize: 'Letter',
        margins: DEFAULT_MARGINS,
        pageGap: PAGE_GAP,
        pageColor: '#1e293b',
      },
    });
    insertNode(editor, brk, 7); // between the paragraphs
    const result = scan(editor);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.pos).toBe(textPos(editor, 'first'));
  });

  it('the STYLE TIER participates — a style-colored body text flags without any mark', async () => {
    const { editor } = renderTensor('<p>styled</p>');
    await settleLayout();
    const definitions = {
      ...builtinDefinitionsById(),
      normal: {
        id: 'normal',
        name: 'Normal Text',
        kind: 'paragraph' as const,
        properties: { color: '#777777' },
      },
    };
    const result = scan(editor, baseCtx({ definitions }));
    expect(result.issues).toHaveLength(1);
  });

  it('unparseable or semi-transparent colors SKIP with a counted note, never a guess', async () => {
    const { editor } = renderTensor('<p>var and alpha</p>');
    await settleLayout();
    const pos = textPos(editor, 'var and alpha');
    addColorMark(editor, pos, pos + 3, 'var(--brand)');
    addColorMark(editor, pos + 4, pos + 9, 'rgba(120, 120, 120, 0.5)');
    const result = scan(editor);
    expect(result.issues).toHaveLength(0);
    expect(result.skippedRuns).toBe(2);
  });

  it('whitespace-only text never flags (ink without meaning)', async () => {
    const { editor } = renderTensor('<p>word</p>');
    await settleLayout();
    const pos = textPos(editor, 'word');
    addColorMark(editor, pos, pos + 4, '#ffffff');
    // Turn it into pure whitespace: white-on-white would flag, but the
    // text no longer carries meaning.
    editor.view.dispatch(editor.state.tr.insertText('   ', pos, pos + 4));
    const result = scan(editor);
    expect(result.issues).toHaveLength(0);
  });
});

describe('result shape and memoization', () => {
  it('kinds keep their fixed order (alt, headings, contrast) regardless of doc order', async () => {
    const { editor } = renderTensor('<p>gray</p><h1>a</h1><h3>b</h3>');
    await settleLayout();
    insertNode(editor, blockImage(editor, ''), 0);
    const pos = textPos(editor, 'gray');
    addColorMark(editor, pos, pos + 4, '#777777');
    const kinds = scan(editor).issues.map((i) => i.kind);
    expect(kinds).toEqual(['altText', 'headingHierarchy', 'contrast']);
  });

  it('memoized on the doc + context — a re-scan walks nothing (the references-scan stability law)', async () => {
    const { editor } = renderTensor('<p>one</p>');
    await settleLayout();
    const ctx = baseCtx();
    const a = scan(editor, ctx);
    const b = scan(editor, ctx);
    expect(b).toBe(a); // same object — cache hit
    const c = scan(editor, baseCtx({ pageColor: '#101010' }));
    expect(c).not.toBe(a); // context changed — recomputed
    expect(c.issues).toHaveLength(1); // black on #101010 fails
  });
});

describe('decorative marking (the alt exemption)', () => {
  it('DECORATIVE images are exempt from the alt rule — block and inline; untoggling flags again', async () => {
    const { editor } = renderTensor('<p>one</p>');
    await settleLayout();
    const { schema } = editor.state;
    insertNode(
      editor,
      schema.nodes.image.create({ src: 'media://d', width: 10, height: 10, alt: '', decorative: true }),
      0,
    );
    insertNode(
      editor,
      schema.nodes.inlineImage.create({ src: 'media://di', width: 10, height: 10, alt: '', decorative: true }),
      3,
    );
    expect(scan(editor).issues).toHaveLength(0);

    // The marking is the user's decision, not a permanent pass —
    // untoggle and the checker asks again.
    act(() => {
      editor.view.dispatch(editor.state.tr.setNodeAttribute(0, 'decorative', false));
    });
    const result = scan(editor);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.kind).toBe('altText');
    expect(result.issues[0]!.pos).toBe(0);
  });

  it('DECORATIVE carries into the render surfaces (placeholder aria-hidden — the skip semantics)', async () => {
    const { editor } = renderTensor('<p>one</p>');
    await settleLayout();
    const { schema } = editor.state;
    // An UNRESOLVED media ref renders the placeholder branch — the
    // decorative image must be hidden from the accessibility tree
    // there (alt="" carries it on the resolved <img> path).
    insertNode(
      editor,
      schema.nodes.image.create({ src: 'media://missing', width: 10, height: 10, alt: '', decorative: true }),
      0,
    );
    // Node views re-render on the PM update flush (the Orca-mirror
    // receipt's own rhythm) — settle before querying the DOM.
    await settleLayout();
    const placeholder = document.querySelector('[data-testid="image-placeholder"]') as HTMLElement;
    expect(placeholder).not.toBeNull();
    expect(placeholder.getAttribute('aria-hidden')).toBe('true');
  });
});
