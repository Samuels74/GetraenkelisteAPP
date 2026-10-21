import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Mock } from 'vitest';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { HEALTH_POLL_MS, RouteError } from './RouteError';

/** A screen whose code cannot be loaded (what a failed `import()` throws). */
function renderFailedChunk() {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        ErrorBoundary: RouteError,
        lazy: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/BookingsPage.js')),
      },
    ],
    { initialEntries: ['/'] },
  );
  render(<RouterProvider router={router} />);
}

/** PocketBase's answer to /api/health. */
const healthy = () => Promise.resolve(new Response('{"message":"API is healthy.","code":200,"data":{}}', {
  headers: { 'content-type': 'application/json' },
}));
/** A reverse proxy's page while the app container restarts. */
const proxyPage = (status: number) => () =>
  Promise.resolve(new Response('<html><body>502 Bad Gateway</body></html>', { status, headers: { 'content-type': 'text/html' } }));
const unreachable = () => Promise.reject(new TypeError('Failed to fetch'));

describe('RouteError for a screen that could not be loaded', () => {
  const reload = vi.fn();
  let health: Mock<() => Promise<Response>>;
  beforeEach(() => {
    reload.mockClear();
    vi.stubGlobal('location', { ...window.location, reload });
    health = vi.fn(unreachable);
    vi.stubGlobal('fetch', health);
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('offline: says "Keine Verbindung" and reloads once the browser is online and the server answers', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderFailedChunk();
    expect(await screen.findByRole('heading', { name: 'Keine Verbindung zum Server' })).toBeInTheDocument();
    expect(screen.queryByText(/aktualisiert/)).not.toBeInTheDocument();

    health.mockImplementation(healthy);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  });

  it('online but the server does not answer: "Keine Verbindung" – and it reloads by itself once the server is back (L7)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    renderFailedChunk();
    expect(await screen.findByRole('heading', { name: 'Keine Verbindung zum Server' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('sobald er wieder antwortet');

    // the Wi-Fi stays up all the time (no `online` event): the page asks the server itself
    await act(() => vi.advanceTimersByTimeAsync(HEALTH_POLL_MS));
    expect(health).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
    health.mockImplementation(healthy);
    await act(() => vi.advanceTimersByTimeAsync(HEALTH_POLL_MS));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('a proxy\'s 502 page is no answer of the server: "Keine Verbindung", not "aktualisiert" (L7)', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    health.mockImplementation(proxyPage(502));
    renderFailedChunk();
    expect(await screen.findByRole('heading', { name: 'Keine Verbindung zum Server' })).toBeInTheDocument();
    expect(screen.queryByText(/aktualisiert/)).not.toBeInTheDocument();
    // "Erneut versuchen" reloads right away
    await userEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('server answers: the app was updated – it reloads once by itself into the new version', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    health.mockImplementation(healthy);
    renderFailedChunk();
    expect(await screen.findByText('Die App wurde aktualisiert – sie wird neu geladen …')).toBeInTheDocument();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('no reload loop: a second failure within a minute asks the user instead', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    health.mockImplementation(healthy);
    sessionStorage.setItem('gl.chunkReloadAt', String(Date.now() - 5_000)); // the automatic reload did not help
    renderFailedChunk();
    expect(await screen.findByText('Die App wurde aktualisiert. Bitte lade die Seite neu.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Etwas ist schiefgelaufen' })).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Neu laden' }));
    expect(reload).toHaveBeenCalledOnce();
  });
});
