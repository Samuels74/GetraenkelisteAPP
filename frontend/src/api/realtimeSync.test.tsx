/**
 * useRealtimeSync with a mocked SDK: what the first connect, a reconnect and
 * the events do to the cached queries.
 */
import { QueryClient, QueryClientProvider, QueryObserver, type QueryKey } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { RecordSubscription } from 'pocketbase';
import type { ReactNode } from 'react';
import type * as SessionModule from '../auth/session';
import { pb } from '../lib/pb';
import type { BookingRecord, PersonRecord, UserRecord } from '../lib/types';
import { personTotalsQuery, queryKeys, type BookingListData } from './queries';
import { realtimeCatchUpPending, resetRealtimeStateForTests, useRealtimeSync } from './realtime';

const session = vi.hoisted(() => ({
  checkSession: vi.fn(() => Promise.resolve<'valid' | 'invalid' | 'unknown'>('valid')),
  applyOwnRecordUpdate: vi.fn(),
}));
vi.mock('../auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionModule>()),
  checkSession: session.checkSession,
  applyOwnRecordUpdate: session.applyOwnRecordUpdate,
}));

type Listener = (event: RecordSubscription<never>) => void;

const COLLECTIONS = ['bookings', 'persons', 'offerings', 'groups', 'users'] as const;
let listeners: Record<string, Listener>;
let topics: Record<string, string[]>;
let onConnect: () => void;
let connected: boolean;

const user = { id: 'u1', role: 'user' as const };

let qc: QueryClient;
const cleanups: Array<() => void> = [];

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/** A mounted query with data that settled at `updatedAt`; `queryFn` counts refetches. */
function mount(queryKey: QueryKey, data: unknown, updatedAt: number) {
  const queryFn = vi.fn(async () => data);
  qc.setQueryData(queryKey, data, { updatedAt });
  cleanups.push(new QueryObserver(qc, { queryKey, queryFn }).subscribe(() => {}));
  return queryFn;
}

/** The SDK reports the connect once the subscriptions request is done (`at`). */
async function connect(at: number) {
  vi.setSystemTime(at);
  connected = true;
  await act(async () => onConnect());
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  resetRealtimeStateForTests();
  pb.authStore.save('token', { id: 'u1', collectionId: 'c_users', collectionName: 'users' });
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  listeners = {};
  topics = {};
  connected = false;
  session.checkSession.mockReset();
  session.checkSession.mockResolvedValue('valid');
  session.applyOwnRecordUpdate.mockReset();
  for (const name of COLLECTIONS) {
    vi.spyOn(pb.collection(name), 'subscribe').mockImplementation(async (topic, callback) => {
      (topics[name] ??= []).push(topic);
      listeners[name] = callback;
      return async () => {};
    });
  }
  vi.spyOn(pb.realtime, 'subscribe').mockImplementation(async (topic, callback) => {
    if (topic === 'PB_CONNECT') onConnect = callback as () => void;
    return async () => {};
  });
  vi.spyOn(pb.realtime, 'unsubscribe').mockResolvedValue();
  vi.spyOn(pb.realtime, 'isConnected', 'get').mockImplementation(() => connected);
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  pb.authStore.clear();
  qc.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function start(generation = 0) {
  const hook = renderHook(({ g }) => useRealtimeSync(user, g), { wrapper, initialProps: { g: generation } });
  await waitFor(() => expect(onConnect).toBeDefined());
  return hook;
}

describe('the first connect (FLOW-5)', () => {
  it('refetches only the queries that settled before the subscriptions were active', async () => {
    const before = mount(queryKeys.groups, [], 1_000);
    const during = mount(queryKeys.offerings, [], 1_990); // while the subscription request was under way
    const after = mount(queryKeys.persons, [], 3_000); // still loading when the connect was reported
    await start();
    await connect(2_000);
    await waitFor(() => expect(before).toHaveBeenCalledOnce());
    expect(during).toHaveBeenCalledOnce();
    expect(after).not.toHaveBeenCalled();
    expect(session.checkSession).toHaveBeenCalledWith(15_000);
  });

  it('after failed attempts: refetches everything (events were missed meanwhile)', async () => {
    const subscribe = vi.mocked(pb.collection('bookings').subscribe);
    subscribe.mockRejectedValueOnce(new Error('Failed to establish realtime connection.'));
    const late = mount(queryKeys.persons, [], 3_000);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    renderHook(() => useRealtimeSync(user, 0), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100); // the failed attempt, then the retry after 1 s
    });
    expect(subscribe).toHaveBeenCalledTimes(2);
    await connect(2_000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(late).toHaveBeenCalledOnce(); // settled after the subscriptions, refetched all the same
  });
});

describe('a reconnect', () => {
  it('refetches everything – after the session check', async () => {
    const persons = mount(queryKeys.persons, [], 1_000);
    const totals = mount(queryKeys.totalsFor(personTotalsQuery('p1'), ['summary']), { count: 0 }, 5_000);
    await start();
    await connect(2_000);
    persons.mockClear();
    totals.mockClear();
    let answer = (_status: 'valid' | 'invalid') => {};
    session.checkSession.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    connected = false; // the connection dropped …
    expect(realtimeCatchUpPending()).toBe(true);
    await connect(10_000); // … and is back
    expect(persons).not.toHaveBeenCalled(); // waits for the session
    await act(async () => answer('valid'));
    await waitFor(() => expect(persons).toHaveBeenCalledOnce());
    expect(totals).toHaveBeenCalledOnce();
  });

  it('a revoked token: no refetch (PocketBase would answer with empty lists), the session ends instead', async () => {
    const persons = mount(queryKeys.persons, [], 1_000);
    await start();
    await connect(2_000);
    persons.mockClear();
    session.checkSession.mockResolvedValueOnce('invalid');
    await connect(10_000);
    await act(async () => {});
    expect(persons).not.toHaveBeenCalled();
  });
});

describe('logout and login again', () => {
  it('the first connect after a new login refetches only what settled before it – not everything again', async () => {
    const { unmount } = await start();
    await connect(2_000);
    pb.authStore.clear(); // logged out (or the session ended)
    unmount();
    pb.authStore.save('token2', { id: 'u1', collectionId: 'c_users', collectionName: 'users' });
    const early = mount(queryKeys.groups, [], 5_000);
    const late = mount(queryKeys.persons, [], 7_000);
    await start();
    await connect(6_000);
    await waitFor(() => expect(early).toHaveBeenCalledOnce());
    expect(late).not.toHaveBeenCalled();
  });
});

describe('realtimeCatchUpPending (focus / online refetch, FLOW-6)', () => {
  it('false before the first connect, true while reconnecting after one, false when connected', async () => {
    await start();
    expect(realtimeCatchUpPending()).toBe(false); // realtime may never work here: focus refetch as usual
    await connect(2_000);
    expect(realtimeCatchUpPending()).toBe(false);
    connected = false;
    expect(realtimeCatchUpPending()).toBe(true);
  });
});

describe('online / visible again', () => {
  it("tries at once – cutting short the SDK's own wait between its reconnect attempts", async () => {
    await start();
    await connect(2_000);
    connected = false;
    const sdk = pb.realtime as unknown as { reconnectAttempts: number; disconnect: () => void };
    const disconnect = vi.spyOn(sdk, 'disconnect').mockImplementation(() => {});
    sdk.reconnectAttempts = 3;
    const subscribe = vi.mocked(pb.collection('bookings').subscribe);
    subscribe.mockClear();
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(disconnect).toHaveBeenCalledOnce();
    await waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
    sdk.reconnectAttempts = 0;
  });
});

describe('subscriptions', () => {
  it('everyone watches all users (names in the bookings); a new session generation subscribes again', async () => {
    const { rerender } = await start();
    expect(topics.users).toEqual(['*']);
    expect(Object.keys(listeners)).toEqual([...COLLECTIONS]);
    rerender({ g: 1 }); // re-login / password change, also in another tab
    await waitFor(() => expect(topics.bookings).toHaveLength(2));
    expect(pb.realtime.unsubscribe).toHaveBeenCalled();
  });
});

describe('person and user events (FLOW-7, FLOW-11)', () => {
  const booking: BookingRecord = {
    id: 'b1',
    collectionId: 'c',
    collectionName: 'bookings',
    created: '2026-10-20 17:00:00.000Z',
    updated: '2026-10-20 17:00:00.000Z',
    person: 'p1',
    offering: 'o1',
    quantity: 1,
    unitPriceCents: 250,
    createdBy: 'u2',
    expand: {
      person: { id: 'p1', number: '7', name: 'Alt', nickname: '' } as PersonRecord,
      createdBy: { id: 'u2', username: 'anna', name: 'Anna Alt' } as UserRecord,
    },
  };
  const list: BookingListData = { pages: [{ items: [booking], next: null, base: '' }], pageParams: [null] };

  it('patch the new names into the rows – the lists are not reloaded, the persons are', async () => {
    const listFn = mount(queryKeys.bookingList({ period: 'all' }), list, 1_000);
    const personsFn = mount(queryKeys.persons, [], 1_000);
    await start();
    await connect(500); // nothing settled before: no first-connect refetch
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    act(() => {
      listeners.persons!({ action: 'update', record: { ...booking.expand!.person!, name: 'Neu' } } as never);
      listeners.users!({ action: 'update', record: { ...booking.expand!.createdBy!, name: 'Anna Neu' } } as never);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150); // the debounce
    });
    const row = qc.getQueryData<BookingListData>(queryKeys.bookingList({ period: 'all' }))!.pages[0]!.items[0]!;
    expect(row.expand!.person!.name).toBe('Neu');
    expect(row.expand!.createdBy!.name).toBe('Anna Neu');
    expect(listFn).not.toHaveBeenCalled();
    expect(personsFn).toHaveBeenCalledOnce();
    expect(session.applyOwnRecordUpdate).not.toHaveBeenCalled(); // not the own record
  });

  it('the own record goes to the session (role changes, forced password change)', async () => {
    await start();
    const own = { id: 'u1', username: 'me', name: 'Me', role: 'admin' } as UserRecord;
    act(() => listeners.users!({ action: 'update', record: own } as never));
    expect(session.applyOwnRecordUpdate).toHaveBeenCalledWith('update', own);
  });
});
