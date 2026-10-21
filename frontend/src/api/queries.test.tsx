import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import type { ListResult } from 'pocketbase';
import type { ReactNode } from 'react';
import { pb } from '../lib/pb';
import type { BookingRecord, PersonRecord, Totals } from '../lib/types';
import { applyBookingChanges } from './bookingSync';
import {
  BOOKINGS_PAGE_SIZE,
  personTotalsQuery,
  queryKeys,
  realtimeStaleTime,
  useBookingList,
  usePersons,
  useRecentBookings,
  useTotals,
  type BookingListData,
  type BookingQuery,
} from './queries';

let seq = 0;
function booking(overrides: Partial<BookingRecord> = {}): BookingRecord {
  seq += 1;
  const second = String(seq % 60).padStart(2, '0');
  return {
    id: `b${String(seq).padStart(5, '0')}`,
    collectionId: 'c',
    collectionName: 'bookings',
    created: `2026-10-20 17:00:${second}.000Z`,
    updated: `2026-10-20 17:00:${second}.000Z`,
    person: 'p1',
    offering: 'o1',
    quantity: 1,
    unitPriceCents: 250,
    createdBy: 'u1',
    ...overrides,
  };
}

const list = (items: BookingRecord[]): ListResult<BookingRecord> => ({
  page: 1,
  perPage: items.length,
  totalItems: -1,
  totalPages: -1,
  items,
});

const ZERO: Totals = { count: 0, quantity: 0, totalCents: 0 };

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
});
afterEach(() => {
  qc.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('usePersons (F6)', () => {
  it('while realtime is connected: no re-download when a screen mounts later; an invalidation still refetches', async () => {
    vi.spyOn(pb.realtime, 'isConnected', 'get').mockReturnValue(true);
    const persons: PersonRecord[] = [];
    const getFullList = vi.spyOn(pb.collection('persons'), 'getFullList').mockResolvedValue(persons);
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = renderHook(() => usePersons(), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();

    vi.setSystemTime(Date.now() + 60 * 60_000); // an hour later
    const second = renderHook(() => usePersons(), { wrapper });
    expect(second.result.current.isStale).toBe(false);
    await act(async () => {});
    expect(getFullList).toHaveBeenCalledOnce();

    // a person event (realtime) or a reconnect invalidates it
    await act(() => qc.invalidateQueries({ queryKey: queryKeys.persons }));
    expect(getFullList).toHaveBeenCalledTimes(2);
  });

  it('without a realtime connection: stale after 30 s like every query (no person event would arrive)', async () => {
    const connected = vi.spyOn(pb.realtime, 'isConnected', 'get').mockReturnValue(false);
    const getFullList = vi.spyOn(pb.collection('persons'), 'getFullList').mockResolvedValue([]);
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = renderHook(() => usePersons(), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();

    vi.setSystemTime(Date.now() + 20_000);
    const second = renderHook(() => usePersons(), { wrapper });
    expect(second.result.current.isStale).toBe(false);
    second.unmount();
    await act(async () => {});
    expect(getFullList).toHaveBeenCalledOnce();

    vi.setSystemTime(Date.now() + 20_000); // 40 s after loading: refetched when a screen mounts
    const third = renderHook(() => usePersons(), { wrapper });
    await waitFor(() => expect(getFullList).toHaveBeenCalledTimes(2));
    third.unmount();

    // connected again: the same data counts as fresh (events keep it current)
    connected.mockReturnValue(true);
    vi.setSystemTime(Date.now() + 60 * 60_000);
    const fourth = renderHook(() => usePersons(), { wrapper });
    expect(fourth.result.current.isStale).toBe(false);
    await act(async () => {});
    expect(getFullList).toHaveBeenCalledTimes(2);
  });
});

describe('useRecentBookings: skips lists known to be empty (F7)', () => {
  const summaryKey = queryKeys.totalsFor(personTotalsQuery('p1'), ['summary']);

  it('does not request the list when the cached summary of the person says 0', async () => {
    const getList = vi.spyOn(pb.collection('bookings'), 'getList');
    qc.setQueryData(summaryKey, ZERO);
    const { result } = renderHook(() => useRecentBookings('p1', 8), { wrapper });
    expect(result.current.isPending).toBe(false);
    expect(result.current.data).toEqual([]);
    await act(async () => {});
    expect(getList).not.toHaveBeenCalled();
  });

  it('shows no stale bookings of an earlier visit when the summary says 0', () => {
    qc.setQueryData(summaryKey, ZERO);
    qc.setQueryData(queryKeys.recentBookings('p1', 8), [booking()]);
    const { result } = renderHook(() => useRecentBookings('p1', 8), { wrapper });
    expect(result.current.data).toEqual([]);
  });

  it('loads in parallel when the summary is not known yet (no extra round trip)', async () => {
    const getList = vi.spyOn(pb.collection('bookings'), 'getList').mockResolvedValue(list([booking()]));
    const { result } = renderHook(() => useRecentBookings('p1', 8), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(getList).toHaveBeenCalledExactlyOnceWith(1, 8, expect.objectContaining({ filter: "person = 'p1'" }));
  });

  it('loads when the summary says there are bookings', async () => {
    const getList = vi.spyOn(pb.collection('bookings'), 'getList').mockResolvedValue(list([booking()]));
    qc.setQueryData(summaryKey, { count: 1, quantity: 1, totalCents: 250 });
    renderHook(() => useRecentBookings('p1', 8), { wrapper });
    await waitFor(() => expect(getList).toHaveBeenCalledOnce());
  });

  it('loads while the summary is being refetched (a booking event for the person arrived)', async () => {
    const getList = vi.spyOn(pb.collection('bookings'), 'getList').mockResolvedValue(list([booking()]));
    qc.setQueryData(summaryKey, ZERO);
    const summary = new QueryObserver(qc, {
      queryKey: summaryKey,
      queryFn: () => new Promise<Totals>(() => {}), // still loading
      staleTime: Infinity,
    });
    const unsubscribe = summary.subscribe(() => {});
    void summary.refetch();
    renderHook(() => useRecentBookings('p1', 8), { wrapper });
    await waitFor(() => expect(getList).toHaveBeenCalledOnce());
    unsubscribe();
  });
});

describe('useBookingList', () => {
  it('pages with a keyset cursor (older than the last loaded booking)', async () => {
    const page1 = Array.from({ length: BOOKINGS_PAGE_SIZE }, () => booking());
    page1.reverse(); // newest first
    const getList = vi
      .spyOn(pb.collection('bookings'), 'getList')
      .mockResolvedValueOnce(list(page1))
      .mockResolvedValueOnce(list([booking({ created: '2026-10-19 10:00:00.000Z' })]));
    const { result } = renderHook(() => useBookingList({ period: 'all', personId: 'p1' }), { wrapper });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    expect(getList.mock.calls[0]).toEqual([
      1,
      BOOKINGS_PAGE_SIZE,
      expect.objectContaining({ filter: "person = 'p1'", sort: '-created,-id' }),
    ]);

    await act(() => result.current.fetchNextPage());
    const last = page1.at(-1)!;
    expect(getList.mock.calls[1]![0]).toBe(1); // always the first page of the rest
    expect(getList.mock.calls[1]![2]).toMatchObject({
      filter: `(person = 'p1') && created <= '${last.created}' && (created < '${last.created}' || (created = '${last.created}' && id < '${last.id}'))`,
    });
    await waitFor(() => expect(result.current.data!.pages).toHaveLength(2));
    expect(result.current.hasNextPage).toBe(false);
  });

  it('does not request a list whose summary (same filter) is known to be 0', async () => {
    const getList = vi.spyOn(pb.collection('bookings'), 'getList');
    const query = { period: 'today' as const, from: null, to: null, personId: null, createdBy: 'u1' };
    qc.setQueryData(queryKeys.totalsFor(query, ['summary']), ZERO);
    const { result } = renderHook(() => useBookingList(query), { wrapper });
    expect(result.current.isPending).toBe(false);
    expect(result.current.data!.pages.flatMap((page) => page.items)).toEqual([]);
    expect(result.current.hasNextPage).toBe(false);
    await act(async () => {});
    expect(getList).not.toHaveBeenCalled();
  });
});

describe('known-empty lists: never "no bookings" while the summary is about to be refetched (L3)', () => {
  /** The Buchungen list view: what the list shows in every render. */
  function ListView({ query, log }: { query: BookingQuery; log: string[] }) {
    useTotals(query, true, { keepPrevious: true, parts: ['summary'] });
    const bookings = useBookingList(query);
    const rows = bookings.data?.pages.flatMap((page) => page.items) ?? [];
    log.push(bookings.isPending ? 'spinner' : rows.length === 0 ? 'Keine Buchungen' : `${rows.length} row(s)`);
    return null;
  }

  /** The Buchen card of p1 with its recent bookings. */
  function BuchenCard({ log }: { log: string[] }) {
    useTotals(personTotalsQuery('p1'), true, { parts: ['summary'] });
    const recent = useRecentBookings('p1', 8);
    log.push(recent.isPending ? '…' : recent.data!.length === 0 ? 'Noch keine Buchungen' : `${recent.data!.length} row(s)`);
    return null;
  }

  /** A booking of p1 arrives while the screen is hidden: its cached summary is only marked invalidated. */
  async function bookedWhileHidden() {
    const deps = { fetchTotals: vi.fn(), fetchBookings: vi.fn(), now: () => new Date('2026-10-20T18:00:00Z') };
    await applyBookingChanges(qc, [{ action: 'create', record: booking({ id: 'hidden' }) }], { deps });
  }

  it('Buchungen list: shows the spinner, then the rows (not "Keine Buchungen" first)', async () => {
    const query: BookingQuery = { period: 'all', from: null, to: null, personId: 'p1', createdBy: null };
    const summaryKey = queryKeys.totalsFor(query, ['summary']);
    qc.setQueryData(summaryKey, ZERO);
    await bookedWhileHidden();
    expect(qc.getQueryState(summaryKey)!.isInvalidated).toBe(true);
    vi.spyOn(pb, 'send').mockResolvedValue({ count: 1, quantity: 1, totalCents: 250 });
    const getList = vi.spyOn(pb.collection('bookings'), 'getList').mockResolvedValue(list([booking()]));
    const log: string[] = [];
    render(
      <QueryClientProvider client={qc}>
        <ListView query={query} log={log} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(log.at(-1)).toBe('1 row(s)'));
    expect(log).not.toContain('Keine Buchungen');
    expect(getList).toHaveBeenCalledOnce();
  });

  it('Buchen: shows nothing, then the rows (not "Noch keine Buchungen" first)', async () => {
    qc.setQueryData(queryKeys.totalsFor(personTotalsQuery('p1'), ['summary']), ZERO);
    await bookedWhileHidden();
    vi.spyOn(pb, 'send').mockResolvedValue({ count: 1, quantity: 1, totalCents: 250 });
    vi.spyOn(pb.collection('bookings'), 'getList').mockResolvedValue(list([booking()]));
    const log: string[] = [];
    render(
      <QueryClientProvider client={qc}>
        <BuchenCard log={log} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(log.at(-1)).toBe('1 row(s)'));
    expect(log).not.toContain('Noch keine Buchungen');
  });

  it('Buchen: an empty list cached by an earlier visit is not shown while it is refetched (FLOW-8)', async () => {
    qc.setQueryData(queryKeys.totalsFor(personTotalsQuery('p1'), ['summary']), ZERO);
    qc.setQueryData(queryKeys.recentBookings('p1', 8), []); // the first visit: loaded in parallel, empty
    await bookedWhileHidden(); // both are marked invalidated
    vi.spyOn(pb, 'send').mockResolvedValue({ count: 1, quantity: 1, totalCents: 250 });
    vi.spyOn(pb.collection('bookings'), 'getList').mockResolvedValue(list([booking()]));
    const log: string[] = [];
    render(
      <QueryClientProvider client={qc}>
        <BuchenCard log={log} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(log.at(-1)).toBe('1 row(s)'));
    expect(log).not.toContain('Noch keine Buchungen');
  });

  it('Buchungen list: empty pages cached by an earlier visit are not shown while they are refetched (FLOW-8)', async () => {
    const query: BookingQuery = { period: 'all', from: null, to: null, personId: 'p1', createdBy: null };
    qc.setQueryData(queryKeys.totalsFor(query, ['summary']), ZERO);
    const empty: BookingListData = { pages: [{ items: [], next: null, base: "person = 'p1'" }], pageParams: [null] };
    qc.setQueryData(queryKeys.bookingList(query), empty);
    await bookedWhileHidden();
    vi.spyOn(pb, 'send').mockResolvedValue({ count: 1, quantity: 1, totalCents: 250 });
    vi.spyOn(pb.collection('bookings'), 'getList').mockResolvedValue(list([booking()]));
    const log: string[] = [];
    render(
      <QueryClientProvider client={qc}>
        <ListView query={query} log={log} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(log.at(-1)).toBe('1 row(s)'));
    expect(log).not.toContain('Keine Buchungen');
  });

  it('rows of an earlier visit stay visible while they are refetched (stale-while-revalidate)', async () => {
    qc.setQueryData(queryKeys.recentBookings('p1', 8), [booking({ id: 'old' })]);
    await bookedWhileHidden();
    vi.spyOn(pb, 'send').mockResolvedValue({ count: 2, quantity: 2, totalCents: 500 });
    vi.spyOn(pb.collection('bookings'), 'getList').mockResolvedValue(list([booking(), booking({ id: 'old' })]));
    const log: string[] = [];
    render(
      <QueryClientProvider client={qc}>
        <BuchenCard log={log} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(log.at(-1)).toBe('2 row(s)'));
    expect(log[0]).toBe('1 row(s)');
  });

  it('does not trust a 0 older than the stale time either (it is refetched on mount)', async () => {
    const summaryKey = queryKeys.totalsFor(personTotalsQuery('p1'), ['summary']);
    qc.setQueryData(summaryKey, ZERO, { updatedAt: Date.now() - 60_000 });
    const send = vi.spyOn(pb, 'send').mockResolvedValue(ZERO);
    const getList = vi.spyOn(pb.collection('bookings'), 'getList').mockResolvedValue(list([]));
    const log: string[] = [];
    render(
      <QueryClientProvider client={qc}>
        <BuchenCard log={log} />
      </QueryClientProvider>,
    );
    expect(log[0]).toBe('…');
    await waitFor(() => expect(log.at(-1)).toBe('Noch keine Buchungen'));
    expect(send).toHaveBeenCalledOnce(); // the summary: one refetch for both observers
    expect(getList).toHaveBeenCalledOnce();
  });
});

describe('while realtime is connected, nothing goes stale by time (FLOW-12)', () => {
  it('lists and totals are not re-downloaded when a screen mounts again later; without a connection after 30 s', async () => {
    const connected = vi.spyOn(pb.realtime, 'isConnected', 'get').mockReturnValue(true);
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: realtimeStaleTime } } });
    const send = vi.spyOn(pb, 'send').mockResolvedValue({ count: 0, quantity: 0, totalCents: 0, perPerson: [] });
    const getList = vi.spyOn(pb.collection('bookings'), 'getList').mockResolvedValue(list([booking()]));
    vi.useFakeTimers({ toFake: ['Date'] });
    const useScreen = () => ({
      totals: useTotals({ period: 'all' }, true, { parts: ['summary', 'perPerson'] }),
      list: useBookingList({ period: 'all' }),
    });
    const first = renderHook(useScreen, { wrapper });
    await waitFor(() => expect(first.result.current.list.isSuccess && first.result.current.totals.isSuccess).toBe(true));
    first.unmount();
    const requests = () => send.mock.calls.length + getList.mock.calls.length;
    const loaded = requests();

    vi.setSystemTime(Date.now() + 60 * 60_000); // Personen → Buchen → … an hour later
    const second = renderHook(useScreen, { wrapper });
    await act(async () => {});
    expect(requests()).toBe(loaded);
    second.unmount();

    connected.mockReturnValue(false); // no events would arrive: stale after 30 s
    const third = renderHook(useScreen, { wrapper });
    await waitFor(() => expect(requests()).toBeGreaterThan(loaded));
    third.unmount();
  });
});

describe('useTotals', () => {
  it('requests the given parts and keeps the previous summary while another view loads', async () => {
    const send = vi
      .spyOn(pb, 'send')
      .mockResolvedValueOnce({ count: 2, quantity: 2, totalCents: 500 })
      .mockImplementationOnce(() => new Promise(() => {})); // "Pro Person" still loading
    const query = { period: 'all' as const };
    const { result, rerender } = renderHook(
      ({ parts }: { parts: Array<'summary' | 'perPerson'> }) => useTotals(query, true, { keepPrevious: true, parts }),
      { wrapper, initialProps: { parts: ['summary'] } },
    );
    await waitFor(() => expect(result.current.data?.count).toBe(2));
    expect((send.mock.calls[0]![1] as { query: Record<string, string> }).query).toEqual({ parts: 'summary' });

    rerender({ parts: ['summary', 'perPerson'] });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect((send.mock.calls[1]![1] as { query: Record<string, string> }).query).toEqual({ parts: 'summary,perPerson' });
    // placeholder: the summary stays, the per-person part is still missing (= loading)
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data).toEqual({ count: 2, quantity: 2, totalCents: 500 });
  });
});
