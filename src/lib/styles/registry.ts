import { create } from 'zustand';
import { z } from 'zod';
import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { appConfigDir, join } from '@tauri-apps/api/path';
import {
  StyleDefinitionSchema,
  isBuiltinId,
  isHeadingStyleId,
  type StyleDefinition,
  type StyleRegistrySnapshot,
} from './types';
import {
  HYPERLINK_SEED,
  LEGACY_HEADING_FALLBACK,
  builtinDefinitionsById,
} from './builtins';

/**
 * Three layers merged by id: code builtins ← global styles.json ←
 * per-doc metadata. Dialog edits write the global layer (the Word-
 * template model); the doc layer round-trips verbatim on save. Any
 * mutation bumps `epoch` — the signal consumers rebuild on.
 */

const STYLES_FILENAME = 'styles.json';

const StylesFileSchema = z.object({
  version: z.number(),
  definitions: z.array(StyleDefinitionSchema),
});

interface StylesFile {
  version: number;
  definitions: StyleDefinition[];
}

const BUILTIN_BY_ID = builtinDefinitionsById();

function mergeLayers(
  global: Record<string, StyleDefinition>,
  doc: Record<string, StyleDefinition>
): Record<string, StyleDefinition> {
  return { ...BUILTIN_BY_ID, ...global, ...doc };
}

/** Slugify a definition name into a stable candidate id ('Legal Body'
 * → 'legal-body'); uniquified against the merged map by suffixing. */
function slugifyId(name: string, taken: Record<string, unknown>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'style';
  if (!taken[base]) return base;
  let n = 2;
  while (taken[`${base}-${n}`]) n += 1;
  return `${base}-${n}`;
}

function layersFromDefs(defs: StyleDefinition[]): Record<string, StyleDefinition> {
  return Object.fromEntries(defs.map((d) => [d.id, d]));
}

/** Unknown styleId → null (baseline rendering) after one dev warning
 *  per id per session; heading-4..6 fall back silently (Heading node
 *  output, not user intent). Pure — no store import. */
const warnedMissingIds = new Set<string>();

export function lookupStyle(
  id: string | null | undefined,
  definitions: Record<string, StyleDefinition>
): StyleDefinition | null {
  if (!id) return null;
  const found = definitions[id];
  if (found) return found;
  if (isHeadingStyleId(id) && LEGACY_HEADING_FALLBACK[id]) {
    return { id, name: id, kind: 'paragraph', properties: LEGACY_HEADING_FALLBACK[id] };
  }
  if (!warnedMissingIds.has(id)) {
    warnedMissingIds.add(id);
    if (import.meta.env.DEV) {
      console.warn(
        `[styles] no definition for styleId '${id}' — rendering with the default baseline. ` +
          'The document references a style the registry does not know; fix the registry or the document.'
      );
    }
  }
  return null;
}

interface StyleRegistryState {
  /** Global layer (styles.json): customs + built-in overrides. */
  global: Record<string, StyleDefinition>;
  /** Doc layer (opened file's metadata.styles): overrides that travel
   * with the document. */
  doc: Record<string, StyleDefinition>;
  /** Merged view: builtins ← global ← doc. */
  merged: Record<string, StyleDefinition>;
  /** Bumped on ANY definition mutation (see module comment). */
  epoch: number;
  /** Whether loadGlobal ran (app bootstrap). 'error' = styles.json
   * unreadable — builtins-only fallback, warned once, never silent. */
  status: 'idle' | 'ready' | 'error';
  loadGlobal: () => Promise<void>;
  setLayers: (layers: { global?: StyleDefinition[]; doc?: StyleDefinition[] }) => void;
  applyDocLayer: (definitions: StyleDefinition[]) => void;
  clearDocLayer: () => void;
  docLayerForSave: () => StyleDefinition[];
  globalLayerForFile: () => StyleDefinition[];
  updateDefinition: (id: string, patch: { name?: string; properties?: StyleDefinition['properties'] }) => void;
  createDefinition: (input: { name: string; kind: StyleDefinition['kind']; properties: StyleDefinition['properties'] }) => StyleDefinition;
  deleteDefinition: (id: string) => void;
  snapshot: () => StyleRegistrySnapshot;
}

async function stylesFilePath(): Promise<string> {
  const dir = await appConfigDir();
  return join(dir, STYLES_FILENAME);
}

async function writeGlobalFile(state: StyleRegistryState): Promise<void> {
  // Outside the Tauri webview there is no appConfigDir — skip
  // silently; every real failure below stays loud.
  if (!('__TAURI_INTERNALS__' in globalThis)) return;
  try {
    const file: StylesFile = { version: 1, definitions: Object.values(state.global) };
    const path = await stylesFilePath();
    const dir = await appConfigDir();
    if (!(await exists(dir))) await mkdir(dir, { recursive: true });
    await writeTextFile(path, JSON.stringify(file, null, 2));
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn('[styles] failed to persist styles.json (definitions stay in-session):', err);
    }
  }
}

export const useStyleRegistryStore = create<StyleRegistryState>((set, get) => ({
  global: {},
  doc: {},
  merged: mergeLayers({}, {}),
  epoch: 0,
  status: 'idle',

  loadGlobal: async () => {
    try {
      const path = await stylesFilePath();
      if (await exists(path)) {
        const parsed = StylesFileSchema.safeParse(JSON.parse(await readTextFile(path)));
        if (!parsed.success) {
          if (import.meta.env.DEV) {
            console.warn('[styles] styles.json failed schema validation — using builtins only:', parsed.error);
          }
          set({ status: 'error' });
          return;
        }
        // The epoch bump is required: initial relayouts cache
        // conversions under the builtins-only registry before this
        // async load completes — without a bump they stay stale forever.
        set((s) => ({
          global: layersFromDefs(parsed.data.definitions),
          merged: mergeLayers(layersFromDefs(parsed.data.definitions), s.doc),
          status: 'ready',
          epoch: s.epoch + 1,
        }));
        return;
      }
        // First run: seed the file with the 'Hyperlink' entry
        // (builtins.ts HYPERLINK_SEED).
      const seeded = { hyperlink: HYPERLINK_SEED };
      set((s) => ({
        global: seeded,
        merged: mergeLayers(seeded, s.doc),
        status: 'ready',
        epoch: s.epoch + 1,
      }));
      await writeGlobalFile(get());
    } catch (err) {
      // jsdom/test or a broken fs: builtins-only, loud in dev.
      if (import.meta.env.DEV) {
        console.warn('[styles] styles.json unavailable — builtins-only registry:', err);
      }
      set({ status: 'error' });
    }
  },

  setLayers: ({ global, doc }) =>
    set((s) => ({
      ...(global ? { global: layersFromDefs(global) } : {}),
      ...(doc ? { doc: layersFromDefs(doc) } : {}),
      merged: mergeLayers(
        global ? layersFromDefs(global) : s.global,
        doc ? layersFromDefs(doc) : s.doc
      ),
      epoch: s.epoch + 1,
    })),

  applyDocLayer: (definitions) =>
    set((s) => ({
      doc: layersFromDefs(definitions),
      merged: mergeLayers(s.global, layersFromDefs(definitions)),
      epoch: s.epoch + 1,
    })),

  clearDocLayer: () =>
    set((s) => ({
      doc: {},
      merged: mergeLayers(s.global, {}),
      epoch: s.epoch + 1,
    })),

  docLayerForSave: () => Object.values(get().doc),
  globalLayerForFile: () => Object.values(get().global),

  updateDefinition: (id, patch) => {
    const current = get().merged[id];
    if (!current) throw new Error(`[styles] cannot edit unknown style id '${id}'`);
    const next: StyleDefinition = {
      id,
      name: patch.name ?? current.name,
      kind: current.kind,
      properties: patch.properties ?? current.properties,
    };
    set((s) => {
      const global = { ...s.global, [id]: next };
      return { global, merged: mergeLayers(global, s.doc), epoch: s.epoch + 1 };
    });
    void writeGlobalFile(get());
  },

  createDefinition: ({ name, kind, properties }) => {
    const id = slugifyId(name, get().merged);
    const def: StyleDefinition = { id, name, kind, properties };
    set((s) => {
      const global = { ...s.global, [id]: def };
      return { global, merged: mergeLayers(global, s.doc), epoch: s.epoch + 1 };
    });
    void writeGlobalFile(get());
    return def;
  },

  deleteDefinition: (id) => {
    if (isBuiltinId(id)) {
      // Loud, test-pinned: fixed built-ins are identity, not data.
      throw new Error(`[styles] built-in style '${id}' cannot be deleted`);
    }
    if (!get().merged[id]) throw new Error(`[styles] cannot delete unknown style id '${id}'`);
    set((s) => {
      const global = { ...s.global };
      const doc = { ...s.doc };
      delete global[id];
      // The user's intent is "this style should not exist" — the doc
      // layer's copy dies with it, or the doc would resurrect it.
      delete doc[id];
      return { global, doc, merged: mergeLayers(global, doc), epoch: s.epoch + 1 };
    });
    void writeGlobalFile(get());
  },

  snapshot: () => ({ definitions: get().merged, epoch: get().epoch }),
}));
