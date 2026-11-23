# Pagination

Tensor lays documents out on pages as you type: the text breaks across sheets, headers and footers paint themselves, and sections carry their own page settings. All of it is driven by the layout engine -- what you see is what prints.

## Page setup

Open the **Layout** tab and click **Page Setup**. The dialog covers paper, margins, and background:

| Setting | Options |
|---|---|
| Paper size | Named sizes plus a custom size (dimensions in points). |
| Orientation | Portrait or landscape -- whole document. |
| Margins | Presets plus per-side values. |
| Page background | A per-document color behind the text. |

The same dialog carries the **Layout mode** switch: Pages or Pageless (see [pageless mode](#pageless-mode)).

## Sections

A **section break** (Insert tab, no default shortcut) starts a new section, and each section can differ from the document: its own paper size, margins, columns, and watermark. Insert a section break, put the caret inside the section, and Page Setup offers **Apply to: This section** -- the change writes that section only. The dialog's section chips (Section 1 of N) show what exists and where you are.

How a section begins is its own choice: **Next page** starts it on a fresh sheet; **Continuous** starts it on the same page, so a two-column block can share a sheet with single-column text.

Columns work the same way: the Layout tab's **Columns** presets apply document-wide or per section, and a **Column break** (Insert tab) moves following text to the next column.

## Headers and footers

Double-click the band above or below the text (or below the sheet edge for footers) and the band becomes editable; a contextual **Header/Footer** tab appears, and the ribbon gains page-number inserts while you're in it. Two fields exist: **page number** resolves to the current page, **page count** to the document total.

The same contextual tab carries **Different First Page**: page 1 gets its own header and footer -- a title-page band with nothing in it -- while later pages repeat.

The View tab's **Show Headers & Footers** hides the bands while you write; hiding them changes nothing in the file.

## Pageless mode

Pageless drops the sheets: text flows continuously, with no page breaks, headers, or footers, and a slim ruler takes the place of the page rulers. Choose it from the View tab's **Paginated / Pageless** toggle or the Page Setup dialog.

The mode is a property of the document: new documents use your Settings default, and once a document's mode is set, the document keeps it -- flipping the toggle writes it into the file. The View tab's **Two Pages** arranges a paginated document side by side.

## Break marks

Page and section breaks are invisible in print, so the Review tab's **Show Break Marks** badges them on screen: a small marker sits at each break, and the table's pin marks the header row of a continued table. Marks are view-only ink -- they never print or export.
