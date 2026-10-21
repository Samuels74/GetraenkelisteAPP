import { InfiniteQueryObserver, QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query';
import { waitFor } from '@testing-library/react';
import type { ListResult } from 'pocketbase';
import { buildBookingsFilter, toPbDate } from '../lib/dates';
import { pb } from '../lib/pb';
import type { BookingRecord, PersonRecord, Totals, TotalsPerPerson, TotalsPerUser, UserRecord } from '../lib/types';
import {
  applyBookingChanges,
  applyPersonUpdates,
  applyUserUpdates,
  isBookingChangeHandled,
  MAX_PATCH_ATTEMPTS,
  MAX_ROW_PATCHES,
  mergeIntoPages,
  removeFromPages,
  replacePersonRow,
  type BookingChange,
  type SyncDeps,
} from './bookingSync';
import { compareNewestFirst, keysetFilter, keysetNewerFilter, type KeysetCursor } from './keyset';
import {
  BOOKINGS_PAGE_SIZE,
  bookingListOptions,
  periodRangeKey,
  personTotalsQuery,
  queryKeys,
  resolveBookingQuery,
  type BookingListData,
  type BookingPage,
  type BookingPageParam,
  type BookingQuery,
} from './queries';

/** 20:00 in Vienna (the tests run with TZ=Europe/Vienna). */
const NOW = new Date('2026-10-20T18:00:00.000Z');
const YESTERDAY = new Date('2026-10-19T18:00:00.000Z');

function booking(id: string, second: number, overrides: Partial<BookingRecord> = {}): BookingRecord {
  return {
    id,
    collectionId: 'c_bookings',
    collectionName: 'bookings',
    created: `2026-10-20 17:00:${String(second).padStart(2, '0')}.000Z`,
    updated: `2026-10-20 17:00:${String(second).padStart(2, '0')}.000Z`,
    person: 'p1',
    offering: 'o1',
    quantity: 1,
    unitPriceCents: 250,
    createdBy: 'u1',
    ...overrides,
  };
}

const cursorOf = (b: BookingRecord): KeysetCursor => ({ created: b.created, id: b.id });
/** The filter a list page of `query` is loaded with at `now`. */
const baseOf = (query: BookingQuery, now: Date) => buildBookingsFilter(resolveBookingQuery(query, now));
const created = (record: BookingRecord, expanded = false): BookingChange => ({ action: 'create', record, expanded });
const deleted = (record: BookingRecord): BookingChange => ({ action: 'delete', record });

function personRow(personId: string, number: string, count: number): TotalsPerPerson {
  return { personId, number, name: `Name ${number}`, nickname: '', count, quantity: count, totalCents: count * 250 };
}

function fakeDeps() {
  return {
    fetchTotals: vi.fn<SyncDeps['fetchTotals']>(async () => ({})),
    fetchBookings: vi.fn<SyncDeps['fetchBookings']>(async () => []),
    now: () => NOW,
  };
}

let qc: QueryClient;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  qc.clear();
});

/** A mounted screen's query with data; `queryFn` counts (re)fetches. */
function mount<T>(queryKey: QueryKey, data: T, { updatedAt = NOW.getTime(), active = true } = {}) {
  const queryFn = vi.fn(async () => data);
  qc.setQueryData(queryKey, data, { updatedAt });
  if (active) {
    const observer = new QueryObserver(qc, { queryKey, queryFn });
    cleanups.push(observer.subscribe(() => {}));
  }
  return { queryFn, data: () => qc.getQueryData<T>(queryKey), state: () => qc.getQueryState(queryKey)! };
}

/** A mounted Buchungen list (keyset pages); `queryFn` counts page requests of (re)fetches. */
function mountList(query: BookingQuery, pages: BookingPage[], { updatedAt = NOW.getTime() } = {}) {
  const options = bookingListOptions(query);
  const queryFn = vi.fn(async ({ pageParam }: { pageParam: BookingPageParam | null }): Promise<BookingPage> => {
    void pageParam;
    return { items: [], next: null, base: '' };
  });
  const data: BookingListData = {
    pages,
    pageParams: pages.map((_, i) => (i === 0 ? null : { cursor: pages[i - 1]!.next!, base: pages[i - 1]!.base })),
  };
  qc.setQueryData(options.queryKey, data, { updatedAt });
  const observer = new InfiniteQueryObserver(qc, { ...options, queryFn });
  cleanups.push(observer.subscribe(() => {}));
  return {
    queryFn,
    observer,
    data: () => qc.getQueryData<BookingListData>(options.queryKey)!,
    ids: () => qc.getQueryData<BookingListData>(options.queryKey)!.pages.map((page) => page.items.map((b) => b.id)),
  };
}

// ---------------------------------------------------------------------------

describe('totals of one person (Buchen card, person detail)', () => {
  const key = queryKeys.totalsFor(personTotalsQuery('p1'), ['summary']);

  it('ignores bookings of other persons – no request at all', async () => {
    const totals = mount(key, { count: 2, quantity: 2, totalCents: 500 });
    const recent = mount(queryKeys.recentBookings('p1', 8), [booking('a', 1)]);
    const deps = fakeDeps();
    await applyBookingChanges(qc, [created(booking('x', 9, { person: 'p2' }))], { deps });
    expect(totals.queryFn).not.toHaveBeenCalled();
    expect(recent.queryFn).not.toHaveBeenCalled();
    expect(deps.fetchTotals).not.toHaveBeenCalled();
    expect(deps.fetchBookings).not.toHaveBeenCalled();
  });

  it('refetches the small totals on a booking of the person', async () => {
    const totals = mount(key, { count: 2, quantity: 2, totalCents: 500 });
    await applyBookingChanges(qc, [created(booking('x', 9))], { deps: fakeDeps() });
    expect(totals.queryFn).toHaveBeenCalledOnce();
  });
});

describe('small totals (summary, per offering, per user)', () => {
  it('are refetched when the booking matches their filter', async () => {
    const summary = mount(queryKeys.totalsFor({ period: 'all' }, ['summary']), { count: 1, quantity: 1, totalCents: 1 });
    const offerings = mount(queryKeys.totalsFor({ period: 'all' }, ['perOffering']), { perOffering: [] });
    const users = mount(queryKeys.totalsFor({ period: 'all' }, ['perUser']), { perUser: [] });
    const deps = fakeDeps();
    await applyBookingChanges(qc, [deleted(booking('x', 9))], { deps });
    for (const query of [summary, offerings, users]) expect(query.queryFn).toHaveBeenCalledOnce();
    expect(deps.fetchTotals).not.toHaveBeenCalled();
  });

  it('are left alone when the booking is outside their filter', async () => {
    const mine = mount(queryKeys.totalsFor({ period: 'all', createdBy: 'u2' }, ['summary']), { count: 0, quantity: 0, totalCents: 0 });
    const today = mount(queryKeys.totalsFor({ period: 'today' }, ['summary']), {
      count: 0,
      quantity: 0,
      totalCents: 0,
      range: periodRangeKey({ period: 'today' }, NOW),
    });
    // by u1, yesterday
    await applyBookingChanges(qc, [created(booking('x', 9, { created: '2026-10-19 17:00:00.000Z' }))], { deps: fakeDeps() });
    expect(mine.queryFn).not.toHaveBeenCalled();
    expect(today.queryFn).not.toHaveBeenCalled();
  });
});

describe('totals with per-person rows (Personen, "Pro Person")', () => {
  const key = queryKeys.totalsFor({ period: 'all' }, ['perPerson']);

  it('fetches and patches only the row of the booked person', async () => {
    const rows = [personRow('pA', '1', 2), personRow('pC', '3', 1)];
    const totals = mount<Totals>(key, { perPerson: rows });
    const deps = fakeDeps();
    deps.fetchTotals.mockResolvedValue({ perPerson: [personRow('pA', '1', 3)] });

    await applyBookingChanges(qc, [created(booking('x', 9, { person: 'pA' }))], { deps });

    expect(deps.fetchTotals).toHaveBeenCalledExactlyOnceWith({ period: 'all', personId: 'pA' }, ['perPerson'], NOW);
    expect(totals.queryFn).not.toHaveBeenCalled();
    expect(totals.data()!.perPerson).toEqual([personRow('pA', '1', 3), rows[1]]);
    expect(totals.data()!.perPerson![1]).toBe(rows[1]); // unchanged rows keep their identity
    expect(totals.state().isInvalidated).toBe(false);
  });

  it('inserts the first row of a person and removes a row that drops to 0', async () => {
    const totals = mount<Totals>(key, { perPerson: [personRow('pA', '1', 2), personRow('pC', '3', 1)] });
    const deps = fakeDeps();
    deps.fetchTotals.mockImplementation(async (query) =>
      query.personId === 'pB' ? { perPerson: [personRow('pB', '2', 1)] } : { perPerson: [] },
    );
    await applyBookingChanges(
      qc,
      [created(booking('x', 9, { person: 'pB' })), deleted(booking('y', 8, { person: 'pC' }))],
      { deps },
    );
    expect(deps.fetchTotals).toHaveBeenCalledTimes(2);
    expect(totals.data()!.perPerson!.map((row) => row.personId)).toEqual(['pA', 'pB']);
  });

  it('keeps the filters of the query and refetches its other parts without the rows', async () => {
    const query: BookingQuery = { period: '7d', from: null, to: null, personId: null, createdBy: 'u1' };
    const proPerson = queryKeys.totalsFor(query, ['summary', 'perPerson']);
    const range = periodRangeKey(query, NOW);
    const totals = mount(proPerson, { count: 2, quantity: 2, totalCents: 500, perPerson: [personRow('pA', '1', 2)], range });
    const deps = fakeDeps();
    deps.fetchTotals.mockImplementation(async (_query, parts) =>
      parts.includes('perPerson') ? { perPerson: [personRow('pA', '1', 3)] } : { count: 3, quantity: 3, totalCents: 750 },
    );
    await applyBookingChanges(qc, [created(booking('x', 9, { person: 'pA' }))], { deps });
    expect(deps.fetchTotals).toHaveBeenCalledWith({ ...query, personId: 'pA' }, ['perPerson'], NOW);
    expect(deps.fetchTotals).toHaveBeenCalledWith(query, ['summary'], NOW);
    expect(totals.data()).toEqual({ count: 3, quantity: 3, totalCents: 750, perPerson: [personRow('pA', '1', 3)], range });
    expect(totals.queryFn).not.toHaveBeenCalled();
  });

  it('ignores bookings outside the filter (another user with "nur meine")', async () => {
    const totals = mount(queryKeys.totalsFor({ period: 'all', createdBy: 'u2' }, ['perPerson']), { perPerson: [] });
    const deps = fakeDeps();
    await applyBookingChanges(qc, [created(booking('x', 9, { createdBy: 'u1' }))], { deps });
    expect(deps.fetchTotals).not.toHaveBeenCalled();
    expect(totals.queryFn).not.toHaveBeenCalled();
  });

  describe('refetches the whole query instead when', () => {
    it('a request of the patch fails', async () => {
      const totals = mount(key, { perPerson: [] });
      const deps = fakeDeps();
      deps.fetchTotals.mockRejectedValue(new Error('offline'));
      await applyBookingChanges(qc, [created(booking('x', 9))], { deps });
      expect(totals.queryFn).toHaveBeenCalledOnce();
    });

    it(`more than ${MAX_ROW_PATCHES} persons booked at once`, async () => {
      const totals = mount(key, { perPerson: [] });
      const deps = fakeDeps();
      const changes = Array.from({ length: MAX_ROW_PATCHES + 1 }, (_, i) => created(booking(`x${i}`, 9, { person: `p${i}` })));
      await applyBookingChanges(qc, changes, { deps });
      expect(deps.fetchTotals).not.toHaveBeenCalled();
      expect(totals.queryFn).toHaveBeenCalledOnce();
    });

    it('the query was invalidated before (e.g. a failed refetch)', async () => {
      const totals = mount(key, { perPerson: [] });
      await qc.invalidateQueries({ queryKey: key, refetchType: 'none' });
      const deps = fakeDeps();
      await applyBookingChanges(qc, [created(booking('x', 9))], { deps });
      expect(deps.fetchTotals).not.toHaveBeenCalled();
      expect(totals.queryFn).toHaveBeenCalledOnce();
    });

    it('"today" has become another day since the totals were computed (midnight)', async () => {
      const todayKey = queryKeys.totalsFor({ period: 'today' }, ['perPerson']);
      // computed for yesterday, written today (a request that straddled midnight): the period counts, not the time
      const totals = mount(todayKey, { perPerson: [], range: periodRangeKey({ period: 'today' }, YESTERDAY) });
      const deps = fakeDeps();
      // even a booking of yesterday: the query must move on to the new day
      await applyBookingChanges(qc, [created(booking('x', 9, { created: '2026-10-19 17:00:00.000Z' }))], { deps });
      expect(deps.fetchTotals).not.toHaveBeenCalled();
      expect(totals.queryFn).toHaveBeenCalledOnce();
    });
  });

  it('only marks a hidden (inactive) query stale', async () => {
    const totals = mount(key, { perPerson: [] }, { active: false });
    const deps = fakeDeps();
    await applyBookingChanges(qc, [created(booking('x', 9))], { deps });
    expect(deps.fetchTotals).not.toHaveBeenCalled();
    expect(totals.state().isInvalidated).toBe(true);
  });

  describe('a fetch or a patch under way (FLOW-2: no refetch per batch)', () => {
    /** The query, mounted with a fetch that waits for `release`. */
    function mountSlow(data: Totals) {
      const totals = mount(key, data);
      const releases: Array<() => void> = [];
      const slow = vi.fn(
        () =>
          new Promise<Totals>((resolve) => {
            releases.push(() => resolve(data));
          }),
      );
      const observer = new QueryObserver(qc, { queryKey: key, queryFn: slow });
      cleanups.push(observer.subscribe(() => {}));
      return { totals, slow, observer, release: () => releases.shift()?.() };
    }

    it('the query is fetching: the rows are patched once the fetch settled – no second full fetch', async () => {
      const { totals, slow, observer, release } = mountSlow({ perPerson: [personRow('pA', '1', 2)] });
      const running = observer.refetch();
      const deps = fakeDeps();
      deps.fetchTotals.mockResolvedValue({ perPerson: [personRow('p1', '9', 1)] });
      const applied = applyBookingChanges(qc, [created(booking('x', 9))], { deps });
      await Promise.resolve();
      expect(deps.fetchTotals).not.toHaveBeenCalled(); // waits for the fetch
      release();
      await running;
      await applied;
      expect(deps.fetchTotals).toHaveBeenCalledOnce();
      expect(slow).toHaveBeenCalledOnce();
      expect(totals.queryFn).not.toHaveBeenCalled();
      expect(totals.data()!.perPerson).toEqual([personRow('pA', '1', 2), personRow('p1', '9', 1)]);
    });

    it('any number of batches during a fetch: one round of row requests after it', async () => {
      const { totals, slow, observer, release } = mountSlow({ perPerson: [] });
      const running = observer.refetch();
      const deps = fakeDeps();
      deps.fetchTotals.mockImplementation(async (query) => ({ perPerson: [personRow(query.personId!, query.personId!, 1)] }));
      const applied = ['pA', 'pB', 'pC', 'pA', 'pD', 'pE'].map((person, i) =>
        applyBookingChanges(qc, [created(booking(`x${i}`, 9, { person }))], { deps }),
      );
      release();
      await running;
      await Promise.all(applied);
      // one request per booked person, none twice; the running fetch was the only full one
      expect(deps.fetchTotals.mock.calls.map(([query]) => query.personId)).toEqual(['pA', 'pB', 'pC', 'pD', 'pE']);
      expect(slow).toHaveBeenCalledOnce();
      expect(totals.queryFn).not.toHaveBeenCalled();
      expect(totals.data()!.perPerson!.map((row) => row.personId)).toEqual(['pA', 'pB', 'pC', 'pD', 'pE']);
    });

    it('patches one batch after the other; batches arriving meanwhile are applied together', async () => {
      const totals = mount(key, { perPerson: [personRow('pA', '1', 1)] });
      const deps = fakeDeps();
      let release = () => {};
      deps.fetchTotals
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = () => resolve({ perPerson: [personRow('pA', '1', 2)] });
            }),
        )
        .mockImplementation(async (query) => ({ perPerson: [personRow(query.personId!, '2', 1)] }));
      const first = applyBookingChanges(qc, [created(booking('x', 9, { person: 'pA' }))], { deps });
      await waitFor(() => expect(deps.fetchTotals).toHaveBeenCalledOnce()); // the first patch is under way
      const second = applyBookingChanges(qc, [created(booking('y', 10, { person: 'pB' }))], { deps });
      const third = applyBookingChanges(qc, [created(booking('z', 11, { person: 'pB' }))], { deps });
      await Promise.resolve();
      expect(deps.fetchTotals).toHaveBeenCalledOnce(); // they wait for the first
      release();
      await Promise.all([first, second, third]);
      expect(deps.fetchTotals).toHaveBeenCalledTimes(2); // pB once for both batches
      expect(totals.data()!.perPerson).toEqual([personRow('pA', '1', 2), personRow('pB', '2', 1)]);
      expect(totals.queryFn).not.toHaveBeenCalled();
    });

    it('the data changed while the rows were loading: the patch starts again on the new data', async () => {
      const totals = mount(key, { perPerson: [personRow('pA', '1', 2)] });
      const deps = fakeDeps();
      deps.fetchTotals
        .mockImplementationOnce(async () => {
          qc.setQueryData<Totals>(key, { perPerson: [personRow('pB', '2', 4)] }); // e.g. a refetch landed meanwhile
          return { perPerson: [personRow('p1', '9', 1)] };
        })
        .mockResolvedValueOnce({ perPerson: [personRow('p1', '9', 2)] });
      await applyBookingChanges(qc, [created(booking('x', 9))], { deps });
      expect(deps.fetchTotals).toHaveBeenCalledTimes(2);
      expect(totals.queryFn).not.toHaveBeenCalled();
      // patched into the new data, not into the data the first request started from
      expect(totals.data()!.perPerson).toEqual([personRow('pB', '2', 4), personRow('p1', '9', 2)]);
    });

    it(`refetches when the data changed during ${MAX_PATCH_ATTEMPTS} attempts in a row`, async () => {
      const totals = mount(key, { perPerson: [] });
      const deps = fakeDeps();
      let version = 0;
      deps.fetchTotals.mockImplementation(async () => {
        version += 1;
        qc.setQueryData<Totals>(key, { perPerson: [personRow('pB', String(version), 1)] });
        return { perPerson: [] };
      });
      await applyBookingChanges(qc, [created(booking('x', 9))], { deps });
      expect(deps.fetchTotals).toHaveBeenCalledTimes(MAX_PATCH_ATTEMPTS);
      expect(totals.queryFn).toHaveBeenCalledOnce();
    });
  });
});

describe('replacePersonRow', () => {
  it('keeps the server order: number case-insensitively, then person id', () => {
    const rows = [personRow('p1', 'a', 1), personRow('p3', 'C', 1)];
    expect(replacePersonRow(rows, 'p2', personRow('p2', 'B', 1)).map((r) => r.number)).toEqual(['a', 'B', 'C']);
    expect(replacePersonRow(rows, 'p0', personRow('p0', '0', 1)).map((r) => r.number)).toEqual(['0', 'a', 'C']);
    expect(replacePersonRow(rows, 'p9', personRow('p9', 'z', 1)).map((r) => r.number)).toEqual(['a', 'C', 'z']);
    expect(replacePersonRow(rows, 'p3', undefined)).toEqual([rows[0]]);
    expect(replacePersonRow(rows, 'p1', { ...rows[0]!, count: 0 })).toEqual([rows[1]]);
    expect(replacePersonRow(rows, 'p4', undefined)).toEqual(rows);
  });
});

// ---------------------------------------------------------------------------

describe('Buchungen list', () => {
  // newest first: n5 … n2; two pages, more on the server (page 2 has a cursor)
  const n5 = booking('n5', 5);
  const n4 = booking('n4', 4);
  const n3 = booking('n3', 3);
  const n2 = booking('n2', 2);
  const twoPages = (base = ''): BookingPage[] => [
    { items: [n5, n4], next: cursorOf(n4), base },
    { items: [n3, n2], next: cursorOf(n2), base },
  ];

  it('loads only the bookings newer than the newest cached one and prepends them', async () => {
    const list = mountList({ period: 'all' }, twoPages());
    const x = booking('x', 9);
    const deps = fakeDeps();
    deps.fetchBookings.mockResolvedValue([x]);
    await applyBookingChanges(qc, [created(x)], { deps });
    expect(deps.fetchBookings).toHaveBeenCalledExactlyOnceWith(keysetNewerFilter('', cursorOf(n5)), BOOKINGS_PAGE_SIZE);
    expect(list.ids()).toEqual([['x', 'n5', 'n4'], ['n3', 'n2']]);
    expect(list.data().pages[1]!.next).toEqual(cursorOf(n2));
    expect(list.queryFn).not.toHaveBeenCalled();
  });

  it('uses the list filter for the head fetch', async () => {
    const query: BookingQuery = { period: 'all', personId: 'p1', createdBy: 'u1' };
    mountList(query, twoPages());
    const deps = fakeDeps();
    const x = booking('x', 9);
    deps.fetchBookings.mockResolvedValue([x]);
    await applyBookingChanges(qc, [created(x)], { deps });
    expect(deps.fetchBookings.mock.calls[0]![0]).toBe(
      keysetNewerFilter("person = 'p1' && createdBy = 'u1'", cursorOf(n5)),
    );
  });

  it('removes a cancelled booking from the cached pages without a request (cursors stay)', async () => {
    const list = mountList({ period: 'all' }, twoPages());
    const deps = fakeDeps();
    await applyBookingChanges(qc, [deleted(n2)], { deps });
    expect(list.ids()).toEqual([['n5', 'n4'], ['n3']]);
    expect(list.data().pages[1]!.next).toEqual(cursorOf(n2)); // "Weitere laden" goes on after n2
    expect(deps.fetchBookings).not.toHaveBeenCalled();
    expect(list.queryFn).not.toHaveBeenCalled();
  });

  it('"Weitere laden" after patches continues after the last loaded page', async () => {
    const list = mountList({ period: 'all' }, twoPages());
    await applyBookingChanges(qc, [deleted(n2), created(booking('own', 9), true)], { deps: fakeDeps() });
    await list.observer.fetchNextPage();
    expect(list.queryFn).toHaveBeenCalledOnce();
    expect(list.queryFn.mock.calls[0]![0].pageParam).toEqual({ cursor: cursorOf(n2), base: '' });
  });

  it('merges an own booking (full record) directly', async () => {
    const list = mountList({ period: 'all' }, twoPages());
    const deps = fakeDeps();
    await applyBookingChanges(qc, [created(booking('own', 9), true)], { deps });
    expect(list.ids()[0]).toEqual(['own', 'n5', 'n4']);
    expect(deps.fetchBookings).not.toHaveBeenCalled();
  });

  it('loads from a new booking on that is older than the newest cached one (committed out of order)', async () => {
    const list = mountList({ period: 'all' }, twoPages());
    // between n5 and n4
    const late = booking('late', 4, { created: '2026-10-20 17:00:04.500Z' });
    const deps = fakeDeps();
    deps.fetchBookings.mockResolvedValue([n5, late]);
    await applyBookingChanges(qc, [created(late)], { deps });
    expect(deps.fetchBookings.mock.calls[0]![0]).toBe(keysetNewerFilter('', cursorOf(late), true));
    expect(list.ids()[0]).toEqual(['n5', 'late', 'n4']);
    expect(list.queryFn).not.toHaveBeenCalled();
  });

  it('does not show bookings older than the loaded pages (they come with "Weitere laden")', async () => {
    const list = mountList({ period: 'all' }, twoPages());
    await applyBookingChanges(qc, [created(booking('old', 1), true)], { deps: fakeDeps() });
    expect(list.ids()).toEqual([['n5', 'n4'], ['n3', 'n2']]);
    expect(list.queryFn).not.toHaveBeenCalled();
  });

  it('ignores bookings outside the filter', async () => {
    const list = mountList({ period: 'all', personId: 'p2' }, twoPages());
    const deps = fakeDeps();
    await applyBookingChanges(qc, [created(booking('x', 9, { person: 'p1' }))], { deps });
    expect(deps.fetchBookings).not.toHaveBeenCalled();
    expect(list.queryFn).not.toHaveBeenCalled();
  });

  it('a create and the cancellation of the same booking in one batch: no request', async () => {
    const list = mountList({ period: 'all' }, twoPages());
    const x = booking('x', 9);
    const deps = fakeDeps();
    await applyBookingChanges(qc, [created(x), deleted(x)], { deps });
    expect(deps.fetchBookings).not.toHaveBeenCalled();
    expect(list.ids()[0]).toEqual(['n5', 'n4']);
  });

  it('reloads when cancellations removed every loaded booking but older ones exist', async () => {
    const list = mountList({ period: 'all' }, [{ items: [n5, n4], next: cursorOf(n4), base: '' }]);
    list.queryFn.mockResolvedValue({ items: [n3, n2], next: cursorOf(n2), base: '' });
    await applyBookingChanges(qc, [deleted(n5), deleted(n4)], { deps: fakeDeps() });
    await waitFor(() => expect(list.ids()).toEqual([['n3', 'n2']]));
    expect(list.queryFn).toHaveBeenCalledOnce();
  });

  it('stays empty without a request when the cancelled bookings were all there were', async () => {
    const list = mountList({ period: 'all' }, [{ items: [n5, n4], next: null, base: '' }]);
    await applyBookingChanges(qc, [deleted(n5), deleted(n4)], { deps: fakeDeps() });
    expect(list.ids()).toEqual([[]]);
    expect(list.queryFn).not.toHaveBeenCalled();
  });

  describe('refetches all loaded pages instead when', () => {
    it('the head fetch returns a full page (there may be more)', async () => {
      const list = mountList({ period: 'all' }, twoPages());
      const deps = fakeDeps();
      deps.fetchBookings.mockResolvedValue(Array.from({ length: BOOKINGS_PAGE_SIZE }, (_, i) => booking(`h${i}`, 10)));
      await applyBookingChanges(qc, [created(booking('h0', 10))], { deps });
      expect(list.queryFn).toHaveBeenCalled();
    });

    it('the head fetch misses a new booking', async () => {
      const list = mountList({ period: 'all' }, twoPages());
      const deps = fakeDeps();
      deps.fetchBookings.mockResolvedValue([]);
      await applyBookingChanges(qc, [created(booking('x', 9))], { deps });
      expect(list.queryFn).toHaveBeenCalled();
    });

    it('the head fetch fails', async () => {
      const list = mountList({ period: 'all' }, twoPages());
      const deps = fakeDeps();
      deps.fetchBookings.mockRejectedValue(new Error('offline'));
      await applyBookingChanges(qc, [created(booking('x', 9))], { deps });
      expect(list.queryFn).toHaveBeenCalled();
    });

    it('"Heute" has become another day since the pages were loaded', async () => {
      // loaded for yesterday, written today (e.g. "Weitere laden" after midnight): the period counts, not the time
      const list = mountList({ period: 'today' }, twoPages(baseOf({ period: 'today' }, YESTERDAY)));
      const deps = fakeDeps();
      await applyBookingChanges(qc, [deleted(n3)], { deps });
      expect(list.queryFn).toHaveBeenCalled();
    });

  });

  describe('a fetch or a patch under way (FLOW-2: no refetch per batch)', () => {
    /**
     * A server with keyset pages of two (newest first) behind the list's
     * queryFn and the head fetch. A request reads the server when it starts and
     * answers after `delay` ms (real timers) – or once `gate` resolves.
     */
    function serve(
      list: ReturnType<typeof mountList>,
      server: BookingRecord[],
      deps: ReturnType<typeof fakeDeps>,
      { delay = 0, gate }: { delay?: number; gate?: Promise<void> } = {},
    ) {
      const counts = { pages: 0, heads: 0 };
      const wait = () => gate ?? new Promise((resolve) => setTimeout(resolve, delay));
      list.queryFn.mockImplementation(async ({ pageParam }) => {
        counts.pages += 1;
        const start = pageParam ? server.findIndex((b) => compareNewestFirst(b, pageParam.cursor) > 0) : 0;
        const items = start < 0 ? [] : server.slice(start, start + 2);
        await wait();
        return { items, next: items.length === 2 ? cursorOf(items[1]!) : null, base: '' };
      });
      deps.fetchBookings.mockImplementation(async (filter) => {
        counts.heads += 1;
        const [, created, op, id] = /created >= '([^']+)'.*id (>=?) '([^']+)'/.exec(filter)!;
        const cursor = { created: created!, id: id! };
        const items = server.filter((b) => {
          const order = compareNewestFirst(b, cursor);
          return order < 0 || (order === 0 && op === '>=');
        });
        await wait();
        return items;
      });
      return counts;
    }

    it('"Weitere laden" landed while the head request was under way: the head request is made again on the new pages', async () => {
      const list = mountList({ period: 'all' }, twoPages());
      const n1 = booking('n1', 1);
      const n0 = booking('n0', 0);
      const x = booking('x', 9);
      const server = [x, n5, n4, n3, n2, n1, n0];
      const deps = fakeDeps();
      const counts = serve(list, server, deps);
      deps.fetchBookings.mockImplementationOnce(async () => {
        await list.observer.fetchNextPage(); // "Weitere laden" lands first: n1, n0
        return [x];
      });
      await applyBookingChanges(qc, [created(x)], { deps });
      // patched into all three pages – never into the two the first head request started from
      expect(list.ids()).toEqual([['x', 'n5', 'n4'], ['n3', 'n2'], ['n1', 'n0']]);
      expect(deps.fetchBookings).toHaveBeenCalledTimes(2);
      expect(counts.pages).toBe(1); // "Weitere laden" only – no full refetch
    });

    it('the list is loading ("Weitere laden" is never cancelled): new bookings are merged after it with one head request', async () => {
      const list = mountList({ period: 'all' }, twoPages());
      const m1 = booking('m1', 1);
      const x = booking('x', 9);
      let release = () => {};
      list.queryFn.mockImplementationOnce(
        () =>
          new Promise<BookingPage>((resolve) => {
            release = () => resolve({ items: [m1], next: null, base: '' });
          }),
      );
      const more = list.observer.fetchNextPage();
      const deps = fakeDeps();
      deps.fetchBookings.mockResolvedValue([x]);
      const applied = applyBookingChanges(qc, [created(x)], { deps });
      await Promise.resolve();
      expect(deps.fetchBookings).not.toHaveBeenCalled(); // waits for the page
      release();
      await more;
      await applied;
      expect(list.ids()).toEqual([['x', 'n5', 'n4'], ['n3', 'n2'], ['m1']]);
      expect(deps.fetchBookings).toHaveBeenCalledOnce();
      expect(list.queryFn).toHaveBeenCalledOnce(); // the extra page – no refetch of all pages
    });

    it.each([1, 2, 4, 10])('%i batch(es) during a full refetch: one head request after it, no further refetch', async (batches) => {
      // three pages of two loaded; the server has more
      const server = Array.from({ length: 9 }, (_, i) => booking(`s${i}`, 20 - i));
      const list = mountList({ period: 'all' }, [
        { items: server.slice(0, 2), next: cursorOf(server[1]!), base: '' },
        { items: server.slice(2, 4), next: cursorOf(server[3]!), base: '' },
        { items: server.slice(4, 6), next: cursorOf(server[5]!), base: '' },
      ]);
      const deps = fakeDeps();
      let open = () => {};
      const counts = serve(list, server, deps, { gate: new Promise<void>((resolve) => (open = resolve)) });
      const refetch = list.observer.refetch(); // a reconnect, a fallback, a remount …
      const applied: Array<Promise<void>> = [];
      for (let i = 0; i < batches; i++) {
        const fresh = booking(`n${i}`, 30 + i);
        server.unshift(fresh);
        applied.push(applyBookingChanges(qc, [created(fresh)], { deps }));
        await Promise.resolve();
      }
      open();
      await refetch;
      await Promise.all(applied);
      expect(counts.pages).toBe(3); // the one running refetch (before: ⌈N/2⌉ more of them)
      expect(counts.heads).toBe(1); // the bookings it missed
      const shown = list.ids().flat();
      expect(shown).toEqual(server.slice(0, shown.length).map((b) => b.id));
      expect(shown.slice(0, batches)).toEqual(server.slice(0, batches).map((b) => b.id));
    });

    it('a steady stream after a refetch goes on with head requests (the refetch does not chain)', async () => {
      const server = Array.from({ length: 12 }, (_, i) => booking(`s${i}`, 40 - i));
      const list = mountList({ period: 'all' }, [
        { items: server.slice(0, 2), next: cursorOf(server[1]!), base: '' },
        { items: server.slice(2, 4), next: cursorOf(server[3]!), base: '' },
        { items: server.slice(4, 6), next: cursorOf(server[5]!), base: '' },
        { items: server.slice(6, 8), next: cursorOf(server[7]!), base: '' },
      ]);
      const deps = fakeDeps();
      // a full refetch takes 4 × 8 ms, longer than the gap between two batches (5 ms)
      const counts = serve(list, server, deps, { delay: 8 });
      void list.observer.refetch();
      const applied: Array<Promise<void>> = [];
      for (let i = 0; i < 12; i++) {
        const fresh = booking(`n${String(i).padStart(2, '0')}`, 50, { created: `2026-10-20 17:01:${String(i).padStart(2, '0')}.000Z` });
        server.unshift(fresh);
        applied.push(applyBookingChanges(qc, [created(fresh)], { deps }));
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await Promise.all(applied);
      await waitFor(() => expect(list.observer.getCurrentResult().isFetching).toBe(false));
      expect(counts.pages).toBe(4); // only the trigger's refetch
      expect(counts.heads).toBeGreaterThan(0);
      expect(counts.heads).toBeLessThanOrEqual(12);
      const shown = list.ids().flat();
      expect(shown).toEqual(server.slice(0, shown.length).map((b) => b.id));
      expect(shown.slice(0, 12)).toEqual(server.slice(0, 12).map((b) => b.id));
    });
  });
});

describe('Buchungen "Heute" across midnight', () => {
  // Vienna (the tests' TZ): 2026-10-20 23:30 = 21:30Z, 2026-10-21 00:05 = 22:05Z
  const BEFORE = new Date('2026-10-20T21:30:00.000Z');
  const AFTER = new Date('2026-10-20T22:05:00.000Z');
  const query: BookingQuery = { period: 'today' };
  const page = (items: BookingRecord[]): ListResult<BookingRecord> => ({
    page: 1,
    perPage: BOOKINGS_PAGE_SIZE,
    totalItems: -1,
    totalPages: -1,
    items,
  });
  const at = (date: Date, minutes: number) => toPbDate(new Date(date.getTime() + minutes * 60_000));

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('"Weitere laden" after midnight continues the loaded day; the next booking event refetches the list', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BEFORE);
    // 50 bookings of the evening (newest first) – more on the server
    const evening = Array.from({ length: BOOKINGS_PAGE_SIZE }, (_, i) =>
      booking(`e${String(BOOKINGS_PAGE_SIZE - i).padStart(2, '0')}`, 0, { created: at(BEFORE, -(i + 1)) }),
    );
    const morning = booking('e00', 0, { created: at(BEFORE, -600) });
    const getList = vi
      .spyOn(pb.collection('bookings'), 'getList')
      .mockResolvedValueOnce(page(evening))
      .mockResolvedValueOnce(page([morning]));
    const observer = new InfiniteQueryObserver(qc, bookingListOptions(query));
    cleanups.push(observer.subscribe(() => {}));
    await waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
    const yesterday = baseOf(query, BEFORE);
    expect(getList.mock.calls[0]![2]).toMatchObject({ filter: yesterday });

    vi.setSystemTime(AFTER);
    await observer.fetchNextPage();
    // the same day as page 1 – not the (empty) rest of the new day
    expect(getList.mock.calls[1]![2]).toMatchObject({ filter: keysetFilter(yesterday, cursorOf(evening.at(-1)!)) });
    expect(observer.getCurrentResult().data!.pages.map((p) => p.items.length)).toEqual([BOOKINGS_PAGE_SIZE, 1]);

    // the first booking of the new day: the list shows the day before → refetch (no head request, no merge)
    const fresh = booking('fresh', 0, { created: at(AFTER, 1) });
    getList.mockResolvedValueOnce(page([fresh]));
    const deps = { ...fakeDeps(), now: () => new Date(AFTER.getTime() + 61_000) };
    await applyBookingChanges(qc, [created(fresh)], { deps });
    expect(deps.fetchBookings).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(observer.getCurrentResult().data!.pages.map((p) => p.items.map((b) => b.id))).toEqual([['fresh']]),
    );
    expect(getList.mock.calls[2]![2]).toMatchObject({ filter: baseOf(query, AFTER) });
  });
});

describe('mergeIntoPages / removeFromPages', () => {
  const a = booking('a', 5);
  const b = booking('b', 3);
  it('puts a booking into the page whose range it falls in, skips known ids', () => {
    const data: BookingListData = {
      pages: [
        { items: [a], next: cursorOf(a), base: '' },
        { items: [b], next: null, base: '' },
      ],
      pageParams: [null, { cursor: cursorOf(a), base: '' }],
    };
    const mid = booking('mid', 4);
    const merged = mergeIntoPages(data, [mid, a]);
    expect(merged.pages.map((p) => p.items.map((i) => i.id))).toEqual([['a'], ['mid', 'b']]);
    expect(merged.pages[0]).toBe(data.pages[0]);
    expect(mergeIntoPages(data, [a])).toBe(data);
  });
  it('returns the same data when nothing is removed', () => {
    const data: BookingListData = { pages: [{ items: [a], next: null, base: '' }], pageParams: [null] };
    expect(removeFromPages(data, new Set(['zz']))).toBe(data);
    expect(removeFromPages(data, new Set(['a'])).pages[0]!.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('recent bookings of a person', () => {
  const key = queryKeys.recentBookings('p1', 3);

  it("refetches on another device's booking of the person (events carry no expand)", async () => {
    const recent = mount(key, [booking('a', 1)]);
    await applyBookingChanges(qc, [created(booking('x', 9))], { deps: fakeDeps() });
    expect(recent.queryFn).toHaveBeenCalledOnce();
  });

  it('removes a cancelled booking locally when all bookings are shown', async () => {
    const recent = mount(key, [booking('b', 2), booking('a', 1)]);
    await applyBookingChanges(qc, [deleted(booking('b', 2))], { deps: fakeDeps() });
    expect(recent.data()!.map((b) => b.id)).toEqual(['a']);
    expect(recent.queryFn).not.toHaveBeenCalled();
  });

  it('removes it at once and refetches a full list (the next older one moves up)', async () => {
    const recent = mount(key, [booking('c', 3), booking('b', 2), booking('a', 1)]);
    recent.queryFn.mockResolvedValue([booking('c', 3), booking('a', 1), booking('z', 0)]);
    const applied = applyBookingChanges(qc, [deleted(booking('b', 2))], { deps: fakeDeps() });
    expect(recent.data()!.map((b) => b.id)).toEqual(['c', 'a']);
    await applied;
    expect(recent.queryFn).toHaveBeenCalledOnce();
    expect(recent.data()!.map((b) => b.id)).toEqual(['c', 'a', 'z']);
  });

  it('ignores the cancellation of a booking it does not show', async () => {
    const recent = mount(key, [booking('c', 3), booking('b', 2), booking('a', 1)]);
    await applyBookingChanges(qc, [deleted(booking('old', 0))], { deps: fakeDeps() });
    expect(recent.queryFn).not.toHaveBeenCalled();
    expect(recent.data()).toHaveLength(3);
  });

  it('merges an own booking (full record) and keeps the limit', async () => {
    const recent = mount(key, [booking('c', 3), booking('b', 2), booking('a', 1)]);
    await applyBookingChanges(qc, [created(booking('own', 9), true)], { deps: fakeDeps() });
    expect(recent.data()!.map((b) => b.id)).toEqual(['own', 'c', 'b']);
    expect(recent.queryFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('own change and its realtime echo', () => {
  it('cost one round: the echo is skipped', async () => {
    const totals = mount(queryKeys.totalsFor(personTotalsQuery('p1'), ['summary']), { count: 0, quantity: 0, totalCents: 0 });
    const recent = mount(queryKeys.recentBookings('p1', 8), [] as BookingRecord[]);
    const own = booking('own', 9);
    await applyBookingChanges(qc, [created(own, true)], { deps: fakeDeps() });
    expect(totals.queryFn).toHaveBeenCalledOnce();
    expect(recent.data()!.map((b) => b.id)).toEqual(['own']);
    expect(recent.queryFn).not.toHaveBeenCalled();

    // the echo (no expand) arrives later
    await applyBookingChanges(qc, [created({ ...own, expand: undefined })], { deps: fakeDeps() });
    expect(totals.queryFn).toHaveBeenCalledOnce();
    expect(recent.queryFn).not.toHaveBeenCalled();
  });

  it('when the echo comes first, the own change is known as handled', async () => {
    const echo = created(booking('own', 9));
    await applyBookingChanges(qc, [echo], { deps: fakeDeps() });
    expect(isBookingChangeHandled(qc, { ...echo, expanded: true })).toBe(true);
    expect(isBookingChangeHandled(qc, deleted(echo.record))).toBe(false);
  });
});

describe('person and user events: new names in the cached rows, no request (FLOW-7, FLOW-11)', () => {
  const person = (id: string, number: string, name: string) => ({ id, number, name, nickname: '' }) as PersonRecord;
  const user = (id: string, username: string, name: string) => ({ id, username, name, role: 'user' }) as UserRecord;
  const userRow = (userId: string, username: string): TotalsPerUser => ({
    userId,
    username,
    name: username,
    count: 1,
    quantity: 1,
    totalCents: 250,
  });
  const shown = (id: string, personId: string, userId: string) =>
    booking(id, 5, {
      person: personId,
      createdBy: userId,
      expand: { person: person(personId, '7', 'Alt'), createdBy: user(userId, 'anna', 'Anna Alt') },
    });

  it('a renamed person: booking rows and per-person rows (re-sorted by number) – nothing refetched', () => {
    const list = mountList({ period: 'all' }, [{ items: [shown('a', 'p1', 'u1'), shown('b', 'p2', 'u1')], next: null, base: '' }]);
    const recent = mount(queryKeys.recentBookings('p1', 8), [shown('a', 'p1', 'u1')]);
    const totals = mount<Totals>(queryKeys.totalsFor({ period: 'all' }, ['perPerson']), {
      perPerson: [personRow('p1', '1', 2), personRow('p2', '2', 1), personRow('p3', '3', 1)],
    });
    const other = list.data().pages[0]!.items[1];
    applyPersonUpdates(qc, [person('p1', '9', 'Neu')]);
    const rows = list.data().pages[0]!.items;
    expect(rows[0]!.expand!.person).toMatchObject({ number: '9', name: 'Neu' });
    expect(rows[1]).toBe(other); // other persons' rows untouched
    expect(rows[1]!.expand!.person!.name).toBe('Alt');
    expect(recent.data()![0]!.expand!.person!.name).toBe('Neu');
    expect(totals.data()!.perPerson!.map((row) => [row.personId, row.number, row.name])).toEqual([
      ['p2', '2', 'Name 2'],
      ['p3', '3', 'Name 3'],
      ['p1', '9', 'Neu'],
    ]);
    expect(list.queryFn).not.toHaveBeenCalled();
    expect(recent.queryFn).not.toHaveBeenCalled();
    expect(totals.queryFn).not.toHaveBeenCalled();
  });

  it('a renamed user: "von …" in the booking rows and the per-user rows (re-sorted by username)', () => {
    const list = mountList({ period: 'all' }, [{ items: [shown('a', 'p1', 'u1'), shown('b', 'p1', 'u2')], next: null, base: '' }]);
    const totals = mount<Totals>(queryKeys.totalsFor({ period: 'all' }, ['perUser']), {
      perUser: [userRow('u1', 'anna'), userRow('u2', 'ben')],
    });
    applyUserUpdates(qc, [user('u1', 'zoe', 'Zoe')]);
    expect(list.data().pages[0]!.items.map((b) => b.expand!.createdBy!.name)).toEqual(['Zoe', 'Anna Alt']);
    expect(totals.data()!.perUser!.map((row) => [row.userId, row.username])).toEqual([
      ['u2', 'ben'],
      ['u1', 'zoe'],
    ]);
    expect(list.queryFn).not.toHaveBeenCalled();
    expect(totals.queryFn).not.toHaveBeenCalled();
  });

  it('the same names (e.g. a password change): the cached data keeps its identity', () => {
    const list = mountList({ period: 'all' }, [{ items: [shown('a', 'p1', 'u1')], next: null, base: '' }]);
    const before = list.data();
    applyUserUpdates(qc, [user('u1', 'anna', 'Anna Alt')]);
    applyPersonUpdates(qc, [person('p1', '7', 'Alt')]);
    expect(list.data()).toBe(before);
  });

  it('an invalidated query is left alone (it is refetched anyway)', async () => {
    const recent = mount(queryKeys.recentBookings('p1', 8), [shown('a', 'p1', 'u1')], { active: false });
    await qc.invalidateQueries({ queryKey: queryKeys.recentBookings('p1', 8) });
    applyPersonUpdates(qc, [person('p1', '9', 'Neu')]);
    expect(recent.data()![0]!.expand!.person!.name).toBe('Alt');
    expect(recent.state().isInvalidated).toBe(true);
  });

  it('a query that is fetching gets the names once its fetch settled', async () => {
    const key = queryKeys.recentBookings('p1', 8);
    mount(key, [shown('a', 'p1', 'u1')]);
    let release = () => {};
    const observer = new QueryObserver(qc, {
      queryKey: key,
      queryFn: () => new Promise<BookingRecord[]>((resolve) => (release = () => resolve([shown('a', 'p1', 'u1')]))),
    });
    cleanups.push(observer.subscribe(() => {}));
    const running = observer.refetch(); // started before the rename: returns the old name
    applyPersonUpdates(qc, [person('p1', '9', 'Neu')]);
    release();
    await running;
    await waitFor(() => expect(qc.getQueryData<BookingRecord[]>(key)![0]!.expand!.person!.name).toBe('Neu'));
  });
});

describe('fallbacks for unexpected changes', () => {
  it('refetches all booking and totals queries on an update (superusers only)', async () => {
    const totals = mount(queryKeys.totalsFor(personTotalsQuery('p2'), ['summary']), { count: 0, quantity: 0, totalCents: 0 });
    const recent = mount(queryKeys.recentBookings('p2', 8), [] as BookingRecord[]);
    await applyBookingChanges(qc, [{ action: 'update', record: booking('x', 9) }], { deps: fakeDeps() });
    expect(totals.queryFn).toHaveBeenCalledOnce();
    expect(recent.queryFn).toHaveBeenCalledOnce();
  });

  it('refetches everything for a record without the needed fields', async () => {
    const totals = mount(queryKeys.totalsFor(personTotalsQuery('p2'), ['summary']), { count: 0, quantity: 0, totalCents: 0 });
    const broken = { id: 'x' } as BookingRecord;
    await applyBookingChanges(qc, [{ action: 'create', record: broken }], { deps: fakeDeps() });
    expect(totals.queryFn).toHaveBeenCalledOnce();
  });

  it('refetches booking queries with an unknown key shape', async () => {
    const other = mount(['bookings', 'something'], 1);
    await applyBookingChanges(qc, [created(booking('x', 9))], { deps: fakeDeps() });
    expect(other.queryFn).toHaveBeenCalledOnce();
  });
});
