import { InfiniteQueryObserver, QueryClient, QueryObserver } from '@tanstack/react-query';
import { waitFor } from '@testing-library/react';
import { invalidateSafely, whenIdle, whenSettled } from './invalidate';
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

describe('invalidateSafely during a running fetch (FLOW-2)', () => {
  it.each([1, 2, 3, 6, 10])('%i invalidation(s) during one fetch → exactly one refetch after it', async (count) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const releases: Array<() => void> = [];
    const queryFn = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          releases.push(() => resolve(queryFn.mock.calls.length));
        }),
    );
    const observer = new QueryObserver(qc, { queryKey: ['totals', { period: 'all' }], queryFn });
    const unsubscribe = observer.subscribe(() => {});
    expect(queryFn).toHaveBeenCalledOnce(); // the first load is under way
    for (let i = 0; i < count; i++) await invalidateSafely(qc, ['totals']);
    releases.shift()!();
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2)); // the one refetch after it
    releases.shift()!();
    await waitFor(() => expect(observer.getCurrentResult().fetchStatus).toBe('idle'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // before: one listener per call – ⌈count/2⌉ refetches in a row
    expect(queryFn).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});

describe('whenSettled / whenIdle', () => {
  it('share one promise per fetching query, resolve when it settled – at once when idle', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let release = () => {};
    const observer = new QueryObserver(qc, {
      queryKey: ['bookings'],
      queryFn: () => new Promise<number>((resolve) => (release = () => resolve(1))),
    });
    const unsubscribe = observer.subscribe(() => {});
    const query = qc.getQueryCache().find({ queryKey: ['bookings'] })!;
    const first = whenSettled(qc, query);
    expect(whenSettled(qc, query)).toBe(first);
    let settled = false;
    void first.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await first;
    expect(query.state.fetchStatus).toBe('idle');
    await whenSettled(qc, query); // idle: at once
    await whenIdle(qc, query);
    unsubscribe();
  });

  it('resolve when the query is removed meanwhile', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new QueryObserver(qc, { queryKey: ['gone'], queryFn: () => new Promise<number>(() => {}) });
    const unsubscribe = observer.subscribe(() => {});
    const query = qc.getQueryCache().find({ queryKey: ['gone'] })!;
    const settled = whenIdle(qc, query);
    unsubscribe();
    qc.getQueryCache().remove(query);
    await settled;
  });
});

describe('retryDelay (realtime reconnect backoff)', () => {
  it('backs off from 1 s up to 30 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(retryDelay)).toEqual([1000, 2000, 5000, 10000, 20000, 30000, 30000, 30000]);
    expect(retryDelay(0)).toBe(1000);
  });
});
