# Accessibility

Tensor ships an on-demand Accessibility Check, carries alt text and captions as first-class document data, and keeps the whole app keyboard-operable. This page covers the parts you use; the contributor-facing model (ARIA per component, testing methodology) lives in [the accessibility model](../concepts/accessibility.md).

## Run the Accessibility Check

Review -- Accessibility Check opens a docked panel that scans the document on demand and groups what it finds:

| Group | What it looks for |
|---|---|
| Alt text | Images missing a description, and decorative images that shouldn't have one. |
| Heading structure | A heading hierarchy that skips levels or starts in the middle. |
| Color contrast | Text below the WCAG AA ratio against its resolved background. |

Each finding shows a snippet of the surrounding text (short, enough to recognize it), and clicking one jumps the document to it. Fixable findings carry their fix: a missing alt text opens the Alt Text dialog right there.

The check reads header and footer content for alt text and contrast -- bands are document content -- but band headings stay out of the heading-structure check: they're chrome, not the body outline.

## Alt text and decorative images

Every image carries alt text and a **decorative** switch, edited in the Alt Text dialog (right-click an image -- Alt Text). They are exclusive on purpose: a decorative image is skipped by screen readers, so describing one would be noise. The checker flags the missing cases.

## Captions

Captions are paragraphs with the Caption style, so they're real content: they join the heading hierarchy tools, they export, and the Table of Figures builds from them whether or not they're currently displayed.

## Color contrast

Contrast is computed against the background that actually paints: a highlight wins over a table cell's fill, which wins over the section's page color, which wins over white. Large text gets the relaxed AA threshold the guidelines allow.

## Keyboard-only workflow

Everything the ribbon does, the command palette does: press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>, type what you want, run it. Headings 4-6 are keyboard-only by design (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>4</kbd>…<kbd>6</kbd>), and every dialog closes with <kbd>Escape</kbd> and commits with <kbd>Enter</kbd>.

Screen readers get the state changes that matter as spoken announcements -- comment activity among them -- and the optional grammar double-underline (Settings -- Accessibility) adds a non-color cue next to the blue grammar underline. Motion follows the system preference or a manual override in Settings -- Accessibility.
