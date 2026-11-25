import { describe, expect, it, vi } from 'vitest';
import { t, useI18n, type Dictionary } from '@/lib/i18n';
import en from '../../locales/en.json';

type DictNode = string | { [key: string]: DictNode };

/** Every leaf of the dictionary must be a non-empty string. */
function leafKeys(node: DictNode, prefix = ''): string[] {
  if (typeof node === 'string') return prefix ? [prefix] : [];
  return Object.entries(node).flatMap(([key, value]) => leafKeys(value, prefix ? `${prefix}.${key}` : key));
}

describe('the en dictionary', () => {
  it('has only non-empty string leaves', () => {
    const leaves = leafKeys(en as DictNode);
    expect(leaves.length).toBeGreaterThan(0);
    for (const key of leaves) {
      const value = key.split('.').reduce<unknown>((node, segment) => (node as Record<string, unknown>)[segment], en);
      expect(value, key).toBeTypeOf('string');
      expect(value as string, key).not.toHaveLength(0);
    }
  });

  it('exports a dictionary whose shape matches its own type', () => {
    // The module derives its key space from typeof en — this assertion
    // keeps t()'s input honest if the JSON ever grows a non-object root.
    const dict: Dictionary = en;
    expect(Object.keys(dict)).toContain('about');
  });
});

describe('t()', () => {
  it('resolves a real dot-path key', () => {
    expect(t('about.info.title')).toBe('Info');
  });

  it('interpolates named {params}', () => {
    expect(t('about.info.version', { version: '0.1.0', license: 'AGPL-3.0' })).toBe('Version 0.1.0 · AGPL-3.0');
    expect(t('about.licenses.intro', { count: 41 })).toContain('41');
  });

  it('returns the key (and warns once) for a missing translation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(t('about.does.not.exist' as never)).toBe('about.does.not.exist');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(t('about.does.not.exist' as never)).toBe('about.does.not.exist');
    expect(warn).toHaveBeenCalledTimes(1); // warned once per key, not per call
    warn.mockRestore();
  });
});

describe('useI18n.setLocale()', () => {
  it('refuses a locale with no dictionary file', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    useI18n.getState().setLocale('xx');
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no dictionary for "xx"'));
    });
    expect(useI18n.getState().locale).toBe('en');
    warn.mockRestore();
  });
});
