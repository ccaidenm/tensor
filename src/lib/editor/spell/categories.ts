import type { LTMatch } from './types';

/**
 * THE CLASSIFICATION MAP — which LanguageTool categories the app
 * treats as spelling vs. grammar vs. never-rendered. The provider
 * (local sidecar or the online API) speaks the same wire; every match
 * it returns carries `rule.category.id`, and THIS map is the single
 * client-side ruling on what each becomes.
 *
 * THE SCOPE LINE (the issue's own): grammar = agreement, punctuation,
 * common usage — mechanical errors. Style/tone/clarity is explicitly
 * out, so every style-flavored category is dropped — not just at the
 * render step but at the REQUEST step (`disabledCategories`), so the
 * engine never even spends cycles on them.
 *
 * Unknown categories are dropped CONSERVATIVELY (they may be new
 * style categories we haven't met) — a loud dev-only warn, never a
 * silent flag.
 */

/** The spelling feature: LT's misspelling stream. */
const SPELLING_CATEGORIES = ['TYPOS'] as const;

/** The grammar feature — the issue's "agreement, punctuation, common
 *  usage" translated to LT's category ids (validated against a real
 *  6.6 server: subject-verb rules ride GRAMMAR, e.g. "He don't"). */
const GRAMMAR_CATEGORIES = [
  'GRAMMAR',
  'PUNCTUATION',
  'CASING',
  'CONFUSED_WORDS',
  'TYPOGRAPHY',
] as const;

/** Always-excluded (style/tone/clarity — the issue's out-of-scope
 *  clause), sent as disabledCategories on every request. */
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
