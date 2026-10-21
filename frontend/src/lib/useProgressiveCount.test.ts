import { act, renderHook } from '@testing-library/react';
import { nextProgressiveCount, useProgressiveCount } from './useProgressiveCount';

describe('nextProgressiveCount', () => {
  it('doubles the count, at least by `first` and at most by `maxStep`', () => {
    const steps = [100];
    while (steps.at(-1)! < 2000) steps.push(nextProgressiveCount(steps.at(-1)!, 100, 400));
    expect(steps).toEqual([100, 200, 400, 800, 1200, 1600, 2000]);
    expect(nextProgressiveCount(0, 100, 400)).toBe(100);
    expect(nextProgressiveCount(300, 100, 100)).toBe(400);
  });
});

describe('useProgressiveCount', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Runs the scheduled step (a timer) and the transition render it triggers. */
  async function nextStep() {
    await act(async () => {
      await vi.advanceTimersToNextTimerAsync();
    });
  }

  it('grows one step per task until the total is reached', async () => {
    const { result } = renderHook(() => useProgressiveCount(500, 100, 200));
    expect(result.current).toMatchObject({ count: 100, complete: false });
    await nextStep();
    expect(result.current).toMatchObject({ count: 200, complete: false });
    await nextStep();
    expect(result.current).toMatchObject({ count: 400, complete: false });
    await nextStep();
    expect(result.current).toMatchObject({ count: 500, complete: true });
    // nothing scheduled once complete
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is complete right away for short and empty lists', () => {
    expect(renderHook(() => useProgressiveCount(30, 100)).result.current).toMatchObject({ count: 30, complete: true });
    expect(renderHook(() => useProgressiveCount(0, 100)).result.current).toMatchObject({ count: 0, complete: true });
  });

  it('finish() renders everything synchronously', () => {
    const { result } = renderHook(() => useProgressiveCount(2000, 100));
    act(() => result.current.finish());
    expect(result.current).toMatchObject({ count: 2000, complete: true });
  });

  it('continues when the list grows and starts over for a new reset key', async () => {
    const { result, rerender } = renderHook(({ total, key }) => useProgressiveCount(total, 100, 100, key), {
      initialProps: { total: 120, key: 'all' },
    });
    await nextStep();
    expect(result.current).toMatchObject({ count: 120, complete: true });
    rerender({ total: 121, key: 'all' }); // a person was added
    expect(result.current.count).toBe(121);
    rerender({ total: 500, key: 'a,b' }); // another selection
    expect(result.current).toMatchObject({ count: 100, complete: false });
    await nextStep();
    expect(result.current.count).toBe(200);
  });
});
