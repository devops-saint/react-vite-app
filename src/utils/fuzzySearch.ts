/**
 * Small dependency-free fuzzy matcher, shared by the Troubleshooting page
 * and the Q&A forum's search / "already answered" suggestions.
 *
 * Scoring is per query word, not per whole string, so a natural-language
 * description ("my request has been stuck in queue for two days") still
 * finds an article titled "Request stuck in Queued": each meaningful word
 * is matched against every word of every field, tolerating plurals and
 * simple suffixes (stemming), prefixes, substrings and small typos
 * (bounded edit distance). Field weights let a title hit outrank a hit
 * buried in a long summary.
 */

export interface FuzzyField {
  text: string;
  weight: number;
}

export interface FuzzyResult<T> {
  item: T;
  /** 0..1, higher is a closer match. */
  score: number;
}

export interface FuzzyOptions {
  /** Drop results scoring below this. Default 0.35. */
  minScore?: number;
  /** Cap on results returned. Default 8. */
  limit?: number;
}

// Words that carry no search signal in a "describe your problem" sentence.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was',
  'one', 'our', 'out', 'has', 'have', 'had', 'its', 'with', 'this', 'that',
  'from', 'they', 'will', 'would', 'there', 'their', 'what', 'about', 'which',
  'when', 'been', 'into', 'than', 'then', 'them', 'these', 'some', 'could',
  'how', 'why', 'who', 'does', 'did', 'doing', 'get', 'got', 'any', 'still',
  'please', 'help', 'need', 'want', 'trying', 'try', 'tried', 'unable', 'issue',
  'problem', 'my', 'me', 'we', 'is', 'it', 'in', 'on', 'of', 'to', 'a', 'an',
  'be', 'as', 'at', 'by', 'or', 'if', 'so', 'do', 'am', 'i',
]);

function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/** Lower-cases, strips punctuation, drops stopwords, stems. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/[\s_-]+/)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token))
    .map(stem);
}

/**
 * Edit distance (Levenshtein plus adjacent-letter swaps, so "cancle" is 1
 * edit from "cancel", not 2), giving up and returning max + 1 once the
 * distance must exceed `max`.
 */
function boundedEditDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let beforePrevious: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost
      );
      if (
        i > 1 &&
        j > 1 &&
        a.charCodeAt(i - 1) === b.charCodeAt(j - 2) &&
        a.charCodeAt(i - 2) === b.charCodeAt(j - 1)
      ) {
        value = Math.min(value, (beforePrevious[j - 2] ?? 0) + 1);
      }
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    beforePrevious = previous;
    previous = current;
  }
  return previous[b.length] ?? max + 1;
}

/** How well one query word matches the best word in a field (0..1). */
function wordScore(queryWord: string, fieldWords: readonly string[]): number {
  let best = 0;
  const allowedTypos = queryWord.length >= 8 ? 2 : queryWord.length >= 5 ? 1 : 0;
  for (const word of fieldWords) {
    if (word === queryWord) return 1;
    let score = 0;
    if (queryWord.length >= 3 && word.startsWith(queryWord)) {
      score = 0.85;
    } else if (word.length >= 4 && queryWord.startsWith(word)) {
      score = 0.8;
    } else if (queryWord.length >= 4 && word.includes(queryWord)) {
      score = 0.65;
    } else if (allowedTypos > 0) {
      const distance = boundedEditDistance(queryWord, word, allowedTypos);
      if (distance <= allowedTypos) score = distance === 1 ? 0.8 : 0.65;
    }
    if (score > best) best = score;
  }
  return best;
}

export function fuzzySearch<T>(
  query: string,
  items: readonly T[],
  getFields: (item: T) => FuzzyField[],
  options: FuzzyOptions = {}
): FuzzyResult<T>[] {
  const { minScore = 0.35, limit = 8 } = options;
  const queryWords = tokenize(query);
  if (queryWords.length === 0) return [];
  const queryPhrase = queryWords.join(' ');
  // For a multi-word description, one coincidental word shouldn't be
  // enough - at least half the meaningful words must hit something.
  const requiredHits = Math.max(1, Math.ceil(queryWords.length / 2));

  const results: FuzzyResult<T>[] = [];
  for (const item of items) {
    const fields = getFields(item)
      .filter((field) => field.text.trim().length > 0)
      .map((field) => ({ ...field, words: tokenize(field.text) }));
    if (fields.length === 0) continue;
    const maxWeight = Math.max(...fields.map((field) => field.weight));

    let total = 0;
    let hits = 0;
    for (const queryWord of queryWords) {
      let best = 0;
      for (const field of fields) {
        const score = wordScore(queryWord, field.words) * (field.weight / maxWeight);
        if (score > best) best = score;
      }
      if (best >= 0.3) hits += 1;
      total += best;
    }
    if (hits < requiredHits) continue;

    let score = total / queryWords.length;
    // Small bonus when the whole phrase appears together in the heaviest field.
    const heaviest = fields.find((field) => field.weight === maxWeight);
    if (heaviest && queryWords.length > 1 && heaviest.words.join(' ').includes(queryPhrase)) {
      score = Math.min(1, score + 0.15);
    }
    if (score >= minScore) results.push({ item, score });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
