import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { render } from '@testing-library/react';
import {
  ACCENTS,
  ACCENTS_BY_ID,
  ACCENT_IDS,
  DEFAULT_ACCENT_ID,
} from '@/lib/branding/accents';
import { ConfigSchema } from '@/lib/config/schema';
import { useConfigStore } from '@/lib/config/store';
import { AboutPanel } from '@/components/settings/panels/AboutPanel';

/**
 * #97 — THE ACCENT ENGINE: the catalog, the schema field, the token
 * writer, the asset parity, and the About heart. The ENGINE's law:
 * ONE variable (--primary) carries the brand — every echo resolves
 * through it, the writer owns it, the catalog is the one source.
 */

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), 'utf-8');

describe('the accent catalog (#97)', () => {
  it('twelve accents, unique ids and hexes, ember first and default', () => {
    expect(ACCENTS).toHaveLength(12);
    expect(new Set(ACCENTS.map((a) => a.id)).size).toBe(12);
    expect(new Set(ACCENTS.map((a) => a.hex.toLowerCase())).size).toBe(12);
    expect(DEFAULT_ACCENT_ID).toBe('ember');
    expect(ACCENTS[0]!.id).toBe('ember');
    expect(ACCENTS_BY_ID.ember.hex.toLowerCase()).toBe('#ed5f27');
  });

  it('every accent has its matching logo file (the asset parity)', () => {
    for (const accent of ACCENTS) {
      const path = `../../public/tensor-logos/tensor-icon-${accent.id}.png`;
      expect(existsSync(new URL(path, import.meta.url)), path).toBe(true);
    }
  });

  it('the schema accepts every id, defaults to ember, rejects strangers', () => {
    for (const id of ACCENT_IDS) {
      expect(ConfigSchema.shape.accent.parse(id)).toBe(id);
    }
    expect(ConfigSchema.shape.accent.parse(undefined)).toBe('ember');
    expect(() => ConfigSchema.shape.accent.parse('chartreuse')).toThrow();
  });
});

describe('the accent token seam (#97)', () => {
  it('the CSS echoes resolve through --primary (ONE variable carries the brand)', () => {
    const css = read('../../src/index.css');
    expect(css).toContain('--ring: var(--primary)');
    expect(css).toContain('--sidebar-primary: var(--primary)');
    expect(css).toContain('--color-search-current: var(--primary)');
    // The CSS default IS the default accent — no flash before JS runs,
    // and correct even if the config layer never loads.
    expect(css).toContain('--primary: #ed5f27');
    // No hardcoded brand oklch survives anywhere in the token blocks.
    expect(css).not.toContain('oklch(0.64 0.19 42)');
    expect(css).not.toContain('oklch(0.70 0.18 42)');
  });
});

describe('the accent writer (#97)', () => {
  beforeEach(() => {
    useConfigStore.getState().setAccent('ember');
  });

  it('a selection retunes --primary inline and picks the readable ink', () => {
    const style = document.documentElement.style;
    useConfigStore.getState().setAccent('azure');
    expect(style.getPropertyValue('--primary').toLowerCase()).toBe('#38bdf8');
    // Azure is pale — the dark ink (the catalog's luminance pick).
    expect(style.getPropertyValue('--primary-foreground')).toBe('oklch(0.18 0.01 285)');

    useConfigStore.getState().setAccent('ember');
    expect(style.getPropertyValue('--primary').toLowerCase()).toBe('#ed5f27');
    expect(style.getPropertyValue('--primary-foreground')).toBe('oklch(1 0 0)');
  });

  it('every catalog accent applies cleanly (the writer is total)', () => {
    const style = document.documentElement.style;
    for (const accent of ACCENTS) {
      useConfigStore.getState().setAccent(accent.id);
      expect(style.getPropertyValue('--primary').toLowerCase()).toBe(accent.hex.toLowerCase());
      expect(style.getPropertyValue('--primary-foreground')).toBe(
        accent.foreground === 'white' ? 'oklch(1 0 0)' : 'oklch(0.18 0.01 285)',
      );
    }
  });

  it('the selection persists into the config shape (the store carries it)', () => {
    useConfigStore.getState().setAccent('teal');
    expect(useConfigStore.getState().config.accent).toBe('teal');
  });
});

describe('the About heart (#97 theme parity)', () => {
  it('the heart speaks the accent (the 🧡 emoji is retired)', () => {
    const { container } = render(<AboutPanel />);
    expect(container.textContent).not.toContain('🧡');
    const heart = container.querySelector('.lucide-heart');
    expect(heart).not.toBeNull();
    // text-primary: follows --primary — the accent's token echo.
    expect(heart!.getAttribute('class')).toContain('text-primary');
    expect(heart!.getAttribute('class')).toContain('fill-current');
  });
});
