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
 */
export function invalidateSafely(queryClient: QueryClient, queryKey: QueryKey): Promise<void> {
  const cache = queryClient.getQueryCache();
  const busy = new Set<Query>(cache.findAll({ queryKey, fetchStatus: 'fetching' }));

  for (const query of busy) {
    const unsubscribe = cache.subscribe((event) => {
      if (event.query !== query) return;
      if (event.type === 'removed') {
        unsubscribe();
        return;
      }
      if (query.state.fetchStatus !== 'idle') return;
      unsubscribe();
      void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false });
    });
  }

  return queryClient.invalidateQueries(
    { queryKey, predicate: (query) => !busy.has(query) },
    { cancelRefetch: false },
  );
}

/** Invalidates several query prefixes safely (see invalidateSafely). */
export function invalidateAllSafely(queryClient: QueryClient, keys: readonly QueryKey[]): Promise<void> {
  return Promise.all(keys.map((key) => invalidateSafely(queryClient, key))).then(() => undefined);
}
