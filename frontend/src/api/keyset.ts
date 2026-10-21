/**
 * Keyset ("seek") pagination over bookings, newest first (`-created,-id`).
 *
 * Offset pagination over a live list duplicates or drops rows when bookings
 * are created/cancelled while paging (the CSV export loads everything; the
 * Buchungen list patches its cached pages on realtime events). With a cursor
 * on (created, id) every following page is strictly older than the last row
 * seen, so rows inserted or removed meanwhile never shift the pages and
 * nothing is read twice. Rows are additionally de-duplicated by id.
 *
 * Index use: PocketBase binds every literal as its own SQL parameter, so SQLite
 * cannot tell that the `created` values in `created < c || (created = c && …)`
 * are equal – it plans a MULTI-INDEX OR plus a sort of *all* older rows per
 * page, which made the CSV export quadratic (docs/LOADTEST-FINDINGS.md F3).
 * The redundant `created <= c` (`>=` for the forward direction) in front
 * selects the same rows and gives SQLite a range scan on the `created` index.
 */
import { pbQuote } from '../lib/dates';

export interface KeysetCursor {
  created: string;
  id: string;
}

/**
 * The lists' sort order (`-created,-id`): negative when `a` comes first, i.e.
 * is newer. PocketBase stores `created` as `YYYY-MM-DD HH:MM:SS.sssZ` and
 * SQLite compares the text, so plain string comparison is the server's order.
 */
export function compareNewestFirst(a: KeysetCursor, b: KeysetCursor): number {
  if (a.created !== b.created) return a.created > b.created ? -1 : 1;
  if (a.id !== b.id) return a.id > b.id ? -1 : 1;
  return 0;
}

/** Combines the base filter with the "older than cursor" condition (next page). */
export function keysetFilter(baseFilter: string, cursor: KeysetCursor | null): string {
  const parts: string[] = [];
  if (baseFilter) parts.push(`(${baseFilter})`);
  if (cursor) {
    const created = pbQuote(cursor.created);
    parts.push(`created <= ${created}`, `(created < ${created} || (created = ${created} && id < ${pbQuote(cursor.id)}))`);
  }
  return parts.join(' && ');
}

/**
 * Combines the base filter with the "newer than cursor" condition – or "at or
 * newer" with `inclusive` (the realtime head fetch of the Buchungen list).
 */
export function keysetNewerFilter(baseFilter: string, cursor: KeysetCursor, inclusive = false): string {
  const parts: string[] = [];
  if (baseFilter) parts.push(`(${baseFilter})`);
  const created = pbQuote(cursor.created);
  parts.push(
    `created >= ${created}`,
    `(created > ${created} || (created = ${created} && id ${inclusive ? '>=' : '>'} ${pbQuote(cursor.id)}))`,
  );
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
