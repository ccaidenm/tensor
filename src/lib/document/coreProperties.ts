/**
 * The document's standard core properties (title, author, subject,
 * keywords, comments) — the .wpdoc metadata the Properties dialog
 * edits and the exporters embed. Keywords are ONE string, matching
 * Word/OOXML/PDF, so no split/join rules exist in the pipeline.
 */

export interface DocumentCoreProperties {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  comments?: string;
}

const CORE_KEYS = ['title', 'author', 'subject', 'keywords', 'comments'] as const;

/** Trim each field; whitespace-only → omitted. Absent means "never set", never "" — nothing downstream sees "". */
export function normalizeCoreProperties(
  raw: DocumentCoreProperties | null | undefined,
): DocumentCoreProperties {
  if (!raw) return {};
  const out: DocumentCoreProperties = {};
  for (const key of CORE_KEYS) {
    const value = raw[key]?.trim();
    if (value) out[key] = value;
  }
  return out;
}

/** DOCX export (#37) consumes this: OOXML spells author as `creator` (Dublin Core) and comments as `description` (dc:description). */
export interface DocxCoreProperties {
  title?: string;
  subject?: string;
  creator?: string;
  keywords?: string;
  description?: string;
}

export function toDocxCoreProperties(
  meta: DocumentCoreProperties | null | undefined,
): DocxCoreProperties {
  const n = normalizeCoreProperties(meta);
  return {
    ...(n.title ? { title: n.title } : {}),
    ...(n.subject ? { subject: n.subject } : {}),
    ...(n.author ? { creator: n.author } : {}),
    ...(n.keywords ? { keywords: n.keywords } : {}),
    ...(n.comments ? { description: n.comments } : {}),
  };
}

/** PDF export (#39) consumes this. PDF has no standard comments field, so comments never map (pinned by test). */
export interface PdfInfo {
  Title?: string;
  Author?: string;
  Subject?: string;
  Keywords?: string;
}

export function toPdfInfo(
  meta: DocumentCoreProperties | null | undefined,
): PdfInfo {
  const n = normalizeCoreProperties(meta);
  return {
    ...(n.title ? { Title: n.title } : {}),
    ...(n.author ? { Author: n.author } : {}),
    ...(n.subject ? { Subject: n.subject } : {}),
    ...(n.keywords ? { Keywords: n.keywords } : {}),
  };
}
