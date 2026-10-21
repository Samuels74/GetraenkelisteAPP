import { QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query';
import type { BookingRecord } from '../lib/types';
import { isBookingChangeHandled, type BookingChange } from './bookingSync';
import { personTotalsQuery, queryKeys } from './queries';
import { flushRealtimeBatch } from './realtime';

const record = (id: string, person: string): BookingRecord => ({
  id,
  collectionId: 'c',
  collectionName: 'bookings',
  created: '2026-10-20 17:00:00.000Z',
  updated: '2026-10-20 17:00:00.000Z',
  person,
  offering: 'o1',
  quantity: 1,
  unitPriceCents: 250,
  createdBy: 'u1',
});

describe('flushRealtimeBatch', () => {
  let qc: QueryClient;
  const cleanups: Array<() => void> = [];
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  });
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    qc.clear();
  });

  function mount(queryKey: QueryKey, data: unknown) {
    const queryFn = vi.fn(async () => data);
    qc.setQueryData(queryKey, data);
    const observer = new QueryObserver(qc, { queryKey, queryFn });
    cleanups.push(observer.subscribe(() => {}));
    return queryFn;
  }

  it('applies booking events in a targeted way (other persons are not refetched)', async () => {
    const p1 = mount(queryKeys.totalsFor(personTotalsQuery('p1'), ['summary']), { count: 0, quantity: 0, totalCents: 0 });
    const p2 = mount(queryKeys.totalsFor(personTotalsQuery('p2'), ['summary']), { count: 0, quantity: 0, totalCents: 0 });
    const persons = mount(queryKeys.persons, []);
    await flushRealtimeBatch(qc, ['bookings'], [{ action: 'create', record: record('b1', 'p1') }]);
    expect(p1).toHaveBeenCalledOnce();
    expect(p2).not.toHaveBeenCalled();
    expect(persons).not.toHaveBeenCalled();
  });

  it('a person event refetches the persons only; booking changes in the same batch stay targeted (FLOW-7)', async () => {
    const p1 = mount(queryKeys.totalsFor(personTotalsQuery('p1'), ['summary']), { count: 0, quantity: 0, totalCents: 0 });
    const p2 = mount(queryKeys.totalsFor(personTotalsQuery('p2'), ['summary']), { count: 0, quantity: 0, totalCents: 0 });
    const persons = mount(queryKeys.persons, []);
    const change: BookingChange = { action: 'create', record: record('b1', 'p1') };
    await flushRealtimeBatch(qc, ['persons', 'bookings'], [change]);
    expect(persons).toHaveBeenCalledOnce();
    expect(p1).toHaveBeenCalledOnce(); // the booking: targeted
    expect(p2).not.toHaveBeenCalled();
    expect(isBookingChangeHandled(qc, change)).toBe(true);
  });

  it('an offering event in the same batch refetches broadly; its booking changes count as handled', async () => {
    const p2 = mount(queryKeys.totalsFor(personTotalsQuery('p2'), ['summary']), { count: 0, quantity: 0, totalCents: 0 });
    const offerings = mount(queryKeys.offerings, []);
    const change: BookingChange = { action: 'create', record: record('b1', 'p1') };
    await flushRealtimeBatch(qc, ['offerings', 'bookings'], [change]);
    expect(offerings).toHaveBeenCalledOnce();
    expect(p2).toHaveBeenCalledOnce(); // offerings → offerings, bookings, totals
    expect(isBookingChangeHandled(qc, change)).toBe(true);
  });

  it('other collections keep their prefix invalidation', async () => {
    const offerings = mount(queryKeys.offerings, []);
    const groups = mount(queryKeys.groups, []);
    const totals = mount(queryKeys.totalsFor({ period: 'all' }, ['perOffering']), { perOffering: [] });
    await flushRealtimeBatch(qc, ['offerings'], []);
    expect(offerings).toHaveBeenCalledOnce();
    expect(totals).toHaveBeenCalledOnce();
    expect(groups).not.toHaveBeenCalled();
  });
});
