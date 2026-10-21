import { act, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, Link, type RouteObject } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { useSearchParamState } from './useSearchParamState';

const DELAY = 300;

function SearchProbe() {
  const [value, setValue, flush] = useSearchParamState('q', DELAY);
  return (
    <>
      <input aria-label="Suche" value={value} onChange={(e) => setValue(e.target.value)} />
      {/* like a result row: writes a pending search before it navigates */}
      <Link to="/anders" onClick={flush}>
        Treffer
      </Link>
    </>
  );
}

function renderAt(path: string, extraRoutes: RouteObject[] = []) {
  const router = createMemoryRouter(
    [
      { path: '/liste', element: <SearchProbe /> },
      { path: '/anders', element: <p>Andere Seite</p> },
      ...extraRoutes,
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const input = () => screen.getByRole('textbox', { name: 'Suche' });
const type = (value: string) => fireEvent.change(input(), { target: { value } });

describe('useSearchParamState', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Lets the pending URL update (timer + router navigation) run. */
  async function settle(ms = DELAY) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it('starts with the value from the URL', () => {
    renderAt('/liste?q=anna&x=1');
    expect(input()).toHaveValue('anna');
  });

  it('updates the text at once and the URL only after a pause (replacing the entry)', async () => {
    const router = renderAt('/liste?x=1');
    type('m');
    await settle(DELAY - 50);
    type('mü');
    expect(input()).toHaveValue('mü');
    await settle(DELAY - 50);
    expect(router.state.location.search).toBe('?x=1');
    await settle(50);
    expect(router.state.location.search).toBe(`?x=1&q=${encodeURIComponent('mü')}`);
    expect(router.state.historyAction).toBe('REPLACE');
    expect(input()).toHaveValue('mü');

    type('');
    await settle();
    expect(router.state.location.search).toBe('?x=1');
  });

  it('keeps text typed while its own URL update is under way', async () => {
    const router = renderAt('/liste');
    type('ab');
    act(() => {
      // The router renders its update as a transition: the user types on before it is shown.
      vi.advanceTimersByTime(DELAY);
      type('abc');
    });
    expect(input()).toHaveValue('abc');
    await settle();
    expect(router.state.location.search).toBe('?q=abc');
    expect(input()).toHaveValue('abc');
  });

  it('takes over URL changes from outside (back/forward, links)', async () => {
    const router = renderAt('/liste?q=anna');
    await act(() => router.navigate('/liste?q=bernd'));
    expect(input()).toHaveValue('bernd');
    await act(() => router.navigate('/liste'));
    expect(input()).toHaveValue('');
    await settle();
    expect(router.state.location.search).toBe('');
  });

  it('drops a pending update when the page is left', async () => {
    const router = renderAt('/liste');
    type('x');
    await act(() => router.navigate('/anders'));
    await settle();
    expect(router.state.location.pathname).toBe('/anders');
    expect(router.state.location.search).toBe('');
  });

  it('restores the text on Back after leaving the page', async () => {
    const router = renderAt('/liste');
    type('anna');
    await settle();
    await act(() => router.navigate('/anders'));
    await act(() => router.navigate(-1));
    expect(router.state.location.search).toBe('?q=anna');
    expect(input()).toHaveValue('anna');
  });

  it('restores its own earlier text on Back – after the tab link cleared it', async () => {
    const router = renderAt('/liste');
    type('anna');
    await settle();
    expect(router.state.location.search).toBe('?q=anna');
    await act(() => router.navigate('/liste')); // the "Personen" tab (push)
    expect(input()).toHaveValue('');
    await act(() => router.navigate(-1)); // browser Back
    expect(router.state.location.search).toBe('?q=anna');
    expect(input()).toHaveValue('anna');
    await settle(DELAY * 2);
    expect(router.state.location.search).toBe('?q=anna'); // not overwritten by a delayed write
    expect(input()).toHaveValue('anna');
  });

  it('a navigation within the delay wins: the text follows it and the pending write is dropped', async () => {
    const router = renderAt('/liste');
    type('ab');
    await act(() => router.navigate('/liste')); // the tab again, before the URL was written
    expect(input()).toHaveValue('');
    await settle(DELAY * 2);
    expect(router.state.location.search).toBe('');
    await act(() => router.navigate(-1));
    expect(input()).toHaveValue('');
  });

  it('a tap within the delay writes the text first, so Back returns to the search', async () => {
    const router = renderAt('/liste');
    type('anna');
    expect(router.state.location.search).toBe(''); // not written yet
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: 'Treffer' }));
    });
    expect(router.state.location.pathname).toBe('/anders');
    await act(() => router.navigate(-1));
    expect(router.state.location.search).toBe('?q=anna');
    expect(input()).toHaveValue('anna');
  });

  it('never writes while a navigation is under way (that would abort it)', async () => {
    let release = () => {};
    const slow: RouteObject = {
      path: '/langsam',
      loader: () =>
        new Promise<null>((resolve) => {
          release = () => resolve(null);
        }),
      element: <p>Langsam</p>,
    };
    const router = renderAt('/liste', [slow]);
    type('x');
    let navigation!: Promise<void>;
    act(() => {
      navigation = router.navigate('/langsam');
    });
    await settle(DELAY * 2);
    expect(router.state.navigation.state).toBe('loading');
    await act(async () => {
      release();
      await navigation;
    });
    expect(router.state.location.pathname).toBe('/langsam');
  });
});
