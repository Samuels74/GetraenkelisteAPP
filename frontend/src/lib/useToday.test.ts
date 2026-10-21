import { act, renderHook } from '@testing-library/react';
import { useToday } from './useToday';

/** Advances the fake clock (and fires the timers due) inside act(). */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

const HOUR = 3_600_000;

describe('useToday', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('moves to the new day at local midnight and keeps the same Date within a day', () => {
    vi.setSystemTime(new Date(2026, 9, 20, 23, 59, 30));
    const { result } = renderHook(() => useToday());
    const first = result.current;
    expect(first.getDate()).toBe(20);

    advance(20_000); // 23:59:50
    expect(result.current).toBe(first);

    advance(12_000); // 00:00:02
    expect(result.current.getDate()).toBe(21);

    // the timer is armed again for the following midnight
    const second = result.current;
    advance(12 * HOUR); // noon: same day, same object
    expect(result.current).toBe(second);
    advance(12 * HOUR); // the next midnight
    expect(result.current.getDate()).toBe(22);
  });

  it('catches up when the page becomes visible again (timers of hidden pages may not fire)', () => {
    vi.setSystemTime(new Date(2026, 9, 20, 22, 0));
    const { result } = renderHook(() => useToday());
    // the phone slept: the clock moved on, the timer did not fire
    vi.setSystemTime(new Date(2026, 9, 21, 8, 0));
    expect(result.current.getDate()).toBe(20);

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(result.current.getDate()).toBe(21);
  });

  it('crosses the day of the DST change (25 hours) correctly', () => {
    // Europe/Vienna (TZ of the tests): 25 Oct 2026 has 25 hours (03:00 → 02:00)
    vi.setSystemTime(new Date(2026, 9, 25, 0, 30));
    const { result } = renderHook(() => useToday());
    advance(23.5 * HOUR + 2_000); // 24 h on the clock later: 23:00:02, still the 25th
    expect(result.current.getDate()).toBe(25);
    advance(HOUR); // 00:00:02 on the 26th
    expect(result.current.getDate()).toBe(26);
  });

  it('stops its timer on unmount', () => {
    vi.setSystemTime(new Date(2026, 9, 20, 23, 0));
    const { unmount } = renderHook(() => useToday());
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
