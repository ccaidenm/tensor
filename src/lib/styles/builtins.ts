import type { StyleDefinition, StyleProperties } from './types';

/**
 * The code layer of the registry merge (code ← global styles.json ←
 * per-doc metadata). 'normal' carries no properties — absent values
 * fall through to the config's baseStyle; editing it overrides them.
 */
export const BUILTIN_DEFINITIONS: StyleDefinition[] = [
  { id: 'normal', name: 'Normal Text', kind: 'paragraph', properties: {} },
  // Heading styles ship keepNext: true — Word's own Heading 1–3
  // default, so a heading never strands at a page bottom away from
  // its first paragraph.
  { id: 'heading-1', name: 'Heading 1', kind: 'paragraph', properties: { fontSize: 32, bold: true, keepNext: true } },
  { id: 'heading-2', name: 'Heading 2', kind: 'paragraph', properties: { fontSize: 24, bold: true, keepNext: true } },
  { id: 'heading-3', name: 'Heading 3', kind: 'paragraph', properties: { fontSize: 19, bold: true, keepNext: true } },
  { id: 'quote', name: 'Quote', kind: 'paragraph', properties: { italic: true } },
  // The caption style — an ordinary editable built-in; the ToF #31
  // hook reads captions regardless of the display toggle.
  { id: 'caption', name: 'Caption', kind: 'paragraph', properties: { fontSize: 12, italic: true } },
  { id: 'emphasis', name: 'Emphasis', kind: 'character', properties: { italic: true } },
  { id: 'strong', name: 'Strong', kind: 'character', properties: { bold: true } },
];

/**
 * Keyboard-only heading levels (4..6): the Heading node produces them
 * via Ctrl+Alt+4..6, so the resolver needs a silent default — a
 * warning would fire on every legitimate level-5 heading.
 */
export const LEGACY_HEADING_FALLBACK: Record<string, StyleProperties> = {
  // keepNext here too (Word's Heading 4–6 default); the DOCX style
  // export reads these fallbacks when no registry definition exists.
  'heading-4': { fontSize: 16, bold: true, keepNext: true },
  'heading-5': { fontSize: 13, bold: true, keepNext: true },
  'heading-6': { fontSize: 11, bold: true, keepNext: true },
};

/**
 * A one-time custom seed — a normal deletable character style. #29:
 * concrete hex, not var(--primary) — canvas fillStyle cannot resolve
 * CSS variables; '#ea580c' approximates the light-theme --primary.
 */
export const HYPERLINK_SEED: StyleDefinition = {
  id: 'hyperlink',
  name: 'Hyperlink',
  kind: 'character',
  properties: { color: '#ea580c', underline: true },
};

export function builtinDefinitionsById(): Record<string, StyleDefinition> {
  return Object.fromEntries(BUILTIN_DEFINITIONS.map((d) => [d.id, d]));
}
