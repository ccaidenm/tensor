import { z } from 'zod';
import type { DocumentCoreProperties } from './coreProperties';
import type { PageSetup } from './pageSetup';
import type { HeaderFooterSettings } from './headerFooter';
import { StyleDefinitionSchema, type StyleDefinition } from '@/lib/styles/types';

export const CURRENT_DOCUMENT_VERSION = 1;

const PageSetupSchema = z.object({
  pageSize: z.string(),
  margins: z.object({
    top: z.number(),
    bottom: z.number(),
    left: z.number(),
    right: z.number(),
  }),
  pageGap: z.number(),
  /** #103 — the doc's rendering mode RIDES THE FILE (the model's
   *  field, now persisted — its absence here silently stripped it on
   *  every save, so every document re-resolved to the app default on
   *  open; the user-caught pageless-everything bug). Absent = old
   *  files resolve via the config default (the resolveViewMode law). */
  viewMode: z.enum(['pages', 'pageless']).optional(),
  orientation: z.enum(['portrait', 'landscape']).optional(),
  pageColor: z.string().optional(),
  customWidth: z.number().optional(),
  customHeight: z.number().optional(),
  /** M-FLOW — the document-level widow/orphan default; absent = ON. */
  widowControl: z.boolean().optional(),
  /** #WATERMARK — the decorative page overlay; absent/null = none. */
  watermark: z
    .object({
      kind: z.enum(['text', 'image']),
      text: z.string().optional(),
      fontSize: z.number().positive().optional(),
      color: z.string().optional(),
      rotation: z.number().optional(),
      opacity: z.number().min(0).max(1).optional(),
      src: z.string().optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      scale: z.number().positive().optional(),
    })
    .nullable()
    .optional(),
  /** #74 COLUMNS — the document-level column spec; absent/null = one column. */
  columns: z
    .object({
      count: z.number().int().min(1),
      /** POINTS — the store's canonical unit (toLayoutOptions converts). */
      gap: z.number().nonnegative().optional(),
      /** Absolute per-column widths in POINTS (the engine's weights). */
      widths: z.array(z.number()).optional(),
      balanced: z.boolean().optional(),
    })
    .nullable()
    .optional(),
}) satisfies z.ZodType<PageSetup>;

/**
 * M-STYLES: the document's own style definitions (the DOC layer of
 * the registry merge — doc overrides global by id; see
 * lib/styles/registry.ts). Optional: old files predate styles and
 * merge as an empty layer. The styleIds on the document's paragraphs
 * ride docJSON (the PM document) — this field carries the DEFINITIONS
 * the document depends on beyond the global registry.
 */
const DocStylesSchema = z.object({
  definitions: z.array(StyleDefinitionSchema).default([]),
});

/**
 * #48 — the per-page styles. File-side spelling: JSON keys are
 * STRINGS (page indexes serialize as strings); normalizePageStyles
 * converts to numeric keys on open. Absent = no per-page styles (the
 * lineNumbers/optional-field precedent — old files open unchanged).
 */
export const PageStylesSchema = z.record(
  z.string(),
  z.object({ background: z.string().optional() }),
);

/**
 * M-LINENUMS: the document's line-number gutter setting. Optional —
 * old files predate it and open with the gutter off (the styles
 * precedent). countBy is metadata-only in v1 (no ribbon UI): the
 * counter advances on every line; a number is SHOWN only when
 * (n−1) % countBy === 0, else the line renders blank.
 */
export const LineNumbersSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['continuous', 'per-page', 'per-paragraph']),
  countBy: z.number().int().min(1).optional(),
});

export type LineNumbersSetting = z.infer<typeof LineNumbersSchema>;

/**
 * M-HEADER-FOOTER-2: the document's header/footer SETTINGS (enables,
 * different-first-page). Optional — old files predate them and open
 * with headers/footers off (the styles/lineNumbers precedent). The
 * CONTENT rides docJSON (headerBlock/footerBlock nodes). The schema
 * is compile-checked against the model type, so the two can't drift.
 * The v1 shape (per-region content docs) is recognized by the open
 * path's migration — see lib/document/headerFooter.ts.
 */
export const HeaderFooterSchema = z.object({
  scope: z.object({ kind: z.literal('document') }),
  differentFirstPage: z.boolean(),
}) satisfies z.ZodType<HeaderFooterSettings>;

/**
 * #COMMENTS — the file-side thread validation. Optional — old files
 * predate it and open with no threads (the styles/lineNumbers
 * precedent). NOT named `comments`: that key is the core-properties
 * "description" field (CorePropertiesSchema). The ANCHORS ride docJSON
 * (the comment mark's threadId); this array is the CONTENT half — the
 * ids are the join. Entries are ≥1 (deleting the last entry deletes
 * the thread, so a saved file never holds an empty one).
 */
export const CommentThreadsSchema = z.array(
  z.object({
    id: z.string(),
    entries: z
      .array(
        z.object({
          id: z.string(),
          author: z.string(),
          text: z.string(),
          createdAt: z.string(),
          editedAt: z.string().optional(),
        }),
      )
      .min(1),
    resolved: z.boolean(),
    resolvedAt: z.string().optional(),
    resolvedBy: z.string().optional(),
  }),
) satisfies z.ZodType<import('@/lib/comments/store').CommentThread[]>;

/**
 * M-HEADER-FOOTER-2: the v1 shape (per-region TipTap JSON docs) —
 * kept ONLY so the open path can SEE it (zod strips unknown keys;
 * without this union the legacy content fields would vanish before
 * the migration reads them) and translate it into doc-level nodes.
 * Never written by saves.
 *
 * UNION ORDER MATTERS: z.union picks the FIRST success, and the plain
 * settings object schema SUCCEEDS on legacy input by stripping — so
 * legacy must come FIRST, and must be distinguishable: the refine
 * requires at least one region CONTENT doc (new settings files have
 * none; a legacy file with all-empty regions migrates as settings
 * with no content, which is exactly its meaning).
 */
const LegacyHfRegionSchema = z
  .object({ doc: z.any().nullable().optional() })
  .nullable()
  .optional();

export const LegacyHeaderFooterSchema = z
  .object({
    scope: z.object({ kind: z.literal('document') }).optional(),
    headerEnabled: z.boolean().optional(),
    footerEnabled: z.boolean().optional(),
    differentFirstPage: z.boolean().optional(),
    header: LegacyHfRegionSchema,
    footer: LegacyHfRegionSchema,
    firstHeader: LegacyHfRegionSchema,
    firstFooter: LegacyHfRegionSchema,
  })
  .refine(
    (v) =>
      v.header != null || v.footer != null || v.firstHeader != null || v.firstFooter != null,
    { message: 'no legacy region content' },
  );

export type LegacyHeaderFooterMetadata = z.infer<typeof LegacyHeaderFooterSchema>;
export type HeaderFooterMetadata =
  | z.infer<typeof HeaderFooterSchema>
  | LegacyHeaderFooterMetadata;

/**
 * M-META: the document's standard core properties — the fields the
 * Properties dialog edits and the exporters embed (DOCX #37 / PDF #39
 * consume the mappings in lib/document/coreProperties.ts). All
 * optional: old files predate them and open with them empty (the
 * styles precedent). `title` predates this milestone (never written
 * by the save path until M-META); keywords are ONE string — OOXML and
 * PDF both spell keywords that way. The schema is compile-checked
 * against the model type, so the two can't drift.
 */
const CorePropertiesSchema = z.object({
  title: z.string().optional(),
  author: z.string().optional(),
  subject: z.string().optional(),
  keywords: z.string().optional(),
  comments: z.string().optional(),
}) satisfies z.ZodType<DocumentCoreProperties>;

export const DocumentFileSchema = z.object({
  version: z.number(),
  docJSON: z.any(),
  metadata: z.object({
    ...CorePropertiesSchema.shape,
    createdAt: z.string().optional(),
    modifiedAt: z.string().optional(),
    originalPath: z.string().optional(),
    pageSetup: PageSetupSchema.optional(),
    pageStyles: PageStylesSchema.optional(),
    styles: DocStylesSchema.optional(),
    lineNumbers: LineNumbersSchema.optional(),
    headerFooter: z.union([LegacyHeaderFooterSchema, HeaderFooterSchema]).optional(),
    /** #COMMENTS — the threads' CONTENT half (the anchors ride docJSON
     *  as comment marks; the ids join them). Absent = the file predates
     *  comments (or carries none). */
    commentThreads: CommentThreadsSchema.optional(),
  }).default({}),
});

export type DocumentFile = z.infer<typeof DocumentFileSchema>;
export type { StyleDefinition };