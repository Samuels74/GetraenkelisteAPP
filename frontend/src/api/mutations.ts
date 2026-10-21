/**
 * Write operations. Every mutation updates or invalidates the affected queries
 * (realtime events do the same for changes made on other devices); bookings
 * and cancellations go through the same targeted update as their realtime
 * events (bookingSync.ts), person and user edits patch the new names into the
 * cached rows like theirs. Updates only send the fields that actually changed,
 * so concurrent edits of other fields by another admin are not overwritten
 * with stale values.
 */
import { useMutation, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { getCurrentUser } from '../auth/session';
import { isPocketBaseNotFound } from '../lib/errors';
import {
  BOOKING_EXPAND,
  bookingsCollection,
  groupsCollection,
  offeringsCollection,
  personsCollection,
  usersCollection,
} from '../lib/pb';
import { sortPersons } from '../lib/search';
import type {
  BookingRecord,
  GroupRecord,
  OfferingRecord,
  PersonRecord,
  Role,
  Totals,
  UserRecord,
} from '../lib/types';
import {
  applyBookingChanges,
  applyPersonUpdates,
  applyUserUpdates,
  isBookingChangeHandled,
  type BookingChange,
} from './bookingSync';
import { invalidateAllSafely } from './invalidate';
import { personTotalsQuery, queryKeys } from './queries';

function invalidate(qc: QueryClient, ...keys: QueryKey[]): Promise<void> {
  return invalidateAllSafely(qc, keys);
}

// ---------------------------------------------------------------------------
// Bookings

export interface CreateBookingInput {
  person: PersonRecord;
  offering: OfferingRecord;
}

/**
 * Instant feedback on the person card (Buchen, person detail) before the
 * refetch of its totals lands – only on mounted queries: those are being
 * refetched right now (applyBookingChanges), so the estimate is replaced by
 * the server's numbers; a cached but hidden query must stay marked stale.
 */
function showOnPersonCard(qc: QueryClient, booking: BookingRecord): void {
  const key = queryKeys.totalsFor(personTotalsQuery(booking.person), ['summary']);
  for (const query of qc.getQueryCache().findAll({ queryKey: key, exact: true })) {
    const old = query.state.data as Totals | undefined;
    if (!query.isActive() || old?.count === undefined || old.quantity === undefined || old.totalCents === undefined) continue;
    qc.setQueryData<Totals>(query.queryKey, {
      ...old,
      count: old.count + 1,
      quantity: old.quantity + booking.quantity,
      totalCents: old.totalCents + booking.quantity * booking.unitPriceCents,
    });
  }
}

export function useCreateBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ person, offering }: CreateBookingInput) =>
      bookingsCollection().create(
        {
          person: person.id,
          offering: offering.id,
          quantity: 1,
          // Set by the server hook anyway (client value ignored).
          createdBy: getCurrentUser()?.id,
        },
        { expand: BOOKING_EXPAND },
      ),
    onSuccess: (booking) => {
      // One update round for the booking and its realtime echo (which can
      // arrive before this response): whichever comes first is applied.
      const change: BookingChange = { action: 'create', record: booking, expanded: true };
      if (isBookingChangeHandled(qc, change)) return;
      void applyBookingChanges(qc, [change]);
      showOnPersonCard(qc, booking);
    },
  });
}

export function useDeleteBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (booking: BookingRecord) => bookingsCollection().delete(booking.id),
    onSettled: (_result, error, booking) => {
      // gone after success – and after PocketBase's 404 (already cancelled elsewhere; a proxy's 404 page says nothing)
      const gone = !error || isPocketBaseNotFound(error);
      if (gone) void applyBookingChanges(qc, [{ action: 'delete', record: booking }]);
      // unclear state after a failed cancel: show the server's state
      else void invalidate(qc, queryKeys.bookings, queryKeys.totals);
    },
  });
}

// ---------------------------------------------------------------------------
// Persons

export interface PersonInput {
  number: string;
  name: string;
  nickname: string;
}

export function useCreatePerson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PersonInput) => personsCollection().create(input),
    onSuccess: (person) => {
      qc.setQueryData<PersonRecord[]>(queryKeys.persons, (old) => (old ? [...old, person] : old));
      void invalidate(qc, queryKeys.persons);
    },
  });
}

export function useUpdatePerson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<PersonInput> }) => personsCollection().update(id, input),
    onSuccess: (person) => {
      // (a new number moves the person in the list – sorted like the server's list)
      qc.setQueryData<PersonRecord[]>(queryKeys.persons, (old) =>
        old ? sortPersons(old.map((p) => (p.id === person.id ? person : p))) : old,
      );
      // Like the realtime event of the change (api/realtime.ts): the new number
      // / name / nickname go into the cached booking rows and per-person totals
      // – no reload of every booking list and all totals on this device.
      applyPersonUpdates(qc, [person]);
      void invalidate(qc, queryKeys.persons);
    },
  });
}

export function useDeletePerson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => personsCollection().delete(id),
    onSuccess: () => invalidate(qc, queryKeys.persons, queryKeys.totals),
  });
}

// ---------------------------------------------------------------------------
// Groups & offerings (admin)

export interface GroupInput {
  name: string;
  sortOrder?: number;
}

export function useSaveGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: Partial<GroupInput> }) =>
      id ? groupsCollection().update(id, input) : groupsCollection().create(input),
    onSuccess: () => invalidate(qc, queryKeys.groups, queryKeys.offerings, queryKeys.totals, queryKeys.bookings),
  });
}

export function useDeleteGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => groupsCollection().delete(id),
    onSuccess: () => invalidate(qc, queryKeys.groups),
  });
}

export interface OfferingInput {
  name: string;
  group: string;
  priceCents: number;
  active: boolean;
  sortOrder?: number;
}

export function useSaveOffering() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: Partial<OfferingInput> }) =>
      id ? offeringsCollection().update(id, input) : offeringsCollection().create(input),
    onSuccess: () => invalidate(qc, queryKeys.offerings, queryKeys.totals, queryKeys.bookings),
  });
}

export function useDeleteOffering() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => offeringsCollection().delete(id),
    onSuccess: () => invalidate(qc, queryKeys.offerings),
  });
}

export interface SortUpdate {
  id: string;
  sortOrder: number;
}

/**
 * Moves the item at `index` (list sorted by sortOrder) by `delta` positions.
 * When all sortOrders are distinct only the two affected items swap their
 * values (2 updates); otherwise (duplicates) the list is renumbered 10, 20,
 * 30, … and only the items whose value changes are returned.
 */
export function computeReorder<T extends { id: string; sortOrder: number }>(
  items: readonly T[],
  index: number,
  delta: -1 | 1,
): SortUpdate[] {
  const target = index + delta;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return [];
  const moving = items[index]!;
  const other = items[target]!;

  const distinct = new Set(items.map((item) => item.sortOrder)).size === items.length;
  if (distinct) {
    return [
      { id: moving.id, sortOrder: other.sortOrder },
      { id: other.id, sortOrder: moving.sortOrder },
    ];
  }

  const order = [...items];
  order[index] = other;
  order[target] = moving;
  return order
    .map((item, position) => ({ item, sortOrder: (position + 1) * 10 }))
    .filter(({ item, sortOrder }) => item.sortOrder !== sortOrder)
    .map(({ item, sortOrder }) => ({ id: item.id, sortOrder }));
}

function applySortUpdates<T extends { id: string; sortOrder: number }>(items: T[], updates: SortUpdate[]): T[] {
  const byId = new Map(updates.map((u) => [u.id, u.sortOrder]));
  return items
    .map((item) => (byId.has(item.id) ? { ...item, sortOrder: byId.get(item.id)! } : item))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export function useReorderGroups() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (updates: SortUpdate[]) => {
      for (const u of updates) await groupsCollection().update(u.id, { sortOrder: u.sortOrder });
    },
    onMutate: (updates) => {
      qc.setQueryData<GroupRecord[]>(queryKeys.groups, (old) => (old ? applySortUpdates(old, updates) : old));
    },
    // on success and on error: show the real server state
    onSettled: () => invalidate(qc, queryKeys.groups, queryKeys.totals),
  });
}

export function useReorderOfferings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (updates: SortUpdate[]) => {
      for (const u of updates) await offeringsCollection().update(u.id, { sortOrder: u.sortOrder });
    },
    onMutate: (updates) => {
      qc.setQueryData<OfferingRecord[]>(queryKeys.offerings, (old) => (old ? applySortUpdates(old, updates) : old));
    },
    onSettled: () => invalidate(qc, queryKeys.offerings, queryKeys.totals),
  });
}

// ---------------------------------------------------------------------------
// Users (admin)

export interface CreateUserInput {
  username: string;
  name: string;
  password: string;
  passwordConfirm: string;
  role: Role;
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateUserInput) => usersCollection().create({ ...input, mustChangePassword: true }),
    onSuccess: () => invalidate(qc, queryKeys.users),
  });
}

export interface UpdateUserInput {
  name?: string;
  role?: Role;
  disabled?: boolean;
  password?: string;
  passwordConfirm?: string;
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateUserInput }) => usersCollection().update(id, input),
    onSuccess: (user: UserRecord) => {
      qc.setQueryData<UserRecord[]>(queryKeys.users, (old) => old?.map((u) => (u.id === user.id ? user : u)));
      // like the realtime event: the name in the cached rows ("von …", per-user totals), no reload
      applyUserUpdates(qc, [user]);
      void invalidate(qc, queryKeys.users);
    },
  });
}

export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => usersCollection().delete(id),
    onSuccess: () => invalidate(qc, queryKeys.users),
  });
}
