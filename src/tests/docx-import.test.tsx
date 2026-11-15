import { describe, it, expect } from 'vitest';
import { unzipSync, strToU8 } from 'fflate';
import type { JSONContent } from '@tiptap/core';
import {
  collectFontFamilies,
  docxImportNoticeLines,
  ingestDocxMedia,
  mapDocxDocument,
  parseDocxTrees,
  substituteFontFamily,
} from '@/lib/docx/import';
import { buildDocx, type DocxExportInput } from '@/lib/docx/export';
import { DEFAULT_MARGINS } from '@/lib/document/pageSetup';
import { BUILTIN_DEFINITIONS } from '@/lib/styles/builtins';
import { sha256Hex } from '@/lib/media/insert';

/**
 * M-DOCX — the #38a import suite. Hand-written OOXML fixtures (zipped
 * with fflate, the same reader the flow uses) assert the inverse
 * mapping; THE GATE at the bottom runs the full export → import →
 * normalized-equality loop that the in-place .docx editing vision
 * stands on.
 */

// A valid 1x1 red PNG. The GATE's source image must carry the REAL
// content address (import re-ingests by sha256 — that IS the contract).
const TINY_PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);
const SHA = 'e'.repeat(64);
// The GATE's source image carries the REAL content address (import
// re-ingests by sha256 — that IS the contract).
const REAL_SHA = await sha256Hex(TINY_PNG);

const W_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

// The parts shape IS name→bytes — no archive round-trip needed for
// fixtures (fflate 0.8's zipSync returns the archive bytes, not a map).
function zipParts(entries: Record<string, string | Uint8Array>): Record<string, Uint8Array> {
  const parts: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(entries)) {
    parts[name] = typeof value === 'string' ? strToU8(value) : value;
  }
  return parts;
}

const STYLES_XML = `${W_DECL}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="48"/><w:rFonts w:asciiTheme="majorHAnsi"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="MyCallout"><w:name w:val="Callout"/><w:basedOn w:val="Normal"/><w:rPr><w:i/><w:color w:val="224488"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="KeyTerm"><w:name w:val="Key Term"/><w:rPr><w:b/></w:rPr></w:style>
</w:styles>`;

const NUMBERING_XML = `${W_DECL}<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="1">
<w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
<w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl>
</w:abstractNum>
<w:num w:numId="7"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

const IMG_REL = '<Relationship Id="rIdIMG" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>';
const LINK_REL = '<Relationship Id="rIdLNK" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.edu/paper" TargetMode="External"/>';
const HDR_REL = '<Relationship Id="rIdHDR" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>';
const FTR_REL = '<Relationship Id="rIdFTR" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>';

function relsXml(extra: string): string {
  return `${W_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${IMG_REL}${LINK_REL}${HDR_REL}${FTR_REL}${extra}</Relationships>`;
}

function body(children: string): string {
  return `${W_DECL}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${children}</w:body></w:document>`;
}

function runXml(text: string, rPr = ''): string {
  return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
}

function importParts(entries: Record<string, string | Uint8Array>, fontPolicy: 'keep' | 'substitute' = 'keep') {
  const parts = zipParts(entries);
  const trees = parseDocxTrees(parts);
  return mapDocxDocument(trees, { fontPolicy, mediaPartToId: new Map() });
}
void importParts;

describe('docx import — M-FLOW pagination properties', () => {
  it('the pPr pagination block maps to paragraph attrs (on flags, off overrides, break-before)', () => {
    const parts = zipParts({
      'word/document.xml': body(
        `<w:p><w:pPr><w:keepNext/><w:keepLines/><w:pageBreakBefore/></w:pPr>${runXml('a')}</w:p>` +
        `<w:p><w:pPr><w:keepNext w:val="0"/><w:widowControl w:val="0"/></w:pPr>${runXml('b')}</w:p>` +
        `<w:p><w:pPr><w:widowControl/></w:pPr>${runXml('c')}</w:p>`,
      ),
      'word/styles.xml': STYLES_XML,
    });
    const parsed = mapDocxDocument(parseDocxTrees(parts), { fontPolicy: 'keep', mediaPartToId: new Map() });
    const [a, b, c] = parsed.json.content!;
    expect(a!.attrs!.keepNext).toBe(true);
    expect(a!.attrs!.keepLines).toBe(true);
    expect(a!.attrs!.breakBefore).toBe('page');
    // Explicit-off overrides: val="0" → false (must beat a style's on).
    expect(b!.attrs!.keepNext).toBe(false);
    expect(b!.attrs!.widowControl).toBe(false);
    // widowControl PRESENT (on) ≡ absent (Word's default ON) — neither writes.
    expect(c!.attrs!.widowControl).toBeUndefined();
  });

  it('a TRAILING page-break run imports as breakAfter (the previously-lost shape)', () => {
    const parts = zipParts({
      'word/document.xml': body(
        // Word's Ctrl+Enter-at-paragraph-end spelling: text, then a
        // page-break run as the paragraph's last content.
        `<w:p>${runXml('chapter ends')}<w:r><w:br w:type="page"/></w:r></w:p>` +
        `<w:p>${runXml('next page')}</w:p>`,
      ),
      'word/styles.xml': STYLES_XML,
    });
    const parsed = mapDocxDocument(parseDocxTrees(parts), { fontPolicy: 'keep', mediaPartToId: new Map() });
    const [first, second] = parsed.json.content!;
    expect(first!.type).toBe('paragraph');
    expect(first!.attrs!.breakAfter).toBe('page');
    expect((first!.content![0] as { text: string }).text).toBe('chapter ends');
    expect(second!.attrs!.breakAfter).toBeUndefined();
  });

  it('a break with content AFTER it inside one paragraph stays counted (no mid-paragraph breaks)', () => {
    const parts = zipParts({
      'word/document.xml': body(
        `<w:p>${runXml('before')}<w:r><w:br w:type="page"/></w:r>${runXml('after')}</w:p>`,
      ),
      'word/styles.xml': STYLES_XML,
    });
    const parsed = mapDocxDocument(parseDocxTrees(parts), { fontPolicy: 'keep', mediaPartToId: new Map() });
    const first = parsed.json.content![0]!;
    expect(first.type).toBe('paragraph');
    expect(first.attrs!.breakAfter).toBeUndefined();
    expect(parsed.report.unknownNodes).toBe(1);
  });

  it('the standalone break paragraph still maps to the pageBreak node (both break spellings kept)', () => {
    const parts = zipParts({
      'word/document.xml': body(
        `<w:p>${runXml('a')}</w:p><w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p>${runXml('b')}</w:p>`,
      ),
      'word/styles.xml': STYLES_XML,
    });
    const parsed = mapDocxDocument(parseDocxTrees(parts), { fontPolicy: 'keep', mediaPartToId: new Map() });
    expect(parsed.json.content![1]!.type).toBe('pageBreak');
  });

  it('style pPr pagination flags land in the style definitions (the Heading1 keepNext, un-dropped)', () => {
    const parts = zipParts({
      'word/document.xml': body(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${runXml('Title')}</w:p>`),
      'word/styles.xml': STYLES_XML, // Heading1 carries <w:keepNext/> in its pPr
    });
    const parsed = mapDocxDocument(parseDocxTrees(parts), { fontPolicy: 'keep', mediaPartToId: new Map() });
    const heading = parsed.styleDefinitions.find((d) => d.id === 'heading-1')!;
    expect(heading.properties.keepNext).toBe(true);
  });

  it('w:cantSplit imports as the row attr', () => {
    const cell = '<w:tc><w:tcPr><w:gridSpan w:val="1"/></w:tcPr><w:p><w:r><w:t>x</w:t></w:r></w:p></w:tc>';
    const parts = zipParts({
      'word/document.xml': body(
        `<w:tbl><w:tr><w:trPr><w:cantSplit/></w:trPr>${cell}</w:tr>` +
        `<w:tr>${cell}</w:tr></w:tbl>`,
      ),
      'word/styles.xml': STYLES_XML,
    });
    const parsed = mapDocxDocument(parseDocxTrees(parts), { fontPolicy: 'keep', mediaPartToId: new Map() });
    const table = parsed.json.content![0]!;
    expect(table.type).toBe('table');
    const [r0, r1] = table.content!;
    expect(r0!.attrs?.cantSplit).toBe(true);
    expect(r1!.attrs?.cantSplit).toBeUndefined();
  });

  it('ROUND-TRIP: the flow attrs survive export → import (keepNext, widowControl off, cantSplit, breakAfter)', async () => {
    const source = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { keepNext: true, keepLines: true }, content: [{ type: 'text', text: 'kept' }] },
        { type: 'paragraph', attrs: { widowControl: false, breakAfter: 'page' }, content: [{ type: 'text', text: 'breaks after' }] },
        {
          type: 'table',
          content: [
            { type: 'tableRow', attrs: { cantSplit: true }, content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'atomic' }] }] }] },
          ],
        },
      ],
    };
    const input: DocxExportInput = {
      json: source,
      pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: 32 },
      headerFooter: null,
      coreProperties: { title: 'flow', creator: 'Tensor' },
      styleDefinitions: [...BUILTIN_DEFINITIONS],
      baseStyle: { fontFamily: 'Source Serif 4', fontSize: 16 },
      media: new Map(),
    };
    const { bytes } = await buildDocx(input);
    const imported = mapDocxDocument(parseDocxTrees(unzipSync(bytes)), { fontPolicy: 'keep', mediaPartToId: new Map() });
    const [kept, breaksAfter, table] = imported.json.content!;
    expect(kept.attrs!.keepNext).toBe(true);
    expect(kept.attrs!.keepLines).toBe(true);
    expect(breaksAfter.attrs!.widowControl).toBe(false);
    expect(breaksAfter.attrs!.breakAfter).toBe('page');
    expect(table.content![0]!.attrs!.cantSplit).toBe(true);
  });
});

describe('docx import — runs and marks', () => {
  it('rPr maps to marks (bold, italic, strike, underline, highlight, color, font, size)', async () => {
    const parts = zipParts({
      'word/document.xml': body(
        `<w:p><w:r><w:rPr><w:b/><w:i/><w:strike/><w:u/><w:highlight w:val="yellow"/><w:color w:val="AA0000"/><w:rFonts w:ascii="Lora"/><w:sz w:val="30"/></w:rPr><w:t>x</w:t></w:r></w:p>`,
      ),
      'word/styles.xml': STYLES_XML,
    });
    const trees = parseDocxTrees(parts);
    const parsed = mapDocxDocument(trees, { fontPolicy: 'keep', mediaPartToId: new Map() });
    const para = parsed.json.content![0]!;
    expect(para.type).toBe('paragraph');
    const textNode = para.content![0]!;
    expect(textNode.text).toBe('x');
    const marks = textNode.marks ?? [];
    const types = marks.map((m) => m.type);
    expect(types).toContain('bold');
    expect(types).toContain('italic');
    expect(types).toContain('strike');
    expect(types).toContain('underline');
    expect(types).toContain('highlight');
    expect(types).toContain('textStyle');
    const style = marks.find((m) => m.type === 'textStyle')!;
    expect(style.attrs).toEqual({ color: '#AA0000', fontFamily: 'Lora', fontSize: 20 }); // sz 30 → 15pt → 20px
    const highlight = marks.find((m) => m.type === 'highlight')!;
    expect(highlight.attrs!.color).toBe('#FFFF00');
  });

  it('consecutive identical runs merge into one text node', async () => {
    const parts = zipParts({
      'word/document.xml': body(
        `<w:p>${runXml('hel')}${runXml('lo')}</w:p>`,
      ),
      'word/styles.xml': STYLES_XML,
    });
    const trees = parseDocxTrees(parts);
    const parsed = mapDocxDocument(trees, { fontPolicy: 'keep', mediaPartToId: new Map() });
    expect(parsed.json.content![0]!.content![0]!.text).toBe('hello');
  });
});

describe('docx import — links and images', () => {
  it('an external hyperlink maps to the link mark via its relationship', () => {
    const parts = zipParts({
      'word/document.xml': body(
        `<w:p><w:hyperlink r:id="rIdLNK">${runXml('the paper')}</w:hyperlink></w:p>`,
      ),
      'word/styles.xml': STYLES_XML,
      'word/_rels/document.xml.rels': relsXml(''),
    });
    const trees = parseDocxTrees(parts);
    const parsed = mapDocxDocument(trees, { fontPolicy: 'keep', mediaPartToId: new Map() });
    const textNode = parsed.json.content![0]!.content![0]!;
    const link = (textNode.marks ?? []).find((m) => m.type === 'link');
    expect(link!.attrs!.href).toBe('https://example.edu/paper');
  });

  it('an image rides its relationship, sized from the EMU extent', () => {
    const drawing = `<w:drawing><wp:inline><wp:extent cx="1143000" cy="571500"/><wp:docPr id="1" name="pic" descr="the figure"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rIdIMG"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
    const parts = zipParts({
      'word/document.xml': body(`<w:p><w:r>${drawing}</w:r></w:p>`),
      'word/styles.xml': STYLES_XML,
      'word/_rels/document.xml.rels': relsXml(''),
      'word/media/image1.png': TINY_PNG,
    });
    const trees = parseDocxTrees(parts);
    const parsed = mapDocxDocument(trees, { fontPolicy: 'keep', mediaPartToId: new Map([['word/media/image1.png', SHA]]) });
    // THE PROMOTION: a paragraph whose only content is one image → block
    const image = parsed.json.content![0]!;
    expect(image.type).toBe('image');
    expect(image.attrs!.src).toBe(`media://${SHA}`);
    expect(image.attrs!.width).toBe(120); // 1143000 EMU ÷ 9525
    expect(image.attrs!.height).toBe(60);
    expect(image.attrs!.alt).toBe('the figure');
  });
});

describe('docx import — lists', () => {
  it('numbered paragraphs rebuild lists with nesting; a plain paragraph ends the run', () => {
    const parts = zipParts({
      'word/document.xml': body(
        `<w:p><w:pPr><w:numPr><w:numId w:val="7"/><w:ilvl w:val="0"/></w:numPr></w:pPr>${runXml('one')}</w:p>` +
        `<w:p><w:pPr><w:numPr><w:numId w:val="7"/><w:ilvl w:val="0"/></w:numPr></w:pPr>${runXml('two')}</w:p>` +
        `<w:p><w:pPr><w:numPr><w:numId w:val="7"/><w:ilvl w:val="1"/></w:numPr></w:pPr>${runXml('nested')}</w:p>` +
        `<w:p>${runXml('plain ends it')}</w:p>` +
        `<w:p><w:pPr><w:numPr><w:numId w:val="7"/><w:ilvl w:val="0"/></w:numPr></w:pPr>${runXml('fresh')}</w:p>`,
      ),
      'word/styles.xml': STYLES_XML,
      'word/numbering.xml': NUMBERING_XML,
    });
    const trees = parseDocxTrees(parts);
    const parsed = mapDocxDocument(trees, { fontPolicy: 'keep', mediaPartToId: new Map() });
    const [list] = parsed.json.content!;
    expect(list.type).toBe('orderedList');
    expect(list.attrs!.listStyleType).toBe('decimal');
    expect(list.content!.length).toBe(2); // one + two (then the nested list lives inside 'two')
    const twoItem = list.content![1]!;
    const nested = twoItem.content!.find((c) => c.type === 'bulletList');
    expect(nested).toBeTruthy();
    expect(nested!.attrs!.listStyleType).toBe('disc');
    const [plain, fresh] = parsed.json.content!.slice(1);
    expect(plain!.type).toBe('paragraph');
    expect(fresh!.type).toBe('orderedList'); // the interrupted run restarts
    expect(fresh!.content![0]!.content![0]!.content![0]!.text).toBe('fresh');
  });
});

describe('docx import — tables', () => {
  it('gridSpan folds to colspan; vMerge continuations fold into the origin rowspan', () => {
    const parts = zipParts({
      'word/document.xml': body(
        `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single"/><w:bottom w:val="single"/><w:left w:val="single"/><w:right w:val="single"/><w:insideH w:val="single"/><w:insideV w:val="single"/></w:tblBorders></w:tblPr>` +
        `<w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>` +
        `<w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:shd w:val="clear" w:fill="FFEECC"/></w:tcPr><w:p>${runXml('merged')}</w:p></w:tc></w:tr>` +
        `<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p>${runXml('span')}</w:p></w:tc><w:tc><w:p>${runXml('B')}</w:p></w:tc></w:tr>` +
        `<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p></w:p></w:tc><w:tc><w:p>${runXml('D')}</w:p></w:tc></w:tr>` +
        `</w:tbl>`,
      ),
      'word/styles.xml': STYLES_XML,
    });
    const trees = parseDocxTrees(parts);
    const parsed = mapDocxDocument(trees, { fontPolicy: 'keep', mediaPartToId: new Map() });
    const table = parsed.json.content![0]!;
    expect(table.type).toBe('table');
    expect(table.attrs!.borderStyle).toBe('all');
    const [row1, row2, row3] = table.content!;
    expect(row1.content!.length).toBe(1); // the merged cell alone
    expect(row1.content![0]!.attrs!.colspan).toBe(2);
    expect(row1.content![0]!.attrs!.backgroundColor).toBe('#FFEECC');
    const origin = row2.content![0]!;
    expect(origin.attrs!.rowspan).toBe(2); // the continuation FOLDED in
    expect(row2.content!.length).toBe(2);
    expect(row3.content!.length).toBe(1); // the continuation vanished
    expect(row3.content![0]!.content![0]!.content![0]!.text).toBe('D');
    expect(origin.attrs!.colwidth).toEqual([160]); // the origin spans ONE column (rowspan is rows)
  });

  it('a tblHeader row imports its cells as Tensor header cells', () => {
    const parts = zipParts({
      'word/document.xml': body(
        `<w:tbl><w:tblGrid><w:gridCol w:w="2400"/></w:tblGrid>` +
        `<w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:p>${runXml('H')}</w:p></w:tc></w:tr>` +
        `<w:tr><w:tc><w:p>${runXml('a')}</w:p></w:tc></w:tr></w:tbl>`,
      ),
      'word/styles.xml': STYLES_XML,
    });
    const trees = parseDocxTrees(parts);
    const parsed = mapDocxDocument(trees, { fontPolicy: 'keep', mediaPartToId: new Map() });
    const table = parsed.json.content![0]!;
    expect(table.content![0]!.content![0]!.type).toBe('tableHeader');
    expect(table.content![1]!.content![0]!.type).toBe('tableCell');
  });
});

describe('docx import — equations (OMML → LaTeX)', () => {
  it('fractions, radicals and scripts convert to display equations', () => {
    const parts = zipParts({
      'word/document.xml': body(
        `<w:p><m:oMathPara><m:oMath><m:f><m:fPr/><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f><m:r><m:t>=</m:t></m:r><m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e><m:r><m:t>c</m:t></m:r></m:e></m:rad><m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath></m:oMathPara></w:p>`,
      ),
      'word/styles.xml': STYLES_XML,
    });
    const trees = parseDocxTrees(parts);
    const parsed = mapDocxDocument(trees, { fontPolicy: 'keep', mediaPartToId: new Map() });
    const equation = parsed.json.content![0]!;
    expect(equation.type).toBe('equation');
    expect(equation.attrs!.latex).toContain('\\frac{a}{b}');
    expect(equation.attrs!.latex).toContain('\\sqrt{c}');
    expect(equation.attrs!.latex).toContain('{x}^{2}');
    expect(parsed.report.degradedEquations).toBe(0);
  });

  it('an unsupported construct degrades to literal text and is counted', () => {
    const parts = zipParts({
      'word/document.xml': body(
        `<w:p><m:oMathPara><m:oMath><m:groupChr><m:e><m:r><m:t>x</m:t></m:r></m:e></m:groupChr></m:oMath></m:oMathPara></w:p>`,
      ),
      'word/styles.xml': STYLES_XML,
    });
    const trees = parseDocxTrees(parts);
    const parsed = mapDocxDocument(trees, { fontPolicy: 'keep', mediaPartToId: new Map() });
    const equation = parsed.json.content![0]!;
    expect(equation.attrs!.latex).toContain('x');
    expect(parsed.report.degradedEquations).toBe(1);
  });
});

describe('docx import — sections, bands, settings', () => {
  const SECTION = `<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1080" w:right="1440" w:bottom="1080" w:left="1440"/><w:titlePg/><w:lnNumType w:countBy="5" w:restart="newPage"/>` +
    `<w:headerReference w:type="default" r:id="rIdHDR"/><w:headerReference w:type="first" r:id="rIdHDR"/><w:footerReference w:type="default" r:id="rIdFTR"/></w:sectPr>`;

  it('page setup lands as the preset + orientation; margins land in pt', () => {
    const parts = zipParts({
      'word/document.xml': body(`${runXml('x')}${SECTION}`),
      'word/styles.xml': STYLES_XML,
      'word/_rels/document.xml.rels': relsXml(''),
    });
    const trees = parseDocxTrees(parts);
    const parsed = mapDocxDocument(trees, { fontPolicy: 'keep', mediaPartToId: new Map() });
    // A4 landscape: Word writes the SWAPPED dims — Tensor stores the
    // portrait preset + the orientation flag.
    expect(parsed.pageSetup.pageSize).toBe('A4');
    expect(parsed.pageSetup.orientation).toBe('landscape');
    expect(parsed.pageSetup.margins.top).toBe(54); // 1080tw → 54pt
    expect(parsed.pageSetup.margins.left).toBe(72); // 1440tw → 72pt
    expect(parsed.headerFooter.differentFirstPage).toBe(true);
    expect(parsed.lineNumbers).toEqual({ enabled: true, mode: 'per-page', countBy: 5 });
  });

  it('header/footer parts become band nodes (first variant honored)', () => {
    const parts = zipParts({
      'word/document.xml': body(`${runXml('x')}${SECTION}`),
      'word/styles.xml': STYLES_XML,
      'word/_rels/document.xml.rels': relsXml(''),
      'word/header1.xml': `${W_DECL}<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p>${runXml('running header')}</w:p></w:hdr>`,
      'word/footer1.xml': `${W_DECL}<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p>${runXml('the footer')}</w:p></w:ftr>`,
    });
    const trees = parseDocxTrees(parts);
    const parsed = mapDocxDocument(trees, { fontPolicy: 'keep', mediaPartToId: new Map() });
    const content = parsed.json.content!;
    const header = content.find((n) => n.type === 'headerBlock');
    expect(header!.attrs!.variant).toBe('default');
    expect(header!.content![0]!.content![0]!.text).toBe('running header');
    const footer = content[content.length - 1]!;
    expect(footer.type).toBe('footerBlock');
    expect(footer.content![0]!.content![0]!.text).toBe('the footer');
  });
});

describe('docx import — styles', () => {
  it('Word styles map to Tensor ids with basedOn chains flattened over docDefaults', () => {
    const parts = zipParts({
      'word/document.xml': body(
        `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${runXml('Title')}</w:p>` +
        `<w:p><w:pPr><w:pStyle w:val="MyCallout"/></w:pPr>${runXml('callout')}<w:r><w:rPr><w:rStyle w:val="KeyTerm"/></w:rPr><w:t>term</w:t></w:r></w:p>`,
      ),
      'word/styles.xml': STYLES_XML,
    });
    const trees = parseDocxTrees(parts);
    const parsed = mapDocxDocument(trees, { fontPolicy: 'keep', mediaPartToId: new Map() });
    const ids = parsed.styleDefinitions.map((d) => d.id);
    expect(ids).toContain('heading-1');
    expect(ids).toContain('normal');
    expect(ids).toContain('MyCallout');
    expect(ids).toContain('KeyTerm');
    const heading = parsed.styleDefinitions.find((d) => d.id === 'heading-1')!;
    expect(heading.properties.bold).toBe(true);
    expect(heading.properties.fontSize).toBe(32); // sz 48 → 24pt → 32px
    // the basedOn chain carries the docDefaults font into Heading1
    expect(heading.properties.fontFamily).toBe('Times New Roman');
    const callout = parsed.styleDefinitions.find((d) => d.id === 'MyCallout')!;
    expect(callout.properties.italic).toBe(true);
    expect(callout.properties.color).toBe('#224488');
    // the paragraphs reference the mapped ids
    expect(parsed.json.content![0]!.attrs!.styleId).toBe('heading-1');
    const calloutPara = parsed.json.content![1]!;
    expect(calloutPara.attrs!.styleId).toBe('MyCallout');
    const termRun = calloutPara.content![1]!;
    expect((termRun.marks ?? []).some((m) => m.type === 'charStyle' && m.attrs!.styleId === 'KeyTerm')).toBe(true);
  });
});

describe('docx import — numbering restart fidelity', () => {
  it('startOverride rides the rebuilt list\'s start', () => {
    const numbering = `${W_DECL}<w:numbering xmlns:w="x">` +
      `<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>` +
      `<w:num w:numId="9"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride></w:num>` +
      `</w:numbering>`;
    const parts = zipParts({
      'word/document.xml': body(
        `<w:p><w:pPr><w:numPr><w:numId w:val="9"/><w:ilvl w:val="0"/></w:numPr></w:pPr>${runXml('five')}</w:p>`,
      ),
      'word/styles.xml': STYLES_XML,
      'word/numbering.xml': numbering,
    });
    const trees = parseDocxTrees(parts);
    const parsed = mapDocxDocument(trees, { fontPolicy: 'keep', mediaPartToId: new Map() });
    const list = parsed.json.content![0]!;
    expect(list.type).toBe('orderedList');
    expect(list.attrs!.start).toBe(5);
  });
});

describe('docx import — the loud postures', () => {
  it('tracked deletions drop and count; insertions keep', () => {
    const parts = zipParts({
      'word/document.xml': body(
        `<w:p>${runXml('kept ')}<w:del w:id="1"><w:r><w:delText>gone</w:delText></w:r></w:del><w:ins w:id="2">${runXml('inserted')}</w:ins></w:p>`,
      ),
      'word/styles.xml': STYLES_XML,
    });
    const trees = parseDocxTrees(parts);
    const parsed = mapDocxDocument(trees, { fontPolicy: 'keep', mediaPartToId: new Map() });
    const textNode = parsed.json.content![0]!.content![0]!;
    expect(textNode.text).toBe('kept inserted');
    expect(parsed.report.trackedChanges).toBe(1);
    expect(docxImportNoticeLines(parsed.report).some((l) => l.includes('Tracked changes imported as final'))).toBe(true);
  });

  it('PAGE fields are suppressed and counted; a TOC becomes a LIVE Tensor ToC', () => {
    const parts = zipParts({
      'word/document.xml': body(
        `<w:p>${runXml('page ')}<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>` +
        `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>TOC \o "1-3"</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:hyperlink w:anchor="_Toc1">${runXml('cached entry')}</w:hyperlink></w:p>` +
        `<w:p><w:hyperlink w:anchor="_Toc2">${runXml('second entry')}</w:hyperlink><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
      ),
      'word/styles.xml': STYLES_XML,
    });
    const trees = parseDocxTrees(parts);
    const parsed = mapDocxDocument(trees, { fontPolicy: 'keep', mediaPartToId: new Map() });
    const firstPara = parsed.json.content![0]!;
    // M-PAGEFIELD: the field IMPORTS as the live node — the cached
    // "3" never landed (the node resolves per page).
    expect(firstPara.type).toBe('paragraph');
    expect(firstPara.content!.some((c) => c.type === 'pageField' && c.attrs!.kind === 'page')).toBe(true);
    expect(firstPara.content!.some((c) => c.type === 'text' && c.text === '3')).toBe(false);
    expect(parsed.report.pageFields).toBe(0); // they import — never dropped
    expect(docxImportNoticeLines(parsed.report).some((l) => l.includes('Page-number fields'))).toBe(false);
    // THE CONVERSION: the dead Word field became a LIVE reference table
    const toc = parsed.json.content![1]!;
    expect(toc.type).toBe('referenceTable');
    expect(toc.attrs!.kind).toBe('toc');
    expect(toc.attrs!.depth).toBe(3); // parsed from \o "1-3"
    const entryTexts = JSON.stringify(toc.content);
    expect(entryTexts).toContain('cached entry');
    expect(entryTexts).toContain('second entry');
    expect(parsed.report.tocFields).toBe(1);
    // the ToC's own anchors are its machinery, not dropped content
    expect(parsed.report.internalLinks).toBe(0);
    expect(docxImportNoticeLines(parsed.report).some((l) => l.includes('live Tensor ToC'))).toBe(true);
  });

  it('footnote references and comments are counted, not imported', () => {
    const parts = zipParts({
      'word/document.xml': body(
        `<w:p>${runXml('text')}<w:r><w:footnoteReference w:id="2"/></w:r><w:commentRangeStart w:id="1"/>${runXml(' more')}<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p>`,
      ),
      'word/styles.xml': STYLES_XML,
    });
    const trees = parseDocxTrees(parts);
    const parsed = mapDocxDocument(trees, { fontPolicy: 'keep', mediaPartToId: new Map() });
    expect(parsed.report.footnotes).toBe(1);
    expect(parsed.report.comments).toBeGreaterThanOrEqual(1);
    expect(parsed.json.content![0]!.content![0]!.text).toBe('text more');
  });
});

describe('docx import — THEME fonts (the dialog that never fired)', () => {
  // Modern Word documents reference fonts as asciiTheme="minorHAnsi"
  // (pointing at theme1.xml) — never literal rFonts. The theme part
  // resolves: the inventory flags Calibri (the dialog fires) and the
  // docDefaults/normal definition carries the document's real font.
  const THEME_XML = `${W_DECL}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:fontScheme><a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;

  it('asciiTheme resolves through theme1.xml; the inventory flags it', () => {
    const parts = zipParts({
      'word/document.xml': body(
        `<w:p><w:r><w:rPr><w:rFonts w:asciiTheme="minorHAnsi"/></w:rPr><w:t>body text</w:t></w:r></w:p>` +
        `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>`,
      ),
      'word/styles.xml': STYLES_XML.replace('<w:rFonts w:ascii="Times New Roman"/>', '<w:rFonts w:asciiTheme="minorHAnsi"/>'),
      'word/theme/theme1.xml': THEME_XML,
    });
    const trees = parseDocxTrees(parts);
    expect(trees.theme!.minor).toBe('Calibri');
    expect(trees.theme!.major).toBe('Calibri Light');
    // the inventory: the theme fonts are the document's fonts
    const fonts = collectFontFamilies(trees);
    expect(fonts.unknown).toContain('Calibri');
    expect(fonts.unknown).toContain('Calibri Light');
    // keep: the resolved theme name rides the run mark AND the normal def
    const kept = mapDocxDocument(trees, { fontPolicy: 'keep', mediaPartToId: new Map() });
    const bodyRun = kept.json.content![0]!.content![0]!;
    const mark = (bodyRun.marks ?? []).find((m) => m.type === 'textStyle');
    expect(mark!.attrs!.fontFamily).toBe('Calibri');
    const normal = kept.styleDefinitions.find((d) => d.id === 'normal')!;
    expect(normal.properties.fontFamily).toBe('Calibri');
    // substitute: Calibri → Open Sans everywhere
    const substituted = mapDocxDocument(trees, { fontPolicy: 'substitute', mediaPartToId: new Map() });
    const subNormal = substituted.styleDefinitions.find((d) => d.id === 'normal')!;
    expect(subNormal.properties.fontFamily).toBe('Open Sans');
  });
});

describe('docx import — page fields (M-PAGEFIELD round-trip)', () => {
  it('fldSimple PAGE/NUMPAGES in a band part import as live fields', () => {
    const parts = zipParts({
      'word/document.xml': body(
        `<w:p><w:r><w:t>x</w:t></w:r></w:p>` +
        `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:headerReference w:type="default" r:id="rIdHDR"/></w:sectPr>`,
      ),
      'word/styles.xml': STYLES_XML,
      'word/_rels/document.xml.rels': relsXml(''),
      'word/header1.xml': `${W_DECL}<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p>${runXml('Page ')}<w:fldSimple w:instr="PAGE"/><w:r><w:t xml:space="preserve"> of </w:t></w:r><w:fldSimple w:instr="NUMPAGES"/></w:p></w:hdr>`,
    });
    const trees = parseDocxTrees(parts);
    const parsed = mapDocxDocument(trees, { fontPolicy: 'keep', mediaPartToId: new Map() });
    const header = parsed.json.content!.find((n) => n.type === 'headerBlock')!;
    const para = header.content![0]!;
    const kinds = para.content!.filter((c) => c.type === 'pageField').map((c) => (c.attrs as { kind?: string }).kind);
    expect(kinds).toEqual(['page', 'pages']);
    // the literal text survives around the fields
    expect(para.content!.some((c) => c.type === 'text' && c.text === 'Page ')).toBe(true);
    expect(para.content!.some((c) => c.type === 'text' && c.text === ' of ')).toBe(true);
  });
});

describe('docx import — THEME colors', () => {
  const THEME_COLORS = `${W_DECL}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme><a:dk1><a:sysClr w:val="windowText" w:lastClr="000000"/></a:dk1><a:lt1><a:sysClr w:val="window" w:lastClr="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2></a:clrScheme></a:themeElements></a:theme>`;

  it('themeColor references resolve through the clrScheme (with shade)', () => {
    const parts = zipParts({
      'word/document.xml': body(
        `<w:p><w:r><w:rPr><w:color w:val="auto" w:themeColor="accent1"/></w:rPr><w:t>themed</w:t></w:r></w:p>` +
        `<w:p><w:r><w:rPr><w:color w:val="auto" w:themeColor="accent1" w:themeShade="80"/></w:rPr><w:t>shaded</w:t></w:r></w:p>`,
      ),
      'word/styles.xml': STYLES_XML,
      'word/theme/theme1.xml': THEME_COLORS,
    });
    const trees = parseDocxTrees(parts);
    const parsed = mapDocxDocument(trees, { fontPolicy: 'keep', mediaPartToId: new Map() });
    const first = parsed.json.content![0]!.content![0]!;
    const mark = (first.marks ?? []).find((m) => m.type === 'textStyle')!;
    expect(mark.attrs!.color).toBe('#4472C4'); // accent1 straight
    const second = parsed.json.content![1]!.content![0]!;
    const shaded = (second.marks ?? []).find((m) => m.type === 'textStyle')!;
    // shade 0x80 (128/255): each channel scales — 0x44→0x22, 0x72→0x39, 0xC4→0x62
    expect(shaded.attrs!.color).toBe('#223962');
  });
});

describe('docx import — floats and vertAlign', () => {
  const ANCHOR_IMG = (behind: boolean): string =>
    `<w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" allowOverlap="1" behindDoc="${behind ? 1 : 0}" locked="0" layoutInCell="1">` +
    `<wp:simplePos x="0" y="0"/>` +
    `<wp:positionH relativeFrom="column"><wp:posOffset>228600</wp:posOffset></wp:positionH>` +
    `<wp:positionV relativeFrom="paragraph"><wp:posOffset>-114300</wp:posOffset></wp:positionV>` +
    `<wp:extent cx="1143000" cy="571500"/><wp:wrapNone/>` +
    `<wp:docPr id="1" name="pic" descr="floating figure"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rIdIMG"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing>`;

  it('an anchored drawing maps to Tensor\'s float model (dx/dy px, z-order)', () => {
    const parts = zipParts({
      'word/document.xml': body(`<w:p><w:r>${ANCHOR_IMG(true)}</w:r></w:p>`),
      'word/styles.xml': STYLES_XML,
      'word/_rels/document.xml.rels': relsXml(''),
      'word/media/image1.png': TINY_PNG,
    });
    const trees = parseDocxTrees(parts);
    const parsed = mapDocxDocument(trees, { fontPolicy: 'keep', mediaPartToId: new Map([['word/media/image1.png', SHA]]) });
    const image = parsed.json.content![0]!;
    expect(image.type).toBe('image'); // solo anchor → block image
    expect(image.attrs!.float).toEqual({ dx: 24, dy: -12, z: 'behind' }); // EMU → px
    expect(image.attrs!.alt).toBe('floating figure');
    expect(parsed.report.wrapAroundFloats).toBe(0); // wrapNone maps exactly
  });

  it('text-wrap floats import as overlays and are counted', () => {
    const wrapSquare = ANCHOR_IMG(false).replace('<wp:wrapNone/>', '<wp:wrapSquare wrapText="bothSides"/>');
    const parts = zipParts({
      'word/document.xml': body(`<w:p><w:r>${wrapSquare}</w:r></w:p>`),
      'word/styles.xml': STYLES_XML,
      'word/_rels/document.xml.rels': relsXml(''),
      'word/media/image1.png': TINY_PNG,
    });
    const trees = parseDocxTrees(parts);
    const parsed = mapDocxDocument(trees, { fontPolicy: 'keep', mediaPartToId: new Map([['word/media/image1.png', SHA]]) });
    expect(parsed.json.content![0]!.attrs!.float!.z).toBe('front');
    expect(parsed.report.wrapAroundFloats).toBe(1);
    expect(docxImportNoticeLines(parsed.report).some((l) => l.includes('approximate'))).toBe(true);
  });

  it('vertAlign (sub/superscript) is dropped and counted', () => {
    const parts = zipParts({
      'word/document.xml': body(
        `<w:p>${runXml('plain ')}<w:r><w:rPr><w:vertAlign w:val="subscript"/></w:rPr><w:t>sub</w:t></w:r></w:p>`,
      ),
      'word/styles.xml': STYLES_XML,
    });
    const trees = parseDocxTrees(parts);
    const parsed = mapDocxDocument(trees, { fontPolicy: 'keep', mediaPartToId: new Map() });
    expect(parsed.report.vertAligns).toBe(1);
    // the text survives — the dropped vertAlign leaves identical
    // formatting, so the runs merge into one node
    expect(parsed.json.content![0]!.content![0]!.text).toBe('plain sub');
    expect(docxImportNoticeLines(parsed.report).some((l) => l.includes('Sub/superscripts dropped (1)'))).toBe(true);
  });
});

describe('docx import — fonts (ruling 4)', () => {
  it('families outside the catalog are flagged; substitution rewrites them', () => {
    const parts = zipParts({
      'word/document.xml': body(
        `<w:p><w:r><w:rPr><w:rFonts w:ascii="Calibri"/><w:sz w:val="28"/></w:rPr><w:t>x</w:t></w:r></w:p>`,
      ),
      'word/styles.xml': STYLES_XML,
    });
    const trees = parseDocxTrees(parts);
    const fonts = collectFontFamilies(trees);
    expect(fonts.unknown).toContain('Calibri');
    expect(fonts.known).toContain('Times New Roman'); // from docDefaults
    // keep: the name rides verbatim
    const kept = mapDocxDocument(trees, { fontPolicy: 'keep', mediaPartToId: new Map() });
    const keptStyle = (kept.json.content![0]!.content![0]!.marks ?? []).find((m) => m.type === 'textStyle')!;
    expect(keptStyle.attrs!.fontFamily).toBe('Calibri');
    // substitute: the closest bundled family
    const substituted = mapDocxDocument(trees, { fontPolicy: 'substitute', mediaPartToId: new Map() });
    const subStyle = (substituted.json.content![0]!.content![0]!.marks ?? []).find((m) => m.type === 'textStyle')!;
    expect(subStyle.attrs!.fontFamily).toBe('Open Sans');
    expect(substituteFontFamily('Cambria')).toBe('Source Serif 4');
    expect(substituteFontFamily('Consolas')).toBe('JetBrains Mono');
  });
});

// ─── THE ROUND-TRIP GATE ─────────────────────────────────────────────────

/** Strip everything both directions agree to be default-valued — the
 *  equality contract both mappings must satisfy. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize).filter((v) => v != null);
  if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(node)) {
      if (key === 'attrs') {
        const attrs = normalizeAttrs((v ?? {}) as Record<string, unknown>);
        if (Object.keys(attrs).length) out.attrs = attrs;
        continue;
      }
      if (key === 'marks') {
        const marks = ((v ?? []) as Record<string, unknown>[]).slice().sort((a, b) => String(a.type).localeCompare(String(b.type)));
        if (marks.length) out.marks = marks;
        continue;
      }
      if (key === 'content') {
        const content = ((v ?? []) as unknown[]).map(normalize).filter((c) => c != null);
        if (content.length) out.content = content;
        continue;
      }
      if (v == null || v === false || v === '') continue;
      out[key] = v;
    }
    return out;
  }
  return value;
}

const ATTR_DEFAULTS: Record<string, unknown> = {
  styleId: 'normal', textAlign: 'left', indentLeft: 0, indentRight: 0,
  firstLineIndent: 0, spaceBefore: 0, spaceAfter: 0, align: 'left',
  keepNext: false, radius: 0, float: null, color: null, scale: 1,
  colspan: 1, rowspan: 1, alt: '', lineColor: null,
};
const ATTR_DROPPED = new Set(['blockId', 'refId', 'lineHeight', 'tabStops']);

function normalizeAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(attrs)) {
    if (ATTR_DROPPED.has(key)) continue;
    if (key in ATTR_DEFAULTS && v === ATTR_DEFAULTS[key]) continue;
    if (v == null || v === false || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[key] = v;
  }
  return out;
}

async function roundTrip(json: JSONContent, pageSetup?: Partial<DocxExportInput['pageSetup']>): Promise<ReturnType<typeof mapDocxDocument>> {
  const input: DocxExportInput = {
    json,
    pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: 32, ...pageSetup },
    headerFooter: null,
    coreProperties: { title: 'Gate' },
    styleDefinitions: [...BUILTIN_DEFINITIONS],
    baseStyle: { fontFamily: 'Source Serif 4', fontSize: 16 },
    media: new Map([[REAL_SHA, { bytes: TINY_PNG, ext: 'png' }]]),
  };
  const { bytes } = await buildDocx(input);
  const parts = unzipSync(bytes);
  const { partToId, entries } = await ingestDocxMedia(parts);
  const trees = parseDocxTrees(parts);
  void entries;
  return mapDocxDocument(trees, { fontPolicy: 'keep', mediaPartToId: partToId });
}

describe('THE ROUND-TRIP GATE (export → import → normalized equality)', () => {
  it('the representative document survives the loop', async () => {
    const source: JSONContent = doc(
      { type: 'headerBlock', attrs: { variant: 'default' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'running header' }] }] },
      { type: 'heading', attrs: { level: 2, styleId: 'heading-2' }, content: [{ type: 'text', text: 'Chapter' }] },
      { type: 'paragraph', content: [
        { type: 'text', text: 'bold text', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' and ' },
        { type: 'text', text: 'linked', marks: [{ type: 'link', attrs: { href: 'https://example.edu' } }, { type: 'italic' }] },
      ] },
      {
        type: 'bulletList',
        attrs: { listStyleType: 'disc' },
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'outer' }] }] },
          { type: 'listItem', content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'deeper' }] },
            { type: 'orderedList', attrs: { listStyleType: 'lower-roman' }, content: [
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nested' }] }] },
            ] },
          ] },
        ],
      },
      {
        type: 'table',
        attrs: { borderStyle: 'all' },
        content: [
          { type: 'tableRow', content: [
            { type: 'tableHeader', attrs: { colwidth: [160] }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
            { type: 'tableHeader', attrs: { colwidth: [160] }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }] },
          ] },
          { type: 'tableRow', content: [
            { type: 'tableCell', attrs: { colspan: 2, colwidth: [160, 160] }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'wide' }] }] },
          ] },
        ],
      },
      { type: 'image', attrs: { src: `media://${REAL_SHA}`, width: 120, height: 60, alt: 'the figure' } },
      { type: 'image', attrs: { src: `media://${REAL_SHA}`, width: 90, height: 90, alt: 'the float', float: { dx: 24, dy: -12, z: 'front' } } },
      { type: 'equation', attrs: { latex: 'E=mc^2' } },
      { type: 'pageBreak' },
      { type: 'horizontalRule' },
      { type: 'paragraph', content: [{ type: 'text', text: 'tab\tstop' }] },
      { type: 'paragraph', attrs: { textAlign: 'center' }, content: [{ type: 'text', text: 'centered' }] },
      { type: 'footerBlock', attrs: { variant: 'default' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'the footer' }] }] },
    );

    const imported = await roundTrip(source);
    // The document skeleton: bands at the ends, everything between.
    const normalizedSource = normalize(source) as { content: unknown[] };
    const normalizedImport = normalize(imported.json) as { content: unknown[] };
    // The equation's latex is canonically RE-SPELLED by Word's format
    // (OMML is the storage) — compare shape, not the string.
    const sourceContent = normalizedSource.content.map((n) => ((n as { type: string }).type === 'equation' ? { type: 'equation' } : n));
    const importContent = normalizedImport.content.map((n) => ((n as { type: string }).type === 'equation' ? { type: 'equation' } : n));
    expect(importContent).toEqual(sourceContent);
    // The equation SURVIVED as native math (a real fraction of the source).
    const equation = imported.json.content!.find((n) => n.type === 'equation');
    expect(equation!.attrs!.latex).toContain('E=m'); // the OMML round-trip re-spells (semantically identical)
    // The report is CLEAN for this document (everything mapped).
    expect(docxImportNoticeLines(imported.report)).toEqual([]);
    // Settings round-trip.
    expect(imported.pageSetup.pageSize).toBe('Letter');
    expect(imported.pageSetup.margins).toEqual({ top: 72, bottom: 72, left: 72, right: 72 });
    expect(imported.coreProperties.title).toBe('Gate');
  });

  it('multi-section documents round-trip (breaks + per-section bands)', async () => {
    // Three sections: A4 for section 0 (custom header), Narrow margins
    // for section 1 (NO own header — inherits), the final on Letter
    // with the doc-default header. Section 0's header DIFFERS from the
    // doc default → a tagged container; section 1's would equal the
    // default (it has none) → inherits, no container.
    const source = doc(
      { type: 'headerBlock', attrs: { variant: 'default', sectionId: 'sec-0' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 's0 header' }] }] },
      { type: 'headerBlock', attrs: { variant: 'default' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'doc default' }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
      { type: 'sectionBreak', attrs: { setup: { pageSize: 'A4', margins: DEFAULT_MARGINS, pageGap: 32 }, sectionId: 'sec-0' } },
      { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
      { type: 'sectionBreak', attrs: { setup: { pageSize: 'Letter', margins: { top: 36, bottom: 36, left: 36, right: 36 }, pageGap: 32 } } },
      { type: 'paragraph', content: [{ type: 'text', text: 'three' }] },
    );
    const imported = await roundTrip(source);
    const content = imported.json.content ?? [];

    // TWO break nodes survive (three sections); the store pageSetup =
    // the FINAL section's (Letter/Normal).
    const breaks = content.filter((n) => n.type === 'sectionBreak');
    expect(breaks).toHaveLength(2);
    expect(imported.pageSetup.pageSize).toBe('Letter');
    expect(imported.pageSetup.margins).toEqual(DEFAULT_MARGINS);
    // Break 0 carries section 0's props (A4) — the PRECEDING spelling.
    expect((breaks[0]!.attrs as { setup?: { pageSize?: string } }).setup?.pageSize).toBe('A4');
    // Break 1 carries section 1's props (the Narrow margins).
    expect((breaks[1]!.attrs as { setup?: { margins?: { top?: number } } }).setup?.margins?.top).toBe(36);

    // The band containers: the doc default (untagged) + section 0's
    // tagged override (its content differs from the default). Section
    // 1 has no own header → no container (it inherits).
    const headers = content.filter((n) => n.type === 'headerBlock');
    expect(headers).toHaveLength(2);
    const tagged = headers.find((h) => (h.attrs as { sectionId?: string }).sectionId);
    expect(tagged).toBeTruthy();
    expect(tagged!.content![0]!.content![0]!.text).toBe('s0 header');
    const untagged = headers.find((h) => !(h.attrs as { sectionId?: string }).sectionId);
    expect(untagged!.content![0]!.content![0]!.text).toBe('doc default');

    // No loss lines: the breaks are no longer collapsed.
    expect(docxImportNoticeLines(imported.report)).toEqual([]);
  });

  it('custom styles and char styles round-trip through the Word spelling', async () => {
    const defs = [
      ...BUILTIN_DEFINITIONS,
      { id: 'my-callout', name: 'Callout', kind: 'paragraph' as const, properties: { italic: true } },
    ];
    const source: JSONContent = doc(
      { type: 'paragraph', attrs: { styleId: 'my-callout' }, content: [{ type: 'text', text: 'callout body' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'term', marks: [{ type: 'charStyle', attrs: { styleId: 'strong' } }] }] },
    );
    const input: DocxExportInput = {
      json: source,
      pageSetup: { pageSize: 'Letter', margins: DEFAULT_MARGINS, pageGap: 32 },
      headerFooter: null,
      coreProperties: {},
      styleDefinitions: defs,
      baseStyle: { fontFamily: 'Source Serif 4', fontSize: 16 },
      media: new Map(),
    };
    const { bytes } = await buildDocx(input);
    const parts = unzipSync(bytes);
    const trees = parseDocxTrees(parts);
    const imported = mapDocxDocument(trees, { fontPolicy: 'keep', mediaPartToId: new Map() });
    expect(normalize(imported.json)).toEqual(normalize(source));
    // the imported DOC LAYER carries the custom definition back
    expect(imported.styleDefinitions.map((d) => d.id)).toContain('my-callout');
  });
});

function doc(...children: JSONContent[]): JSONContent {
  return { type: 'doc', content: children };
}
