import { create } from "zustand";
import { ConfigSchema, DEFAULT_CONFIG, type Config } from "./schema";
import { SHORTCUTS } from "../shortcuts";

export const ZOOM_MIN = 50;
export const ZOOM_MAX = 200;

interface ConfigStore {
  config: Config;

  setTheme: (theme: Config["theme"]) => void;
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
  setShowCaptions: (value: boolean) => void;
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
  /** M-META: the user identity (the default author for new docs). */
  setIdentityAuthor: (value: string) => void;
  /** Spell check: the master gate + the provider/language that were
   *  chosen with informed consent (default off — see schema.ts). */
  setSpellCheckEnabled: (value: boolean) => void;
  /** Marks the provider choice as made (the setup flow's write). */
  setSpellCheckConfigured: () => void;
  setSpellCheckProvider: (value: Config["spellCheck"]["provider"]) => void;
  setSpellCheckLanguage: (value: string) => void;

  loadConfig: (raw: unknown) => void;
}

export const useConfigStore = create<ConfigStore>((set) => ({
  config: DEFAULT_CONFIG,

  setTheme: (theme) =>
    set((state) => ({
      config: { ...state.config, theme },
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

  setIdentityAuthor: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        identity: { ...state.config.identity, author: value },
      },
    })),

  setSpellCheckEnabled: (value) =>
    set((state) => ({
      config: {
        ...state.config,
        spellCheck: { ...state.config.spellCheck, enabled: value },
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
function applyThemeClass(theme: Config["theme"]): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}
applyThemeClass(useConfigStore.getState().config.theme);
useConfigStore.subscribe((state, prev) => {
  if (state.config.theme !== prev.config.theme) {
    applyThemeClass(state.config.theme);
  }
});