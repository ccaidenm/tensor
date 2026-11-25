# Comments

Comments are threads anchored to text: select a phrase, add a comment, and the words carry the thread wherever edits take them. Threads live in the document's metadata, so they save, reopen, and survive round trips exactly where the text went.

## Add a comment

Select the text, press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>M</kbd> (or the floating toolbar's comment button), and type. The comment lands in the gutter -- the space beside the page -- as a thread card, and the selected text picks up a highlight.

## Threads and the gutter

A thread is a short conversation: the opening comment, replies beneath it, and a resolve state. Every entry records its author at the time it was written (a historical record, the way Word stores them) and when it was written or last edited.

The gutter lists every thread anchored near the visible page; clicking a card scrolls to the anchored text, and moving the caret through commented text highlights its card. The gutter lives in the boundary space beside the sheet -- the View tab's **Show Boundary Content** toggle hides it without hiding your comments.

## Resolve and delete

**Resolve** marks a thread done: it stays in the document (with who resolved it and when) but fades from the gutter's default view, and the gutter's toggle brings resolved threads back. **Delete** removes the thread; deleting the last reply deletes the thread itself.

Deleting the *text* a comment anchors to is different: the thread loses its anchor but stays visible in the gutter -- an orphaned thread is never silently gone.

## Keyboard and screen readers

<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>M</kbd> adds a comment from the selection, the gutter is reachable by keyboard, and comment activity is announced to screen readers as it happens.

## Comments and other formats

Comments live in `.wpdoc` files. Tensor's own exports keep the commented text but drop the annotations, and DOCX import reports skipped comments by count -- comments are not yet a conversion format.
