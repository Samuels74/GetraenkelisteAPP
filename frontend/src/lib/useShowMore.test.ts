import { act, renderHook } from '@testing-library/react';
import { LIST_PAGE_SIZE, useShowMore } from './useShowMore';

describe('useShowMore', () => {
  it('starts with one page and adds a page per showMore()', () => {
    const { result } = renderHook(() => useShowMore('a'));
    expect(result.current.limit).toBe(LIST_PAGE_SIZE);
    act(() => result.current.showMore());
    expect(result.current.limit).toBe(2 * LIST_PAGE_SIZE);
    // two quick taps before the next render add two pages
    act(() => {
      result.current.showMore();
      result.current.showMore();
    });
    expect(result.current.limit).toBe(4 * LIST_PAGE_SIZE);
  });

  it('starts over when the reset key changes', () => {
    const { result, rerender } = renderHook(({ key }) => useShowMore(key, 10), { initialProps: { key: 'm' } });
    act(() => result.current.showMore());
    expect(result.current.limit).toBe(20);
    rerender({ key: 'mü' });
    expect(result.current.limit).toBe(10);
    act(() => result.current.showMore());
    expect(result.current.limit).toBe(20);
    // back to an earlier key: still a fresh start
    rerender({ key: 'm' });
    expect(result.current.limit).toBe(10);
  });

  it('starts over on every new key – also back to one that had shown more (A → B → A)', () => {
    const { result, rerender } = renderHook(({ key }) => useShowMore(key), { initialProps: { key: 'a' } });
    act(() => result.current.showMore());
    act(() => result.current.showMore());
    expect(result.current.limit).toBe(3 * LIST_PAGE_SIZE);
    rerender({ key: 'ab' });
    expect(result.current.limit).toBe(LIST_PAGE_SIZE);
    rerender({ key: 'a' });
    expect(result.current.limit).toBe(LIST_PAGE_SIZE);
  });

  it('can start with the rows shown before (Back to the list), for its first key only', () => {
    const { result, rerender } = renderHook(({ key }) => useShowMore(key, 10, 30), { initialProps: { key: 'a' } });
    expect(result.current.limit).toBe(30);
    act(() => result.current.showMore());
    expect(result.current.limit).toBe(40);
    rerender({ key: 'b' });
    expect(result.current.limit).toBe(10);
  });
});
