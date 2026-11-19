/**
 * LOCAL MODELS — shared types: the Rust DTOs (the installed registry),
 * the wrapper's request/response shape, and the module shim for the
 * untyped @browsermt/bergamot-translator package.
 *
 * THE ARCHITECTURE (the spell-installer posture): Rust owns the
 * network and disk (catalog fetch, per-pair downloads, gunzip, hash
 * verification, manifests); the TS engine loads the DOWNLOADED model
 * bytes through the asset protocol (convertFileSrc) — the webview
 * never fetches a model URL from the internet, and translation is
 * fully offline after download.
 */

/** One direction in Mozilla's catalog (translate_catalog's DTO). */
export interface CatalogPair {
  /** Hyphenated direction code ("en-de") — the registry's own key. */
  code: string;
  from: string;
  to: string;
  /** Approximate on-disk size after decompression. */
  bytes: number;
}

export interface CatalogDto {
  pairs: CatalogPair[];
}

/** One model file on disk (translate_model_installed's DTO). */
export interface InstalledFile {
  /** model | lex | vocab | srcvocab | trgvocab — the wrapper registry's keys. */
  kind: string;
  /** Absolute path — mapped through convertFileSrc() into the registry. */
  path: string;
  size: number;
  sha256: string;
}

export interface InstalledPair {
  code: string;
  from: string;
  to: string;
  files: InstalledFile[];
}

/** The download-progress event payload (translate-download-progress). */
export interface TranslateDownloadProgress {
  stage: string;
  received: number;
  total: number;
}

// ─── The wrapper's registry shapes (its loadTranslationModel contract) ──

/** One file entry in the wrapper's registry JSON: `name` is fetched,
 *  `expectedSha256Hash` verified (hex). */
export interface WrapperRegistryFile {
  name: string;
  size: number;
  expectedSha256Hash?: string;
}

/** The wrapper registry: keys are from+to concatenated (it parses them
 *  back with substring(0,2)/substring(2,4) — the 2-letter law). */
export type WrapperRegistry = Record<
  string,
  Partial<Record<'model' | 'lex' | 'vocab' | 'srcvocab' | 'trgvocab', WrapperRegistryFile>>
>;
