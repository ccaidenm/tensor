# Import and export

Tensor saves `.wpdoc` natively, and everything else is a conversion with the same rule behind it: what Tensor can model converts exactly; anything it cannot is reported to you, never silently dropped.

## Save As: two formats only

The Save As dialog offers `.wpdoc` and `.docx`. Markdown and PDF are export-only -- saving a `.md` on every keystroke would lose data each time, so Markdown is a deliberate copy (see [Markdown](#markdown)), and PDF comes from the print pipeline (see [PDF and printing](#pdf-and-printing)).

## Word (.docx)

Both directions run through one mapping layer: export and import are inverses through the same tables, so what maps one way maps back.

**Import** -- open a `.docx` from the Open dialog (or drop one on the Start Screen). Word's style names map to Tensor's (Heading 1-6, Quote, Caption, Normal), custom styles ride across verbatim, and Word math (OMML) converts to Tensor equations and back. Anything Tensor cannot model is counted and listed in a report dialog -- what was dropped, converted, or refused -- before you see the document.

Fonts are the one judgment call: a Word file full of Calibri and Aptos has no exact Tensor equivalent. The **Fonts not in Tensor** dialog offers substitutions (Calibri maps to Open Sans, Cambria to Source Serif 4, and so on), so the file opens with a close face instead of a default one.

**Export** -- Tensor menu, Export, **Word Document** (or Save As with the `.docx` extension). Sections, headers and footers, merged table cells, tab stops, hyperlinks, text wrapping around images, watermarks, and page-number fields all have Word spellings. An export either maps a feature 1:1 or reports it -- it never drops silently.

## Markdown

Tensor menu, Export, **Markdown (.md)**. The document's own file is never touched: an export is a copy.

If the document uses anything Markdown cannot represent, a dialog lists the categories -- banded content, reference tables, page breaks, custom formatting -- and asks **Export Anyway** or Cancel before anything writes. Cancelling produces no file.

Images export as *references*: the picture bytes land in a folder next to the file, named by their content hash, and the Markdown points at them. Identical images dedupe to one file.

What Markdown keeps and drops:

| Tensor content | Markdown |
|---|---|
| Paragraphs, headings, hard breaks | Standard |
| Bold, italic, strikethrough, inline code | `**`, `*`, `~~`, backticks |
| Links, lists, quotes, code blocks | Standard |
| Tables | GFM pipe tables; cell decoration collapses to text |
| Block images, inline images | Image references; sizes, alignment, radius, and float are dropped |
| Display equations | `$$ … $$` blocks, LaTeX verbatim; paint attributes dropped |
| Underline, highlight | `++text++` and `==text==` (conventions that round-trip in Tensor) |
| Headers and footers, reference tables, page breaks | Skipped -- no Markdown spelling exists |

**Import** -- the Open dialog accepts `.md` and `.markdown`. Structure parses into the editor; a standalone image line becomes a block image, an image inside text stays inline; images land in the document through the standard pipeline. Remote image URLs are refused, never fetched -- the import finishes and reports what was not imported.

The imported document starts **Untitled** and marked unsaved: the `.md` is not adopted as the document's file. Save As establishes the `.wpdoc`.

## PDF and printing

Press <kbd>Ctrl</kbd>+<kbd>P</kbd> for Print Preview. One layout walk feeds both destinations, chosen in the preview dialog:

- **Printer** -- Tensor enumerates the system's printers; the paper size, duplex picker (one-sided, two-sided long edge, two-sided short edge), and page ranges all apply.
- **PDF** -- writes a PDF file. Tensor's default export folder applies unless you hold the always-ask modifier (Shift by default), which prompts for a location.

Both paths print the paginated document -- what the preview shows is what the engine laid out.
