import { describe, expect, it, vi } from 'vitest';
import { checkForUpdate, compareVersions, parseRelease } from '@/lib/updater/check';

const RELEASE = {
  tag_name: 'v0.2.0',
  html_url: 'https://github.com/ccaidenm/tensor/releases/tag/v0.2.0',
};

describe('compareVersions()', () => {
  it.each([
    ['0.2.0', '0.1.0', 1],
    ['0.1.0', '0.2.0', -1],
    ['0.1.0', '0.1.0', 0],
    ['1.0.0', '0.9.9', 1],
    ['0.1.0', '0.1', 0],
    ['0.1', '0.1.1', -1],
    ['v0.2.0', '0.1.0', 1],
  ])('%s vs %s → %i', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });

  it('treats non-numeric segments as zero instead of NaN-poisoning', () => {
    expect(compareVersions('0.1.x', '0.1.0')).toBe(0);
  });
});

describe('parseRelease()', () => {
  it('strips the v prefix and keeps the html_url', () => {
    expect(parseRelease(RELEASE)).toEqual({
      version: '0.2.0',
      url: 'https://github.com/ccaidenm/tensor/releases/tag/v0.2.0',
    });
  });

  it('falls back to the releases page when html_url is missing', () => {
    const notice = parseRelease({ tag_name: 'v1.0.0' });
    expect(notice?.url).toBe('https://github.com/ccaidenm/tensor/releases/latest');
  });

  it.each([[null], [{}], [{ tag_name: '' }], [{ html_url: 3 }]])('rejects %j', (payload) => {
    expect(parseRelease(payload)).toBeNull();
  });
});

describe('checkForUpdate()', () => {
  function fetchReturning(status: number, body: unknown = RELEASE): typeof fetch {
    return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  }

  it('returns the notice when a newer release exists', async () => {
    expect(await checkForUpdate('0.1.0', fetchReturning(200))).toEqual({
      version: '0.2.0',
      url: 'https://github.com/ccaidenm/tensor/releases/tag/v0.2.0',
    });
  });

  it('returns null when running the latest version', async () => {
    expect(await checkForUpdate('0.2.0', fetchReturning(200))).toBeNull();
  });

  it('returns null on a non-OK response', async () => {
    expect(await checkForUpdate('0.1.0', fetchReturning(404))).toBeNull();
  });

  it('returns null when the fetch throws (offline is not a notification)', async () => {
    const failing = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await checkForUpdate('0.1.0', failing)).toBeNull();
  });
});
