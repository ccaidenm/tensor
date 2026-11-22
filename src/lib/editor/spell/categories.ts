import type { LTMatch } from './types';

/**
 * THE CLASSIFICATION MAP — the single client-side decision on what each
 * LT category becomes. Style/tone/clarity is dropped at the REQUEST step;
 * unknown categories drop conservatively (dev-only warn).
 */

/** The spelling feature: LT's misspelling stream. */
const SPELLING_CATEGORIES = ['TYPOS'] as const;

/** The grammar feature: agreement, punctuation, common usage, in LT's
 *  category ids (validated against a real 6.6 server). */
const GRAMMAR_CATEGORIES = [
  'GRAMMAR',
  'PUNCTUATION',
  'CASING',
  'CONFUSED_WORDS',
  'TYPOGRAPHY',
] as const;

/** Always-excluded (style/tone/clarity — out of scope), sent as
 *  disabledCategories on every request. */
export const STYLE_CATEGORIES = [
  'STYLE',
  'COLLOQUIALISMS',
  'REDUNDANCY',
  'PLEONASM',
  'SEMANTICS',
  'CREATIVE_WRITING',
  'PLAIN_ENGLISH',
] as const;

export type MatchKind = 'spelling' | 'grammar' | 'dropped';

/** One match → its feature kind. Spelling first (misspelling can ride
 *  non-TYPOS categories like CONFUSED_WORDS), then the grammar
 *  allowlist, then dropped. */
export function classifyMatch(m: LTMatch): MatchKind {
  const category = m.rule?.category?.id;
  if (category === 'TYPOS' || m.rule?.issueType === 'misspelling') return 'spelling';
  if ((GRAMMAR_CATEGORIES as readonly string[]).includes(category)) return 'grammar';
  if (import.meta.env.DEV && category && !(STYLE_CATEGORIES as readonly string[]).includes(category)) {
    console.warn(`[spell] dropping match from unknown category "${category}" (rule ${m.rule?.id})`);
  }
  return 'dropped';
}

/** The server-side exclusion list for a request under the current
 *  toggles: style is ALWAYS excluded; whichever feature is off has its
 *  categories excluded too (leaner requests — the engine skips them). */
export function disabledCategoriesFor(spellingOn: boolean, grammarOn: boolean): string | undefined {
  const cats: string[] = [...STYLE_CATEGORIES];
  if (!spellingOn) cats.push(...SPELLING_CATEGORIES);
  if (!grammarOn) cats.push(...GRAMMAR_CATEGORIES);
  return cats.length > 0 ? cats.join(',') : undefined;
}
