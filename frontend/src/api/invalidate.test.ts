import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { waitFor } from '@testing-library/react';
import { invalidateSafely } from './invalidate';
import { retryDelay } from './realtime';

interface Page {
  page: number;
  version: number;
}

describe('invalidateSafely', () => {
  it('keeps a running "Weitere laden" (fetchNextPage) and refetches all pages afterwards', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let version = 1;
    let slowPage2: Promise<void> | null = null;
    let releasePage2 = () => {};
    const queryFn = vi.fn(async ({ pageParam }: { pageParam: number }): Promise<Page> => {
      if (pageParam === 2 && slowPage2) await slowPage2;
      return { page: pageParam, version };
    });
    const observer = new InfiniteQueryObserver(qc, {
      queryKey: ['bookings', 'list', { period: 'all' }],
      queryFn,
      initialPageParam: 1,
      getNextPageParam: (last: Page) => (last.page < 5 ? last.page + 1 : undefined),
    });
    const unsubscribe = observer.subscribe(() => {});
    await waitFor(() => expect(observer.getCurrentResult().data?.pages).toHaveLength(1));

    slowPage2 = new Promise<void>((resolve) => {
      releasePage2 = resolve;
    });
    const next = observer.fetchNextPage();
    // a realtime event arrives while page 2 is loading
    version = 2;
    await invalidateSafely(qc, ['bookings']);
    releasePage2();
    await next;

    // page 2 was not lost …
    await waitFor(() => expect(observer.getCurrentResult().data?.pages).toHaveLength(2));
    // … and both pages were refetched with the new data after the event
    await waitFor(() =>
      expect(observer.getCurrentResult().data?.pages.map((p) => p.version)).toEqual([2, 2]),
    );
    expect(observer.getCurrentResult().isFetching).toBe(false);
    unsubscribe();
  });

  it('invalidates idle queries immediately', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let version = 1;
    const observer = new InfiniteQueryObserver(qc, {
      queryKey: ['totals', {}],
      queryFn: () => Promise.resolve({ page: 1, version }),
      initialPageParam: 1,
      getNextPageParam: () => undefined,
    });
    const unsubscribe = observer.subscribe(() => {});
    await waitFor(() => expect(observer.getCurrentResult().data?.pages[0]?.version).toBe(1));
    version = 2;
    await invalidateSafely(qc, ['totals']);
    await waitFor(() => expect(observer.getCurrentResult().data?.pages[0]?.version).toBe(2));
    unsubscribe();
  });
});

describe('retryDelay (realtime reconnect backoff)', () => {
  it('backs off from 1 s up to 30 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(retryDelay)).toEqual([1000, 2000, 5000, 10000, 20000, 30000, 30000, 30000]);
    expect(retryDelay(0)).toBe(1000);
  });
});
