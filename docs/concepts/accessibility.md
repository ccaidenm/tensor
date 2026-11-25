# The accessibility model

Tensor's accessibility is built from platform primitives first, real content second, and tests third -- this page is the contributor-facing model; the user-facing behavior is [Accessibility](../features/accessibility.md).

## ARIA strategy

- **Platform primitives over hand-written roles.** The UI kit is Base UI (Radix-style behavior with proper semantics), so dialogs, menus, selects, and popovers arrive with the right roles and focus behavior already attached.
- **Every icon-only control is labeled.** The shared `IconButton` takes a label and renders it as the accessible name -- "Show Rulers", "Merge Cells", "Close" -- which is also what the test suite asserts on.
- **State is real state.** Toggles carry `aria-pressed`, list items their `aria-selected`, and tab strips are real tablists. The equation editor's scale presets and the spell providers all read state, not color.
- **Groups are named.** Ribbon groups, page-setup option clusters, and form groups expose `role="group"` with an `aria-label`, so screen readers can enumerate the ribbon's structure instead of a flat button soup.

## The two-layer content rule

The paginated canvas paints engine-computed glyphs -- that is the whole point of the architecture -- so assistive tech would have nothing to read. The hidden editing view solves it: it stays in the tree as the input and reading surface (opacity zero, explicitly *not* `aria-hidden`), while the canvas is decoration. Equations follow the same rule: the KaTeX copy is the readable text, the painted glyphs are the display. The rule is one-directional -- the hidden view is for input and reading, never for hit-testing or geometry, which come from the engine's positioned facts.

## Announcements

One module owns spoken feedback: a single `aria-live="polite"` region appended to the document on first use. It clears before setting, so repeated messages re-announce (live regions fire only on change). Comment activity, spell-check state, and setup completions go through it rather than relying on visual toasts alone.

## Keyboard navigation

The command palette is the backbone: every command the ribbon exposes is reachable by typing, and nothing in the menus is mouse-only. Dialogs close with <kbd>Escape</kbd> and confirm with <kbd>Enter</kbd>; focus rings appear only for keyboard focus (`focus-visible`), and heading levels 4-6 exist keyboard-only. Focus Mode restores the sidebar it displaced on exit.

## Testing methodology

Accessibility is asserted in the same vitest suite as everything else -- the repo's rule is that behavior lands with a test that failed first. Suites assert accessible names on shared controls (`IconButton` labels), aria states on toggles, and the announcer's messages through a test seam that resets the live region per test file. The Accessibility Check feature doubles as a product-level audit: its contrast, alt-text, and heading-hierarchy scans run against the same resolved styles the renderer uses, so a regression in the paint path surfaces as a checker finding, not a silent drift.
