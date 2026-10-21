/**
 * The SPA's requests, built exactly like the frontend builds them – paths,
 * query parameters (names, order, values), filters, page sizes, expands. A
 * load test is only as good as its resemblance to the real client, so this
 * module mirrors:
 *
 *   frontend/src/api/queries.ts   persons/groups/offerings/users (getFullList,
 *                                 batch 1000), fetchBookings (the Buchungen
 *                                 list pages, its realtime head request, the
 *                                 recent bookings of a person, the CSV pages),
 *                                 fetchTotals (with `parts`)
 *   frontend/src/api/totals.ts    parts: canonical order, omitted when all four
 *   frontend/src/lib/dates.ts     period → range in the browser's time zone,
 *                                 buildBookingsFilter, buildTotalsQuery, pbQuote
 *   frontend/src/api/keyset.ts    keysetFilter (next page / CSV), keysetNewerFilter
 *                                 (realtime head request), compareNewestFirst
 *   frontend/src/api/mutations.ts booking create (createdBy + expand), delete
 *   frontend/src/auth/session.ts  auth-refresh
 *
 * The PocketBase SDK (0.28.1) serializes query parameters in insertion order
 * with encodeURIComponent: getList(1, n, { filter, sort, expand, skipTotal:
 * true }) sends `page=1&perPage=n&filter=…&sort=…&expand=…&skipTotal=true`;
 * getFullList requests `page=k&perPage=1000&skipTotal=1[&sort=…]` until a
 * page is shorter than 1000 (3 requests for exactly 2000 persons). The model
 * sends the same names, order and values (only the browser additionally
 * percent-encodes the apostrophes of filter literals). If the frontend
 * changes how it queries, change this module too – `npm run model-check`
 * compares the device model with the real SPA request by request.
 */
import { BOOKING_EXPAND } from '../seed.ts';
import { periodRanges, toPbDate, type PeriodKey } from '../time.ts';

export { BOOKING_EXPAND };

/** frontend/src/api/queries.ts BOOKINGS_PAGE_SIZE (list pages and the realtime head request). */
export const BOOKINGS_PAGE_SIZE = 50;
/** getFullList({ batch: 1000 }) */
export const FULL_LIST_BATCH = 1000;
/** fetchAllBookings → fetchAllKeyset(…, 500) */
export const CSV_PAGE_SIZE = 500;
/** useRecentBookings: Buchen 8, person detail 20 */
export const RECENT_BUCHEN = 8;
export const RECENT_DETAIL = 20;
/** The lists' sort order (`-created,-id`). */
export const BOOKINGS_SORT = '-created,-id';

/** The SPA's booking query: a period preset plus optional person / "nur meine" (createdBy). */
export interface BookingQuery {
  period: PeriodKey;
  personId?: string;
  createdBy?: string;
}

/** Parts of GET /api/app/totals (frontend/src/lib/types.ts TotalsPart). */
export type TotalsPart = 'summary' | 'perPerson' | 'perOffering' | 'perUser';

/** frontend/src/api/totals.ts ALL_TOTALS_PARTS – also the canonical order. */
export const ALL_TOTALS_PARTS: readonly TotalsPart[] = ['summary', 'perPerson', 'perOffering', 'perUser'];

/** normalizeParts(): fixed order, no duplicates; missing or empty = all parts. */
export function normalizeParts(parts?: readonly TotalsPart[]): TotalsPart[] {
  if (!parts || parts.length === 0) return [...ALL_TOTALS_PARTS];
  return ALL_TOTALS_PARTS.filter((part) => parts.includes(part));
}

/** partsParam(): the `parts` value – undefined (omitted) when all four are wanted. */
export function partsParam(parts?: readonly TotalsPart[]): string | undefined {
  const normalized = normalizeParts(parts);
  return normalized.length === ALL_TOTALS_PARTS.length ? undefined : normalized.join(',');
}

/** Query string with encodeURIComponent like the SDK (insertion order; undefined values are left out). */
export function queryString(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

/** frontend/src/lib/dates.ts pbQuote */
export function pbQuote(value: string): string {
  return `'${value.replace(/'/g, "\\'")}'`;
}

/** The range of a period preset as the browser computes it (local midnight in `timeZone`). */
function rangeOf(query: BookingQuery, nowMs: number, timeZone: string): { from?: number; to?: number } {
  return query.period === 'all' ? {} : periodRanges(nowMs, timeZone)[query.period];
}

/** frontend/src/lib/dates.ts buildBookingsFilter */
export function bookingsFilter(query: BookingQuery, nowMs: number, timeZone: string): string {
  const { from, to } = rangeOf(query, nowMs, timeZone);
  const parts: string[] = [];
  if (from !== undefined) parts.push(`created >= ${pbQuote(toPbDate(from))}`);
  if (to !== undefined) parts.push(`created < ${pbQuote(toPbDate(to))}`);
  if (query.personId) parts.push(`person = ${pbQuote(query.personId)}`);
  if (query.createdBy) parts.push(`createdBy = ${pbQuote(query.createdBy)}`);
  return parts.join(' && ');
}

/**
 * frontend/src/lib/dates.ts buildTotalsQuery (ISO 8601 UTC) plus fetchTotals'
 * `parts` – parameter order from, to, person, createdBy, parts; `parts` is
 * left out when all four parts are wanted.
 */
export function totalsParams(query: BookingQuery, nowMs: number, timeZone: string, parts?: readonly TotalsPart[]): Record<string, string> {
  const { from, to } = rangeOf(query, nowMs, timeZone);
  const params: Record<string, string> = {};
  if (from !== undefined) params.from = new Date(from).toISOString();
  if (to !== undefined) params.to = new Date(to).toISOString();
  if (query.personId) params.person = query.personId;
  if (query.createdBy) params.createdBy = query.createdBy;
  const value = partsParam(parts);
  if (value) params.parts = value;
  return params;
}

/** A position in the `-created,-id` order: the last booking of a page, the newest shown one. */
export interface KeysetCursor {
  created: string;
  id: string;
}

/**
 * frontend/src/api/keyset.ts compareNewestFirst: negative when `a` is newer.
 * PocketBase stores `created` as `YYYY-MM-DD HH:MM:SS.sssZ` and SQLite
 * compares the text, so plain string comparison is the server's order.
 */
export function compareNewestFirst(a: KeysetCursor, b: KeysetCursor): number {
  if (a.created !== b.created) return a.created > b.created ? -1 : 1;
  if (a.id !== b.id) return a.id > b.id ? -1 : 1;
  return 0;
}

/**
 * frontend/src/api/keyset.ts keysetFilter: the base filter plus "older than
 * the cursor" – the next page of the Buchungen list and of the CSV export.
 * The redundant `created <= c` gives SQLite a range on the created index
 * (PocketBase binds every literal separately; without it each page sorted
 * all older rows – docs/LOADTEST-FINDINGS.md F3).
 */
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
 * The keyset condition the SPA sent before the F3 fix (without `created <= c`)
 * – not sent by the app any more; A5 and A1-planner measure it for comparison.
 */
export function legacyKeysetFilter(baseFilter: string, cursor: KeysetCursor | null): string {
  const parts: string[] = [];
  if (baseFilter) parts.push(`(${baseFilter})`);
  if (cursor) {
    const created = pbQuote(cursor.created);
    parts.push(`(created < ${created} || (created = ${created} && id < ${pbQuote(cursor.id)}))`);
  }
  return parts.join(' && ');
}

/**
 * frontend/src/api/keyset.ts keysetNewerFilter: the base filter plus "newer
 * than the cursor" – or "at or newer" with `inclusive` (the realtime head
 * request of the Buchungen list).
 */
export function keysetNewerFilter(baseFilter: string, cursor: KeysetCursor, inclusive = false): string {
  const parts: string[] = [];
  if (baseFilter) parts.push(`(${baseFilter})`);
  const created = pbQuote(cursor.created);
  parts.push(`created >= ${created}`, `(created > ${created} || (created = ${created} && id ${inclusive ? '>=' : '>'} ${pbQuote(cursor.id)}))`);
  return parts.join(' && ');
}

const records = (collection: string) => `/api/collections/${collection}/records`;

export const paths = {
  /** usePersons: one page of getFullList({ batch: 1000 }) – no sort, no filter. */
  personsPage: (page: number) => `${records('persons')}?${queryString({ page, perPage: FULL_LIST_BATCH, skipTotal: 1 })}`,
  /** useGroups */
  groups: () => `${records('groups')}?${queryString({ page: 1, perPage: FULL_LIST_BATCH, skipTotal: 1, sort: 'sortOrder,name' })}`,
  /** useOfferings */
  offerings: () =>
    `${records('offerings')}?${queryString({ page: 1, perPage: FULL_LIST_BATCH, skipTotal: 1, sort: 'sortOrder,name' })}`,
  /** useUsers (admin screens) */
  users: () => `${records('users')}?${queryString({ page: 1, perPage: FULL_LIST_BATCH, skipTotal: 1, sort: 'username' })}`,
  /**
   * fetchBookings(filter, limit) = getList(1, limit, { filter, sort, expand,
   * skipTotal: true }): every Buchungen list page (page 1 = the base filter,
   * later pages = keysetFilter), the realtime head request (keysetNewerFilter,
   * 50), the CSV pages (keysetFilter, 500). "Alle" sends `filter=`.
   */
  bookings: (filter: string, perPage = BOOKINGS_PAGE_SIZE) =>
    `${records('bookings')}?${queryString({ page: 1, perPage, filter, sort: BOOKINGS_SORT, expand: BOOKING_EXPAND, skipTotal: 'true' })}`,
  /** useRecentBookings(personId, limit) → fetchBookings(`person = '<id>'`, limit) */
  recent: (personId: string, limit = RECENT_BUCHEN) => paths.bookings(`person = ${pbQuote(personId)}`, limit),
  /** fetchTotals: GET /api/app/totals[?from&to&person&createdBy&parts] (totalsParams) */
  totals: (params: Record<string, string> = {}) => {
    const qs = queryString(params);
    return `/api/app/totals${qs ? `?${qs}` : ''}`;
  },
  /** useCreateBooking: POST with expand (body: person, offering, quantity 1, createdBy) */
  createBooking: () => `${records('bookings')}?${queryString({ expand: BOOKING_EXPAND })}`,
  booking: (id: string) => `${records('bookings')}/${encodeURIComponent(id)}`,
  persons: () => records('persons'),
  person: (id: string) => `${records('persons')}/${encodeURIComponent(id)}`,
  /** refreshSession: POST users/auth-refresh */
  refresh: () => '/api/collections/users/auth-refresh',
  login: () => '/api/collections/users/auth-with-password',
  realtime: () => '/api/realtime',
};

/** Body of the SPA's booking create (createdBy is ignored by the server hook, sent anyway). */
export function bookingBody(personId: string, offeringId: string, userId: string): Record<string, unknown> {
  return { person: personId, offering: offeringId, quantity: 1, createdBy: userId };
}

/**
 * The realtime topics the SPA subscribes (frontend/src/api/realtime.ts):
 * everyone watches all users (their names are shown with the bookings).
 * The parameters stay for callers that describe a device.
 */
export function realtimeTopics(_userId: string, _admin: boolean): string[] {
  return ['bookings/*', 'persons/*', 'offerings/*', 'groups/*', 'users/*'];
}

/** "Heute" etc. – labels of the Buchungen period presets. */
export const PERIOD_LABELS: Record<PeriodKey, string> = { today: 'Heute', '7d': '7 Tage', '30d': '30 Tage', all: 'Alle' };

export { toPbDate };
