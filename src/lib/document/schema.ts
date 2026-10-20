import { z } from 'zod';
import type { DocumentCoreProperties } from './coreProperties';
import type { PageSetup } from './pageSetup';
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
  orientation: z.enum(['portrait', 'landscape']).optional(),
  pageColor: z.string().optional(),
  customWidth: z.number().optional(),
  customHeight: z.number().optional(),
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
    styles: DocStylesSchema.optional(),
    lineNumbers: LineNumbersSchema.optional(),
  }).default({}),
});

export type DocumentFile = z.infer<typeof DocumentFileSchema>;
export type { StyleDefinition };
