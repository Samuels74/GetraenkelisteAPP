import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { ClientResponseError, type ListResult, type RecordService } from 'pocketbase';
import type { MockInstance } from 'vitest';
import type { ReactNode } from 'react';
import { pb } from '../lib/pb';
import type { BookingRecord, OfferingRecord, PersonRecord, Totals, UserRecord } from '../lib/types';
import { useCreateBooking, useDeleteBooking, useUpdatePerson, useUpdateUser } from './mutations';
import { personTotalsQuery, queryKeys, usePersons, useRecentBookings, useTotals } from './queries';
import { flushRealtimeBatch } from './realtime';

const person = { id: 'p1', number: '1', name: 'Anna', nickname: '' } as PersonRecord;
const offering = { id: 'o1', name: 'Bier', priceCents: 350 } as OfferingRecord;

const stored = (id: string, second: number): BookingRecord => ({
  id,
  collectionId: 'c',
  collectionName: 'bookings',
  created: `2026-10-20 17:00:${String(second).padStart(2, '0')}.000Z`,
  updated: `2026-10-20 17:00:${String(second).padStart(2, '0')}.000Z`,
  person: 'p1',
  offering: 'o1',
  quantity: 1,
  unitPriceCents: 350,
  createdBy: 'u1',
});
/** As the create response / list requests return it (with expand). */
const expanded = (record: BookingRecord): BookingRecord => ({ ...record, expand: { person, offering } });
const list = (items: BookingRecord[]): ListResult<BookingRecord> => ({ page: 1, perPage: 8, totalItems: -1, totalPages: -1, items });

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/** The Buchen screen's data of person p1 plus the mutations. */
function renderBuchen() {
  return renderHook(
    () => ({
      totals: useTotals(personTotalsQuery('p1'), true, { parts: ['summary'] }),
      recent: useRecentBookings('p1', 8),
      create: useCreateBooking(),
      remove: useDeleteBooking(),
    }),
    { wrapper },
  );
}

let totals: Totals;
let send: MockInstance<typeof pb.send>;
let getList: MockInstance<RecordService<BookingRecord>['getList']>;

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  const one = stored('old', 1);
  totals = { count: 1, quantity: 1, totalCents: 350 };
  send = vi.spyOn(pb, 'send').mockImplementation(async () => ({ ...totals }));
  getList = vi.spyOn(pb.collection('bookings'), 'getList').mockResolvedValue(list([expanded(one)]));
});
afterEach(() => {
  qc.clear();
  vi.restoreAllMocks();
});

async function loaded() {
  const view = renderBuchen();
  await waitFor(() => expect(view.result.current.totals.data?.count).toBe(1));
  await waitFor(() => expect(view.result.current.recent.data).toHaveLength(1));
  send.mockClear();
  getList.mockClear();
  return view;
}

describe('own booking: one update round, the realtime echo is free', () => {
  it('tap → POST + one totals refetch; the recent list takes the response; the echo costs nothing', async () => {
    const { result } = await loaded();
    const created = expanded(stored('new', 9));
    vi.spyOn(pb.collection('bookings'), 'create').mockResolvedValue(created);
    totals = { count: 2, quantity: 2, totalCents: 700 };

    await act(() => result.current.create.mutateAsync({ person, offering }));
    // the new row right away (from the response, no request)
    await waitFor(() => expect(result.current.recent.data!.map((b) => b.id)).toEqual(['new', 'old']));
    await waitFor(() => expect(result.current.totals.data?.count).toBe(2));
    expect(send).toHaveBeenCalledOnce();
    expect(getList).not.toHaveBeenCalled();

    // the realtime echo of the own booking
    const { expand: _expand, ...echo } = created;
    await act(() => flushRealtimeBatch(qc, ['bookings'], [{ action: 'create', record: echo }]));
    expect(send).toHaveBeenCalledOnce();
    expect(getList).not.toHaveBeenCalled();
    expect(result.current.totals.data?.count).toBe(2);
  });

  it('echo before the response: the echo does the round, the response adds nothing (no double count)', async () => {
    const { result } = await loaded();
    const created = expanded(stored('new', 9));
    let respond = (_value: BookingRecord) => {};
    vi.spyOn(pb.collection('bookings'), 'create').mockReturnValue(
      new Promise<BookingRecord>((resolve) => {
        respond = resolve;
      }),
    );
    totals = { count: 2, quantity: 2, totalCents: 700 };
    getList.mockResolvedValue(list([created, expanded(stored('old', 1))]));

    let mutation!: Promise<BookingRecord>;
    act(() => {
      mutation = result.current.create.mutateAsync({ person, offering });
    });
    const { expand: _expand, ...echo } = created;
    await act(() => flushRealtimeBatch(qc, ['bookings'], [{ action: 'create', record: echo }]));
    expect(send).toHaveBeenCalledOnce(); // totals of p1
    expect(getList).toHaveBeenCalledOnce(); // the echo has no expand → refetch of the recent list
    await act(async () => {
      respond(created);
      await mutation;
    });
    expect(send).toHaveBeenCalledOnce();
    expect(getList).toHaveBeenCalledOnce();
    await waitFor(() => expect(result.current.recent.data!.map((b) => b.id)).toEqual(['new', 'old']));
    // no estimate on top of the refetched numbers
    expect(qc.getQueryData<Totals>(['totals', personTotalsQuery('p1'), ['summary']])?.count).toBe(2);
  });

  it('cancel → DELETE + one totals refetch; the row disappears at once; the echo costs nothing', async () => {
    const { result } = await loaded();
    const target = result.current.recent.data![0]!;
    const del = vi.spyOn(pb.collection('bookings'), 'delete').mockResolvedValue(true);
    totals = { count: 0, quantity: 0, totalCents: 0 };

    await act(() => result.current.remove.mutateAsync(target));
    expect(del).toHaveBeenCalledExactlyOnceWith('old');
    expect(qc.getQueryData(['bookings', 'recent', 'p1', 8])).toEqual([]); // at once, no request
    await waitFor(() => expect(result.current.recent.data).toEqual([]));
    await waitFor(() => expect(result.current.totals.data?.count).toBe(0));
    expect(send).toHaveBeenCalledOnce();
    expect(getList).not.toHaveBeenCalled(); // the list showed all bookings of the person

    await act(() => flushRealtimeBatch(qc, ['bookings'], [{ action: 'delete', record: stored('old', 1) }]));
    expect(send).toHaveBeenCalledOnce();
    expect(getList).not.toHaveBeenCalled();
  });
});

describe('a cancellation answered by a proxy\'s 404 page (app container restarting) – M1', () => {
  it('is not taken for "already cancelled": the row stays until the server says otherwise', async () => {
    const { result } = await loaded();
    const target = result.current.recent.data![0]!;
    vi.spyOn(pb.collection('bookings'), 'delete').mockRejectedValue(new ClientResponseError({ status: 404, data: {} }));

    await act(() => result.current.remove.mutateAsync(target).catch(() => undefined));
    // not removed locally; the lists ask the server instead (here: still there)
    await waitFor(() => expect(getList).toHaveBeenCalled());
    expect(result.current.recent.data!.map((b) => b.id)).toEqual(['old']);
  });
});

describe('own person / user edits patch the names like their realtime events (N1)', () => {
  const user = { id: 'u1', username: 'anna', name: 'Anna Alt', role: 'user' } as UserRecord;
  const withNames = (record: BookingRecord): BookingRecord => ({ ...record, expand: { person, offering, createdBy: user } });

  it('a renamed person: persons list (re-sorted) and booking rows – no booking list or totals request', async () => {
    const ben = { id: 'p2', number: '2', name: 'Ben', nickname: '' } as PersonRecord;
    const getFullList = vi.spyOn(pb.collection('persons'), 'getFullList').mockResolvedValue([person, ben]);
    const { result } = renderHook(
      () => ({
        persons: usePersons(),
        totals: useTotals(personTotalsQuery('p1'), true, { parts: ['summary'] }),
        recent: useRecentBookings('p1', 8),
        update: useUpdatePerson(),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.recent.data).toHaveLength(1));
    await waitFor(() => expect(result.current.persons.data).toHaveLength(2));
    send.mockClear();
    getList.mockClear();
    getFullList.mockClear();

    const renamed = { ...person, number: '9', name: 'Anna Neu' };
    vi.spyOn(pb.collection('persons'), 'update').mockResolvedValue(renamed);
    getFullList.mockResolvedValue([ben, renamed]);
    await act(() => result.current.update.mutateAsync({ id: 'p1', input: { number: '9', name: 'Anna Neu' } }));

    expect(qc.getQueryData<PersonRecord[]>(queryKeys.persons)!.map((p) => p.number)).toEqual(['2', '9']);
    await waitFor(() =>
      expect(result.current.recent.data![0]!.expand!.person).toMatchObject({ number: '9', name: 'Anna Neu' }),
    );
    await waitFor(() => expect(getFullList).toHaveBeenCalledOnce()); // the persons list itself, as on a realtime event
    expect(getList).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('a renamed user: "von …" in the booking rows – no booking list or totals request', async () => {
    getList.mockResolvedValue(list([withNames(stored('old', 1))]));
    const { result } = renderHook(
      () => ({
        totals: useTotals(personTotalsQuery('p1'), true, { parts: ['summary'] }),
        recent: useRecentBookings('p1', 8),
        update: useUpdateUser(),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.recent.data).toHaveLength(1));
    await waitFor(() => expect(result.current.totals.data?.count).toBe(1));
    send.mockClear();
    getList.mockClear();

    vi.spyOn(pb.collection('users'), 'update').mockResolvedValue({ ...user, name: 'Anna Neu' });
    await act(() => result.current.update.mutateAsync({ id: 'u1', input: { name: 'Anna Neu' } }));

    await waitFor(() => expect(result.current.recent.data![0]!.expand!.createdBy!.name).toBe('Anna Neu'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getList).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
