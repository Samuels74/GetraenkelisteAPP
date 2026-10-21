import type { Query, QueryClient, QueryKey } from '@tanstack/react-query';

/**
 * Invalidates queries without cancelling fetches that are already running.
 *
 * TanStack's default (`cancelRefetch: true`) aborts an in-flight fetch – for
 * infinite queries that also aborts a running `fetchNextPage()` ("Weitere
 * laden"), and the refetch then only reloads the pages that were cached before,
 * so the extra page is lost. Here, queries that are currently fetching are left
 * alone and invalidated once their fetch has settled (the refetch then reloads
 * all pages, including the new one).
 *
 * Once per query: however many invalidations arrive during a fetch, one
 * refetch follows it. (One listener per call turned a stream of booking events
 * during a slow fetch into back-to-back full refetches – FLOW-2.)
 *
 * `exact`: only the query with exactly this key (default: every key with this prefix).
 */
export function invalidateSafely(
  queryClient: QueryClient,
  queryKey: QueryKey,
  { exact = false }: { exact?: boolean } = {},
): Promise<void> {
  const cache = queryClient.getQueryCache();
  const busy = new Set<Query>(
    cache.findAll({ queryKey, exact, predicate: (query) => query.state.fetchStatus !== 'idle' }),
  );
  for (const query of busy) invalidateWhenSettled(queryClient, query);

  return queryClient.invalidateQueries(
    { queryKey, exact, predicate: (query) => !busy.has(query) },
    { cancelRefetch: false },
  );
}

/** Invalidates several query prefixes safely (see invalidateSafely). */
export function invalidateAllSafely(queryClient: QueryClient, keys: readonly QueryKey[]): Promise<void> {
  return Promise.all(keys.map((key) => invalidateSafely(queryClient, key))).then(() => undefined);
}

// Queries that already wait for their running fetch to settle before they are invalidated.
const invalidateAfterFetch = new WeakSet<Query>();

function invalidateWhenSettled(queryClient: QueryClient, query: Query): void {
  if (invalidateAfterFetch.has(query)) return;
  invalidateAfterFetch.add(query);
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.query !== query) return;
    const removed = event.type === 'removed';
    if (!removed && query.state.fetchStatus !== 'idle') return;
    unsubscribe();
    invalidateAfterFetch.delete(query);
    // synchronously, in the notification of the settled fetch: the refetch has
    // started before anything that awaits whenSettled() looks at the query
    if (!removed) void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false });
  });
}

// One promise (one cache listener) per fetching query, shared by everyone who waits for it.
const settling = new WeakMap<Query, Promise<void>>();

/**
 * Resolves once the query is not fetching any more – at once when it is idle –
 * or when it was removed from the cache. Note: by the time an awaiting caller
 * continues, the next fetch may already have started (e.g. the refetch of
 * invalidateSafely); check `fetchStatus` again.
 */
export function whenSettled(queryClient: QueryClient, query: Query): Promise<void> {
  const cache = queryClient.getQueryCache();
  if (query.state.fetchStatus === 'idle' || cache.get(query.queryHash) !== query) return Promise.resolve();
  let settled = settling.get(query);
  if (!settled) {
    settled = new Promise<void>((resolve) => {
      const unsubscribe = cache.subscribe((event) => {
        if (event.query !== query) return;
        if (event.type !== 'removed' && query.state.fetchStatus !== 'idle') return;
        unsubscribe();
        settling.delete(query);
        resolve();
      });
    });
    settling.set(query, settled);
  }
  return settled;
}

/** Waits until the query is idle (also across fetches that start one after the other) or gone. */
export async function whenIdle(queryClient: QueryClient, query: Query): Promise<void> {
  const cache = queryClient.getQueryCache();
  while (query.state.fetchStatus !== 'idle' && cache.get(query.queryHash) === query) {
    await whenSettled(queryClient, query);
  }
}
