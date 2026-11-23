# Shortcuts

Every keyboard shortcut lives in one registry -- what the app listens for, what Settings can rebind, and what this page documents all come from the same source. Nothing here is a default you have to remember: the command palette runs any command by name.

## The command palette

Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> and type. The palette fuzzy-matches every command -- open, export, insert, format -- and runs it without a shortcut existing at all. It also takes direct table dimensions: typing `4x3` inserts a four-by-three table.

## General

| Shortcut | Action |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Save |
| <kbd>Ctrl</kbd>+<kbd>O</kbd> | Open |
| <kbd>Ctrl</kbd>+<kbd>N</kbd> | New document |
| <kbd>Ctrl</kbd>+<kbd>Q</kbd> | Quit |
| <kbd>Ctrl</kbd>+<kbd>,</kbd> | Settings |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> | Command palette |
| <kbd>Ctrl</kbd>+<kbd>P</kbd> | Print preview |

## Editing

| Shortcut | Action |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>F</kbd> | Find and replace |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd> | Undo / redo (owned by the OS; listed for reference, not rebindable) |
| <kbd>F7</kbd> | Toggle spell check |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>M</kbd> | Add comment |
| <kbd>Alt</kbd>+<kbd>=</kbd> | Insert equation |

## Formatting

| Shortcut | Action |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>B</kbd> | Bold |
| <kbd>Ctrl</kbd>+<kbd>I</kbd> | Italic |
| <kbd>Ctrl</kbd>+<kbd>U</kbd> | Underline |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> | Strikethrough |
| <kbd>Ctrl</kbd>+<kbd>\</kbd> | Clear formatting |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>.</kbd> / <kbd>,</kbd> | Font size up / down |

## Paragraphs

| Shortcut | Action |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> / <kbd>E</kbd> / <kbd>R</kbd> / <kbd>J</kbd> | Align left / center / right / justify |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>8</kbd> / <kbd>7</kbd> | Bullet / numbered list |
| <kbd>Ctrl</kbd>+<kbd>]</kbd> / <kbd>[</kbd> | Increase / decrease indent |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>4</kbd>…<kbd>6</kbd> | Heading 4-6 (levels 1-3 live in the styles gallery) |

## Insert

| Shortcut | Action |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>K</kbd> | Hyperlink |
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | Page break |
| <kbd>F11</kbd> | Focus mode |

Section breaks and column breaks have no default key -- the ribbon and the command palette carry them.

## Rebinding

Settings -- Shortcuts lists every rebindable shortcut with its current binding. Click one and press the new combination; Tensor flags conflicts against the live bindings (not just the defaults) and refuses a binding that would shadow another command. Each shortcut has a reset. The Settings page stores your bindings across launches; anything you never touched follows the defaults above.

Two entries are not rebindable: undo and redo, which the OS owns. They are listed so this page stays complete, marked as system-owned.

The display convention follows what you pressed: a binding stored as <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>.</kbd> displays as <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>&gt;</kbd> -- the shifted glyph and the physical key are the same binding.
