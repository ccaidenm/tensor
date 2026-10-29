# Markdown import/export (M-MD, issue #40)

Tensor exports the current document as a Markdown file and opens existing
Markdown files into the editor. Markdown is a **plain-text, structure-only
format** — this document is the explicit contract for what travels, what is
converted, and what is intentionally left behind (issue #40's "decide and
document explicitly what happens to content with no Markdown equivalent").

The engine is a standalone `MarkdownManager` (`@tiptap/markdown`, GFM on)
built from the production extension list — the editor itself is untouched
(its HTML/JSON command behavior never changes shape).

## Export

**Where:** Tensor menu → Export → Markdown (.md)… and the command palette
("Export Markdown"). The document's own file is never touched — an export is
a copy, not a conversion (`filePath`/dirty state are unchanged).

**The lossy confirm:** if the document uses anything Markdown cannot
represent, an in-app warning dialog (the same shadcn treatment as the
Developer Mode warning in Settings) lists the categories — banded content,
reference tables, page breaks, custom formatting — and asks
**Export Anyway / Cancel** *before* the save dialog opens. Cancelling writes
nothing. A document with none of those categories exports with no dialog.

**Images** export as references into a sibling asset folder:

```
Q3 Report.md
Q3 Report.assets/
  <sha256>.png
  <sha256>.jpeg
```

Filenames are the image content addresses (the same `media://<sha256>` ids
the document model uses), so identical images dedupe to one file and
renaming the .md never breaks the references. References are written
URI-encoded (`./Q3%20Report.assets/<sha>.png`) because raw spaces are not
legal in Markdown link destinations.

## Mapping table

| Tensor content | Markdown |
| --- | --- |
| Paragraphs, headings 1–6, hard breaks | Standard |
| Bold, italic, strikethrough, inline code | `**`, `*`, `~~`, backticks |
| Links | `[text](url)` |
| Bullet / numbered lists | `-` / `1.` (list style types dropped) |
| Blockquote, horizontal rule, fenced code blocks | Standard |
| Tables | GFM pipe tables; per-cell padding and shading dropped; multi-block cell content collapses to inline text |
| Images (block + inline) | `![alt](./<name>.assets/<sha>.<ext>)` — sizes, alignment, radius and float are dropped (Markdown has no dimensions) |
| Equations (display) | `$$ … $$` blocks (Obsidian/Joplin/Pandoc convention), latex verbatim; equation alignment/color/scale dropped |
| Underline | `++text++` and highlight `==text==` — the official conventions; they round-trip in Tensor, mainstream readers render them literally |
| Header & footer content | **Skipped** (document-level bands; no Markdown spelling) |
| Reference tables (ToC/ToF/Index) | **Skipped** — their entries are derived content the generator owns |
| Page breaks | **Skipped** |
| Custom styles, colors, fonts, font sizes, alignment, spacing, indents, tab stops, bookmarks | **Dropped** (counted under "custom formatting" in the export warning) |

Task-list checkboxes from external files degrade to plain list items (the
schema has no task lists).

### Warned vs documented-only

The export confirm fires for content that **disappears** (header/footer
text, reference tables, page breaks) and for **text formatting** Markdown
cannot express (custom styles, colors, fonts, sizes, alignment, spacing,
indents, tab stops). Object **decoration** is documented here, not warned —
those objects are all represented in Markdown and keep their content:
images still render (at natural size — Markdown has no dimensions), the
equation's latex still travels, table cells keep their text. Dropped
without warning: image size/alignment/radius/float, equation
alignment/color/scale, table borders/shading/cell padding, list numbering
styles.

## Import

**Where:** the standard Open… flow (the file dialog accepts `.md` /
`.markdown` alongside `.wpdoc`).

- Structure parses into the editor: headings, paragraphs, inline
  formatting, lists, tables (GFM), links, blockquotes, code, equations
  (`$$`), images.
- A standalone `![pic](…)` line becomes a **block image**; an image inside
  flowing text stays **inline**.
- Images are ingested through the standard pipeline (bytes → sha256 →
  MediaStore), so they land as first-class `media://` references. Markdown
  carries no dimensions — the standard dimension backfill measures them
  after import.
- **Remote images (`http(s)://`) are refused, never fetched** — consistent
  with the app-wide no-silent-fetch posture. Missing or unreadable image
  files are dropped. Either way the import finishes and one dialog reports
  the count ("N images were not imported…").
- The imported document starts **Untitled** (the .md is not adopted as the
  document's file — Save As establishes a `.wpdoc`). It is marked dirty:
  the imported content is unsaved work, covered by the autosave recovery
  copy like any unsaved document.
- Page setup, styles, line numbers and headers/footers do not exist in
  Markdown — defaults apply (gutter off, no bands, default page setup).

## Round-trip honesty

The round-trip test (`src/tests/markdown.test.tsx`, the AC's "structure
survives reasonably") parses → serializes → re-parses a representative
document and requires deep equality. What legitimately does not survive a
Markdown round-trip — and is not a bug: custom styles and all dropped
formatting above, band content, reference tables, page breaks, image
sizing, table cell decoration, and the equation's paint-only attributes.

## Code map

- `src/lib/markdown/specs.ts` — the image/equation handlers (attached by
  extending the real nodes)
- `src/lib/markdown/manager.ts` — the standalone manager, parse/serialize,
  the top-level image promotion
- `src/lib/markdown/lossy.ts` — the loss classifier + warning text
- `src/lib/markdown/exportMarkdown.ts` — confirm gate, save dialog, assets
- `src/lib/markdown/importMarkdown.ts` — read, parse, image ingestion
- `src/lib/markdown/paths.ts` — separator-aware path shims
