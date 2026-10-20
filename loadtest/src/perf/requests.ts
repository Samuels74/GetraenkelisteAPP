/**
 * The SPA's requests, built exactly like the frontend builds them – paths,
 * query parameters, filters, page sizes, expands. A load test is only as good
 * as its resemblance to the real client, so this module mirrors:
 *
 *   frontend/src/api/queries.ts   persons/groups/offerings/users (getFullList,
 *                                 batch 1000), booking list (50 per page,
 *                                 sort -created,-id, BOOKING_EXPAND), recent
 *                                 bookings of a person, totals, CSV export
 *   frontend/src/lib/dates.ts     period → range in the browser's time zone,
 *                                 buildBookingsFilter, buildTotalsQuery, pbQuote
 *   frontend/src/api/keyset.ts    keyset filter of the CSV export
 *   frontend/src/api/mutations.ts booking create (createdBy + expand), delete
 *   frontend/src/auth/session.ts  auth-refresh
 *
 * The PocketBase SDK (0.28.1) serializes query parameters with
 * encodeURIComponent; getFullList requests `page=n&perPage=1000&skipTotal=1`
 * until a page is shorter than 1000 (3 requests for exactly 2000 persons).
 * If the frontend changes how it queries, change this module too.
 */
import { BOOKING_EXPAND } from '../seed.ts';
import { periodRanges, toPbDate, type PeriodKey } from '../time.ts';

export { BOOKING_EXPAND };

/** frontend/src/api/queries.ts BOOKINGS_PAGE_SIZE */
export const BOOKINGS_PAGE_SIZE = 50;
/** getFullList({ batch: 1000 }) */
export const FULL_LIST_BATCH = 1000;
/** fetchAllBookings → fetchAllKeyset(…, 500) */
export const CSV_PAGE_SIZE = 500;
/** useRecentBookings: Buchen 8, person detail 20 */
export const RECENT_BUCHEN = 8;
export const RECENT_DETAIL = 20;

/** The SPA's booking query: a period preset plus optional person / "nur meine" (createdBy). */
export interface BookingQuery {
  period: PeriodKey;
  personId?: string;
  createdBy?: string;
}

/** Query string with encodeURIComponent like the SDK (insertion order). */
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
  return periodRanges(nowMs, timeZone)[query.period];
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

/** frontend/src/lib/dates.ts buildTotalsQuery (ISO 8601 UTC) as query parameters. */
export function totalsParams(query: BookingQuery, nowMs: number, timeZone: string): Record<string, string> {
  const { from, to } = rangeOf(query, nowMs, timeZone);
  const params: Record<string, string> = {};
  if (from !== undefined) params.from = new Date(from).toISOString();
  if (to !== undefined) params.to = new Date(to).toISOString();
  if (query.personId) params.person = query.personId;
  if (query.createdBy) params.createdBy = query.createdBy;
  return params;
}

export interface KeysetCursor {
  created: string;
  id: string;
}

/** frontend/src/api/keyset.ts keysetFilter */
export function keysetFilter(baseFilter: string, cursor: KeysetCursor | null): string {
  const parts: string[] = [];
  if (baseFilter) parts.push(`(${baseFilter})`);
  if (cursor) {
    const created = pbQuote(cursor.created);
    parts.push(`(created < ${created} || (created = ${created} && id < ${pbQuote(cursor.id)}))`);
  }
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
  /** useBookingList page / CSV page: getList(page, perPage, { filter, sort, expand, skipTotal }) – "Alle" sends filter="" */
  bookings: (filter: string, page = 1, perPage = BOOKINGS_PAGE_SIZE) =>
    `${records('bookings')}?${queryString({ page, perPage, skipTotal: 1, sort: '-created,-id', expand: BOOKING_EXPAND, filter })}`,
  /** useRecentBookings(personId, limit) */
  recent: (personId: string, limit = RECENT_BUCHEN) =>
    `${records('bookings')}?${queryString({
      page: 1,
      perPage: limit,
      skipTotal: 1,
      sort: '-created,-id',
      expand: BOOKING_EXPAND,
      filter: `person = ${pbQuote(personId)}`,
    })}`,
  /** fetchTotals: GET /api/app/totals[?from&to&person&createdBy] */
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

/** The realtime topics the SPA subscribes (frontend/src/api/realtime.ts). */
export function realtimeTopics(userId: string, admin: boolean): string[] {
  return ['bookings/*', 'persons/*', 'offerings/*', 'groups/*', admin ? 'users/*' : `users/${userId}`];
}

/** "Heute" etc. – labels of the Buchungen period presets. */
export const PERIOD_LABELS: Record<PeriodKey, string> = { today: 'Heute', '7d': '7 Tage', '30d': '30 Tage', all: 'Alle' };

export { toPbDate };
