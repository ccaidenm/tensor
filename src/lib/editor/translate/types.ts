/**
 * Translate — shared types: the wire contract (the Rust command's
 * shape), the block model (one translatable top-level block), and the
 * preview/apply surfaces.
 *
 * PRIVACY POSTURE (the spell-check consent law): translation is
 * inherently an ONLINE feature — the selected text (or the whole
 * document) leaves the device for the LibreTranslate instance the
 * user chose. The gate lives in client.ts (the catalogsAllowed
 * precedent): no invoke fires while config.translation.configured is
 * false, and the endpoint is the user's own, never a hardcoded
 * default.
 */

/** One instance language — the wire shape (GET /languages). */
export interface TranslationLanguage {
  code: string;
  name: string;
}

/**
 * One translatable top-level block: its serialized HTML (the
 * schema's own serializer — the same tags the document model speaks)
 * plus the PM range it occupies.
 *
 * GRANULARITY LAW: translation is TOP-LEVEL-block granularity — a
 * bullet list, blockquote, or table travels whole (its inner
 * paragraphs are part of the block's HTML), so structure never has
 * to be re-nested by hand and interleave inserts sibling blocks that
 * are already valid.
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
