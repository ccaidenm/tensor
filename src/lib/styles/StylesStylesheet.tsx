import { useMemo } from 'react';
import { useStyleRegistryStore } from '@/lib/styles/registry';
import { cssDeclarations } from '@/lib/styles/resolve';
import type { StyleDefinition } from '@/lib/styles/types';

/**
 * The pageless render path: a generated <style> sheet applies the
 * registry (paragraphs carry `wp-style-{id}`, spans `wp-charstyle-{id}`).
 * Precedence is CSS by construction — base < paragraph class < char
 * class < direct (source order; inline beats class).
 */

function buildSheet(definitions: Record<string, StyleDefinition>): string {
  const paragraphRules: string[] = [];
  const characterRules: string[] = [];
  for (const def of Object.values(definitions)) {
    const decls = cssDeclarations(def.properties);
    if (decls.length === 0) continue;
    const selector = def.kind === 'paragraph' ? `.wp-style-${def.id}` : `.wp-charstyle-${def.id}`;
    const rule = `${selector} { ${decls.join('; ')}; }`;
    (def.kind === 'paragraph' ? paragraphRules : characterRules).push(rule);
  }
  // Paragraph tier FIRST, character tier AFTER (source order = the
  // char tier wins at equal specificity — the cascade's middle).
  return [...paragraphRules, ...characterRules].join('\n');
}

export function StylesStylesheet() {
  const merged = useStyleRegistryStore((s) => s.merged);
  const css = useMemo(() => buildSheet(merged), [merged]);
  return <style data-testid="styles-stylesheet">{css}</style>;
}
