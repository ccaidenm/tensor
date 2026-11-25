# Tensor Roadmap

Tensor v1.0.0 covers the core word-processor scope: real pagination, the full formatting surface, tables and reference tables, DOCX/Markdown/PDF interoperability, comments, and the accessibility foundation. Everything below is planned but unscheduled — items move up when they move up.

Feature requests? Check here first, then open an issue — and for big ideas, see [CONTRIBUTING.md](CONTRIBUTING.md#big-ideas).

## Near term

Polish and infrastructure — no big features:

- [ ] Code signing for Windows and macOS installers
- [ ] Weblate integration for community translations
- [ ] Auto-update channel (check GitHub Releases, in-app notification)
- [ ] Broader platform QA: Linux distros, macOS hardware
- [ ] System tray (minimize to tray, restore on relaunch)

## Next

The features that make Tensor genuinely serious for long documents:

- [ ] Footnotes & endnotes (auto-numbered, renumbering on delete)
- [ ] Cross-references (to headings, footnotes, bookmarks)
- [ ] Tracked changes (insertions, deletions, accept/reject, review panel)
- [ ] PDF export with password protection

## Later

- [ ] Document templates ("New from template", local template folder)
- [ ] Mail merge (template + CSV/JSON data source)
- [ ] ODT import/export
- [ ] Local version history (file-based snapshots with a timeline view)

## Exploring (no commitment)

Evaluated when there's bandwidth — open an issue if one matters to you:

- Plugin system (sandboxed, user-installable)
- Theme system (ship themes, user-authored themes)
- CLI / headless mode (`tensor --export-pdf document.wpdoc`)
- Split view / side-by-side documents
- Batch operations across documents

## Non-planned

- Accounts, telemetry, or ads
- Cloud storage
