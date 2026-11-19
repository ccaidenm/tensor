import type { Editor } from '@tiptap/core';

export interface DocumentStats {
  words: number;
  characters: number;
  charactersWithSpaces: number;
}

export function getDocumentStats(editor: Editor): DocumentStats {
  const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, ' ', ' ');
  const trimmed = text.trim();
  const words = trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
  const characters = text.replace(/\s/g, '').length;
  const charactersWithSpaces = text.length;
  return { words, characters, charactersWithSpaces };
}

export interface CursorPosition {
  line: number;
  column: number;
}

export function getCursorPosition(editor: Editor): CursorPosition {
  const { from } = editor.state.selection;
  const resolvedPos = editor.state.doc.resolve(from);

  let line = 1;
  editor.state.doc.forEach((_node, offset, index) => {
    if (offset < from) line = index + 1;
  });

  const column = resolvedPos.parentOffset + 1;
  return { line, column };
}

// ─── STATISTICS (the Review tab's dashboard) ───────────────────────────
//
// THE SECTIONED WALK: one structured pass over the top-level blocks
// produces the document summary AND the heading-delimited breakdown —
// the lightweight, display-only "section" concept the issue asks for
// (every heading H1–H6 starts a region titled by its text; content
// before the first heading is the Preamble). This is deliberately NOT
// the Sections/section-breaks document-model feature.
//
// THE READABILITY HEURISTICS are standard and English-centric (the
// panel discloses it): syllables from vowel groups with the silent-e
// adjustment, sentences from terminators + line breaks, Flesch Reading
// Ease (0–100, clamped) and Flesch–Kincaid Grade from the classic
// formulas. No libraries — the formulas ARE the feature.

export interface RegionStats {
  /** The heading's text, or 'Preamble'. */
  title: string;
  /** The heading level (1–6); null for the Preamble. */
  level: number | null;
  /** Doc position of the region's first block — the row-navigation seam. */
  pos: number;
  words: number;
  characters: number;
  charactersWithSpaces: number;
  sentences: number;
  syllables: number;
}

export interface StatisticsReport {
  /** Document-wide rollup (headings included). */
  total: RegionStats;
  /** Heading-delimited regions, in document order. */
  regions: RegionStats[];
}

function emptyRegion(title: string, level: number | null, pos: number): RegionStats {
  return {
    title,
    level,
    pos,
    words: 0,
    characters: 0,
    charactersWithSpaces: 0,
    sentences: 0,
    syllables: 0,
  };
}

/** Sentence-ish pieces: terminator (. ! ? …) followed by space/end, or
 *  a line break (a list item without a period is still a "sentence"
 *  for readability purposes — a heuristic, disclosed in the panel). */
export function countSentences(text: string): number {
  return text
    .split(/[.!?…]+(?:\s|$)|\n+/)
    .map((s) => s.trim())
    .filter(Boolean).length;
}

/** One word's syllable estimate: vowel groups (a e i o u y) with the
 *  silent-e adjustment ("cake" → 1, "table" → 2 — a consonant+le
 *  ending keeps its vowel group); letterless words (digits) speak as
 *  one syllable; never fewer than one. */
export function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 1;
  const groups = w.match(/[aeiouy]+/g)?.length ?? 0;
  let n = groups;
  if (w.length > 2 && w.endsWith('e') && !/[^aeiouy]le$/.test(w)) n -= 1;
  return Math.max(1, n);
}

function accumulate(region: RegionStats, text: string): void {
  region.charactersWithSpaces += text.length;
  region.characters += text.replace(/\s/g, '').length;
  const trimmed = text.trim();
  if (!trimmed) return;
  const words = trimmed.split(/\s+/);
  region.words += words.length;
  region.sentences += countSentences(trimmed);
  for (const word of words) region.syllables += countSyllables(word);
}

/**
 * THE REPORT — the panel's and the dialog's shared computation (one
 * walk, many surfaces; the numbers can never drift). Headings count as
 * words in both their own region and the total.
 */
export function getSectionedStats(editor: Editor): StatisticsReport {
  const doc = editor.state.doc;
  const total = emptyRegion('Document', null, 0);
  const regions: RegionStats[] = [];
  let current: RegionStats | null = null;
  let first = true;

  doc.forEach((node, offset) => {
    const isHeading = node.type.name === 'heading';
    if (isHeading) {
      current = emptyRegion(node.textContent.trim() || '(untitled)', node.attrs.level as number, offset);
      regions.push(current);
    } else if (!current) {
      current = emptyRegion('Preamble', null, offset);
      regions.push(current);
    }
    // THE TEXT BETWEEN LAW: reproduce doc.textBetween(0, size, ' ', ' ')
    // exactly so the totals can never drift from the status bar — a
    // block-separator space before every node but the first, and leaf
    // nodes (images, rules) render as the leafText (' ') just like the
    // whole-doc call does.
    const own = node.isLeaf ? ' ' : node.textBetween(0, node.content.size, ' ', ' ');
    const text = first ? own : ' ' + own;
    first = false;
    accumulate(total, text);
    if (current) accumulate(current, text);
  });

  return { total, regions };
}

// ─── Reading time ──────────────────────────────────────────────────────

/** The standard words-per-minute baseline (the issue's "standard
 *  baseline" — 200 wpm, the classic reading-speed convention). */
export const READING_WPM = 200;

export function formatReadingTime(words: number): string {
  if (words <= 0) return '—';
  const minutes = words / READING_WPM;
  if (minutes < 1) return '< 1 min';
  return `≈ ${Math.round(minutes)} min`;
}

// ─── Readability ───────────────────────────────────────────────────────

/** Flesch Reading Ease: 206.835 − 1.015·(words/sentences) − 84.6·
 *  (syllables/words), clamped to [0, 100] (real texts can score
 *  negative; the UI shows a band, so the clamp keeps it honest).
 *  null when there is nothing to read. */
export function fleschReadingEase(words: number, sentences: number, syllables: number): number | null {
  if (words === 0 || sentences === 0) return null;
  const score = 206.835 - 1.015 * (words / sentences) - 84.6 * (syllables / words);
  return Math.max(0, Math.min(100, score));
}

/** Flesch–Kincaid Grade Level: 0.39·(words/sentences) + 11.8·
 *  (syllables/words) − 15.59, floored at 0 (kindergarten). null when
 *  there is nothing to read. */
export function fleschKincaidGrade(words: number, sentences: number, syllables: number): number | null {
  if (words === 0 || sentences === 0) return null;
  const grade = 0.39 * (words / sentences) + 11.8 * (syllables / words) - 15.59;
  return Math.max(0, grade);
}

/** The standard Flesch bands (Wikipedia's table). */
export function fleschBand(score: number): string {
  if (score >= 90) return 'Very easy';
  if (score >= 80) return 'Easy';
  if (score >= 70) return 'Fairly easy';
  if (score >= 60) return 'Standard';
  if (score >= 50) return 'Fairly difficult';
  if (score >= 30) return 'Difficult';
  return 'Very confusing';
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}
