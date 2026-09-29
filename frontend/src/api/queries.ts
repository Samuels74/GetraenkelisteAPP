/**
 * TanStack Query hooks for all reads. Query keys start with the collection
 * name so realtime events can invalidate them by prefix (see realtime.ts).
 */
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
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
import type { BookingRecord, Totals } from '../lib/types';
import { fetchAllKeyset } from './keyset';

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

export const queryKeys = {
  persons: ['persons'] as const,
  groups: ['groups'] as const,
  offerings: ['offerings'] as const,
  users: ['users'] as const,
  bookings: ['bookings'] as const,
  bookingList: (query: BookingQuery) => ['bookings', 'list', query] as const,
  recentBookings: (personId: string, limit: number) => ['bookings', 'recent', personId, limit] as const,
  totals: ['totals'] as const,
  totalsFor: (query: BookingQuery) => ['totals', query] as const,
};

export function usePersons() {
  return useQuery({
    queryKey: queryKeys.persons,
    queryFn: async () => sortPersons(await personsCollection().getFullList({ batch: 1000 })),
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

export function fetchTotals(query: BookingQuery): Promise<Totals> {
  return pb.send<Totals>('/api/app/totals', {
    method: 'GET',
    query: buildTotalsQuery(resolveBookingQuery(query)),
  });
}

export function useTotals(query: BookingQuery, enabled = true, options: { keepPrevious?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.totalsFor(query),
    queryFn: () => fetchTotals(query),
    enabled,
    placeholderData: options.keepPrevious ? keepPreviousData : undefined,
  });
}

/** All-time totals without filters – tells which records are referenced by bookings. */
export function useReferenceTotals(enabled = true) {
  return useTotals({ period: 'all' }, enabled);
}

export function useBookingList(query: BookingQuery, enabled = true) {
  return useInfiniteQuery({
    enabled,
    queryKey: queryKeys.bookingList(query),
    queryFn: ({ pageParam }) =>
      bookingsCollection().getList(pageParam, BOOKINGS_PAGE_SIZE, {
        filter: buildBookingsFilter(resolveBookingQuery(query)),
        sort: '-created,-id',
        expand: BOOKING_EXPAND,
        skipTotal: true,
      }),
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages) =>
      lastPage.items.length < BOOKINGS_PAGE_SIZE ? undefined : pages.length + 1,
  });
}

export function useRecentBookings(personId: string | null | undefined, limit = 8) {
  return useQuery({
    queryKey: queryKeys.recentBookings(personId ?? '', limit),
    queryFn: async () =>
      (
        await bookingsCollection().getList(1, limit, {
          filter: buildBookingsFilter({ range: {}, personId }),
          sort: '-created,-id',
          expand: BOOKING_EXPAND,
          skipTotal: true,
        })
      ).items,
    enabled: Boolean(personId),
  });
}

/** Loads all bookings for the given filter (CSV export). */
/**
 * Loads all bookings for the given filter (CSV export) with keyset pagination,
 * so bookings created/cancelled during the export neither duplicate nor drop
 * rows (see keyset.ts).
 */
export function fetchAllBookings(query: BookingQuery): Promise<BookingRecord[]> {
  return fetchAllKeyset(
    async (filter, pageSize) =>
      (
        await bookingsCollection().getList(1, pageSize, {
          filter,
          sort: '-created,-id',
          expand: BOOKING_EXPAND,
          skipTotal: true,
        })
      ).items,
    buildBookingsFilter(resolveBookingQuery(query)),
    500,
  );
}
