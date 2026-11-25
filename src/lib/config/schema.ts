import { z } from 'zod';
import { PAGE_GAP, DEFAULT_MARGINS } from '../document/pageSetup';
import { SHORTCUTS } from '../shortcuts';
import { ACCENT_IDS, DEFAULT_ACCENT_ID } from '../branding/accents';

const DEFAULT_KEYBINDINGS: Record<string, string> = Object.fromEntries(
  SHORTCUTS.filter((s) => s.context !== 'os').map((s) => [s.id, s.keys]),
);

export const ConfigSchema = z.object({
  /** #102 — 'system' follows the OS; the new-install default.
   *  Persisted light/dark ride untouched. */
  theme: z.enum(['light', 'dark', 'system']).default('system'),
  /** #97 — the brand accent; the store's writer retunes --primary +
   *  the foreground ink (catalog: lib/branding/accents). */
  accent: z.enum(ACCENT_IDS).default(DEFAULT_ACCENT_ID),
  /** #100 — which side the window controls sit on. Linux/Windows only
   *  (macOS keeps native traffic lights). */
  windowControlsSide: z.enum(['right', 'left']).default('right'),
  /** #103 — the start screen's recent-documents list (most recent
   *  first; deduped by path; capped). Recorded on open and save-as. */
  recentDocuments: z
    .object({ path: z.string(), name: z.string(), openedAt: z.number() })
    .array()
    .default([]),
  /** #101 — per-sidebar width memory (px); the layout survives restarts. */
  sidebarWidths: z.record(z.string(), z.number()).default({}),
  autosaveIntervalMs: z.number().default(5000),
  useFloatingToolbar: z.boolean().default(true),
  editor: z.object({
    defaultFontFamily: z.string().default('system-ui'),
    defaultFontSize: z.number().default(16),
    /** New-document default only; each document owns its mode once set.
     *  .catch: a stray value from an older build falls back to Pages
     *  instead of rejecting the whole file. */
    defaultPageLayout: z.enum(['Pages', 'Pageless']).catch('Pages').default('Pages'),
    /** #101 — the paginated desk's page arrangement (1 = stack, 2 =
     *  two side by side). A view preference, not a document property. */
    pageColumns: z.union([z.literal(1), z.literal(2)]).default(1),
    defaultPageSize: z.string().default('Letter'),
    defaultPageGap: z.number().default(PAGE_GAP),
    defaultMargins: z.object({
      top: z.number(),
      bottom: z.number(),
      left: z.number(),
      right: z.number(),
    }).default(DEFAULT_MARGINS),
    colorDisplayFormat: z.enum(['hex', 'rgb', 'hsl']).default('hex'),
    customColors: z.array(z.string()).default([]),
    /** THE SYMBOL PICKER'S CHIP ROW (the collapse law): the user's
     *  recently used character groups — the row shows Common + these
     *  (most recent first, capped by the picker), everything else
     *  lives in the ellipsis dropdown. Session-valued, config-
     *  persisted: your corner palette keeps YOUR groups. */
    recentSymbolGroups: z.array(z.string()).default([]),
    showNonPrintingChars: z.boolean().default(false),
    /** Caption display toggle — presentation-only; ToF reads captions
     *  regardless. */
    showCaptions: z.boolean().default(true),
    /** Header/footer band display toggle — presentation-only; saves
     *  round-trip regardless. Pages mode only. */
    showHeadersFooters: z.boolean().default(true),
    /** Watermark display toggle — the view's switch, not the
     *  document's setting. Pages mode only. */
    showWatermark: z.boolean().default(true),
    /** #58 — page/section-break badges; structural ink, so on by
     *  default. View-only; never printed. */
    showBreakMarks: z.boolean().default(true),
    /** Ruler bars — per-axis display toggles. Pages mode only. */
    showHorizontalRuler: z.boolean().default(true),
    showVerticalRuler: z.boolean().default(true),
    /** The outside-space toggle — the comments gutter today. Hiding it
     *  never reflows the document. Both modes. */
    showBoundaryContent: z.boolean().default(true),
    zoomLevel: z.number().default(100),
    /** Painted-selection background; '' = theme primary at selection
     * opacity (the default look). */
    selectionColor: z.string().default(''),
    /** Display unit for measurement inputs (margins, page size). */
    measurementUnit: z.enum(['inches', 'centimeters', 'millimeters', 'points', 'picas']).default('inches'),
    /** Middle-click pastes the system clipboard at the click point
     * (X11 primary-paste habit). Off = browser default. */
    pasteOnMiddleClick: z.boolean().default(false),
  }).default({
    defaultFontFamily: 'system-ui',
    defaultFontSize: 16,
    defaultPageLayout: 'Pages' as const,
    pageColumns: 1 as const,
    defaultPageSize: 'Letter',
    defaultPageGap: PAGE_GAP,
    defaultMargins: DEFAULT_MARGINS,
    colorDisplayFormat: 'hex',
    customColors: [],
    recentSymbolGroups: [],
    showNonPrintingChars: false,
    showBreakMarks: true,
    showCaptions: true,
    showHeadersFooters: true,
    showWatermark: true,
    showHorizontalRuler: true,
    showVerticalRuler: true,
    showBoundaryContent: true,
    zoomLevel: 100,
    selectionColor: '',
    measurementUnit: 'inches',
    pasteOnMiddleClick: false,
  }),
  privacy: z.object({
    autoCheckForUpdates: z.boolean().default(false),
    /** #103 — externals-off by default; the wizard pre-enables it for
     *  users who continue through setup. */
    fetchLinkMetadata: z.boolean().default(false),
    /** Gate for online font-catalog browsing (Google Fonts / Font
     *  Share) — OFF; no network code reads it yet. */
    allowFontCatalogs: z.boolean().default(false),
  }).default({
    autoCheckForUpdates: false,
    fetchLinkMetadata: false,
    allowFontCatalogs: false,
  }),
  /** Spell check — consent posture: OFF until the user picks a
   *  provider (Settings > Proofing / the setup dialog). Online sends
   *  text to LanguageTool's servers; local is loopback-only after a
   *  ~290MB download. `spelling` and `grammar` are independent
   *  as-you-type toggles (the master switch flips both); `configured`
   *  records the provider choice. Migration: old `enabled: true`
   *  configs map to both flags on. */
  spellCheck: z.preprocess(
    (raw) => {
      if (raw && typeof raw === 'object' && !('spelling' in raw) && !('grammar' in raw)) {
        const old = raw as Record<string, unknown> & { enabled?: unknown };
        return {
          ...old,
          spelling: old.enabled === true,
          grammar: old.enabled === true,
        };
      }
      return raw;
    },
    z.object({
      /** The informed choice has been MADE (the ribbon button toggles
       *  outright once true; before that, it opens the setup dialog). */
      configured: z.boolean().default(false),
      provider: z.enum(['online', 'local']).default('local'),
      /** LT language code; v1 ships en-US (the bundled dictionary file
       *  and the runtime's languages follow it). */
      language: z.string().default('en-US'),
      spelling: z.boolean().default(false),
      grammar: z.boolean().default(false),
    }).default({
      configured: false,
      provider: 'local',
      language: 'en-US',
      spelling: false,
      grammar: false,
    })
  ),
  /** Translation — the spell-check consent posture carried forward:
   *  OFF until a provider is configured (the setup dialog). The
   *  selected text goes to the chosen service — libretranslate
   *  (self-hostable, keyless), google, deepl, or local (Bergamot,
   *  on-device). `configured` records the choice; `endpoint` is
   *  libretranslate's routing fact; `lastTargetLang` seeds the
   *  picker. */
  translation: z.object({
    provider: z.enum(['libretranslate', 'google', 'deepl', 'local']).default('libretranslate'),
    configured: z.boolean().default(false),
    endpoint: z.string().default(''),
    apiKey: z.string().default(''),
    lastTargetLang: z.string().default(''),
  }).default({
    provider: 'libretranslate',
    configured: false,
    endpoint: '',
    apiKey: '',
    lastTargetLang: '',
  }),
  accessibility: z.object({
    reduceMotion: z.enum(['system', 'on', 'off']).default('system'),
    /** Grammar flags: double-line in ADDITION to color — the
     *  color-blind aid (Accessibility → Visual Cues). Default off:
     *  color-only is the default distinction. */
    grammarDoubleLine: z.boolean().default(false),
  }).default({
    reduceMotion: 'system',
    grammarDoubleLine: false,
  }),
  /** Developer mode: Reload + Inspect Element in the context menu.
   *  OFF; enabling accepts an explicit warning. */
  developerMode: z.boolean().default(false),
  /** #39 — the default export folder; '' = the OS save dialog's
   *  default. A path = exports write there unless the button is
   *  modifier-clicked (always prompts). */
  downloadsDir: z.string().default(''),
  /** The modifier that forces Save-as-PDF to prompt. */
  pdfAlwaysAskTrigger: z.enum(['shift', 'ctrl']).default('shift'),
  /** The preview modal's last destination — reopening lands where
   *  you were. */
  print: z.object({
    lastDestination: z.enum(['printer', 'pdf']).default('printer'),
    /** The last-used duplex setting — the picker's seed. */
    lastDuplex: z
      .enum(['one-sided', 'two-sided-long-edge', 'two-sided-short-edge'])
      .default('one-sided'),
  }).default({ lastDestination: 'printer', lastDuplex: 'one-sided' }),
  /** The user's identity — the default author for new documents.
   *  Empty = nothing baked into files the user didn't save with
   *  their name (privacy-first). */
  identity: z.object({
    author: z.string().default(''),
  }).default({ author: '' }),
  /** #103 — true once the setup wizard completed or was skipped;
   *  everyone sees the wizard once. */
  firstRunCompleted: z.boolean().default(false),
  /** Keyed by ShortcutDefinition.id; '' = explicitly unbound. Missing
   *  keys fall back via getEffectiveKeybinding() — never index this
   *  object directly. */
  keybindings: z.record(z.string(), z.string()).default(DEFAULT_KEYBINDINGS),
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({});

/** Master gate — either spelling or grammar active. */
export function spellCheckActive(spell: Config['spellCheck']): boolean {
  return spell.spelling || spell.grammar;
}
