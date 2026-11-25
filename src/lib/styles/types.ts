import { z } from 'zod';

/**
 * A style is a named, addressable set of properties: documents
 * reference styles by id (styleId attr, default 'normal' — old
 * documents get it via the attr default on load, no migration);
 * resolution happens only in resolveRun, never in the engine.
 */

export type StyleKind = 'paragraph' | 'character';

/**
 * Length-preserving casing: every value maps source chars to output
 * chars 1:1, keeping PM and engine offsets identity-mapped — length-
 * changing transforms are banned (transformText asserts).
 */
export type TextTransform = 'uppercase' | 'lowercase' | 'capitalize' | 'title-case' | 'none';

export const StylePropertiesSchema = z.object({
  fontFamily: z.string().optional(),
  fontSize: z.number().positive().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strike: z.boolean().optional(),
  color: z.string().optional(),
  /** Highlight background (the same mark the ribbon's Highlighter
   * button sets). */
  highlight: z.string().optional(),
  lineHeight: z.number().positive().optional(),
  spaceBefore: z.number().optional(),
  spaceAfter: z.number().optional(),
  indentLeft: z.number().optional(),
  indentRight: z.number().optional(),
  firstLineIndent: z.number().optional(),
  /**
   * 'justify': pageless renders it natively; paginated treats it as
   * left + the dropped-attr warning (same as the textAlign attr).
   */
  textAlign: z.enum(['left', 'center', 'right', 'justify']).optional(),
  fontVariant: z.enum(['small-caps', 'normal']).optional(),
  textTransform: z.enum(['uppercase', 'lowercase', 'capitalize', 'title-case', 'none']).optional(),
  /**
   * Pagination flags at the style tier — same spellings as the
   * engine's FlowPolicy; direct attrs beat the style; absent =
   * inherit (keeps off, widowControl on). Paragraph-kind styles only.
   */
  keepNext: z.boolean().optional(),
  keepLines: z.boolean().optional(),
  keepPrevious: z.boolean().optional(),
  widowControl: z.boolean().optional(),
  breakBefore: z.literal('page').optional(),
  breakAfter: z.literal('page').optional(),
});

export type StyleProperties = z.infer<typeof StylePropertiesSchema>;

export const StyleDefinitionSchema = z.object({
  id: z.string().min(1),
  /** Display name. Rename changes name ONLY — never id. */
  name: z.string().min(1),
  kind: z.enum(['paragraph', 'character']),
  properties: StylePropertiesSchema.default({}),
});

export type StyleDefinition = z.infer<typeof StyleDefinitionSchema>;

/** The fixed built-in registry ids. These can be EDITED (name and
 * properties, via the registry-epoch path) but never DELETED and
 * never renamed (id is identity). */
export const BUILTIN_PARAGRAPH_IDS = ['normal', 'heading-1', 'heading-2', 'heading-3', 'quote'] as const;
export const BUILTIN_CHARACTER_IDS = ['emphasis', 'strong'] as const;
export const BUILTIN_IDS = [...BUILTIN_PARAGRAPH_IDS, ...BUILTIN_CHARACTER_IDS] as const;
export type BuiltinId = (typeof BUILTIN_IDS)[number];

export function isBuiltinId(id: string): id is BuiltinId {
  return (BUILTIN_IDS as readonly string[]).includes(id);
}

/** The heading tier's reserved id spelling (`heading-1` .. `heading-6`).
 * The Dropdown exposes 1..3 as built-ins; 4..6 are keyboard-only
 * levels whose visual defaults live in builtins.ts (legacy fallback). */
export function headingStyleId(level: number): string {
  return `heading-${level}`;
}

export function isHeadingStyleId(id: string): boolean {
  return /^heading-[1-6]$/.test(id);
}

/**
 * The registry snapshot the adapter consumes — pure data (the
 * adapter never imports the zustand store). Any definition edit
 * bumps `epoch`, invalidating the adapter's identity cache wholesale.
 */
export interface StyleRegistrySnapshot {
  definitions: Record<string, StyleDefinition>;
  epoch: number;
}
