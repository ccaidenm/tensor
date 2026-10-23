import { z } from 'zod';
import { PAGE_GAP, DEFAULT_MARGINS } from '../document/pageSetup';
import { SHORTCUTS } from '../shortcuts';

const DEFAULT_KEYBINDINGS: Record<string, string> = Object.fromEntries(
  SHORTCUTS.filter((s) => s.context !== 'os').map((s) => [s.id, s.keys]),
);

export const ConfigSchema = z.object({
  theme: z.enum(['light', 'dark']).default('light'),
  autosaveIntervalMs: z.number().default(5000),
  useFloatingToolbar: z.boolean().default(true),
  editor: z.object({
    defaultFontFamily: z.string().default('system-ui'),
    defaultFontSize: z.number().default(16),
    defaultPageLayout: z.string().default('Pages'),
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
    showNonPrintingChars: z.boolean().default(false),
    /** M-IMAGES-1: caption DISPLAY toggle (the NPC precedent —
     *  presentation-only ink, both modes; the model is untouched and
     *  ToF reads captions regardless). Default: captions visible. */
    showCaptions: z.boolean().default(true),
    /** M-HEADER-FOOTER: header/footer band DISPLAY toggle (the captions
     *  NPC precedent — presentation-only; the settings/model are
     *  untouched and saves round-trip regardless). Default: bands
     *  visible, matching Word/GDocs. Pages mode only. */
    showHeadersFooters: z.boolean().default(true),
    /** M-RULER: the ruler bars — per-axis display toggles (the command
     *  palette's show/hide surface). Pages mode only (pageless has no
     *  page geometry to rule). Defaults: visible, matching Word/GDocs. */
    showHorizontalRuler: z.boolean().default(true),
    showVerticalRuler: z.boolean().default(true),
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
    defaultPageLayout: 'Pages',
    defaultPageSize: 'Letter',
    defaultPageGap: PAGE_GAP,
    defaultMargins: DEFAULT_MARGINS,
    colorDisplayFormat: 'hex',
    customColors: [],
    showNonPrintingChars: false,
    showCaptions: true,
    showHeadersFooters: true,
    showHorizontalRuler: true,
    showVerticalRuler: true,
    zoomLevel: 100,
    selectionColor: '',
    measurementUnit: 'inches',
    pasteOnMiddleClick: false,
  }),
  privacy: z.object({
    autoCheckForUpdates: z.boolean().default(false),
    fetchLinkMetadata: z.boolean().default(true),
    /** M-FONTS-A: gate for milestone B's online catalog browsing
     *  (Google Fonts / Font Share). Inert until B ships — default OFF,
     *  no network code reads it yet; saving the preference is all it
     *  does today. */
    allowFontCatalogs: z.boolean().default(false),
  }).default({
    autoCheckForUpdates: false,
    fetchLinkMetadata: true,
    allowFontCatalogs: false,
  }),
  /** Spell check — the CONSENT posture (the fonts/privacy precedents,
   *  hardened): OFF by default; enabling requires picking a provider
   *  with an informed choice (Settings > Proofing / the setup dialog).
   *  Online = text is sent to LanguageTool's servers; Local = the
   *  sidecar, loopback-only after a one-time ≈290MB download.
   *
   *  TWO INDEPENDENT FEATURES under one consent: `spelling` and
   *  `grammar` are separate as-you-type toggles (Settings → Proofing)
   *  so either can run alone; the master switch (ribbon / F7 /
   *  palette) flips BOTH. `configured` records that the provider
   *  choice was made — the consent covers both features, since the
   *  same text goes to the same destination either way.
   *
   *  MIGRATION: configs persisted by the spell-check release carry
   *  `enabled` (both-or-neither) — `enabled: true` maps to both flags
   *  on (grammar arrives enabled for existing users), anything else
   *  to both off. */
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
  /** M-T4 — DEVELOPER MODE: exposes Reload + Inspect Element in the
   *  document context menu. Default OFF; enabling requires accepting
   *  an explicit warning (General > Advanced) — devtools can inspect
   *  and mutate anything, and a careless edit can break the running
   *  app. The toggle is the single gate; the menu reads it live. */
  developerMode: z.boolean().default(false),
  /** M-META: the user's own identity — the default AUTHOR for new
   *  documents' metadata. Empty = unset: nothing is baked into files
   *  the user didn't explicitly save with their name (privacy-first;
   *  local config.json only). Pre-release onboarding will write this
   *  during setup; the setting itself is permanent — Settings >
   *  General > User. */
  identity: z.object({
    author: z.string().default(''),
  }).default({ author: '' }),
  /** Keyed by ShortcutDefinition.id (see src/lib/shortcuts.ts). Flat
   *  record rather than a fixed shape — every command in the Shortcuts
   *  registry gets an entry here, seeded from that registry's defaults.
   *  An empty string value means "explicitly unbound". Missing keys
   *  (e.g. a persisted config from before a given shortcut existed) fall
   *  back to the registry default via getEffectiveKeybinding() — never
   *  index this object directly. */
  keybindings: z.record(z.string(), z.string()).default(DEFAULT_KEYBINDINGS),
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({});

/** The MASTER gate — is any checking feature active? (Either flag on =
 *  the ribbon button shows active; the master switch turns both
 *  together. Either alone is a legitimate running state.) */
export function spellCheckActive(spell: Config['spellCheck']): boolean {
  return spell.spelling || spell.grammar;
}
