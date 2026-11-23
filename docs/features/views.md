# Views

Tensor's controls live in two bars: the title bar row (the Tensor menu, the document title, the window controls) and the ribbon beneath it (the tabbed tool strip). Docked panels, a floating toolbar, and two view modes cover the rest.

## The ribbon

Five tabs, context over content:

| Tab | Groups |
|---|---|
| Home | Styles, font family and size, text color, highlight, bold/italic/underline/strikethrough, alignment, line spacing, lists, indents, undo/redo |
| Insert | Page/section/column breaks, image, table grid, symbol picker, reference tables, hyperlink, comment, bookmark, equation, horizontal rule, watermark |
| Layout | Page setup, orientation, paper size, page background, columns, spacing and indents, line numbers |
| Review | Spell and grammar toggle, dictionary, translate, document properties, find & replace, accessibility check, statistics, non-printing characters, break marks |
| View | Display mode (Paginated / Pageless, Two Pages, Focus Mode), Show toggles (captions, rulers, boundary content, headers & footers, watermarks), zoom, print preview |

Contextual tabs appear when the caret enters a special object and replace themselves when it leaves: a **Table** tab while the caret is in a table, **Header/Footer** tools while a band is being edited, and **Reference Table** tools. Clicking a normal tab never kicks you out of a context -- leaving the object does.

## The title bar

The frameless window merges its own chrome: the **Tensor** button opens the app menu (Open, Save, Save As, Export, Library, Settings), the middle shows the document's name and dirty state, and the window controls sit on the right -- on the side your Settings choose (macOS keeps its native traffic lights).

## The floating toolbar

Select text and a small toolbar floats above it: bold, italic, underline, strikethrough, text color, highlight color, comment, and hyperlink. It appears over table selections too, where it gains **Merge Cells / Split Cells** and **Table Properties**. It follows the selection and disappears when the selection does.

## Focus mode

Press <kbd>F11</kbd> (or the View tab's **Focus Mode**) and Tensor clears the frame: sidebars close and the window goes fullscreen, leaving the text with nothing around it. A toast tells you the way out -- the shortcut you rebound it to, or hovering the top-right corner for the exit button.

Focus mode is session state: it never persists, and every launch starts in normal view. Exiting restores whatever sidebar you had open.

## Panels and the status bar

Search, translate, statistics, comments, and the watermark panel dock beside the document instead of stacking dialogs. The status bar runs along the bottom: word and character counts on the left, page, line, and column on the right.

Print preview is a view of its own: the dialog renders the paginated output exactly as the engine laid it out. Its controls are covered in [import and export](import-export.md) -- both destinations share that pipeline.
