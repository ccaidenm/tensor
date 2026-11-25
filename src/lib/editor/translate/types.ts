/**
 * Translate — shared types: the wire contract, the block model, the
 * preview/apply surfaces. PRIVACY: inherently ONLINE — the text leaves
 * the device for the user-chosen endpoint (gate in client.ts).
 */

/** One instance language — the wire shape (GET /languages). */
export interface TranslationLanguage {
  code: string;
  name: string;
}

/**
 * One translatable top-level block: schema-serialized HTML plus its PM
 * range. TOP-LEVEL granularity — a list or table travels whole, so
 * structure never needs re-nesting and interleaved inserts are siblings.
 */
export interface TranslateBlock {
  /** Stable identity (BlockIdExtension) — the preview's react key. */
  blockId: string;
  /** The top-level node's type name (paragraph, heading, bulletList…). */
  nodeType: string;
  /** Doc range of the top-level block (from = node start). */
  from: number;
  to: number;
  /** The block serialized as HTML (schema-serializer output). */
  html: string;
  /** Plain text for the preview's original column. */
  text: string;
}

/** One preview row: a block, its translation, and how it landed. */
export interface TranslatedBlock {
  block: TranslateBlock;
  /** The translated HTML (schema-parseable) — apply re-parses this. */
  translatedHtml: string;
  /** Plain text for the preview's translated column. */
  translatedText: string;
  /** Why this block kept its original (parse failed / empty response). */
  failed?: string;
  /** The source language the instance detected (first block only). */
  detected?: string;
}

/** The apply commit paths (the panel's two actions × the insert
 *  layout choice). */
export type TranslateApplyMode = 'replace' | 'insert-interleaved' | 'insert-appended';
