# Editing

The Review tab carries Tensor's proofing and research tools: spell and grammar checking, find and replace, translation, and document statistics.

## Spell and grammar check

Checking is off until you turn it on -- the first activation opens **Enable Spell & Grammar Check**, which offers two providers:

- **Use Online Checking** -- text goes to LanguageTool's servers.
- **Local checking** -- LanguageTool runs on this device, loopback-only, after a download of roughly 290 MB (the dialog shows progress).

Pick one and checking starts. Spelling and grammar are separate switches in Settings -- Proofing, and <kbd>F7</kbd> (or the Review tab's toggle) turns checking on and off for the document. Misspellings underline in red; grammar issues in blue by default, with an optional double underline for color-blind readers (Settings -- Accessibility).

The **Dictionary** button adds words to your custom dictionary -- one file per language, shared by every document.

## Find and replace

Press <kbd>Ctrl</kbd>+<kbd>F</kbd> (or Review -- Find & Replace). The panel docks beside the document:

| Control | What it does |
|---|---|
| Find in document | The search field; matches highlight as you type. |
| Case sensitive | Toggle. |
| Use regular expressions | Regex search. |
| Previous / Next match | Step through results. |
| Replace with, Replace, Replace All | Replacement runs from the same panel. |

A results sidebar lists every match in document order; clicking one scrolls to it.

## Translate

The Review tab's **Translate** button opens a docked panel. Select text, pick a target language, and the panel translates the selection -- a scope switch decides whether the whole document or just the selection translates.

Four providers, chosen once in the setup dialog:

| Provider | Runs where |
|---|---|
| LibreTranslate | A self-hostable service; no account needed. |
| Google | Their cloud API. |
| DeepL | Their cloud API. |
| Local (Bergamot) | On this device -- language models download on demand and translate offline. |

The source language auto-detects; the last target language is remembered.

## Document statistics

**Document Statistics** on the Review tab opens a panel of live counts: **Words**, **Reading time**, **Characters**, and **Sentences**. The counts update as you write.

## Formatting marks

**Show Non-Printing Characters** (Review tab) reveals spaces, tabs, and paragraph marks -- a view-only aid that never prints.
