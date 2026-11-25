<!-- markdownlint-disable MD041 -->

# Changelog

All notable changes to Tensor are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).
## [v1.0.0] - 2026-11-25

### Internal

- Update release workflow

- Update release workflow

- Update release workflow


## [v1.0.0-rc.2] - 2026-11-25

### Added

- Add update auto-check function (#65)

- Translation runtime and en.json source of truth

- First-run setup wizard (#103)

- Split view (#101)

- Sidebar docking + resizing (#101)

- Recovery surfacing + startup library (#103)

- Clean up ribbon (#101)

- App customization (#102)

- Custom topbar (#100)

- Accent engine + brand color (#97)

- Tensor app icon set and bundle metadata (#97)

- Tensor identity and version single-sourcing (#97)

- Comment surfaces

- Comment anchor highlights

- Comment UI infrastructure

- Comment model

- Focus mode

- Pageless selection sync and click-anywhere focus

- The pageless ruler — a read-only mirror of the paginated bar

- The pageless strip and per-document view mode

- Type U+<hex> to insert any Unicode character

- Native symbol tooltips and collapsed MRU chip row

- Unicode character picker

- Document statistics panel

- Sectioned document statistics with readability

- Local translation in the panel, setup card, and model manager

- The local translation engine and run routing

- Local translation models on the Rust wire

- Translate panel, setup dialog, and Review wiring

- Translate wire for LibreTranslate, Google, DeepL

- Translate config, consent gate, and pipeline

- Columns in print, PDF, and DOCX

- Columns dialog, presets, break button, and column ruler

- Column break node

- Column persistence and column-correct rendering

- Balanced columns

- Manual column breaks

- Column flow-slot core

- Watermarks in print, PDF, and DOCX

- Watermark panel and ribbon entry

- Watermark model and page layer

- Page backgrounds in print and PDF export

- Page-style scope in page setup

- Per-page background styles

- Decorative image marking

- Accessibility check panel and review tab trigger

- Document accessibility scan (alt, headings, contrast)

- Line spacing dialog polish

- Document-level widow control in page setup

- The line spacing & page breaks popover

- Pagination properties through docx import and export

- The table panel's pagination controls

- Flow projection through the adapter, tables, and the doc widow default

- Paragraph and heading flow attributes with style resolution

- Row split control (cantSplit)

- Per-section header/footer unlink and re-link

- Page-setup undo and redo

- Labeled paper/background columns, custom-size polish

- Palette footer key hints

- Sections through DOCX, Markdown, and the print walk

- The Page Setup dialog with apply-to scopes

- The mixed-geometry paginated view

- Section breaks and per-section bands

- Per-section page geometry

- Print preview UX improvements

- Tensor-native print pipeline

- Custom print dialog with destination control

- Printing & PDF export

- Print preview modal

- Print rendering

- Page numbers

- MSWord Numbering, theme colors, floating images

- In-place docx file editing

- ToC conversion, fonts, import report

- DOCX import (#38a)

- DOCX export (#37)

- Export and import support for Markdown files

- Equations, tables, tabs, ruler, bands, reference tables

- Inline image objects

- Image typing

- TextStyle.fontVariant — declared line + contentHash coverage

- Pageless/Paginated parity + docs

- M6 line-box semantics — bottom-only leading + block spacing

- Package exports + TextStyle.lineHeight

- Bonds, forced breaks, headings

- Incremental layout

- Page breaking

- Paginated reference-table rendering

- Reference-table ribbon tab, insert dialog and palette commands

- Reference-table container model and generator

- Contextual gutter dynamic content

- Header/footer palette commands

- Header & footer handling

- Contextual ribbon tabs

- Equation dialog interface polish

- Basic equation picker

- Accessibility settings panel

- Proofing settings polish

- Spellcheck base

- Custom context menu

- Table improvements

- Basic table implementation

- Tab/indent drag handling

- Vertical ruler

- Horizontal ruler tab stopping

- Horizontal ruler marker drag handling

- Horizontal ruler base

- Metadata

- Image system polishing

- Floating image compatability

- Update file handling for images

- Custom font tracking

- Font browser

- Line numbering

- Command palette

- Style UI

- Styles registry + base UI

- Misc pagination features

- Margin UI control + px => pt

- Layout UI

- Selection

- Scroll policy + page boundaries

- M4 first pixels — engine-driven PaginatedView


### Build & CI

- Update changelog workflow

- Limit vitest workers


### Changed

- Integrate monorepo engine package

- Delete old pagination files

- Pagination typing revision


### Dependencies

- Pin the Bergamot WASM engine and its prebuild copy

- Add shadcn to developer dependencies


### Fixed

- Enable devtools capabilities in release builds (#110)

- Empty document text decorations

- Enforce UI continuity (#101)

- Document loading defaults

- Character picker dropdown visibility

- Replace the local pair popup with an in-panel list

- Undo page styling independence

- Node type declaration for page numbers

- Image support for Markdown export

- Engine subtree fixes

- Resolve the split-dance mapped position to the boundary

- Disable the WebKitGTK DMABUF renderer to stop WebProcess stalls


### Internal

- Fix Linux cups compatability

- Update versioning

- Release v1.0.0

- Update workflows + docs (#65)

- Cleanup comments, dead code, build fixes (#96)

- Absorb engine into main repository

- Fix typecheck baseline


### Other

- Add project documentation (#98)

- Concepts and configuration reference

- Docs index and getting started

- Feature pages

- Add publishing scaffolding

- IndentRight + firstLineIndent (hanging via negative) — completes the indent family

- Add architecture documentation

- Add contribution guidelines

- UI improvement

- Update app cross-refs

- Add architecture documentation


### Performance

- Final performance pass

- Canvas virtualization


### Testing

- Add Markdown format tests

- Reference-table suite



