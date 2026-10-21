/**
 * TanStack Query hooks for all reads. Query keys start with the collection
 * name so realtime events can invalidate them by prefix (see realtime.ts);
 * booking events update the booking and totals queries in a targeted way
 * instead (bookingSync.ts), which relies on the key shapes defined here.
 */
import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import {
  buildBookingsFilter,
  buildTotalsQuery,
  periodToRange,
  type BookingFilter,
  type PeriodKey,
} from '../lib/dates';
import {
  BOOKING_EXPAND,
  bookingsCollection,
  groupsCollection,
  offeringsCollection,
  pb,
  personsCollection,
  usersCollection,
} from '../lib/pb';
import { sortPersons } from '../lib/search';
import type { BookingRecord, Totals, TotalsPart } from '../lib/types';
import { fetchAllKeyset, keysetFilter, type KeysetCursor } from './keyset';
import { normalizeParts, partsParam, pickTotals, hasTotalsParts } from './totals';

export const BOOKINGS_PAGE_SIZE = 50;

/** Serializable booking filter used in query keys; dates are resolved at fetch time. */
export interface BookingQuery {
  period: PeriodKey;
  from?: string | null;
  to?: string | null;
  personId?: string | null;
  createdBy?: string | null;
}

export function resolveBookingQuery(query: BookingQuery, now = new Date()): BookingFilter {
  return {
    range: periodToRange(query.period, now, query.from, query.to),
    personId: query.personId,
    createdBy: query.createdBy,
  };
}

/**
 * The resolved period of a filter as text ("from/to", "/" for "Alle"). Relative
 * periods ("Heute", 7 / 30 Tage) move at local midnight, so cached data keeps
 * what it was loaded for (`TotalsData.range`, `BookingPage.base`) – a patch
 * may only touch data of the current period (bookingSync.ts).
 */
export function periodRangeKey(query: BookingQuery, now = new Date()): string {
  const { from, to } = periodToRange(query.period, now, query.from, query.to);
  return `${from ? from.toISOString() : ''}/${to ? to.toISOString() : ''}`;
}

/** The all-time totals of one person (Buchen card, person detail) – one shared cache entry. */
export function personTotalsQuery(personId: string): BookingQuery {
  return { period: 'all', personId };
}

export const queryKeys = {
  persons: ['persons'] as const,
  groups: ['groups'] as const,
  offerings: ['offerings'] as const,
  users: ['users'] as const,
  bookings: ['bookings'] as const,
  bookingList: (query: BookingQuery) => ['bookings', 'list', query] as const,
  recentBookings: (personId: string, limit: number) => ['bookings', 'recent', personId, limit] as const,
  totals: ['totals'] as const,
  /** The totals of a filter; the requested parts (canonical, default: all) are part of the key. */
  totalsFor: (query: BookingQuery, parts?: readonly TotalsPart[]) =>
    ['totals', query, normalizeParts(parts)] as const,
};

/** How long data stays fresh without a realtime connection. */
export const STALE_TIME_WITHOUT_REALTIME_MS = 30_000;

/**
 * How long cached data stays fresh – the default of every query
 * (app/queryClient.ts), evaluated whenever TanStack checks. While realtime is
 * connected, never stale by time: every change reaches the cache through an
 * event (booking events patch or invalidate the affected queries, other
 * collections invalidate by prefix or patch the names), every reconnect
 * refetches everything, and the periods relative to "today" are invalidated
 * at midnight (midnight.ts). Re-downloading what a screen showed whenever it
 * mounts or the app is refocused after 30 s bought nothing – ≈420 KiB of
 * persons (F6), all loaded list pages, the per-person totals (FLOW-12).
 * Without a connection (not yet established, reconnecting, or SSE blocked by a
 * proxy) no event would arrive, so data goes stale after 30 s: a change made
 * on another device shows up after a remount.
 */
export function realtimeStaleTime(): number {
  return pb.realtime.isConnected ? Infinity : STALE_TIME_WITHOUT_REALTIME_MS;
}

/** All persons (picker, Personen, filters). */
export function usePersons() {
  return useQuery({
    queryKey: queryKeys.persons,
    queryFn: async () => sortPersons(await personsCollection().getFullList({ batch: 1000 })),
    // also set here: the persons depend on it most (≈420 KiB with 2000 persons)
    staleTime: realtimeStaleTime,
  });
}

export function useGroups() {
  return useQuery({
    queryKey: queryKeys.groups,
    queryFn: () => groupsCollection().getFullList({ sort: 'sortOrder,name', batch: 1000 }),
  });
}

export function useOfferings() {
  return useQuery({
    queryKey: queryKeys.offerings,
    queryFn: () => offeringsCollection().getFullList({ sort: 'sortOrder,name', batch: 1000 }),
  });
}

export function useUsers(enabled = true) {
  return useQuery({
    queryKey: queryKeys.users,
    queryFn: () => usersCollection().getFullList({ sort: 'username', batch: 1000 }),
    enabled,
  });
}

/** Totals as cached: the requested parts plus the period they were computed for. */
export interface TotalsData extends Totals {
  /** periodRangeKey() of the request – missing on data from elsewhere (placeholders, tests). */
  range?: string;
}

/**
 * `GET /api/app/totals` for a filter, only the given parts (default: all).
 * Parameter order: from, to, person, createdBy, parts.
 */
export async function fetchTotals(query: BookingQuery, parts?: readonly TotalsPart[], now = new Date()): Promise<TotalsData> {
  const params = buildTotalsQuery(resolveBookingQuery(query, now));
  const partsValue = partsParam(parts);
  if (partsValue) params.parts = partsValue;
  const totals = pickTotals(await pb.send<Totals>('/api/app/totals', { method: 'GET', query: params }), parts);
  if (!hasTotalsParts(totals, parts)) throw new Error('Die Summen konnten nicht vollständig geladen werden.');
  return { ...totals, range: periodRangeKey(query, now) };
}

function totalsQueryOptions(query: BookingQuery, parts?: readonly TotalsPart[]) {
  return queryOptions({
    queryKey: queryKeys.totalsFor(query, parts),
    queryFn: () => fetchTotals(query, parts),
  });
}

export interface TotalsOptions {
  /** Keep showing the previous filter's totals (the parts of it that this query asks for) while loading. */
  keepPrevious?: boolean;
  /** The parts the screen shows (default: all). */
  parts?: readonly TotalsPart[];
}

const placeholders = new Map<string, (previous: Totals | undefined) => Totals | undefined>();

/**
 * Placeholder while a new filter loads: the previous data, cut down to the
 * parts this query asks for – a part the previous query did not have stays
 * missing (= still loading). One stable function per parts combination.
 */
function previousParts(parts: readonly TotalsPart[]) {
  const key = parts.join(',');
  let placeholder = placeholders.get(key);
  if (!placeholder) {
    placeholder = (previous) => {
      if (!previous) return undefined;
      const picked = pickTotals(previous, parts);
      return Object.keys(picked).length > 0 ? picked : undefined;
    };
    placeholders.set(key, placeholder);
  }
  return placeholder;
}

export function useTotals(query: BookingQuery, enabled = true, options: TotalsOptions = {}) {
  const parts = normalizeParts(options.parts);
  return useQuery({
    ...totalsQueryOptions(query, parts),
    enabled,
    placeholderData: options.keepPrevious ? previousParts(parts) : undefined,
  });
}

/** All-time totals without filters – the per-record parts tell which records are referenced by bookings. */
export function useReferenceTotals(options: { parts?: readonly TotalsPart[]; enabled?: boolean } = {}) {
  return useTotals({ period: 'all' }, options.enabled ?? true, { parts: options.parts });
}

/**
 * True when the cached summary of `query` says "no bookings" – then the list
 * of that filter is known to be empty and is not requested: PocketBase delays
 * empty filtered lists by up to 0.5 s once 3 came within 3 s from one IP (F7).
 * Only a summary that is already there counts (no request of its own, so the
 * list never waits for it), and only while it is not being refetched – also
 * not in the first render of a screen that is about to refetch it (stale, or
 * invalidated by a booking event while the screen was hidden): then the list
 * loads in parallel, and "no bookings" is never shown while bookings may exist.
 * That is why the observer is enabled for a cached summary: TanStack reports
 * the refetch on mount as `fetching` from the first render on (a disabled
 * observer would say `idle` until the screen's own summary query starts it).
 */
function useKnownEmpty(query: BookingQuery, enabled: boolean): boolean {
  const queryClient = useQueryClient();
  const options = totalsQueryOptions(query, ['summary']);
  const cached = enabled && queryClient.getQueryData(options.queryKey) !== undefined;
  const summary = useQuery({ ...options, enabled: cached });
  return cached && summary.status === 'success' && summary.fetchStatus === 'idle' && summary.data.count === 0;
}

/** Bookings matching a PocketBase filter, newest first (`-created,-id`), with the full expand. */
export async function fetchBookings(filter: string, limit: number): Promise<BookingRecord[]> {
  return (
    await bookingsCollection().getList(1, limit, {
      filter,
      sort: '-created,-id',
      expand: BOOKING_EXPAND,
      skipTotal: true,
    })
  ).items;
}

/**
 * One page of the Buchungen list. Pages are keyset pages (older than the last
 * row of the previous page), not offsets: realtime events insert and remove
 * rows in the cached pages (bookingSync.ts), which would shift offset pages.
 * `next` is the cursor of the following page, fixed when the page was loaded
 * (null: the filter has no more bookings). `base` is the filter the page was
 * loaded with: page 1 resolves the period, the following pages reuse it, so
 * the pages of a list always show one period – "Weitere laden" after midnight
 * continues the day the list was loaded for, and bookingSync.ts can tell that
 * the list is outdated (refetched instead of patched).
 */
export interface BookingPage {
  items: BookingRecord[];
  next: KeysetCursor | null;
  base: string;
}

/** Where a following page starts: after `cursor`, with page 1's filter. */
export interface BookingPageParam {
  cursor: KeysetCursor;
  base: string;
}

export type BookingListData = InfiniteData<BookingPage, BookingPageParam | null>;

export async function fetchBookingPage(
  query: BookingQuery,
  param: BookingPageParam | null,
  now = new Date(),
): Promise<BookingPage> {
  const base = param ? param.base : buildBookingsFilter(resolveBookingQuery(query, now));
  const filter = param ? keysetFilter(base, param.cursor) : base; // the first page as before
  const items = await fetchBookings(filter, BOOKINGS_PAGE_SIZE);
  const last = items.at(-1);
  const next = last && items.length >= BOOKINGS_PAGE_SIZE ? { created: last.created, id: last.id } : null;
  return { items, next, base };
}

/** Key, pages and paging of the Buchungen list (the hook adds the screen's options). */
export function bookingListOptions(query: BookingQuery) {
  return infiniteQueryOptions({
    queryKey: queryKeys.bookingList(query),
    queryFn: ({ pageParam }: { pageParam: BookingPageParam | null }) => fetchBookingPage(query, pageParam),
    initialPageParam: null as BookingPageParam | null,
    getNextPageParam: (lastPage: BookingPage): BookingPageParam | undefined =>
      lastPage.next ? { cursor: lastPage.next, base: lastPage.base } : undefined,
  });
}

/**
 * An empty list from the cache that is being refetched is shown as loading,
 * not as "no bookings": it is refetched because it may be outdated (stale, or
 * a booking arrived while the screen was hidden, a reconnect, …), and showing
 * it for the round trip of the refetch painted "Keine Buchungen" / "Noch keine
 * Buchungen." while bookings existed (FLOW-8). Lists with rows keep showing
 * them while they are refetched (stale-while-revalidate); a known-empty list
 * (useKnownEmpty) is not fetched at all.
 */
function loadingWhileRefetchingEmpty<R extends { isRefetching: boolean; data: unknown }>(
  result: R,
  isEmpty: (data: NonNullable<R['data']>) => boolean,
): R {
  const data = result.data;
  if (!result.isRefetching || data === undefined || data === null || !isEmpty(data)) return result;
  return {
    ...result,
    data: undefined,
    status: 'pending',
    isPending: true,
    isLoading: true,
    isSuccess: false,
    isRefetching: false,
  };
}

const EMPTY_LIST: BookingListData = { pages: [{ items: [], next: null, base: '' }], pageParams: [null] };
const selectEmptyList = (): BookingListData => EMPTY_LIST;

export function useBookingList(query: BookingQuery, enabled = true) {
  // The Buchungen list view requests the summary of the same filter (parts=summary).
  const knownEmpty = useKnownEmpty(query, enabled);
  const result = useInfiniteQuery({
    ...bookingListOptions(query),
    enabled: enabled && !knownEmpty,
    // known empty: show "no bookings" – also over cached pages of an earlier visit
    placeholderData: knownEmpty ? EMPTY_LIST : undefined,
    select: knownEmpty ? selectEmptyList : undefined,
  });
  return loadingWhileRefetchingEmpty(result, (data) => data.pages.every((page) => page.items.length === 0));
}

const NO_BOOKINGS: BookingRecord[] = [];
const selectNoBookings = (): BookingRecord[] => NO_BOOKINGS;

export function useRecentBookings(personId: string | null | undefined, limit = 8) {
  // Buchen card and person detail show the person's summary (personTotalsQuery, parts=summary).
  const knownEmpty = useKnownEmpty(personTotalsQuery(personId ?? ''), Boolean(personId));
  const result = useQuery({
    queryKey: queryKeys.recentBookings(personId ?? '', limit),
    queryFn: () => fetchBookings(buildBookingsFilter({ range: {}, personId }), limit),
    enabled: Boolean(personId) && !knownEmpty,
    placeholderData: knownEmpty ? NO_BOOKINGS : undefined,
    select: knownEmpty ? selectNoBookings : undefined,
  });
  return loadingWhileRefetchingEmpty(result, (data) => data.length === 0);
}

/**
 * Loads all bookings for the given filter (CSV export) with keyset pagination,
 * so bookings created/cancelled during the export neither duplicate nor drop
 * rows (see keyset.ts).
 */
export function fetchAllBookings(query: BookingQuery): Promise<BookingRecord[]> {
  return fetchAllKeyset(fetchBookings, buildBookingsFilter(resolveBookingQuery(query)), 500);
}
