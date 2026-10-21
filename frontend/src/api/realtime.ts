/**
 * Realtime sync: subscribe to collection changes (PocketBase SSE) and update
 * the affected queries so several phones stay in sync. Booking events update
 * the booking and totals queries in a targeted way (bookingSync.ts: only what
 * the change touches, patched where possible); person and user events patch
 * the changed names into the cached rows and invalidate only their own lists;
 * offering and group events invalidate by prefix (INVALIDATION_MAP) – they
 * are rare.
 *
 * Robustness:
 * - The SDK only reconnects automatically after a *successful* first connect.
 *   If the first connect fails (server restarting, phone offline, …) we retry
 *   with backoff. When the browser goes online again or the app becomes
 *   visible, the next attempt starts at once (also cutting short the SDK's own
 *   wait of up to 2 s between its reconnect attempts).
 * - PocketBase drops a client's realtime auth when the user's tokenKey changes
 *   (password change, deactivation) – before it broadcasts the record update,
 *   so that event does not arrive, and nothing after it. After the own
 *   password change – in this tab or another tab of the browser (session.ts) –
 *   the subscriptions are re-established with the new token. A revoked token
 *   (deactivated, reset by an admin, password changed on another device) is
 *   caught by the session checks (session.ts: every minute while visible).
 * - Every reconnect refetches everything (events may have been missed) – after
 *   the session check, because PocketBase answers a revoked token as a guest
 *   (empty lists). The first connect refetches only what loaded before the
 *   subscriptions were active: changes in between would be missed (FLOW-5).
 * - While connected, cached data does not go stale by time (queries.ts
 *   realtimeStaleTime); while a reconnect is pending, focus / `online` do not
 *   refetch – the reconnect does, once (FLOW-6, app/queryClient.ts).
 */
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import type { RecordSubscription } from 'pocketbase';
import { useEffect, useRef, useState } from 'react';
import { applyOwnRecordUpdate, checkSession } from '../auth/session';
import { pb } from '../lib/pb';
import type { BookingRecord, PersonRecord, UserRecord } from '../lib/types';
import {
  applyBookingChanges,
  applyPersonUpdates,
  applyUserUpdates,
  markBookingChangesHandled,
  type BookingChange,
} from './bookingSync';
import { invalidateAllSafely, invalidateSafely } from './invalidate';
import { queryKeys } from './queries';

type SyncedCollection = 'bookings' | 'persons' | 'offerings' | 'groups' | 'users';

/**
 * Which query prefixes an event of a collection invalidates (expands and
 * totals included). Booking events use bookingSync.ts instead; their entry is
 * what a batch of booking events may touch at most. Persons and users appear
 * in booking rows and totals only with their names, which are patched
 * (applyPersonUpdates / applyUserUpdates) – a new guest no longer reloads
 * every list on every device (FLOW-7).
 */
export const INVALIDATION_MAP: Record<SyncedCollection, QueryKey[]> = {
  bookings: [queryKeys.bookings, queryKeys.totals],
  persons: [queryKeys.persons],
  offerings: [queryKeys.offerings, queryKeys.bookings, queryKeys.totals],
  groups: [queryKeys.groups, queryKeys.offerings, queryKeys.bookings, queryKeys.totals],
  users: [queryKeys.users],
};

/** Updated person / user records of a batch (their names are patched into the cached rows). */
export interface RecordUpdates {
  persons?: readonly PersonRecord[];
  users?: readonly UserRecord[];
}

/**
 * One debounced batch of events: names are patched, other collections
 * invalidate their prefixes; booking changes are applied in a targeted way –
 * unless the invalidation refetches all booking and totals queries anyway.
 */
export function flushRealtimeBatch(
  queryClient: QueryClient,
  collections: Iterable<SyncedCollection>,
  bookingChanges: readonly BookingChange[],
  updates: RecordUpdates = {},
): Promise<void> {
  const keys = new Map<string, QueryKey>();
  for (const collection of collections) {
    if (collection === 'bookings') continue;
    for (const key of INVALIDATION_MAP[collection]) keys.set(JSON.stringify(key), key);
  }
  const broad = [queryKeys.bookings, queryKeys.totals].every((key) => keys.has(JSON.stringify(key)));
  if (!broad) {
    applyPersonUpdates(queryClient, updates.persons ?? []);
    applyUserUpdates(queryClient, updates.users ?? []);
  }
  const work: Promise<void>[] = [];
  if (bookingChanges.length > 0) {
    if (broad) markBookingChangesHandled(queryClient, bookingChanges);
    else work.push(applyBookingChanges(queryClient, bookingChanges));
  }
  if (keys.size > 0) work.push(invalidateAllSafely(queryClient, [...keys.values()]));
  return Promise.all(work).then(() => undefined);
}

const DEBOUNCE_MS = 120;

/** Delays between attempts when the realtime connection cannot be established. */
export const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000] as const;

/** Delay before the next attempt after `failures` consecutive failed connects. */
export function retryDelay(failures: number): number {
  const index = Math.min(Math.max(failures - 1, 0), RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[index]!;
}

/** On a reconnect, a session check of the last 15 s counts (the app start or the visibility check just made one). */
const RECONNECT_SESSION_CHECK_MAX_AGE_MS = 15_000;

// ---------------------------------------------------------------------------
// Connection state (one realtime connection per app)

/** The user whose connection has been established (null: none yet since the app started or the user changed). */
let connectedUser: string | null = null;

/**
 * A reconnect is pending: once connected it refetches everything, so a focus
 * or `online` refetch now would load everything twice (FLOW-6). False before
 * the first connect – realtime may never work here (SSE blocked by a proxy):
 * then focus / `online` refetch as usual.
 */
export function realtimeCatchUpPending(): boolean {
  return connectedUser !== null && !pb.realtime.isConnected;
}

/**
 * The first connect: queries that settled before the subscriptions became
 * active may miss changes made in between – they are refetched (on a cold
 * start the few small ones that beat the subscription; persons kept
 * `staleTime: Infinity` afterwards and missed a new guest for good – FLOW-5).
 * The subscriptions become active while their request is under way; `time`
 * is its end (PB_CONNECT is reported after the request), so everything that
 * settled before is covered – at the price of what settled during that one
 * round trip. (A request still under way when the connection is reported may
 * have read the data a moment before the subscriptions were active – a window
 * of less than a round trip that only a refetch of the screen would close.)
 */
function invalidateSettledBefore(queryClient: QueryClient, time: number): Promise<void> {
  const queries = queryClient.getQueryCache().findAll({
    predicate: ({ state }) => {
      const settled = Math.max(state.dataUpdatedAt, state.errorUpdatedAt);
      return settled > 0 && settled < time;
    },
  });
  return Promise.all(queries.map((query) => invalidateSafely(queryClient, query.queryKey, { exact: true }))).then(
    () => undefined,
  );
}

/**
 * Ends the SDK's wait between its own reconnect attempts (up to 2 s after a
 * connection that had been established; `connect()` does nothing meanwhile).
 * The SDK has no public way to do it – its `disconnect()` resets the attempts
 * (pocketbase 0.28 RealtimeService); without it the SDK's next tick reconnects.
 */
function cutShortSdkReconnectWait(): void {
  const realtime = pb.realtime as unknown as { reconnectAttempts?: unknown; disconnect?: unknown };
  if (typeof realtime.disconnect === 'function' && typeof realtime.reconnectAttempts === 'number' && realtime.reconnectAttempts > 0) {
    (realtime.disconnect as () => void).call(pb.realtime);
  }
}

// Subscribe/unsubscribe work is serialized: a restart must fully disconnect
// before subscribing again – otherwise the SDK keeps the old connection (and
// its server-side auth) instead of submitting the subscriptions anew.
let queue: Promise<unknown> = Promise.resolve();
function serialized(task: () => Promise<void>): Promise<void> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

const ALL_QUERIES: QueryKey = [];

export function useRealtimeSync(user: Pick<UserRecord, 'id' | 'role'> | null, sessionGeneration: number): void {
  const queryClient = useQueryClient();
  const userId = user?.id;
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);
  // A connect attempt failed: the data loaded meanwhile may miss events.
  const missedEvents = useRef(false);

  useEffect(() => {
    if (!userId) return;
    if (connectedUser !== userId) connectedUser = null; // another user: their first connect

    let disposed = false;
    let debounceTimer: number | undefined;
    let retryTimer: number | undefined;
    const pending = new Set<SyncedCollection>();
    let bookingChanges: BookingChange[] = [];
    let personUpdates = new Map<string, PersonRecord>();
    let userUpdates = new Map<string, UserRecord>();

    const flush = () => {
      debounceTimer = undefined;
      const collections = [...pending];
      const changes = bookingChanges;
      const updates = { persons: [...personUpdates.values()], users: [...userUpdates.values()] };
      pending.clear();
      bookingChanges = [];
      personUpdates = new Map();
      userUpdates = new Map();
      void flushRealtimeBatch(queryClient, collections, changes, updates);
    };

    const schedule = (collection: SyncedCollection) => {
      if (disposed) return;
      pending.add(collection);
      debounceTimer ??= window.setTimeout(flush, DEBOUNCE_MS);
    };

    const scheduleBooking = (event: RecordSubscription<BookingRecord>) => {
      if (disposed) return;
      bookingChanges.push({ action: event.action, record: event.record });
      schedule('bookings');
    };

    const schedulePerson = (event: RecordSubscription<PersonRecord>) => {
      if (disposed) return;
      if (event.action === 'update') personUpdates.set(event.record.id, event.record);
      schedule('persons');
    };

    const scheduleUser = (event: RecordSubscription<UserRecord>) => {
      if (disposed) return;
      if (event.record.id === userId) applyOwnRecordUpdate(event.action, event.record);
      if (event.action === 'update') userUpdates.set(event.record.id, event.record);
      schedule('users');
    };

    const onConnect = () => {
      if (disposed) return;
      // After a reconnect – or a first connect after failed attempts – we may
      // have missed events → refetch everything.
      const catchUp = connectedUser === userId || missedEvents.current;
      const connectedAt = Date.now();
      connectedUser = userId;
      missedEvents.current = false;
      failures.current = 0;
      // The session first: a revoked token (disabled user, password reset)
      // would load empty lists (PocketBase answers it as a guest).
      void checkSession(RECONNECT_SESSION_CHECK_MAX_AGE_MS).then((status) => {
        if (disposed || status === 'invalid') return;
        if (catchUp) void invalidateAllSafely(queryClient, [ALL_QUERIES]);
        else void invalidateSettledBefore(queryClient, connectedAt);
      });
    };

    void serialized(async () => {
      if (disposed) return;
      const results = await Promise.allSettled([
        pb.collection('bookings').subscribe('*', scheduleBooking),
        pb.collection('persons').subscribe('*', schedulePerson),
        ...(['offerings', 'groups'] as const).map((collection) =>
          pb.collection(collection).subscribe('*', () => schedule(collection)),
        ),
        // Everyone watches all users: their names are shown with the bookings
        // ("von …"). The own record brings role changes and the forced
        // password change (a deactivation does not arrive – see the header).
        pb.collection('users').subscribe('*', scheduleUser),
        pb.realtime.subscribe('PB_CONNECT', onConnect),
      ]);
      if (disposed || results.every((result) => result.status === 'fulfilled')) return;

      // The (first) connect failed and the SDK will not retry on its own.
      await pb.realtime.unsubscribe().catch(() => undefined);
      if (disposed) return;
      failures.current += 1;
      missedEvents.current = true;
      retryTimer = window.setTimeout(() => setAttempt((n) => n + 1), retryDelay(failures.current));
    });

    const retryNow = () => {
      if (disposed || pb.realtime.isConnected) return;
      failures.current = 0;
      cutShortSdkReconnectWait();
      setAttempt((n) => n + 1);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') retryNow();
    };
    window.addEventListener('online', retryNow);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      // logged out: the next login starts with a first connect, not a reconnect (its screen just loaded)
      if (!pb.authStore.token) connectedUser = null;
      window.clearTimeout(debounceTimer);
      window.clearTimeout(retryTimer);
      window.removeEventListener('online', retryNow);
      document.removeEventListener('visibilitychange', onVisibility);
      void serialized(() => pb.realtime.unsubscribe().catch(() => undefined));
    };
  }, [userId, sessionGeneration, attempt, queryClient]);
}

/** Test helper: forget the connection state of the module. */
export function resetRealtimeStateForTests(): void {
  connectedUser = null;
}
