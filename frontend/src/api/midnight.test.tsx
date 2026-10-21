import { QueryClient, QueryClientProvider, QueryObserver, type QueryKey } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { getDay, invalidateRelativePeriods, MAX_TIMER_WAIT_MS, subscribeToDay, useMidnightRefresh } from './midnight';
import { personTotalsQuery, queryKeys } from './queries';

const HOUR = 3_600_000;

/** Advances the fake clock and fires the timers due (inside act for React). */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('subscribeToDay (one timer for local midnight)', () => {
  let visibility: DocumentVisibilityState = 'visible';
  const subscriptions: Array<() => void> = [];
  /** Subscribes for this test only. */
  const listen = (listener: () => void) => {
    const unsubscribe = subscribeToDay(listener);
    subscriptions.push(unsubscribe);
    return unsubscribe;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  });
  afterEach(() => {
    for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('notifies right after local midnight and again the night after; the day object is stable within a day', () => {
    vi.setSystemTime(new Date(2026, 9, 20, 23, 59, 30));
    const listener = vi.fn();
    const unsubscribe = listen(listener);
    const day = getDay();
    expect(day.getDate()).toBe(20);

    advance(20_000); // 23:59:50
    expect(listener).not.toHaveBeenCalled();
    expect(getDay()).toBe(day);

    advance(12_000); // 00:00:02
    expect(listener).toHaveBeenCalledOnce();
    expect(getDay().getDate()).toBe(21);
    const next = getDay();

    advance(12 * HOUR); // noon: nothing
    expect(listener).toHaveBeenCalledOnce();
    expect(getDay()).toBe(next);
    advance(12 * HOUR); // the following midnight
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getDay().getDate()).toBe(22);
    unsubscribe();
  });

  it.each([
    ['autumn, 25 hours (02:00 twice)', new Date(2026, 9, 25, 0, 30), 24.5 * HOUR, 25],
    ['spring, 23 hours (no 02:00)', new Date(2026, 2, 29, 0, 30), 22.5 * HOUR, 29],
  ])('crosses the DST night correctly – %s', (_label, start, untilLastHour, date) => {
    // Europe/Vienna (TZ of the tests): 29 Mar 2026 has 23 hours, 25 Oct 2026 has 25
    vi.setSystemTime(start);
    const listener = vi.fn();
    const unsubscribe = listen(listener);
    advance(untilLastHour - 2_000); // 23:59:58 local
    expect(listener).not.toHaveBeenCalled();
    expect(getDay().getDate()).toBe(date);
    advance(4_000); // 00:00:02 local of the next day
    expect(listener).toHaveBeenCalledOnce();
    expect(getDay().getDate()).toBe(date + 1);
    unsubscribe();
  });

  it('catches up when the page becomes visible again (the timer of a locked phone may not fire)', () => {
    vi.setSystemTime(new Date(2026, 9, 20, 22, 0));
    const listener = vi.fn();
    const unsubscribe = listen(listener);
    visibility = 'hidden';
    vi.setSystemTime(new Date(2026, 9, 21, 8, 0)); // slept through midnight, no timer fired
    expect(listener).not.toHaveBeenCalled();
    visibility = 'visible';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(getDay().getDate()).toBe(21);
    unsubscribe();
  });

  it('a device that slept across midnight with the page visible: the new day within a minute of waking (N8)', () => {
    vi.setSystemTime(new Date(2026, 9, 20, 22, 0));
    const listener = vi.fn();
    listen(listener);
    // timers count only the time the device is awake: the clock jumps, no timer fires meanwhile
    vi.setSystemTime(new Date(2026, 9, 21, 7, 30));
    expect(listener).not.toHaveBeenCalled();
    advance(MAX_TIMER_WAIT_MS);
    expect(listener).toHaveBeenCalledOnce();
    expect(getDay().getDate()).toBe(21);
  });

  it('one timer for all listeners, none after the last one left', () => {
    vi.setSystemTime(new Date(2026, 9, 20, 12, 0));
    const first = listen(() => {});
    const second = listen(() => {});
    expect(vi.getTimerCount()).toBe(1);
    first();
    expect(vi.getTimerCount()).toBe(1);
    second();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the "Heute" / 7 / 30 Tage queries at midnight (FLOW-10)', () => {
  let qc: QueryClient;
  const cleanups: Array<() => void> = [];
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  });
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    qc.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function mount(queryKey: QueryKey, active = true) {
    const queryFn = vi.fn(async () => ({}));
    qc.setQueryData(queryKey, {});
    if (active) cleanups.push(new QueryObserver(qc, { queryKey, queryFn }).subscribe(() => {}));
    return { queryFn, state: () => qc.getQueryState(queryKey)! };
  }

  it('invalidates exactly the queries of relative periods: mounted ones refetch, hidden ones are marked', async () => {
    const today = mount(queryKeys.bookingList({ period: 'today' }));
    const week = mount(queryKeys.totalsFor({ period: '7d', createdBy: 'u1' }, ['summary']));
    const monthHidden = mount(queryKeys.totalsFor({ period: '30d' }, ['summary', 'perPerson']), false);
    const all = mount(queryKeys.bookingList({ period: 'all' }));
    const custom = mount(queryKeys.totalsFor({ period: 'custom', from: '2026-10-01', to: '2026-10-20' }, ['summary']));
    const person = mount(queryKeys.totalsFor(personTotalsQuery('p1'), ['summary']));
    const recent = mount(queryKeys.recentBookings('p1', 8));
    const persons = mount(queryKeys.persons);

    await invalidateRelativePeriods(qc);

    expect(today.queryFn).toHaveBeenCalledOnce();
    expect(week.queryFn).toHaveBeenCalledOnce();
    expect(monthHidden.state().isInvalidated).toBe(true);
    for (const other of [all, custom, person, recent, persons]) {
      expect(other.queryFn).not.toHaveBeenCalled();
      expect(other.state().isInvalidated).toBe(false);
    }
  });

  it('useMidnightRefresh: the "Heute" list refetches at midnight without any booking', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 20, 23, 59, 0));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const today = mount(queryKeys.bookingList({ period: 'today' }));
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { unmount } = renderHook(() => useMidnightRefresh(), { wrapper });
    advance(30_000);
    expect(today.queryFn).not.toHaveBeenCalled();
    advance(32_000); // 00:00:02
    expect(today.queryFn).toHaveBeenCalledOnce();
    unmount();
  });
});
