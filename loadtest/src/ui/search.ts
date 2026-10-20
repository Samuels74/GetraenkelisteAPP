/**
 * Node copies of the SPA's person search, sort order and money format
 * (frontend/src/lib/search.ts, lib/money.ts). The browser checks use them to
 * compute what a screen must show after a keystroke or a booking – the
 * "ready" conditions compare against these values, so a measurement can never
 * be satisfied by old content. Keep in sync with the frontend.
 */

type PersonLike = { id: string; number: string; name: string; nickname: string };

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

/** Natural sort by number (`2` < `10`), then name – frontend comparePersons(). */
export function comparePersons(a: PersonLike, b: PersonLike): number {
  return collator.compare(a.number, b.number) || collator.compare(a.name, b.name);
}

export function sortPersons<T extends PersonLike>(persons: readonly T[]): T[] {
  return [...persons].sort(comparePersons);
}

/** Lowercase, trimmed, without diacritics – frontend normalizeSearch(). */
export function normalizeSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Ranked search over number, name and nickname – frontend searchPersons(). */
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
      const parts = q.split(/\s+/).filter(Boolean);
      const haystack = `${number} ${name} ${nickname}`;
      if (parts.length > 1 && parts.every((part) => haystack.includes(part))) score = 10;
    }
    if (score > 0) scored.push({ person, score });
  }

  return scored.sort((a, b) => b.score - a.score || comparePersons(a.person, b.person)).map((entry) => entry.person);
}

const currency = new Intl.NumberFormat('de-AT', { style: 'currency', currency: 'EUR' });

/**
 * The app's display format (`€ 3,50`, `€ 41.103,50`) with the no-break spaces
 * replaced by plain spaces – page-probe.js normalizes page text the same way.
 */
export function euro(cents: number): string {
  return currency.format(cents / 100).replace(/[  ]/g, ' ');
}
