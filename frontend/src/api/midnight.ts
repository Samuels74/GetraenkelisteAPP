/**
 * Local midnight: one timer for everything that depends on "today"
 * (ARCHITECTURE.md §6 "Data flow").
 *
 * The periods "Heute", 7 Tage and 30 Tage move at local midnight. While
 * realtime is connected, cached data does not go stale by time (queries.ts
 * realtimeStaleTime), and before this an open "Heute" screen kept showing the
 * day before until the next booking arrived (FLOW-10). useMidnightRefresh
 * invalidates the queries of these periods when the day changes: mounted
 * screens refetch the new day at once, hidden ones when they are shown again.
 *
 * The timer fires a little after the next local midnight (`startOfLocalDay`
 * – 23- and 25-hour days at the DST changes included) and is armed again.
 * Timers of hidden pages may fire late or not at all (a locked phone), so the
 * day is also checked whenever the page becomes visible again. And timers
 * count only the time the device is awake: a laptop that sleeps across
 * midnight with the page "visible" (no visibilitychange) would fire hours
 * late – the timer never waits longer than a minute, each time a look at the
 * clock.
 *
 * `subscribeToDay` / `getDay` are a store for React's useSyncExternalStore:
 * screens that label days ("Heute", "Gestern") can re-render on the same
 * timer instead of arming their own.
 */
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { startOfLocalDay } from '../lib/dates';
import { showsRelativePeriod } from './bookingSync';
import { invalidateSafely } from './invalidate';

/** A little after midnight: a timer may fire a few milliseconds early. */
const AFTER_MIDNIGHT_MS = 1_000;
/** The longest wait of the timer (see the header: timers stand still while the device sleeps). */
export const MAX_TIMER_WAIT_MS = 60_000;

const listeners = new Set<() => void>();
/** A moment of the current day – the same object for the whole day (a stable snapshot). */
let day = new Date();
let timer: ReturnType<typeof setTimeout> | undefined;

function sameLocalDay(a: Date, b: Date): boolean {
  return startOfLocalDay(a).getTime() === startOfLocalDay(b).getTime();
}

function arm(now: Date): void {
  clearTimeout(timer);
  const untilMidnight = startOfLocalDay(now, 1).getTime() - now.getTime() + AFTER_MIDNIGHT_MS;
  timer = setTimeout(check, Math.min(untilMidnight, MAX_TIMER_WAIT_MS));
}

/** Re-reads the clock: a new day notifies every listener; the timer is armed for the next midnight. */
function check(): void {
  const now = new Date();
  const changed = !sameLocalDay(day, now);
  if (changed) day = now;
  arm(now);
  if (changed) for (const listener of [...listeners]) listener();
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') check();
}

/** Calls `listener` whenever the local day changes; returns the unsubscribe function. */
export function subscribeToDay(listener: () => void): () => void {
  if (listeners.size === 0) {
    // the first listener: nobody holds an older day – start from today
    const now = new Date();
    if (!sameLocalDay(day, now)) day = now;
    arm(now);
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
  listeners.add(listener);
  return () => {
    if (!listeners.delete(listener) || listeners.size > 0) return;
    clearTimeout(timer);
    timer = undefined;
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}

/** A Date of the current local day – the same object until the day changes (see subscribeToDay). */
export function getDay(): Date {
  return day;
}

/** Invalidates the queries of periods relative to "today" (lists and totals of Heute / 7 / 30 Tage). */
export function invalidateRelativePeriods(queryClient: QueryClient): Promise<void> {
  const queries = queryClient.getQueryCache().findAll({ predicate: (query) => showsRelativePeriod(query.queryKey) });
  return Promise.all(queries.map((query) => invalidateSafely(queryClient, query.queryKey, { exact: true }))).then(
    () => undefined,
  );
}

/** At local midnight, the "Heute" / 7 / 30 Tage screens move on to the new day (see the header). */
export function useMidnightRefresh(): void {
  const queryClient = useQueryClient();
  useEffect(() => subscribeToDay(() => void invalidateRelativePeriods(queryClient)), [queryClient]);
}
