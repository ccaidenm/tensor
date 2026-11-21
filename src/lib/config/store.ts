import { create } from "zustand";
import { ConfigSchema, DEFAULT_CONFIG, type Config } from "./schema";
import { SHORTCUTS } from "../shortcuts";
import { ACCENTS_BY_ID, DEFAULT_ACCENT_ID, accentLogoPath } from "../branding/accents";
import { inTauriWindow } from "../window/tauriEnv";

export const ZOOM_MIN = 50;
export const ZOOM_MAX = 200;

interface ConfigStore {
  config: Config;

  setTheme: (theme: Config["theme"]) => void;
  /** #97 — the brand accent (the writer below retunes the tokens). */
  setAccent: (accent: Config["accent"]) => void;
  /** #100 — the window controls' side (Linux/Windows lane). */
  setWindowControlsSide: (side: Config["windowControlsSide"]) => void;
  /** #103 — record an opened/saved document as recent (dedupe by
   *  path, most-recent first, capped at 10). */
  noteRecentDocument: (path: string, name: string) => void;
  /** #103 — drop a recent (the file vanished — the open failed). */
  removeRecentDocument: (path: string) => void;
  /** #101 — the draggable sidebars' width memory (committed on drag
   *  release; the panel reads it live during the drag). */
  setSidebarWidth: (id: string, width: number) => void;
  addCustomColor: (color: string) => void;
  removeCustomColor: (color: string) => void;
  setUseFloatingToolbar: (value: boolean) => void;
  /** M-T4: Developer Mode — gates Reload/Inspect Element in the context
   *  menu; the General panel requires accepting a warning to enable. */
  setDeveloperMode: (value: boolean) => void;
  setReduceMotion: (value: Config["accessibility"]["reduceMotion"]) => void;
  setSelectionColor: (value: string) => void;
  setMeasurementUnit: (value: Config["editor"]["measurementUnit"]) => void;
  setPasteOnMiddleClick: (value: boolean) => void;
  setShowNonPrintingChars: (value: boolean) => void;
  /** #58 — the break-mark badges (structural, default ON). */
  setShowBreakMarks: (value: boolean) => void;
  setShowCaptions: (value: boolean) => void;
  setShowHeadersFooters: (value: boolean) => void;
  setShowWatermark: (value: boolean) => void;
  /** #COMMENTS — the boundary-content toggle (the rewired "Show
   *  Margins" stub): the outside space around the sheets (the comments
   *  gutter today). Persisted like the other show-* view settings. */
  setShowBoundaryContent: (value: boolean) => void;
  setShowHorizontalRuler: (value: boolean) => void;
  setShowVerticalRuler: (value: boolean) => void;
  setBothRulers: (value: boolean) => void;
  /** Zoom law: clamp to [50, 200] (ZOOM_MIN/ZOOM_MAX — ZoomGroup's
   *  constants, now the single spelling of the range). */
  setZoomLevel: (value: number) => void;
  /** 'Pages' = paginated (engine-driven PaginatedView); anything else
   * (canonically 'Pageless') renders the pageless editing surface. */
  setDefaultPageLayout: (value: Config["editor"]["defaultPageLayout"]) => void;

  setKeybinding: (id: string, keys: string) => void;
  resetKeybinding: (id: string) => void;
  resetAllKeybindings: () => void;

  setFetchLinkMetadata: (value: boolean) => void;
  setAutoCheckForUpdates: (value: boolean) => void;
  setAllowFontCatalogs: (value: boolean) => void;
  /** THE SYMBOL PICKER'S CHIP ROW: the recently used character groups
   *  (MRU, capped by the picker's row limit). */
  setRecentSymbolGroups: (groups: string[]) => void;
  /** M-META: the user identity (the default author for new docs). */
  setIdentityAuthor: (value: string) => void;
  /** Spell check: the MASTER gate (ribbon / F7 / palette) — flips BOTH
   *  feature flags together. The provider/language chosen with informed
   *  consent (default off — see schema.ts). */
  setSpellCheckEnabled: (value: boolean) => void;
  /** The INDEPENDENT feature toggles (Settings → Proofing): either can
   *  run alone. */
  setSpellSpelling: (value: boolean) => void;
  setSpellGrammar: (value: boolean) => void;
  /** Marks the provider choice as made (the setup flow's write). */
  setSpellCheckConfigured: () => void;
  setSpellCheckProvider: (value: Config["spellCheck"]["provider"]) => void;
  setSpellCheckLanguage: (value: string) => void;
  /** Accessibility: grammar flags as a double line in addition to
   *  color (the color-blind aid). */
  setGrammarDoubleLine: (value: boolean) => void;
  /** TRANSLATE: the consent write (the setup flow's commit —
   *  provider + endpoint + optional key land with it, one write like
   *  the spell provider choice). */
  setTranslationConfigured: () => void;
  setTranslationProvider: (value: Config["translation"]["provider"]) => void;
  setTranslationEndpoint: (value: string) => void;
  setTranslationApiKey: (value: string) => void;
  setTranslationLastTargetLang: (value: string) => void;
  /** M-PRINT: the default folder for PDF/file exports ('' = the OS
   *  save dialog's own default). */
  setDownloadsDir: (value: string) => void;
  /** M-PRINT: the modifier-click that forces Save-as-PDF to prompt. */
  setPdfAlwaysAskTrigger: (value: 'shift' | 'ctrl') => void;
  /** M-PRINT: the preview modal's last destination (the segmented
   *  control's memory). */
  setPrintLastDestination: (value: 'printer' | 'pdf') => void;
  /** M-PRINT: the last-used duplex setting (the picker's seed). */
  setPrintLastDuplex: (
    value: 'one-sided' | 'two-sided-long-edge' | 'two-sided-short-edge',
  ) => void;

  loadConfig: (raw: unknown) => void;
}

export const useConfigStore = create<ConfigStore>((set) => ({
  config: DEFAULT_CONFIG,

  setTheme: (theme) =>
    set((state) => ({
      config: { ...state.config, theme },
    })),

  setAccent: (accent) =>
    set((state) => ({
      config: { ...state.config, accent },
    })),

  setWindowControlsSide: (side) =>
    set((state) => ({
      config: { ...state.config, windowControlsSide: side },
    })),

  // #103 — the recents list: the start screen's data source. One
  // entry per path (re-opening moves it to the front, refreshing its
  // timestamp); the cap keeps the list honest (a decade of files is
  // not "recent").
  noteRecentDocument: (path, name) =>
    set((state) => ({
      config: {
        ...state.config,
        recentDocuments: [
          { path, name, openedAt: Date.now() },
          ...state.config.recentDocuments.filter((d) => d.path !== path),
        ].slice(0, 10),
      },
    })),

  removeRecentDocument: (path) =>
    set((state) => ({
      config: {
        ...state.config,
        recentDocuments: state.config.recentDocuments.filter((d) => d.path !== path),
      },
    })),

  setSidebarWidth: (id, width) =>
    set((state) => ({
      config: {
        ...state.config,
        sidebarWidths: { ...state.config.sidebarWidths, [id]: Math.round(width) },
      },
    })),

  setDownloadsDir: (value) =>
    set((state) => ({
      config: { ...state.config, downloadsDir: value },
    })),

  setPdfAlwaysAskTrigger: (value) =>
    set((state) => ({
      config: { ...state.config, pdfAlwaysAskTrigger: value },
    })),

  setPrintLastDestination: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        print: { ...state.config.print, lastDestination: value },
      },
    })),

  setPrintLastDuplex: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        print: { ...state.config.print, lastDuplex: value },
      },
    })),

  addCustomColor: (color) =>
    set((state) => {
      if (state.config.editor.customColors.includes(color)) return state; // no duplicates
      return {
        config: {
          ...state.config,
          editor: {
            ...state.config.editor,
            customColors: [...state.config.editor.customColors, color],
          },
        },
      };
    }),

  removeCustomColor: (color) =>
    set((state) => ({
      config: {
        ...state.config,
        editor: {
          ...state.config.editor,
          customColors: state.config.editor.customColors.filter(
            (c) => c !== color,
          ),
        },
      },
    })),

  setUseFloatingToolbar: (value) =>
    set((state) => ({
      config: { ...state.config, useFloatingToolbar: value },
    })),

  setDeveloperMode: (value) =>
    set((state) => ({
      config: { ...state.config, developerMode: value },
    })),

  setReduceMotion: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        accessibility: { ...state.config.accessibility, reduceMotion: value },
      },
    })),

  setSelectionColor: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        editor: { ...state.config.editor, selectionColor: value },
      },
    })),

  setMeasurementUnit: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        editor: { ...state.config.editor, measurementUnit: value },
      },
    })),

  setPasteOnMiddleClick: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        editor: { ...state.config.editor, pasteOnMiddleClick: value },
      },
    })),

  setShowNonPrintingChars: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        editor: { ...state.config.editor, showNonPrintingChars: value },
      },
    })),

  setShowCaptions: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        editor: { ...state.config.editor, showCaptions: value },
      },
    })),

  // #COMMENTS — the boundary-content toggle (the rewired "Show Margins"
  // stub): persisted like the other show-* view settings.
  setShowBoundaryContent: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        editor: { ...state.config.editor, showBoundaryContent: value },
      },
    })),

  // #58 — the break-mark badges (structural, default ON).
  setShowBreakMarks: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        editor: { ...state.config.editor, showBreakMarks: value },
      },
    })),

  // M-HEADER-FOOTER: the band display toggle (the captions NPC precedent).
  setShowHeadersFooters: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        editor: { ...state.config.editor, showHeadersFooters: value },
      },
    })),

  // #WATERMARK: the display toggle (the captions NPC precedent —
  // view-only; the document's watermark setting never moves).
  setShowWatermark: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        editor: { ...state.config.editor, showWatermark: value },
      },
    })),

setShowHorizontalRuler: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        editor: { ...state.config.editor, showHorizontalRuler: value },
      },
    })),

  setShowVerticalRuler: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        editor: { ...state.config.editor, showVerticalRuler: value },
      },
    })),

  setBothRulers: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        editor: {
          ...state.config.editor,
          showHorizontalRuler: value,
          showVerticalRuler: value,
        },
      },
    })),

  setZoomLevel: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        editor: {
          ...state.config.editor,
          zoomLevel: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value)),
        },
      },
    })),

  setDefaultPageLayout: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        editor: { ...state.config.editor, defaultPageLayout: value },
      },
    })),

  setKeybinding: (id, keys) =>
    set((state) => ({
      config: {
        ...state.config,
        keybindings: { ...state.config.keybindings, [id]: keys },
      },
    })),

  resetKeybinding: (id) =>
    set((state) => {
      const def = SHORTCUTS.find((s) => s.id === id);
      if (!def) return state;
      return {
        config: {
          ...state.config,
          keybindings: { ...state.config.keybindings, [id]: def.keys },
        },
      };
    }),

  resetAllKeybindings: () =>
    set((state) => ({
      config: {
        ...state.config,
        keybindings: Object.fromEntries(
          SHORTCUTS.filter((s) => s.context !== "os").map((s) => [
            s.id,
            s.keys,
          ]),
        ),
      },
    })),

  setFetchLinkMetadata: (value: boolean) =>
    set((state) => ({
      config: {
        ...state.config,
        privacy: { ...state.config.privacy, fetchLinkMetadata: value },
      },
    })),

  setAutoCheckForUpdates: (value: boolean) =>
    set((state) => ({
      config: {
        ...state.config,
        privacy: { ...state.config.privacy, autoCheckForUpdates: value },
      },
    })),

  loadConfig: (raw) => {
    const result = ConfigSchema.safeParse(raw);
    if (result.success) {
      set({ config: result.data });
    } else {
      console.warn(
        "Invalid config file, falling back to defaults",
        result.error,
      );
      set({ config: DEFAULT_CONFIG });
    }
  },

  setAllowFontCatalogs: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        privacy: { ...state.config.privacy, allowFontCatalogs: value },
      },
    })),

  setRecentSymbolGroups: (groups) =>
    set((state) => ({
      config: {
        ...state.config,
        editor: { ...state.config.editor, recentSymbolGroups: groups },
      },
    })),

  setIdentityAuthor: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        identity: { ...state.config.identity, author: value },
      },
    })),

  setSpellCheckEnabled: (value) =>
    // MASTER: both flags together — the ribbon/F7/palette semantic.
    set((state) => ({
      config: {
        ...state.config,
        spellCheck: {
          ...state.config.spellCheck,
          spelling: value,
          grammar: value,
        },
      },
    })),

  setSpellSpelling: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        spellCheck: { ...state.config.spellCheck, spelling: value },
      },
    })),

  setSpellGrammar: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        spellCheck: { ...state.config.spellCheck, grammar: value },
      },
    })),

  setSpellCheckConfigured: () =>
    set((state) => ({
      config: {
        ...state.config,
        spellCheck: { ...state.config.spellCheck, configured: true },
      },
    })),

  setSpellCheckProvider: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        spellCheck: { ...state.config.spellCheck, provider: value },
      },
    })),

  setSpellCheckLanguage: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        spellCheck: { ...state.config.spellCheck, language: value },
      },
    })),

  setGrammarDoubleLine: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        accessibility: { ...state.config.accessibility, grammarDoubleLine: value },
      },
    })),

  setTranslationConfigured: () =>
    set((state) => ({
      config: {
        ...state.config,
        translation: { ...state.config.translation, configured: true },
      },
    })),

  setTranslationProvider: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        translation: { ...state.config.translation, provider: value },
      },
    })),

  setTranslationEndpoint: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        translation: { ...state.config.translation, endpoint: value },
      },
    })),

  setTranslationApiKey: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        translation: { ...state.config.translation, apiKey: value },
      },
    })),

  setTranslationLastTargetLang: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        translation: { ...state.config.translation, lastTargetLang: value },
      },
    })),
}));

// M-RULER THEME SYNC: the `dark` class is applied SYNCHRONOUSLY with
// every theme value, including the very first, from this module — one
// writer, registered before any component subscribes (zustand listeners
// fire in registration order, so the class is always current BEFORE
// React re-renders). App's passive useEffect used to own this, but
// layout-effect painters read computed styles BEFORE passive effects
// run: chrome that paints from computed styles (the M-RULER canvas)
// mounted after a persisted dark config loaded would take its FIRST
// paint against the stale (light) class — white knockouts on a dark
// bar — and, with no later theme change firing, never repaint.
// #102 — 'system' resolves against the OS scheme. matchMedia is a
// SYNCHRONOUS read (the synchronous-writer law holds) — taken LAZILY
// per apply (a module-level capture would freeze the test env's query
// AND miss a hot media state); the change listener binds once, on the
// first query, and re-applies while the theme is 'system'.
function systemQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
}

function applyThemeClass(theme: Config["theme"]): void {
  const q = systemQuery();
  document.documentElement.classList.toggle(
    "dark",
    theme === "system" ? (q?.matches ?? false) : theme === "dark",
  );
  if (q && !systemListenerBound) {
    systemListenerBound = true;
    q.addEventListener("change", () => {
      applyThemeClass(useConfigStore.getState().config.theme);
    });
  }
}
let systemListenerBound = false;

// #97 — THE ACCENT WRITER (the theme-class law's twin): the brand
// tokens retune SYNCHRONOUSLY with every accent value, including the
// very first, from this module — one writer, registered before any
// component subscribes, so chrome that paints from computed styles
// never takes a first paint against the default accent when a
// persisted selection exists. Inline on <html>: beats :root and .dark
// — ONE mechanism, both modes (one hex per accent, the catalog's
// model). The echoes (--ring, --sidebar-primary, --color-search-
// current) resolve through var(--primary) in index.css, so ONE
// variable carries the brand; the foreground ink is the catalog's
// luminance-picked per-accent value (the pale accents keep readable
// button text).
function applyAccent(accentId: Config["accent"]): void {
  const accent = ACCENTS_BY_ID[accentId] ?? ACCENTS_BY_ID[DEFAULT_ACCENT_ID];
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty("--primary", accent.hex);
  rootStyle.setProperty(
    "--primary-foreground",
    accent.foreground === "white" ? "oklch(1 0 0)" : "oklch(0.18 0.01 285)",
  );
  // #102 — THE PARITY SWEEP (the user's list): the favicon follows the
  // accent (the browser-tab/dev surface; the real window icon below).
  const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (favicon) favicon.href = accentLogoPath(accentId);
}

/** #102 — the OS window icon (taskbar/alt-tab) follows the accent too:
 *  each accent's 1024px logo fetched from the bundled assets and set as
 *  the window icon. Best-effort and async (the CSS writer above owns
 *  the synchronous law — the icon is not paint-critical); no-ops
 *  outside a Tauri window. */
async function followAccentWindowIcon(accentId: Config["accent"]): Promise<void> {
  if (!inTauriWindow()) return;
  try {
    const res = await fetch(accentLogoPath(accentId));
    if (!res.ok) return;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setIcon(bytes);
  } catch {
    // Best-effort: a failed fetch/permission never breaks the accent.
  }
}
applyThemeClass(useConfigStore.getState().config.theme);
applyAccent(useConfigStore.getState().config.accent);
void followAccentWindowIcon(useConfigStore.getState().config.accent);
useConfigStore.subscribe((state, prev) => {
  if (state.config.theme !== prev.config.theme) {
    applyThemeClass(state.config.theme);
  }
  if (state.config.accent !== prev.config.accent) {
    applyAccent(state.config.accent);
    void followAccentWindowIcon(state.config.accent);
  }
});
