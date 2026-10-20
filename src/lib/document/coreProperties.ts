/**
 * M-META — the document's standard core properties (title, author,
 * subject, keywords, comments): the .wpdoc metadata fields the
 * Properties dialog edits and the exporters embed. Out of scope by
 * ruling: custom/arbitrary user-defined fields — the standard five
 * cover the common case.
 *
 * Keywords are ONE string. Word's Properties dialog, OOXML
 * `cp:keywords`, and PDF `/Keywords` all spell keywords that way (a
 * single, conventionally comma-separated string) — storing the same
 * shape means no split/join rules exist anywhere in the pipeline.
 */

export interface DocumentCoreProperties {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  comments?: string;
}

const CORE_KEYS = ['title', 'author', 'subject', 'keywords', 'comments'] as const;

/**
 * Trim every field; whitespace-only → omitted. Empty in, empty out —
 * saves write only real content (the lineNumbers conditional-spread
 * precedent: absent means "never set", never ""). The document store
 * normalizes on write, so nothing downstream ever sees "".
 */
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

/**
 * THE EXPORT CONTRACT — DOCX export (#37) consumes this. OOXML
 * `cp:coreProperties` spellings: the document's author is `creator`
 * (the Dublin Core term) and comments are `description` (dc:description).
 */
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

/**
 * THE EXPORT CONTRACT — PDF export (#39) consumes this. PDF Info
 * dictionary keys. PDF has no standard comments field, so comments
 * never map (pinned by test — a future mapping can't invent one).
 */
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
