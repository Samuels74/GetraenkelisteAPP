/**
 * Realtime sync: subscribe to collection changes (PocketBase SSE) and
 * invalidate the affected queries so several phones stay in sync.
 *
 * Robustness:
 * - The SDK only reconnects automatically after a *successful* first connect.
 *   If the first connect fails (server restarting, phone offline, …) we retry
 *   with backoff, and immediately when the browser goes online again or the
 *   app becomes visible.
 * - PocketBase drops a client's realtime auth when the user's tokenKey changes
 *   (own password change). The subscriptions are therefore re-established on
 *   every new session generation (= token replaced by a (re-)login).
 * - Every (re)connect refetches everything (events may have been missed) and
 *   checks the session (a disabled/reset user is logged out).
 */
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { RecordSubscription } from 'pocketbase';
import { useEffect, useRef, useState } from 'react';
import { applyOwnRecordUpdate, refreshSessionThrottled } from '../auth/session';
import { pb } from '../lib/pb';
import type { UserRecord } from '../lib/types';
import { invalidateAllSafely } from './invalidate';
import { queryKeys } from './queries';

type SyncedCollection = 'bookings' | 'persons' | 'offerings' | 'groups' | 'users';

/** Which query prefixes depend on which collection (expands and totals included). */
export const INVALIDATION_MAP: Record<SyncedCollection, QueryKey[]> = {
  bookings: [queryKeys.bookings, queryKeys.totals],
  persons: [queryKeys.persons, queryKeys.bookings, queryKeys.totals],
  offerings: [queryKeys.offerings, queryKeys.bookings, queryKeys.totals],
  groups: [queryKeys.groups, queryKeys.offerings, queryKeys.bookings, queryKeys.totals],
  users: [queryKeys.users, queryKeys.bookings, queryKeys.totals],
};

const DEBOUNCE_MS = 120;

/** Delays between attempts when the realtime connection cannot be established. */
export const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000] as const;

/** Delay before the next attempt after `failures` consecutive failed connects. */
export function retryDelay(failures: number): number {
  const index = Math.min(Math.max(failures - 1, 0), RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[index]!;
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
  const admin = user?.role === 'admin';
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);
  const connectedBefore = useRef(false);
  // A connect attempt failed: the data loaded meanwhile may miss events.
  const missedEvents = useRef(false);

  useEffect(() => {
    if (!userId) return;

    let disposed = false;
    let debounceTimer: number | undefined;
    let retryTimer: number | undefined;
    const pending = new Set<SyncedCollection>();

    const flush = () => {
      debounceTimer = undefined;
      const keys = new Map<string, QueryKey>();
      for (const collection of pending) {
        for (const key of INVALIDATION_MAP[collection]) keys.set(JSON.stringify(key), key);
      }
      pending.clear();
      void invalidateAllSafely(queryClient, [...keys.values()]);
    };

    const schedule = (collection: SyncedCollection) => {
      if (disposed) return;
      pending.add(collection);
      debounceTimer ??= window.setTimeout(flush, DEBOUNCE_MS);
    };

    const onConnect = () => {
      if (disposed) return;
      // After a reconnect – or a first connect after failed attempts – we may
      // have missed events → refetch everything.
      if (connectedBefore.current || missedEvents.current) void invalidateAllSafely(queryClient, [ALL_QUERIES]);
      connectedBefore.current = true;
      missedEvents.current = false;
      failures.current = 0;
      // A revoked token (disabled user, password reset) ends the session.
      refreshSessionThrottled(15_000);
    };

    void serialized(async () => {
      if (disposed) return;
      const results = await Promise.allSettled([
        ...(['bookings', 'persons', 'offerings', 'groups'] as const).map((collection) =>
          pb.collection(collection).subscribe('*', () => schedule(collection)),
        ),
        // Admins watch all users (admin screen); everyone watches their own
        // record (role changes, forced password change, deactivation).
        pb.collection('users').subscribe(admin ? '*' : userId, (event: RecordSubscription<UserRecord>) => {
          if (disposed) return;
          if (admin) schedule('users');
          if (event.record.id === userId) applyOwnRecordUpdate(event.action, event.record);
        }),
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
      setAttempt((n) => n + 1);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') retryNow();
    };
    window.addEventListener('online', retryNow);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      window.clearTimeout(debounceTimer);
      window.clearTimeout(retryTimer);
      window.removeEventListener('online', retryNow);
      document.removeEventListener('visibilitychange', onVisibility);
      void serialized(() => pb.realtime.unsubscribe().catch(() => undefined));
    };
  }, [userId, admin, sessionGeneration, attempt, queryClient]);
}
