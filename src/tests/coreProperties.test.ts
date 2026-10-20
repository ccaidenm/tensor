import { describe, it, expect } from 'vitest';
import {
  normalizeCoreProperties,
  toDocxCoreProperties,
  toPdfInfo,
} from '@/lib/document/coreProperties';
import { DocumentFileSchema, CURRENT_DOCUMENT_VERSION } from '@/lib/document/schema';

/**
 * M-META — the standard core properties: normalization, the export
 * contract spellings (DOCX #37 / PDF #39 consume these), and schema
 * back-compat. The dialog/store/plumbing behavior lives in
 * documentProperties.test.tsx and wpdoc.test.tsx.
 */

describe('normalizeCoreProperties', () => {
  it('trims values; whitespace-only fields drop out', () => {
    expect(
      normalizeCoreProperties({ title: '  Report  ', author: '   ', subject: 'Quarterly' }),
    ).toEqual({ title: 'Report', subject: 'Quarterly' });
  });

  it('null/undefined/empty in — empty object out', () => {
    expect(normalizeCoreProperties(null)).toEqual({});
    expect(normalizeCoreProperties(undefined)).toEqual({});
    expect(normalizeCoreProperties({})).toEqual({});
    expect(normalizeCoreProperties({ title: '', author: ' ' })).toEqual({});
  });
});

describe('the export contract', () => {
  it('DOCX cp:coreProperties spelling — author→creator, comments→description', () => {
    const meta = { title: 'T', author: 'A', subject: 'S', keywords: 'k1, k2', comments: 'C' };
    expect(toDocxCoreProperties(meta)).toEqual({
      title: 'T',
      subject: 'S',
      creator: 'A',
      keywords: 'k1, k2',
      description: 'C',
    });
  });

  it('DOCX: empty fields never map (no empty XML elements)', () => {
    expect(toDocxCoreProperties({ author: ' ' })).toEqual({});
    expect(toDocxCoreProperties({ title: 'T', author: '' })).toEqual({ title: 'T' });
  });

  it('PDF Info dictionary keys', () => {
    const meta = { title: 'T', author: 'A', subject: 'S', keywords: 'k', comments: 'C' };
    expect(toPdfInfo(meta)).toEqual({ Title: 'T', Author: 'A', Subject: 'S', Keywords: 'k' });
  });

  it('PDF has no standard comments field — comments never map', () => {
    expect(toPdfInfo({ comments: 'C' })).toEqual({});
  });
});

describe('schema back-compat', () => {
  it('the five fields round-trip through DocumentFileSchema', () => {
    const metadata = { title: 'T', author: 'A', subject: 'S', keywords: 'k', comments: 'C' };
    const parsed = DocumentFileSchema.parse({
      version: CURRENT_DOCUMENT_VERSION,
      docJSON: {},
      metadata,
    });
    expect(parsed.metadata).toMatchObject(metadata);
  });

  it('files that predate the fields still parse (all optional)', () => {
    const parsed = DocumentFileSchema.parse({ version: 1, docJSON: {}, metadata: {} });
    expect(parsed.metadata.title).toBeUndefined();
    expect(parsed.metadata.author).toBeUndefined();
  });
});
