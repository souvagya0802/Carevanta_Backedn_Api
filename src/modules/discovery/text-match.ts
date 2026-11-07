/**
 * Small, dependency-free text matching for patient search.
 *
 * Patients type sentences ("my son has high fever since 2 days"), typos
 * ("fevr", "diabetis"), half words while typing ("cardi") and local words
 * ("bukhar"). We normalise the query, drop filler words, then score each
 * catalogue term against the remaining words:
 *
 *   1.00  the whole query is the term
 *   0.95  the term appears word-for-word inside the query
 *   ≤0.90 every word of the term matches a query word with a small typo
 *   0.80  the query is the start of the term (typing in progress)
 *
 * Short words (≤ 3 letters, e.g. "bp", "ent", "cbc") must match exactly,
 * because one wrong letter changes their meaning.
 */

const FILLER = new Set([
  'i', 'im', 'me', 'my', 'mine', 'we', 'our', 'he', 'she', 'his', 'her', 'son', 'daughter', 'baby', 'mother', 'father', 'wife', 'husband',
  'am', 'is', 'are', 'was', 'have', 'having', 'has', 'had', 'got', 'feel', 'feeling', 'suffering',
  'a', 'an', 'the', 'of', 'for', 'to', 'in', 'on', 'at', 'with', 'from', 'since', 'and', 'or', 'some', 'very', 'little', 'bit', 'lot',
  'near', 'nearby', 'around', 'please', 'need', 'want', 'looking', 'find', 'show', 'search', 'best', 'good', 'top', 'cheap', 'urgent',
  'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years', 'today', 'yesterday', 'last', 'ago',
  'ki', 'ka', 'ke', 'hai', 'ho', 'raha', 'rahi', 'mujhe', 'mera', 'meri', 'amar', 'ami', 'hocche', 'hoyeche', 'theke', 'koro', 'korbo',
]);

/** Words too generic to identify anything on their own. */
const GENERIC = new Set(['doctor', 'doctors', 'specialist', 'test', 'tests', 'pain', 'problem', 'scan', 'check', 'checkup', 'infection', 'disease', 'clinic', 'hospital', 'medicine', 'byatha', 'dard']);

/** Lowercase, strip accents and punctuation, collapse spaces. Keeps letters of any script and digits. */
export function normalise(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Words that carry meaning: filler and bare numbers removed. Falls back to all words if everything was filler. */
export function meaningfulWords(text: string): string[] {
  const words = normalise(text).split(' ').filter(Boolean);
  const kept = words.filter((w) => !FILLER.has(w) && !/^\d+$/.test(w));
  return kept.length ? kept : words;
}

/** Optimal string alignment distance (Levenshtein plus swapped neighbours), capped for speed. */
export function editDistance(a: string, b: string, cap = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > cap) return cap + 1;
  }
  return d[a.length]![b.length]!;
}

/** How alike two single words are, 0..1. Allows 1 typo for 4–6 letters, 2 for longer words, none for short ones. */
export function wordSimilarity(query: string, term: string): number {
  if (query === term) return 1;
  if (query.length <= 3 || term.length <= 3) return 0;
  // In short words the first letter is rarely the typo; "sardi" is not a misspelt "cardi".
  if (Math.min(query.length, term.length) <= 5 && query[0] !== term[0]) return 0;
  const allowed = Math.max(query.length, term.length) >= 7 ? 2 : 1;
  const dist = editDistance(query, term, allowed);
  if (dist > allowed) {
    // "paediatrician" vs "pediatric": share a long stem.
    const stem = Math.min(query.length, term.length);
    return stem >= 6 && (term.startsWith(query.slice(0, stem - 1)) || query.startsWith(term.slice(0, stem - 1))) ? 0.75 : 0;
  }
  return 1 - dist / Math.max(query.length, term.length) / 1.5;
}

export interface TermMatch { score: number; corrected: boolean; partial: boolean }

/**
 * Score one catalogue term (already normalised) against the query words.
 * `corrected` means a typo was forgiven; `partial` means the user is still typing.
 */
export function matchTerm(queryWords: string[], term: string): TermMatch | null {
  const t = term.split(' ').filter(Boolean);
  if (!t.length || !queryWords.length) return null;
  const q = queryWords;
  if (q.join(' ') === t.join(' ')) return { score: 1, corrected: false, partial: false };

  const last = q[q.length - 1]!;

  // Word-for-word inside the query, or the term contains all of the query (e.g. "sugar" → "sugar test").
  for (let i = 0; i + t.length <= q.length; i++) if (t.every((w, k) => q[i + k] === w)) return { score: 0.95, corrected: false, partial: false };

  // Typing in progress: earlier words match, the last query word starts a term word.
  if (q.length <= t.length && last.length >= 3) {
    const head = q.slice(0, -1);
    const headOk = head.every((w, k) => w === t[k] || wordSimilarity(w, t[k]!) >= 0.75);
    if (headOk && t[q.length - 1]!.startsWith(last)) return { score: 0.8 - (t.length - q.length) * 0.05, corrected: false, partial: true };
  }

  // Fuzzy: every term word matches some query word in order.
  let best = 0;
  for (let i = 0; i + t.length <= q.length; i++) {
    let total = 0;
    let ok = true;
    for (let k = 0; k < t.length; k++) {
      const s = wordSimilarity(q[i + k]!, t[k]!);
      if (s < 0.6) { ok = false; break; }
      total += s;
    }
    if (ok) best = Math.max(best, (total / t.length) * 0.9);
  }
  if (best >= 0.6) return { score: best, corrected: true, partial: false };

  // A single word that is part of a longer term ("sugar" → "blood sugar"), but not a generic word like "doctor" or "pain".
  if (q.length === 1 && last.length >= 4 && !GENERIC.has(last) && t.includes(last)) return { score: 0.7, corrected: false, partial: false };
  return null;
}

/** Best match across a name and its synonyms; reports which term matched so the UI can say "showing fever for 'bukhar'". */
export function bestMatch(queryWords: string[], terms: string[]): (TermMatch & { term: string }) | null {
  let best: (TermMatch & { term: string }) | null = null;
  for (const raw of terms) {
    const term = normalise(raw);
    const m = matchTerm(queryWords, term);
    if (m && (!best || m.score > best.score)) best = { ...m, term: raw };
  }
  return best;
}
