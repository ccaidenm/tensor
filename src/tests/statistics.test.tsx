import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { tensorExtensions } from '@/lib/editor/tensorExtensions';
import {
  getSectionedStats,
  getDocumentStats,
  countSentences,
  countSyllables,
  formatReadingTime,
  fleschReadingEase,
  fleschKincaidGrade,
  fleschBand,
  fleschBandTone,
} from '@/lib/editor/documentStats';

/**
 * The statistics computation — the sectioned walk (regions, sentences,
 * syllables), the readability math against hand-computed values, and
 * the no-drift invariant: the sidebar's totals must equal the status
 * bar's whole-document numbers exactly (one computation, many surfaces).
 */

function makeEditor(html: string): Editor {
  return new Editor({ extensions: tensorExtensions(), content: html });
}

describe('the sectioned walk', () => {
  it('splits regions at every heading, with the Preamble before the first', () => {
    const editor = makeEditor(
      '<p>Intro text here.</p>' +
      '<h1>Chapter One</h1>' +
      '<p>First paragraph of chapter one.</p>' +
      '<h2>Section 1.1</h2>' +
      '<p>Deep content.</p>' +
      '<h1>Chapter Two</h1>' +
      '<ul><li>Item one</li><li>Item two</li></ul>',
    );
    const { regions } = getSectionedStats(editor);
    expect(regions.map((r) => r.title)).toEqual(['Preamble', 'Chapter One', 'Section 1.1', 'Chapter Two']);
    expect(regions.map((r) => r.level)).toEqual([null, 1, 2, 1]);
    // The Preamble holds only the pre-heading paragraph.
    expect(regions[0]!.words).toBe(3);
    // Chapter One = its own heading text (2) + its paragraph (5).
    expect(regions[1]!.words).toBe(7);
    // Section 1.1 = heading (2) + paragraph (2).
    expect(regions[2]!.words).toBe(4);
    // Chapter Two = heading (2) + list items (4).
    expect(regions[3]!.words).toBe(6);
  });

  it('headings count as words in their own region AND the total', () => {
    const editor = makeEditor('<h1>Alpha</h1><p>Beta gamma.</p>');
    const { total, regions } = getSectionedStats(editor);
    expect(regions[0]!.words).toBe(3); // Alpha + Beta + gamma
    expect(total.words).toBe(3);
  });

  it('a heading-only region keeps its heading words (no silent drops)', () => {
    const editor = makeEditor('<h1>One</h1><h2>Two</h2><p>Three four.</p>');
    const { regions } = getSectionedStats(editor);
    expect(regions.map((r) => r.words)).toEqual([1, 3]); // 'One' | 'Two' + 'Three four.'
  });

  it('captures positions for navigation (each region starts at its block)', () => {
    const editor = makeEditor('<p>Intro</p><h1>Head</h1><p>Body</p>');
    const { regions } = getSectionedStats(editor);
    // <p>Intro</p> occupies 0..7; the h1 starts at 7.
    expect(regions[0]!.pos).toBe(0);
    expect(regions[1]!.pos).toBe(7);
  });

  it('THE NO-DRIFT LAW: totals equal the status bar\'s whole-document numbers', () => {
    const editor = makeEditor(
      '<h1>Title here</h1>' +
      '<p>Some <strong>bold</strong> text and <a href="https://x">a link</a>.</p>' +
      '<ul><li>List item one</li><li>Item two</li></ul>' +
      '<blockquote><p>Quoted words.</p></blockquote>' +
      '<table><tr><th>H</th><td>Cell text</td></tr></table>' +
      '<p><img src="x.png">inline</p>' +
      '<hr>',
    );
    const whole = getDocumentStats(editor);
    const { total } = getSectionedStats(editor);
    expect(total.words).toBe(whole.words);
    expect(total.characters).toBe(whole.characters);
    expect(total.charactersWithSpaces).toBe(whole.charactersWithSpaces);
  });
});

describe('the sentence heuristic', () => {
  it('counts terminators and line breaks, ignores trailing pieces', () => {
    expect(countSentences('One. Two! Three?')).toBe(3);
    expect(countSentences('No terminator here')).toBe(1);
    expect(countSentences('Item one\nItem two\nItem three')).toBe(3);
    expect(countSentences('Ellipsis … done.')).toBe(2);
    expect(countSentences('')).toBe(0);
  });
});

describe('the syllable heuristic', () => {
  it('reads known words correctly', () => {
    expect(countSyllables('cat')).toBe(1);
    expect(countSyllables('cake')).toBe(1); // silent e
    expect(countSyllables('table')).toBe(2); // consonant+le keeps the group
    expect(countSyllables('candle')).toBe(2);
    expect(countSyllables('beautiful')).toBe(3);
    expect(countSyllables('syllable')).toBe(3);
    expect(countSyllables('rhythm')).toBe(1); // y as the only vowel
    expect(countSyllables('123')).toBe(1); // letterless speaks as one
  });
});

describe('the readability math', () => {
  // words=100, sentences=5 (20 w/s), syllables=180 (1.8 s/w) —
  // hand-computed from the classic formulas.
  const words = 100, sentences = 5, syllables = 180;

  it('Flesch Reading Ease matches the hand-computed value, clamped', () => {
    expect(fleschReadingEase(words, sentences, syllables)).toBeCloseTo(34.255, 3);
    // An unreadable wall clamps to 0; nothing to read is null.
    expect(fleschReadingEase(100, 1, 500)).toBe(0);
    expect(fleschReadingEase(0, 0, 0)).toBeNull();
  });

  it('Flesch–Kincaid Grade matches the hand-computed value, floored at 0', () => {
    expect(fleschKincaidGrade(words, sentences, syllables)).toBeCloseTo(13.45, 3);
    expect(fleschKincaidGrade(10, 2, 5)).toBe(0); // 1.95+2.95-15.59 → floored
    expect(fleschKincaidGrade(0, 0, 0)).toBeNull();
  });

  it('the bands follow the standard Flesch table', () => {
    expect(fleschBand(95)).toBe('Very easy');
    expect(fleschBand(85)).toBe('Easy');
    expect(fleschBand(75)).toBe('Fairly easy');
    expect(fleschBand(65)).toBe('Standard');
    expect(fleschBand(55)).toBe('Fairly difficult');
    expect(fleschBand(40)).toBe('Difficult');
    expect(fleschBand(10)).toBe('Very confusing');
  });

  it('the tones shade green → red with the bands (the positivity gradient)', () => {
    expect(fleschBandTone(95)).toBe('positive');
    expect(fleschBandTone(75)).toBe('positive');
    expect(fleschBandTone(65)).toBe('neutral');
    expect(fleschBandTone(55)).toBe('caution');
    expect(fleschBandTone(40)).toBe('warning');
    expect(fleschBandTone(10)).toBe('poor');
  });

  it('a real sentence reads as very easy (the pangram)', () => {
    const editor = makeEditor('<p>The quick brown fox jumps over the lazy dog.</p>');
    const { total } = getSectionedStats(editor);
    const ease = fleschReadingEase(total.words, total.sentences, total.syllables)!;
    expect(ease).toBeGreaterThan(90);
    expect(fleschBand(ease)).toBe('Very easy');
  });
});

describe('reading time', () => {
  it('formats from the 200 wpm baseline', () => {
    expect(formatReadingTime(0)).toBe('—');
    expect(formatReadingTime(150)).toBe('< 1 min');
    expect(formatReadingTime(1000)).toBe('≈ 5 min');
    expect(formatReadingTime(10000)).toBe('≈ 50 min');
  });
});
