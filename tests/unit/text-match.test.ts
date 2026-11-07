import { describe, expect, it } from 'vitest';
import { bestMatch, editDistance, matchTerm, meaningfulWords, normalise, wordSimilarity } from '../../src/modules/discovery/text-match.js';

const words = (q: string) => meaningfulWords(q);

describe('normalising what patients type', () => {
  it('lowercases, strips accents and punctuation', () => {
    expect(normalise('  Févér!!  (since 2 days) ')).toBe('fever since 2 days');
  });
  it('drops filler words and bare numbers, keeps the meaning', () => {
    expect(words('My son has high fever since 2 days')).toEqual(['high', 'fever']);
    expect(words('amar pet dard hocche')).toEqual(['pet', 'dard']);
  });
  it('keeps everything if the query was only filler', () => {
    expect(words('i have')).toEqual(['i', 'have']);
  });
  it('keeps non-Latin scripts', () => {
    expect(normalise('জ্বর')).not.toBe('');
  });
});

describe('typo tolerance', () => {
  it('counts swapped letters as one edit', () => {
    expect(editDistance('fevre', 'fever')).toBe(1);
    expect(editDistance('diabetis', 'diabetes')).toBe(1);
  });
  it('forgives one typo in short words and two in long ones', () => {
    expect(wordSimilarity('fevr', 'fever')).toBeGreaterThan(0.6);
    expect(wordSimilarity('cardiolojist', 'cardiologist')).toBeGreaterThan(0.6);
    expect(wordSimilarity('paracitamol', 'paracetamol')).toBeGreaterThan(0.6);
  });
  it('never guesses on short codes or a different first letter', () => {
    expect(wordSimilarity('bp', 'bd')).toBe(0);
    expect(wordSimilarity('ent', 'end')).toBe(0);
    expect(wordSimilarity('sardi', 'cardi')).toBe(0); // "cold" must not become "heart"
  });
});

describe('matching a catalogue term', () => {
  it('exact, inside a sentence, corrected, and half-typed', () => {
    expect(matchTerm(['fever'], 'fever')?.score).toBe(1);
    expect(matchTerm(words('i have high fever since yesterday'), 'fever')?.score).toBe(0.95);
    const typo = matchTerm(['fevr'], 'fever');
    expect(typo?.corrected).toBe(true);
    const typing = matchTerm(['cardi'], 'cardiologist');
    expect(typing?.partial).toBe(true);
  });
  it('a generic word alone matches nothing', () => {
    expect(matchTerm(['doctor'], 'child doctor')).toBeNull();
    expect(matchTerm(['pain'], 'back pain')).toBeNull();
  });
  it('completing a word beats guessing a typo', () => {
    const complete = matchTerm(['cardi'], 'cardiologist')!.score;
    const typo = matchTerm(['cardi'], 'sardi');
    expect(typo).toBeNull();
    expect(complete).toBeGreaterThan(0.6);
  });
  it('bestMatch reports which word matched (for "showing fever for bukhar")', () => {
    const m = bestMatch(['bukhar'], ['Fever', 'high temperature', 'bukhar', 'jor']);
    expect(m).toMatchObject({ term: 'bukhar', score: 1 });
  });
});
