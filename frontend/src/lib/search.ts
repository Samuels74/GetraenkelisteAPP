/**
 * Person search/sorting helpers (client-side; the person list is small).
 */
import type { PersonRecord } from './types';

type PersonLike = Pick<PersonRecord, 'id' | 'number' | 'name' | 'nickname'>;

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

/** Natural sort by number (`2` < `10`, `001` < `002`), then name. */
export function comparePersons(a: PersonLike, b: PersonLike): number {
  return collator.compare(a.number, b.number) || collator.compare(a.name, b.name);
}

export function sortPersons<T extends PersonLike>(persons: readonly T[]): T[] {
  return [...persons].sort(comparePersons);
}

/** Lowercase, trimmed, without diacritics (`Müller` → `muller`). */
export function normalizeSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Folded form of names and nicknames: normalizeSearch plus the German
 * spelling variants, folded the same way in the query and in the names –
 * "ß" → "ss", and "ae"/"oe"/"ue" → "a"/"o"/"u" (what "ä"/"ö"/"ü" become
 * without their dots). So "Weiss" finds "Weiß", and "Mueller", "Müller" and
 * "Muller" find each other. A few extra matches ("Michal" also finds
 * "Michael") are harmless. Searches compare this form *and* the plain one
 * (see searchPersons).
 */
export function foldName(value: string): string {
  return normalizeSearch(value.replace(/[ßẞ]/g, 'ss')).replace(/[aou]e/g, (pair) => pair[0]!);
}

/** The searchable texts of a person: name and nickname, plain (normalizeSearch) and folded (foldName). */
interface SearchForms {
  plain: readonly [name: string, nickname: string];
  folded: readonly [name: string, nickname: string];
  /** The words of name and nickname, plain and folded. */
  plainWords: readonly string[];
  foldedWords: readonly string[];
}

/** Per person object (query data is immutable: a change is a new object). */
const searchForms = new WeakMap<object, SearchForms>();

function words(...texts: string[]): string[] {
  return texts.join(' ').split(/\s+/).filter(Boolean);
}

function formsOf(person: PersonLike): SearchForms {
  let entry = searchForms.get(person);
  if (!entry) {
    const plain = [normalizeSearch(person.name), normalizeSearch(person.nickname)] as const;
    const folded = [foldName(person.name), foldName(person.nickname)] as const;
    entry = { plain, folded, plainWords: words(...plain), foldedWords: words(...folded) };
    searchForms.set(person, entry);
  }
  return entry;
}

/** Person numbers are unique case-insensitively (ARCHITECTURE.md §4). */
export function findPersonByNumber<T extends PersonLike>(persons: readonly T[], number: string): T | undefined {
  const needle = number.trim().toLowerCase();
  if (!needle) return undefined;
  return persons.find((p) => p.number.toLowerCase() === needle);
}

/**
 * Ranked search over number, name and nickname:
 * exact number > number prefix > name/nickname prefix (also per word) > substring.
 * Names match in their plain form (normalizeSearch: case, diacritics) or in
 * their folded form (foldName: also ß/ss, ä/ae …) – the plain form keeps the
 * substrings that folding cuts ("erstein" in "Feuerstein", "el" in
 * "Michael"), the folded one finds the spelling variants. Numbers compare as
 * they are (case-insensitive). An empty query returns all persons sorted by
 * number.
 */
export function searchPersons<T extends PersonLike>(persons: readonly T[], query: string): T[] {
  const q = normalizeSearch(query);
  if (!q) return sortPersons(persons);
  const t = foldName(query);
  // folding never touches whitespace: the words of both forms correspond
  const queryParts = q.split(/\s+/).filter(Boolean);
  const foldedParts = t.split(/\s+/).filter(Boolean);
  // the query in the form of the texts: plain against plain, folded against folded
  const prefix = (plain: readonly string[], folded: readonly string[]) =>
    plain.some((text) => text.startsWith(q)) || folded.some((text) => text.startsWith(t));
  const contains = (plain: readonly string[], folded: readonly string[]) =>
    plain.some((text) => text.includes(q)) || folded.some((text) => text.includes(t));

  const scored: Array<{ person: T; score: number }> = [];
  for (const person of persons) {
    const number = person.number.toLowerCase();
    const forms = formsOf(person);

    let score = 0;
    if (number === q) score = 100;
    else if (number.startsWith(q)) score = 80;
    else if (prefix(forms.plain, forms.folded)) score = 60;
    else if (prefix(forms.plainWords, forms.foldedWords)) score = 50;
    else if (number.includes(q)) score = 30;
    else if (contains(forms.plain, forms.folded)) score = 20;
    else if (queryParts.length > 1) {
      // All query words must match somewhere (e.g. "max must").
      const plainNames = forms.plain.join(' ');
      const foldedNames = forms.folded.join(' ');
      const all = queryParts.every(
        (part, i) => number.includes(part) || plainNames.includes(part) || foldedNames.includes(foldedParts[i] ?? part),
      );
      if (all) score = 10;
    }
    if (score > 0) scored.push({ person, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || comparePersons(a.person, b.person))
    .map((entry) => entry.person);
}

/** Label like `001 · Max Mustermann („Maxi“)`. */
export function personLabel(person: Pick<PersonRecord, 'number' | 'name' | 'nickname'>): string {
  const parts = [person.number];
  if (person.name) parts.push(person.name);
  let label = parts.join(' · ');
  if (person.nickname) label += ` („${person.nickname}“)`;
  return label;
}

/** The person number pattern of the `persons` collection. */
export const PERSON_NUMBER_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isValidPersonNumber(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 20 && PERSON_NUMBER_PATTERN.test(trimmed);
}
