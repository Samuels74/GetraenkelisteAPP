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

/** Person numbers are unique case-insensitively (ARCHITECTURE.md §4). */
export function findPersonByNumber<T extends PersonLike>(persons: readonly T[], number: string): T | undefined {
  const needle = number.trim().toLowerCase();
  if (!needle) return undefined;
  return persons.find((p) => p.number.toLowerCase() === needle);
}

/**
 * Ranked search over number, name and nickname:
 * exact number > number prefix > name/nickname prefix (also per word) > substring.
 * An empty query returns all persons sorted by number.
 */
export function searchPersons<T extends PersonLike>(persons: readonly T[], query: string): T[] {
  const q = normalizeSearch(query);
  if (!q) return sortPersons(persons);

  const scored: Array<{ person: T; score: number }> = [];
  for (const person of persons) {
    const number = person.number.toLowerCase();
    const name = normalizeSearch(person.name);
    const nickname = normalizeSearch(person.nickname);
    const words = `${name} ${nickname}`.split(/\s+/).filter(Boolean);

    let score = 0;
    if (number === q) score = 100;
    else if (number.startsWith(q)) score = 80;
    else if (name.startsWith(q) || nickname.startsWith(q)) score = 60;
    else if (words.some((w) => w.startsWith(q))) score = 50;
    else if (number.includes(q)) score = 30;
    else if (name.includes(q) || nickname.includes(q)) score = 20;
    else {
      // All query words must match somewhere (e.g. "max must").
      const parts = q.split(/\s+/).filter(Boolean);
      const haystack = `${number} ${name} ${nickname}`;
      if (parts.length > 1 && parts.every((part) => haystack.includes(part))) score = 10;
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
