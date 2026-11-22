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
  /** #103 — the doc's rendering mode rides the file; schema-absence
   *  silently stripped it on save (the pageless-everything bug).
   *  Absent = old files resolve via the config default. */
  viewMode: z.enum(['pages', 'pageless']).optional(),
  orientation: z.enum(['portrait', 'landscape']).optional(),
  pageColor: z.string().optional(),
  customWidth: z.number().optional(),
  customHeight: z.number().optional(),
  /** The document-level widow/orphan default; absent = on. */
  widowControl: z.boolean().optional(),
  /** The decorative page overlay; absent/null = none. */
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
  /** #74 — the document-level column spec; absent/null = one column. */
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
 * The document's own style definitions (the DOC layer of the registry
 * merge — doc overrides global by id). Paragraph styleIds ride docJSON;
 * this carries definitions beyond the global registry. Optional for old files.
 */
const DocStylesSchema = z.object({
  definitions: z.array(StyleDefinitionSchema).default([]),
});

/**
 * #48 — the per-page styles. File-side spelling: JSON keys are STRINGS
 * (page indexes serialize as strings); normalizePageStyles converts to
 * numeric keys on open. Absent = none (old files open unchanged).
 */
export const PageStylesSchema = z.record(
  z.string(),
  z.object({ background: z.string().optional() }),
);

/**
 * The line-number gutter setting; optional (old files open with it off).
 * countBy: the counter advances on every line but a number shows only
 * when (n−1) % countBy === 0, else the line renders blank.
 */
export const LineNumbersSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['continuous', 'per-page', 'per-paragraph']),
  countBy: z.number().int().min(1).optional(),
});

export type LineNumbersSetting = z.infer<typeof LineNumbersSchema>;

/**
 * The header/footer SETTINGS (content rides docJSON as band nodes).
 * Optional — old files open with headers/footers off. Compile-checked
 * against the model type; the v1 shape is handled by the open-path migration
 * (lib/document/headerFooter.ts).
 */
export const HeaderFooterSchema = z.object({
  scope: z.object({ kind: z.literal('document') }),
  differentFirstPage: z.boolean(),
}) satisfies z.ZodType<HeaderFooterSettings>;

/**
 * File-side thread validation; optional (old files open with none). NOT
 * named `comments` — that key is the core-properties "description" field.
 * Anchors ride docJSON; entries are ≥1 (the file never holds an empty one).
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
 * The v1 shape (per-region content docs), kept so zod doesn't strip its
 * region fields before the migration reads them; never written. Union
 * order matters: the settings schema succeeds on legacy input by
 * stripping, so legacy must come first.
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

/**
 * The standard core properties (DOCX #37 / PDF #39 consume the mappings
 * in coreProperties.ts). Optional (old files open empty); keywords are
 * ONE string. Compile-checked against the model type.
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
    /** Comment threads' content half (anchors ride docJSON; absent =
     *  the file predates comments or carries none). */
    commentThreads: CommentThreadsSchema.optional(),
  }).default({}),
});

export type DocumentFile = z.infer<typeof DocumentFileSchema>;
export type { StyleDefinition };