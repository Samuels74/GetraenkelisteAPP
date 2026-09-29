/**
 * Keyset ("seek") pagination over bookings, newest first (`-created,-id`).
 *
 * Offset pagination over a live list duplicates or drops rows when bookings
 * are created/cancelled while paging (the CSV export loads everything). With
 * a cursor on (created, id) every following page is strictly older than the
 * last row seen, so rows inserted meanwhile (always newer) never shift the
 * pages and nothing is read twice. Rows are additionally de-duplicated by id.
 */
import { pbQuote } from '../lib/dates';

export interface KeysetCursor {
  created: string;
  id: string;
}

/** Combines the base filter with the "older than the cursor" condition. */
export function keysetFilter(baseFilter: string, cursor: KeysetCursor | null): string {
  const parts: string[] = [];
  if (baseFilter) parts.push(`(${baseFilter})`);
  if (cursor) {
    const created = pbQuote(cursor.created);
    parts.push(`(created < ${created} || (created = ${created} && id < ${pbQuote(cursor.id)}))`);
  }
  return parts.join(' && ');
}

/**
 * Loads all rows matching `baseFilter` page by page. `fetchPage` must return
 * the rows sorted by `-created,-id` (at most `pageSize`).
 */
export async function fetchAllKeyset<T extends { id: string; created: string }>(
  fetchPage: (filter: string, pageSize: number) => Promise<T[]>,
  baseFilter: string,
  pageSize = 500,
): Promise<T[]> {
  const seen = new Set<string>();
  const rows: T[] = [];
  let cursor: KeysetCursor | null = null;
  for (;;) {
    const page = await fetchPage(keysetFilter(baseFilter, cursor), pageSize);
    for (const row of page) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
    const last = page.at(-1);
    if (page.length < pageSize || !last) return rows;
    cursor = { created: last.created, id: last.id };
  }
}
