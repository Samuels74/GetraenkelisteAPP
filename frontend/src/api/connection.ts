/**
 * "Is what the screen shows still current?" – for the inline hint
 * "Verbindung zum Server unterbrochen – Anzeige evtl. nicht aktuell"
 * (components/ConnectionHint.tsx).
 *
 * A failed background refresh keeps the content a screen shows (stale-while-
 * revalidate), and while realtime is connected nothing goes stale by time
 * (queries.ts realtimeStaleTime). The offline banner only reflects the
 * browser's network state – with a working Wi-Fi but an unreachable server
 * (container restarting, proxy without upstream) every screen kept old numbers
 * without a word (L5). The hint shows, while the browser is online, when
 * - a query that a screen shows failed to refresh for want of a usable answer
 *   (network error, timeout, 5xx, a proxy's page – not PocketBase's own 4xx,
 *   which are answers) and kept its old data, or
 * - realtime has been disconnected for OUTAGE_HINT_AFTER_MS while the page was
 *   visible: no event reaches the cache meanwhile, the data may miss changes.
 * Failures from while the browser was offline do not count: the offline
 * banner said so, and what failed is refetched once it is back.
 */
import { notifyManager, onlineManager, useQueryClient, type Query, type QueryClient } from '@tanstack/react-query';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { isPocketBaseError } from '../lib/errors';
import { useOnline } from '../lib/useOnline';
import { realtimeCatchUpPending } from './realtime';

/** Realtime disconnected for this long (page visible, browser online): the hint shows. */
export const OUTAGE_HINT_AFTER_MS = 30_000;
/** How often the realtime state is looked at while somebody shows the hint. */
export const OUTAGE_POLL_MS = 5_000;

// ---------------------------------------------------------------------------
// When the browser was online again the last time

let onlineSince = 0;
onlineManager.subscribe((online) => {
  if (online) onlineSince = Date.now();
});

/** A refresh that failed for want of a usable answer, with the old data kept – while online. */
function isFailedRefresh(query: Query): boolean {
  const { status, data, error, errorUpdatedAt } = query.state;
  // (a failure in the very millisecond the browser went online was still an offline one)
  if (status !== 'error' || data === undefined || errorUpdatedAt <= onlineSince) return false;
  // PocketBase's own 4xx is an answer (a permission, a deleted record – the session checks handle a revoked token)
  return !isPocketBaseError(error) || error.status >= 500;
}

function failedRefreshes(queryClient: QueryClient): Query[] {
  return queryClient.getQueryCache().findAll({ type: 'active', predicate: isFailedRefresh });
}

// ---------------------------------------------------------------------------
// Realtime outage

/** Since when realtime has been down while visible and online (null: it is not). */
let outageSince: number | null = null;
let outage = false;
const outageListeners = new Set<() => void>();
let outageTimer: ReturnType<typeof setInterval> | undefined;
let unsubscribeOnline: (() => void) | undefined;

function updateOutage(): void {
  const now = Date.now();
  // Hidden or offline, the clock starts over: after an unlock the reconnect
  // follows at once (no hint for that moment); offline has its own banner.
  const down = document.visibilityState === 'visible' && onlineManager.isOnline() && realtimeCatchUpPending();
  if (!down) outageSince = null;
  else outageSince ??= now;
  const next = outageSince !== null && now - outageSince >= OUTAGE_HINT_AFTER_MS;
  if (next === outage) return;
  outage = next;
  for (const listener of [...outageListeners]) listener();
}

function subscribeOutage(listener: () => void): () => void {
  if (outageListeners.size === 0) {
    updateOutage();
    outageTimer = setInterval(updateOutage, OUTAGE_POLL_MS);
    document.addEventListener('visibilitychange', updateOutage);
    unsubscribeOnline = onlineManager.subscribe(updateOutage);
  }
  outageListeners.add(listener);
  return () => {
    if (!outageListeners.delete(listener) || outageListeners.size > 0) return;
    clearInterval(outageTimer);
    outageTimer = undefined;
    document.removeEventListener('visibilitychange', updateOutage);
    unsubscribeOnline?.();
    unsubscribeOnline = undefined;
    outageSince = null;
    outage = false;
  };
}

function getOutage(): boolean {
  return outage;
}

/** True while realtime has been down for OUTAGE_HINT_AFTER_MS (page visible, browser online). */
export function useRealtimeOutage(): boolean {
  return useSyncExternalStore(subscribeOutage, getOutage, getOutage);
}

/** Data refetched by hand is current now: the outage's clock starts over. */
function restartOutageClock(): void {
  if (outageSince !== null) outageSince = Date.now();
  updateOutage();
}

// ---------------------------------------------------------------------------
// The hint

export interface ConnectionHintState {
  /** Show the hint. */
  shown: boolean;
  /** Refetches what failed – everything shown, during a realtime outage. */
  retry: () => void;
  retrying: boolean;
}

export function useConnectionHint(): ConnectionHintState {
  const queryClient = useQueryClient();
  const online = useOnline();
  const realtimeDown = useRealtimeOutage();
  const subscribe = useCallback(
    // batched like TanStack's own hooks: cache events also fire while other components render
    (onChange: () => void) => queryClient.getQueryCache().subscribe(notifyManager.batchCalls(onChange)),
    [queryClient],
  );
  // (read on every render as well: going online moves `onlineSince`)
  const failed = useSyncExternalStore(subscribe, () => failedRefreshes(queryClient).length > 0, () => false);
  const [retrying, setRetrying] = useState(false);

  const retry = useCallback(() => {
    setRetrying(true);
    void queryClient
      .refetchQueries({ type: 'active', predicate: (query) => realtimeDown || isFailedRefresh(query) })
      .finally(() => {
        setRetrying(false);
        restartOutageClock();
      });
  }, [queryClient, realtimeDown]);

  return { shown: online && (failed || realtimeDown), retry, retrying };
}

/** Test helper: forget the outage state of the module. */
export function resetConnectionStateForTests(): void {
  outageSince = null;
  outage = false;
  onlineSince = 0;
}
