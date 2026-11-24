# Configuration

Every setting lives in one JSON file in the app's config directory, validated by a schema on load: unknown or stale values fall back to defaults instead of failing, and the file is yours to inspect. This page maps every option to its real key.

Settings are edited in the app -- Settings opens with <kbd>Ctrl</kbd>+<kbd>,</kbd>. A few config values are *state* the app persists rather than options you choose (recent documents, sidebar widths, the last print destination, rebindings); they appear at the end.

## General

| Setting | Key | Values | Default |
|---|---|---|---|
| Theme | `theme` | light / dark / system | system |
| Accent | `accent` | the accent catalog's ids | first accent |
| Window controls side | `windowControlsSide` | right / left (Linux/Windows) | right |
| Autosave interval | `autosaveIntervalMs` | milliseconds | 5000 |
| Floating toolbar | `useFloatingToolbar` | on / off | on |
| Developer mode | `developerMode` | on / off (accepts a warning) | off |
| Default export folder | `downloadsDir` | a path ('' = ask every time) | ask |
| Measurement unit | `editor.measurementUnit` | inches / centimeters / millimeters / points / picas | inches |
| Color display | `editor.colorDisplayFormat` | hex / rgb / hsl | hex |
| Default font, size | `editor.defaultFontFamily`, `editor.defaultFontSize` | installed families | system-ui, 16 |
| New-document layout | `editor.defaultPageLayout` | Pages / Pageless | Pages |
| New-document paper | `editor.defaultPageSize`, `editor.defaultMargins`, `editor.defaultPageGap` | named sizes, margins, gap | Letter, defaults |
| Page arrangement | `editor.pageColumns` | 1 / 2 | 1 |
| Zoom | `editor.zoomLevel` | 50-200 | 100 |
| Selection color | `editor.selectionColor` | hex ('' = theme primary) | '' |
| Custom colors | `editor.customColors` | hex list | empty |
| Recent symbol groups | `editor.recentSymbolGroups` | ids | empty |
| Middle-click paste | `editor.pasteOnMiddleClick` | on / off | off |

## View toggles

| Toggle | Key | Default |
|---|---|---|
| Show rulers (horizontal / vertical) | `editor.showHorizontalRuler`, `editor.showVerticalRuler` | on |
| Show break marks | `editor.showBreakMarks` | on |
| Show captions | `editor.showCaptions` | on |
| Show headers & footers | `editor.showHeadersFooters` | on |
| Show watermarks | `editor.showWatermark` | on |
| Show boundary content | `editor.showBoundaryContent` | on |
| Show non-printing characters | `editor.showNonPrintingChars` | off |

All display toggles are view state only -- they change nothing that saves or prints.

## Privacy

| Setting | Key | Values | Default |
|---|---|---|---|
| Check for updates | `privacy.autoCheckForUpdates` | on / off | off |
| Fetch link metadata | `privacy.fetchLinkMetadata` | on / off | off |
| Online font catalogs | `privacy.allowFontCatalogs` | on / off | off |

All three default off: Tensor phones home for nothing unless you switch a door on. The font-catalog switch is the gate for the online catalog browsing in the font picker.

## Proofing

| Setting | Key | Values | Default |
|---|---|---|---|
| Provider configured | `spellCheck.configured` | -- | false (checking off) |
| Provider | `spellCheck.provider` | local / online | local |
| Language | `spellCheck.language` | a LanguageTool code | en-US |
| Spelling | `spellCheck.spelling` | on / off | off |
| Grammar | `spellCheck.grammar` | on / off | off |
| Translation provider | `translation.provider` | libretranslate / google / deepl / local | libretranslate |
| Service endpoint | `translation.endpoint` | a URL | empty |
| API key | `translation.apiKey` | a string | empty |
| Last target language | `translation.lastTargetLang` | a BCP 47 code | empty |

The master gate is consent: until a provider is chosen, checking does nothing, and the ribbon toggle opens the setup dialog first.

## Accessibility

| Setting | Key | Values | Default |
|---|---|---|---|
| Reduce motion | `accessibility.reduceMotion` | system / on / off | system |
| Grammar double line | `accessibility.grammarDoubleLine` | on / off | off |

## Identity

| Setting | Key | Default |
|---|---|---|
| Author name | `identity.author` | empty |

Empty means documents you did not save with a name carry none -- privacy first.

## State the app persists (not options)

`recentDocuments` (the Start Screen list), `sidebarWidths`, `print.lastDestination` and `print.lastDuplex` (the preview's last choices), `keybindings` (your rebindings), and `firstRunCompleted` (the setup wizard's once-only gate) ride the same file. Missing keys resolve to defaults -- older configs predate newer settings by design.
