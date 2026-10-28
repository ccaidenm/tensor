## Commit conventions

Commits follow the conventional format:

```
type(scope): Description
```

> [!NOTE]
> The **type** describes what the change does: it's what the changelog is built from. The **scope** describes where it lands (or why): it's what history categories are built from. The two axes are independent: any type pairs with any scope.

### Types

| Type | Use for |
|---|---|
| `feat` | New user-visible capability: features, options, controls |
| `fix` | Restores correct behavior: crashes, wrong output, visual bugs |
| `perf` | Same observable behavior, but faster or lighter |
| `refactor` | Code restructure with no behavior change -- users wouldn't notice |
| `docs` | Documentation only: `docs/`, Markdown files |
| `test` | Standalone test work: new coverage, test infrastructure |
| `chore` | Maintenance: scripts, generated files, releases, most dependency bumps |
| `revert` | Reverts a previous commit -- cite its hash in the body |

Ride-alongs don't earn their own type: a bug fix that adds tests is still
`fix`, and code comments travel with whatever commit they accompany.

### Scopes

| Scope | Covers |
|---|---|
| `editor` | The document itself: typing, cursor, selection, undo/redo, formatting application, rulers, line numbers, spell/grammar, find |
| `engine` | `packages/engine/` — pagination: pages, sections, columns, headers/footers, page numbers, pageless mode, watermarks |
| `ui` | App chrome around the document: ribbon, toolbars, dialogs, command palette, shortcuts, settings, UI modes |
| `format` | The file layer: `.wpdoc` codec, DOCX/Markdown/TXT import & export, PDF export |
| `i18n` | (Internationalization) `locales/*.json`, string extraction, translation fixes |
| `a11y` | (Accessibility) ARIA, keyboard navigation, focus management, screen reader support |
| `deps` | Dependency updates (usually paired with `chore` or `fix`) |
| `ci` | GitHub Actions, Vite/TypeScript/Tauri build config |
| *(none)* | Project-wide changes: releases, license, repo-wide docs |

### Rules

1. **Type first, scope second.** Ask what the changelog will say, then where a future search would look.
2. **Why beats where.** When a change serves a cross-cutting concern, the intent wins over the file location: adding an `aria-label` in UI code is `a11y`, not `ui`; translating an existing string is `i18n`.
3. **One primary scope.** Multi-area changes take the dominant area; a genuine 50/50 split takes none.
4. **Focused description.** Imperative mood, lowercase, no trailing period, under 72 characters ("add", not "adds" or "added").

### Choosing between close scopes

| If the change is… | Use | Because |
|---|---|---|
| Floating toolbar, ribbon, dialogs | `ui` | Control surfaces, even when they act on the document |
| Rulers, line numbers | `editor` | They present and measure the document itself |
| Headers, footers, columns, pageless mode | `engine` | Page model and page furniture |
| Print preview | `ui` | It's a viewing mode — the PDF/print *pipeline* is `format` |
| Spell/grammar check, document search | `editor` | Document-content correctness |

### Examples

```
feat(editor): Horizontal ruler base
fix(ui): Toolbar overflow on narrow widths
feat(engine): Balanced column breaking
perf(editor): Batch layout passes between keystrokes
fix(a11y): Focus trap in command palette
fix(i18n): Wwrong plural rule in French
```

### Breaking changes

The saved document is Tensor's real public API. Mark any commit that breaks compatibility with existing documents or user configuration:

```
feat(format)!: revision of .wpdoc section storage

BREAKING CHANGE: documents saved before 0.3 must be re-saved on open
```

> [!IMPORTANT]
> **The `!` goes after the scope**, and the `BREAKING CHANGE:` footer says what breaks and what users must do. Breaking changes are acceptable before 1.0 -- but they must always be marked.
