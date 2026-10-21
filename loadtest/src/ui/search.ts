/**
 * Node copies of the SPA's person search, sort order and money / count
 * format (frontend/src/lib/search.ts, lib/money.ts). The browser checks use them to
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

/** Folded form of names: normalizeSearch plus ß → ss and ae/oe/ue → a/o/u – frontend foldName(). */
export function foldName(value: string): string {
  return normalizeSearch(value.replace(/[ßẞ]/g, 'ss')).replace(/[aou]e/g, (pair) => pair[0] as string);
}

function words(...texts: string[]): string[] {
  return texts.join(' ').split(/\s+/).filter(Boolean);
}

/**
 * Ranked search over number, name and nickname – frontend searchPersons():
 * names match in their plain form (normalizeSearch) or in their folded form
 * (foldName), numbers as they are (case-insensitive).
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
    const plain = [normalizeSearch(person.name), normalizeSearch(person.nickname)];
    const folded = [foldName(person.name), foldName(person.nickname)];

    let score = 0;
    if (number === q) score = 100;
    else if (number.startsWith(q)) score = 80;
    else if (prefix(plain, folded)) score = 60;
    else if (prefix(words(...plain), words(...folded))) score = 50;
    else if (number.includes(q)) score = 30;
    else if (contains(plain, folded)) score = 20;
    else if (queryParts.length > 1) {
      // all query words must match somewhere (e.g. "max must")
      const plainNames = plain.join(' ');
      const foldedNames = folded.join(' ');
      const all = queryParts.every(
        (part, i) => number.includes(part) || plainNames.includes(part) || foldedNames.includes(foldedParts[i] ?? part),
      );
      if (all) score = 10;
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

const countFormat = new Intl.NumberFormat('de-AT', { maximumFractionDigits: 0 });
const amountGroupSeparator = currency.formatToParts(1_000_000).find((part) => part.type === 'group')?.value ?? '.';

/** A count as the app shows it – frontend lib/money.ts formatCount(): `14927` → `14.927` (the amounts' separator). */
export function count(value: number): string {
  return countFormat
    .formatToParts(value)
    .map((part) => (part.type === 'group' ? amountGroupSeparator : part.value))
    .join('');
}
