// M-DOCX SPIKE v2 — the Word-for-Web bisect instrument. Generates TWO files:
//   /tmp/opencode/spike-minimal.docx — the #3289 control (known-good shape)
//   /tmp/opencode/tensor-spike-v2.docx — the full Tensor-shaped doc, hardened:
//     v1's literal \t inside run text (desktop tolerated; Word's own writer
//     never emits it) is now a real w:tab element via the Tab class, the
//     hyperlink rides ExternalHyperlink (rels + defined style), and the font
//     test moved to its own non-italic paragraph (unambiguous render).
// Run: node scripts/docx-spike.mjs
import { writeFileSync } from 'node:fs';
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  Tab,
  Table,
  TableCell,
  TableBorders,
  TableRow,
  TextRun,
  UnderlineType,
  VerticalMergeType,
  WidthType,
  convertInchesToTwip,
} from 'docx';
import { Math as DocxMath, latexToMath } from 'docx/math';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// ── the control: #3289's minimal repro (maintainer-validated shape) ──
const minimal = new Document({
  sections: [
    {
      properties: {},
      headers: {
        default: new Footer({
          children: [
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [new TextRun({ children: ['Page ', PageNumber.CURRENT] })],
            }),
          ],
        }),
      },
      children: [new Paragraph('Hello world')],
    },
  ],
});

// ── the full Tensor-shaped document, hardened ──
const doc = new Document({
  title: 'Tensor DOCX Spike v2',
  creator: 'Tensor',
  subject: 'Export engine validation',
  keywords: ['tensor', 'spike', 'docx'],
  description: 'The ruling-1 gate document, round two.',
  styles: {
    paragraphStyles: [
      {
        id: 'TensorAbstract',
        name: 'Tensor Abstract',
        basedOn: 'Normal',
        next: 'Normal',
        run: { size: 20, italics: true },
        paragraph: { spacing: { after: 240 } },
      },
    ],
  },
  numbering: {
    config: [
      {
        reference: 'tensor-ordered',
        levels: [
          { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START },
          { level: 1, format: LevelFormat.LOWER_ROMAN, text: '%2.', alignment: AlignmentType.START },
        ],
      },
      {
        reference: 'tensor-bullets',
        levels: [
          { level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.START },
        ],
      },
    ],
  },
  sections: [
    {
      properties: {
        page: {
          size: { width: convertInchesToTwip(8.5), height: convertInchesToTwip(11) },
          margin: {
            top: convertInchesToTwip(1),
            bottom: convertInchesToTwip(1),
            left: convertInchesToTwip(1),
            right: convertInchesToTwip(1),
          },
        },
        titlePage: true,
      },
      headers: {
        default: new Header({ children: [new Paragraph('Tensor header (default)')] }),
        first: new Header({ children: [new Paragraph('Tensor header (first page)')] }),
      },
      footers: {
        default: new Footer({ children: [new Paragraph('Tensor footer')] }),
      },
      children: [
        new Paragraph({ text: 'Spike Document', heading: HeadingLevel.HEADING_1 }),

        new Paragraph({
          style: 'TensorAbstract',
          children: [
            new TextRun({ text: 'Abstract: ', italics: true }),
            new TextRun({ text: 'bold ', bold: true }),
            new TextRun({ text: 'italic ', italics: true }),
            new TextRun({ text: 'underline ', underline: { type: UnderlineType.SINGLE } }),
            new TextRun({ text: 'strike ', strike: true }),
            new TextRun({ text: 'highlight ', highlight: 'yellow' }),
            new TextRun({ text: 'colored ', color: 'AA0000' }),
            new TextRun({ text: 'sized ', size: 28 }),
          ],
        }),

        // The font test now lives OUTSIDE the italic abstract style, so a
        // serif vs sans render is unambiguous this round.
        new Paragraph({
          children: [
            new TextRun({ text: 'The next word is Times New Roman: ' }),
            new TextRun({ text: 'fonted', font: 'Times New Roman' }),
            new TextRun({ text: '.', }),
          ],
        }),

        new Paragraph({
          children: [
            new TextRun({ text: 'A link to ' }),
            new ExternalHyperlink({
              link: 'https://github.com/tensor-editor',
              children: [new TextRun({ text: 'the repo', style: 'Hyperlink' })],
            }),
            new TextRun({
              text: 'and a real tab:',
              children: [],
            }),
            new Tab(),
            new TextRun({ text: 'end', tabStops: [{ type: 'right', position: convertInchesToTwip(6) }] }),
          ],
        }),

        new Paragraph({ text: 'Bullet one', numbering: { reference: 'tensor-bullets', level: 0 } }),
        new Paragraph({ text: 'Ordered one', numbering: { reference: 'tensor-ordered', level: 0 } }),
        new Paragraph({ text: 'Ordered sub (roman)', numbering: { reference: 'tensor-ordered', level: 1 } }),

        new Paragraph({
          children: [
            new ImageRun({
              type: 'png',
              data: TINY_PNG,
              transformation: { width: 120, height: 120 },
              altText: { title: 'spike image', description: 'a one-pixel spike image', name: 'spike' },
            }),
          ],
        }),

        new Paragraph({
          children: [new DocxMath({ children: latexToMath('x^2 + \\frac{a}{b} = \\sqrt{c}') })],
        }),

        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: TableBorders.ALL_SINGLE,
          rows: [
            new TableRow({
              children: [
                new TableCell({
                  columnSpan: 2,
                  shading: { type: ShadingType.CLEAR, fill: 'FFEECC' },
                  children: [new Paragraph('merged header cell')],
                }),
              ],
            }),
            new TableRow({
              children: [
                new TableCell({
                  verticalMerge: VerticalMergeType.RESTART,
                  children: [new Paragraph('rowspan cell')],
                }),
                new TableCell({ children: [new Paragraph('B')] }),
              ],
            }),
            new TableRow({
              children: [
                new TableCell({ verticalMerge: VerticalMergeType.CONTINUE, children: [] }),
                new TableCell({ children: [new Paragraph('D')] }),
              ],
            }),
          ],
        }),

        new Paragraph({ children: [new PageBreak()] }),
        new Paragraph({ text: 'Page two begins here.' }),
      ],
    },
  ],
});

const [minBuf, fullBuf] = await Promise.all([Packer.toBlob(minimal), Packer.toBlob(doc)]);
writeFileSync('/tmp/opencode/spike-minimal.docx', Buffer.from(await minBuf.arrayBuffer()));
writeFileSync('/tmp/opencode/tensor-spike-v2.docx', Buffer.from(await fullBuf.arrayBuffer()));
console.log(
  `wrote /tmp/opencode/spike-minimal.docx (${minBuf.size} bytes) and /tmp/opencode/tensor-spike-v2.docx (${fullBuf.size} bytes)`,
);
