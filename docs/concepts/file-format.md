# The file format

`.wpdoc` is Tensor's own format, and the reason it exists is scope: Word files round-trip through conversion tables, Markdown loses anything it cannot spell, and plain JSON would leave images and metadata to guesswork. The saved document is Tensor's real public API, so it gets a format designed like one.

## What a .wpdoc file actually is

Two generations exist, and both open forever:

| Version | Shape | Media |
|---|---|---|
| v1 | A single plain-JSON file | None -- it predates the media layer |
| v2 | A ZIP container | Images packed alongside the document |

Opening a file unpacks it, validates the document JSON against the schema, and feeds its media into the store. A v1 file is detected by its marker and converted through the same schema -- the converter is permanent, not deprecated, so old documents never stop opening. A file that fails validation fails *loudly*: the error dialog says the file is not a valid document, rather than opening something quietly wrong.

## Inside the v2 container

- **`document.json`** -- the whole document: content, styles, page setup, header and footer content, comments, core properties. Validated by the schema on every open.
- **Media files** -- every image the document references, keyed by content hash (the `media://` ids in the document point at them).

Saving runs a garbage collection: the save walks the *entire* file -- including metadata, because a document-level watermark's image lives there -- collects every referenced media id, and packs only those. Drop an image from the document and its bytes leave with the next save.

Recovery snapshots use the same v2 container, so a crashed session opens with the same guarantees as a saved one.

## What the schema covers

The schema owns shapes the editor trusts without re-checking: the block tree and its attributes, the style registry layer, page setup (sizes, margins, orientation, page color, per-document columns and watermark), header/footer content and the different-first-page flag, line-number settings, comment threads, and document properties (author, title, dates). Absent fields mean unset -- the app defaults -- and a stray value from an older build falls back instead of rejecting the file.

## How it maps to DOCX

DOCX import and export run through one mapping layer used in both directions: Word styles, sections, headers and footers, merged cells, tab stops, hyperlinks, text wrapping, watermarks, and OMML math all have two-way spellings. Anything without one is counted and reported on both paths -- never silently dropped. The [import and export](../features/import-export.md) page covers the user-facing behavior; the mapping tables live in the code beside the format.

## See also

- [Import and export](../features/import-export.md) -- the DOCX, Markdown, and PDF behavior
- [The pagination engine](pagination-engine.md) -- the layout package the document feeds
- [Architecture](architecture.md) -- where the format sits in the layers
