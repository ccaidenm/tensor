import { describe, it, expect } from 'vitest';
import { unzipSync } from 'fflate';
import type { JSONContent } from '@tiptap/core';
import { buildDocx, docxReportLines, type DocxExportInput } from '@/lib/docx/export';
import { DEFAULT_MARGINS, type PageSetup } from '@/lib/document/pageSetup';
import { BUILTIN_DEFINITIONS } from '@/lib/styles/builtins';

/**
 * M-DOCX — the #37a export suite. STRUCTURAL assertions only (never
 * string-compare whole XML — the lib's attribute order is not a
 * contract): unzip the produced bytes with fflate, probe the parts for
 * the specific constructs the mapping promises. The round-trip gate
 * (export → import → normalized JSON) lands with #38a; "opens without
 * corruption warnings in Word" is the user-validated spike gate.
 */

// A valid 1x1 red PNG (the smallest image the format can express).
const TINY_PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);
const SHA = 'c'.repeat(64);

function doc(...children: JSONContent[]): JSONContent {
  return { type: 'doc', content: children };
}

function para(text: string, attrs: Record<string, unknown> = {}, marks?: { type: string; attrs?: Record<string, unknown> }[]): JSONContent {
  return {
    type: 'paragraph',
    attrs,
    content: [{ type: 'text', text, ...(marks ? { marks } : {}) }],
  };
}

function makeInput(json: JSONContent, overrides: Partial<DocxExportInput> = {}): DocxExportInput {
  return {
    json,
    pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: 32 } satisfies PageSetup,
    headerFooter: null,
    coreProperties: { title: 'Test Doc', creator: 'Tensor' },
    styleDefinitions: [...BUILTIN_DEFINITIONS],
    baseStyle: { fontFamily: 'Source Serif 4', fontSize: 16 },
    media: new Map([[SHA, { bytes: TINY_PNG, ext: 'png' }]]),
    ...overrides,
  };
}

async function exportParts(input: DocxExportInput): Promise<{ parts: Record<string, Uint8Array>; text: (part: string) => string; report: Awaited<ReturnType<typeof buildDocx>>['report'] }> {
  const { bytes, report } = await buildDocx(input);
  const parts = unzipSync(bytes);
  const decoder = new TextDecoder();
  return { parts, text: (part: string) => decoder.decode(parts[part]!), report };
}

describe('docx export — page geometry (units seam)', () => {
  it('Letter + 1in margins land in twips (pt × 20)', async () => {
    const { text } = await exportParts(makeInput(doc(para('x'))));
    const sect = text('word/document.xml');
    expect(sect).toContain('w:w="12240"'); // 612pt
    expect(sect).toContain('w:h="15840"'); // 792pt
    expect(sect).toContain('w:top="1440"'); // 72pt
    expect(sect).toContain('w:left="1440"');
  });

  it('landscape swaps the page dimensions and sets w:orient', async () => {
    const { text } = await exportParts(makeInput(doc(para('x')), {
      pageSetup: { pageSize: 'A4', margins: DEFAULT_MARGINS, pageGap: 32, orientation: 'landscape' },
    }));
    const sect = text('word/document.xml');
    // A4: 595×842pt portrait → landscape emits 16840×11900
    expect(sect).toContain('w:orient="landscape"');
    expect(sect).toContain('w:w="16840"');
    expect(sect).toContain('w:h="11900"');
  });

  it('a custom page size rides its pt dimensions', async () => {
    const { text } = await exportParts(makeInput(doc(para('x')), {
      pageSetup: { pageSize: 'custom', customWidth: 400, customHeight: 600, margins: DEFAULT_MARGINS, pageGap: 32 },
    }));
    const sect = text('word/document.xml');
    expect(sect).toContain('w:w="8000"'); // 400pt
    expect(sect).toContain('w:h="12000"'); // 600pt
  });
});

describe('docx export — paragraphs and inline marks', () => {
  it('headings reference the Word built-in tier', async () => {
    const { text } = await exportParts(makeInput(doc({ type: 'heading', attrs: { level: 1, styleId: 'heading-1' }, content: [{ type: 'text', text: 'Title' }] })));
    expect(text('word/document.xml')).toContain('<w:pStyle w:val="Heading1"/>');
  });

  it('marks map to run properties (bold, italics, strike, underline, highlight, color, font, size)', async () => {
    const { text } = await exportParts(makeInput(doc(para('x', {}, [
      { type: 'bold' }, { type: 'italic' }, { type: 'strike' }, { type: 'underline' },
      { type: 'highlight', attrs: { color: '#FFFF00' } },
      { type: 'textStyle', attrs: { color: '#AA0000', fontFamily: 'Lora', fontSize: 20 } },
    ]))));
    const body = text('word/document.xml');
    expect(body).toContain('<w:b/>');
    expect(body).toContain('<w:i/>');
    expect(body).toContain('<w:strike/>');
    expect(body).toContain('<w:u w:val="single"/>');
    expect(body).toContain('<w:highlight w:val="yellow"/>');
    expect(body).toContain('<w:color w:val="AA0000"/>');
    expect(body).toContain('w:ascii="Lora"');
    // 20px → 15pt → 30 half-points
    expect(body).toContain('<w:sz w:val="30"/>');
  });

  it('a non-palette highlight rides run shading', async () => {
    const { text } = await exportParts(makeInput(doc(para('x', {}, [{ type: 'highlight', attrs: { color: '#ABC123' } }]))));
    const body = text('word/document.xml');
    expect(body).toContain('w:fill="ABC123"');
    expect(body).not.toContain('<w:highlight');
  });

  it('links group into ExternalHyperlink with a wired relationship', async () => {
    const linkMark = { type: 'link', attrs: { href: 'https://example.edu' } };
    const { text } = await exportParts(makeInput(doc({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'see ', marks: [linkMark] },
        { type: 'text', text: 'the source', marks: [linkMark] },
      ],
    })));
    const body = text('word/document.xml');
    expect(body).toContain('<w:hyperlink');
    expect(body).toContain('>see </w:t>');
    expect(body).toContain('>the source</w:t>');
    const rels = text('word/_rels/document.xml.rels');
    expect(rels).toContain('Target="https://example.edu"');
    expect(rels).toContain('TargetMode="External"');
  });

  it('tabs split into w:tab elements (the Word-for-Web law) with paragraph stops', async () => {
    const { text } = await exportParts(makeInput(doc(para('a\tb', {
      tabStops: [{ position: 384, alignment: 'right' }],
    }))));
    const body = text('word/document.xml');
    expect(body).toContain('<w:tab/>');
    expect(body).toContain('<w:tab w:val="right"');
    expect(body).toContain('w:pos="5760"'); // 384px × 15
    expect(/\t/.test(body)).toBe(false); // never a literal tab in w:t
  });

  it('spacing, indents and line height map to OOXML geometry', async () => {
    const { text } = await exportParts(makeInput(doc(para('x', {
      spaceBefore: 24, spaceAfter: 12, indentLeft: 32, firstLineIndent: -32, lineHeight: '1.5',
    }))));
    const body = text('word/document.xml');
    expect(body).toContain('w:before="360"'); // 24px × 15
    expect(body).toContain('w:after="180"'); // 12px × 15
    expect(body).toContain('w:left="480"'); // 32px × 15
    expect(body).toContain('w:hanging="480"'); // negative first-line = hanging
    expect(body).toContain('w:line="360"'); // 1.5 × 240
    expect(body).toContain('w:lineRule="auto"');
  });

  it('a positive first-line indent stays firstLine', async () => {
    const { text } = await exportParts(makeInput(doc(para('x', { firstLineIndent: 32 }))));
    expect(text('word/document.xml')).toContain('w:firstLine="480"');
  });
});

describe('docx export — lists', () => {
  it('numbering references with per-instance restarts', async () => {
    const list = (styleType: string, items: string[]) => ({
      type: 'orderedList',
      attrs: { listStyleType: styleType },
      content: items.map((t) => ({ type: 'listItem', content: [para(t)] })),
    });
    const { text } = await exportParts(makeInput(doc(
      list('decimal', ['one', 'two']),
      para('between'),
      list('decimal', ['fresh']),
      list('lower-roman', ['roman']),
    )));
    const body = text('word/document.xml');
    // 3 ordered items + 1 roman item = 4 numPr pairs
    expect(body.match(/<w:numPr>/g)?.length).toBe(4);
    const numbering = text('word/numbering.xml');
    expect(numbering).toContain('w:val="lowerRoman"');
    // two decimal lists → two CONCRETE instances of the same abstract
    expect(numbering.match(/<w:num /g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('bullets ride the bullet format with the marker text', async () => {
    const { text } = await exportParts(makeInput(doc({
      type: 'bulletList',
      attrs: { listStyleType: 'disc' },
      content: [{ type: 'listItem', content: [para('item')] }],
    })));
    expect(text('word/numbering.xml')).toContain('w:val="bullet"');
    expect(text('word/numbering.xml')).toContain('<w:lvlText w:val="•"/>');
  });

  it('an unknown list style falls back to decimal and is counted', async () => {
    const { report } = await exportParts(makeInput(doc({
      type: 'orderedList',
      attrs: { listStyleType: 'armenian' },
      content: [{ type: 'listItem', content: [para('item')] }],
    })));
    expect(report.unknownListStyles).toBe(1);
    expect(docxReportLines(report).some((l) => l.includes('decimal (1)'))).toBe(true);
  });
});

describe('docx export — tables', () => {
  const cell = (text: string, attrs: Record<string, unknown> = {}, type = 'tableCell') => ({
    type,
    attrs,
    content: [para(text)],
  });
  const table = (rows: JSONContent[]) => ({ type: 'table', attrs: { borderStyle: 'all' }, content: rows });

  it('colspan maps to gridSpan; rowspan maps to vMerge restart + synthesized continuations', async () => {
    const { text } = await exportParts(makeInput(doc(table([
      { type: 'tableRow', content: [cell('merged', { colspan: 2 })] },
      { type: 'tableRow', content: [cell('span', { rowspan: 2 }), cell('B')] },
      { type: 'tableRow', content: [cell('D')] },
    ]))));
    const body = text('word/document.xml');
    expect(body).toContain('<w:gridSpan w:val="2"/>');
    expect(body).toContain('<w:vMerge w:val="restart"/>');
    expect(body.match(/<w:vMerge w:val="continue"\/>/g)?.length).toBe(1); // synthesized
    expect(body).toContain('>D<'); // the real cell after the continuation
  });

  it('cell shading and borders map', async () => {
    const { text } = await exportParts(makeInput(doc(table([
      { type: 'tableRow', content: [cell('x', { backgroundColor: '#FFEECC' })] },
    ]))));
    const body = text('word/document.xml');
    expect(body).toContain('w:fill="FFEECC"');
    expect(body).toContain('<w:tblBorders>');
  });

  it('a leading all-header row repeats (tblHeader)', async () => {
    const { text } = await exportParts(makeInput(doc(table([
      { type: 'tableRow', content: [cell('H', {}, 'tableHeader'), cell('H2', {}, 'tableHeader')] },
      { type: 'tableRow', content: [cell('a'), cell('b')] },
    ]))));
    expect(text('word/document.xml')).toContain('<w:tblHeader/>');
  });

  it('borderStyle none kills every border', async () => {
    const { text } = await exportParts(makeInput(doc({
      type: 'table', attrs: { borderStyle: 'none' },
      content: [{ type: 'tableRow', content: [cell('x')] }],
    })));
    const body = text('word/document.xml');
    expect(body).toContain('w:val="none"');
  });
});

describe('docx export — the NaN regression + horizontal rule', () => {
  it('fontSize STRING spellings coerce through the unit seam (the reported export failure)', async () => {
    // TipTap's FontSize extension stores the user's spelling — '18px',
    // '10pt' — and pxToHalfPoints(NaN) made the docx lib's
    // hpsMeasureValue throw "Invalid value 'NaN' specified. Must be an
    // integer." (surfaced through the app's error dialog, which read as
    // a Rust failure).
    const { text } = await exportParts(makeInput(doc(para('x', {}, [
      { type: 'textStyle', attrs: { fontSize: '18px' } },
    ]))));
    expect(text('word/document.xml')).toContain('<w:sz w:val="27"/>'); // 18px = 13.5pt
    const { text: t2 } = await exportParts(makeInput(doc(para('y', {}, [
      { type: 'textStyle', attrs: { fontSize: '10pt' } },
    ]))));
    expect(t2('word/document.xml')).toContain('<w:sz w:val="20"/>'); // 10pt = 20 half-points
  });

  it('a horizontal rule draws as a bottom-bordered paragraph (was counted unknown)', async () => {
    const { text, report } = await exportParts(makeInput(doc({ type: 'horizontalRule' })));
    expect(text('word/document.xml')).toContain('<w:pBdr>');
    expect(text('word/document.xml')).toContain('<w:bottom w:val="single"');
    expect(report.unknownNodes['horizontalRule']).toBeUndefined();
  });
});

describe('docx export — images and equations', () => {
  it('a block image embeds as a drawing with its media part and alt text', async () => {
    const { parts, text } = await exportParts(makeInput(doc({
      type: 'image',
      attrs: { src: `media://${SHA}`, width: 120, height: 90, alt: 'the pic' },
    })));
    const body = text('word/document.xml');
    expect(body).toContain('<w:drawing>');
    expect(body).toContain('descr="the pic"');
    const mediaName = Object.keys(parts).find((k) => k.startsWith('word/media/'));
    expect(mediaName).toBeTruthy();
    const media = parts[mediaName!];
    expect([...media.slice(0, 4)]).toEqual([...TINY_PNG.slice(0, 4)]); // PNG magic
  });

  it('a missing media entry leaves a counted placeholder', async () => {
    const { text, report } = await exportParts(makeInput(doc({
      type: 'image',
      attrs: { src: `media://${'d'.repeat(64)}`, width: 10, height: 10, alt: '' },
    })));
    expect(text('word/document.xml')).toContain('[missing image]');
    expect(report.missingImages).toBe(1);
  });

  it('webp/svg images are refused and counted (Word cannot embed them)', async () => {
    const { report } = await exportParts(makeInput(doc({
      type: 'image',
      attrs: { src: `media://${SHA}`, width: 10, height: 10, alt: '' },
    }), {
      media: new Map([[SHA, { bytes: TINY_PNG, ext: 'webp' }]]),
    }));
    expect(report.unsupportedImages).toBe(1);
  });

  it('a floated image exports as an anchored drawing (wrapNone, z-order, EMU offsets)', async () => {
    const { text, report } = await exportParts(makeInput(doc({
      type: 'image',
      attrs: { src: `media://${SHA}`, width: 120, height: 60, alt: 'floated', float: { dx: 24, dy: -12, z: 'behind' } },
    })));
    const body = text('word/document.xml');
    expect(body).toContain('<wp:anchor');
    expect(body).toContain('behindDoc="1"'); // z: behind
    expect(body).toContain('<wp:wrapNone/>'); // the overlay model
    // 24px → 228600 EMU (the anchor-relative offset)
    expect(body).toContain('228600');
    // floats MAP now — no reported loss
    expect(docxReportLines(report)).toEqual([]);
  });

  it('equations export as native OMML', async () => {
    const { text } = await exportParts(makeInput(doc({
      type: 'equation',
      attrs: { latex: 'x^2 + \\frac{a}{b}' },
    })));
    const body = text('word/document.xml');
    expect(body).toContain('<m:oMath>');
    expect(body).toContain('<m:f>');
  });

  it('unparseable latex degrades to literal text and is counted', async () => {
    const { text, report } = await exportParts(makeInput(doc({
      type: 'equation',
      attrs: { latex: '\\thisisnotacommand{x}' },
    })));
    expect(report.equationsAsText).toBe(1);
    expect(text('word/document.xml')).toContain('\\thisisnotacommand{x}');
    expect(docxReportLines(report).some((l) => l.includes('Equations exported as plain text (1)'))).toBe(true);
  });
});

describe('docx export — bands, styles, properties, degradation', () => {
  it('header/footer bands become parts; differentFirstPage becomes titlePg with an empty first', async () => {
    const { parts, text } = await exportParts(makeInput(doc(
      { type: 'headerBlock', attrs: { variant: 'default' }, content: [para('running header')] },
      { type: 'footerBlock', attrs: { variant: 'first' }, content: [para('first-page footer')] },
      para('body'),
    ), {
      headerFooter: { scope: { kind: 'document' }, differentFirstPage: true },
    }));
    const keys = Object.keys(parts);
    expect(keys.some((k) => k.startsWith('word/header'))).toBe(true);
    expect(keys.some((k) => k.startsWith('word/footer'))).toBe(true);
    const allParts = keys.filter((k) => k.startsWith('word/header')).map((k) => text(k)).join('\n');
    expect(allParts).toContain('running header');
    const footerParts = keys.filter((k) => k.startsWith('word/footer')).map((k) => text(k)).join('\n');
    expect(footerParts).toContain('first-page footer');
    expect(text('word/document.xml')).toContain('<w:titlePg/>');
  });

  it('custom styles emit as prefixed Word styles and paragraphs reference them', async () => {
    const defs = [
      ...BUILTIN_DEFINITIONS,
      { id: 'my-callout', name: 'Callout', kind: 'paragraph' as const, properties: { italic: true, color: '#224488' } },
      { id: 'key-term', name: 'Key Term', kind: 'character' as const, properties: { bold: true } },
    ];
    const { text } = await exportParts(makeInput(doc(para('styled', { styleId: 'my-callout' })), { styleDefinitions: defs }));
    const styles = text('word/styles.xml');
    expect(styles).toContain('w:styleId="Tensor-my-callout"');
    expect(styles).toContain('w:styleId="Tensor-key-term"');
    expect(text('word/document.xml')).toContain('<w:pStyle w:val="Tensor-my-callout"/>');
    // the heading built-ins stay Word-native
    expect(styles).toContain('w:styleId="Heading1"');
  });

  it('a charStyle mark references its emitted character style', async () => {
    const { text } = await exportParts(makeInput(doc(para('term', {}, [{ type: 'charStyle', attrs: { styleId: 'strong' } }]))));
    expect(text('word/document.xml')).toContain('<w:rStyle w:val="Tensor-strong"/>');
  });

  it('a Tensor ToC exports as a REAL Word TOC field (the round-trip closes)', async () => {
    const { text, report } = await exportParts(makeInput(doc(
      { type: 'referenceTable', attrs: { kind: 'toc', depth: 3, leaders: true, numberDisplay: 'plain' }, content: [para('1.2 An entry')] },
      para('body'),
    )));
    const body = text('word/document.xml');
    // the field instruction rides (XML-escaped quotes); the entries
    // are Word's to regenerate
    expect(body).toContain('<w:fldSimple w:instr="TOC');
    expect(body).toContain('&quot;1-3&quot;'); // quotes are XML-escaped in the attribute
    expect(body).toContain('w:fldSimple');
    // updateFields makes Word refresh the field on open
    expect(text('word/settings.xml')).toContain('updateFields');
    // the derived entries do NOT export (Word owns them Word-side)
    expect(body).not.toContain('An entry');
    // and it is no longer a reported loss — the round-trip is clean
    expect(docxReportLines(report)).toEqual([]);
  });

  it('unknown node types are counted, never silently dropped', async () => {
    const { report } = await exportParts(makeInput(doc({ type: 'mysteryNode' } as unknown as JSONContent)));
    expect(report.unknownNodes['mysteryNode']).toBe(1);
    expect(docxReportLines(report).some((l) => l.includes('mysteryNode (1)'))).toBe(true);
  });

  it('core properties ride docProps with the OOXML spellings', async () => {
    const { text } = await exportParts(makeInput(doc(para('x')), {
      coreProperties: { title: 'Thesis', subject: 'Physics', creator: 'A. Student', keywords: 'quantum', description: 'remarks' },
    }));
    const core = text('docProps/core.xml');
    expect(core).toContain('<dc:title>Thesis</dc:title>');
    expect(core).toContain('<dc:creator>A. Student</dc:creator>');
    expect(core).toContain('>quantum</cp:keywords>');
    expect(core).toContain('<dc:description>remarks</dc:description>');
  });
});
