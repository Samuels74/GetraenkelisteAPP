import { onlineManager, QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClientResponseError } from 'pocketbase';
import type { ReactNode } from 'react';
import { ConnectionHint } from '../components/ConnectionHint';
import {
  OUTAGE_HINT_AFTER_MS,
  OUTAGE_POLL_MS,
  resetConnectionStateForTests,
  useConnectionHint,
  useRealtimeOutage,
} from './connection';
import type * as RealtimeModule from './realtime';

const realtime = vi.hoisted(() => ({ catchUpPending: false }));
vi.mock('./realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof RealtimeModule>()),
  realtimeCatchUpPending: () => realtime.catchUpPending,
}));

const HINT = 'Verbindung zum Server unterbrochen – Anzeige evtl. nicht aktuell.';

/** What the SDK throws without a usable answer. */
const networkError = () => new ClientResponseError({ status: 0, response: {} });
const proxyPage = (status: number) => new ClientResponseError({ status, data: {} });
const pbAnswer = (status: number) =>
  new ClientResponseError({ status, response: { status, message: "The requested resource wasn't found.", data: {} } });

let qc: QueryClient;
let visibility: DocumentVisibilityState;
const cleanups: Array<() => void> = [];

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/** A query a screen shows (an active observer), loaded once; `next` answers its refetches. */
async function shownQuery(key: string, next: { fail?: Error }) {
  let calls = 0;
  const observer = new QueryObserver(qc, {
    queryKey: [key],
    queryFn: async () => {
      calls += 1;
      if (calls > 1 && next.fail) throw next.fail;
      return `${key} #${calls}`;
    },
    retry: false,
  });
  cleanups.push(observer.subscribe(() => {}));
  await waitFor(() => expect(observer.getCurrentResult().data).toBe(`${key} #1`));
  return { observer, calls: () => calls };
}

beforeEach(() => {
  // like the app (app/queryClient.ts): requests run offline, too, and fail at once
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, networkMode: 'always' } } });
  resetConnectionStateForTests();
  realtime.catchUpPending = false;
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  qc.clear();
  onlineManager.setOnline(true);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a failed background refresh (L5)', () => {
  it('shows the hint next to the kept content – network errors, proxy pages, 5xx', async () => {
    for (const fail of [networkError(), proxyPage(404), proxyPage(502), pbAnswer(500)]) {
      const next: { fail?: Error } = {};
      const { observer } = await shownQuery(`q${fail.status}-${Math.random()}`, next);
      const { result, unmount } = renderHook(() => useConnectionHint(), { wrapper });
      expect(result.current.shown).toBe(false);
      next.fail = fail;
      await act(() => observer.refetch());
      expect(observer.getCurrentResult().data).toMatch(/#1$/); // kept
      await waitFor(() => expect(result.current.shown).toBe(true));
      unmount();
      qc.clear();
    }
  });

  it('not for PocketBase\'s own 4xx (an answer), nor for a first load that failed (the screen shows that error)', async () => {
    const next: { fail?: Error } = {};
    const { observer } = await shownQuery('answer', next);
    next.fail = pbAnswer(404);
    await act(() => observer.refetch());
    const failedFirst = new QueryObserver(qc, { queryKey: ['first'], queryFn: () => Promise.reject(networkError()), retry: false });
    cleanups.push(failedFirst.subscribe(() => {}));
    await waitFor(() => expect(failedFirst.getCurrentResult().isError).toBe(true));
    const { result } = renderHook(() => useConnectionHint(), { wrapper });
    expect(result.current.shown).toBe(false);
  });

  it('not for what failed while offline (the banner said so) – again once a refresh fails online', async () => {
    const next: { fail?: Error } = {};
    const { observer } = await shownQuery('offline', next);
    act(() => onlineManager.setOnline(false));
    next.fail = networkError();
    await act(() => observer.refetch());
    const { result } = renderHook(() => useConnectionHint(), { wrapper });
    expect(result.current.shown).toBe(false); // offline: the banner
    act(() => onlineManager.setOnline(true));
    expect(result.current.shown).toBe(false); // that failure was the offline one
    await new Promise((resolve) => setTimeout(resolve, 2));
    await act(() => observer.refetch());
    await waitFor(() => expect(result.current.shown).toBe(true)); // the server is unreachable, too
  });

  it('"Erneut versuchen" refetches what failed – the hint goes once it worked', async () => {
    const next: { fail?: Error } = {};
    const failing = await shownQuery('failing', next);
    const fine = await shownQuery('fine', {});
    next.fail = proxyPage(502);
    await act(() => failing.observer.refetch());
    render(<ConnectionHint />, { wrapper });
    expect(await screen.findByRole('status')).toHaveTextContent(HINT);

    next.fail = undefined;
    await userEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    await waitFor(() => expect(screen.queryByTestId('connection-hint')).not.toBeInTheDocument());
    expect(failing.calls()).toBe(3);
    expect(fine.calls()).toBe(1); // what did not fail is not loaded again
  });
});

describe('realtime down for a while (L5)', () => {
  beforeEach(() => vi.useFakeTimers());

  it('after OUTAGE_HINT_AFTER_MS while visible and online – and gone after the reconnect', async () => {
    const { result } = renderHook(() => useRealtimeOutage());
    realtime.catchUpPending = true; // was connected, is reconnecting
    await act(() => vi.advanceTimersByTimeAsync(OUTAGE_POLL_MS));
    await act(() => vi.advanceTimersByTimeAsync(OUTAGE_HINT_AFTER_MS - OUTAGE_POLL_MS));
    expect(result.current).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(OUTAGE_POLL_MS));
    expect(result.current).toBe(true);
    realtime.catchUpPending = false;
    await act(() => vi.advanceTimersByTimeAsync(OUTAGE_POLL_MS));
    expect(result.current).toBe(false);
  });

  it('the clock starts over when the app was hidden (an unlock reconnects at once) or offline (the banner)', async () => {
    const { result } = renderHook(() => useRealtimeOutage());
    realtime.catchUpPending = true;
    await act(() => vi.advanceTimersByTimeAsync(OUTAGE_HINT_AFTER_MS - OUTAGE_POLL_MS));
    visibility = 'hidden';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(result.current).toBe(false);
    visibility = 'visible';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(() => vi.advanceTimersByTimeAsync(OUTAGE_HINT_AFTER_MS - OUTAGE_POLL_MS));
    expect(result.current).toBe(false);
    act(() => onlineManager.setOnline(false));
    await act(() => vi.advanceTimersByTimeAsync(OUTAGE_HINT_AFTER_MS * 2));
    expect(result.current).toBe(false);
    act(() => onlineManager.setOnline(true));
    await act(() => vi.advanceTimersByTimeAsync(OUTAGE_HINT_AFTER_MS + OUTAGE_POLL_MS));
    expect(result.current).toBe(true);
  });

  it('the hint\'s retry refetches everything shown; data loaded by hand counts as current for another while', async () => {
    let loads = 0;
    const observer = new QueryObserver(qc, { queryKey: ['shown'], queryFn: async () => ++loads, retry: false });
    cleanups.push(observer.subscribe(() => {}));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(loads).toBe(1);
    const { result } = renderHook(() => useConnectionHint(), { wrapper });
    realtime.catchUpPending = true;
    await act(() => vi.advanceTimersByTimeAsync(OUTAGE_HINT_AFTER_MS + OUTAGE_POLL_MS));
    expect(result.current.shown).toBe(true);

    await act(async () => {
      result.current.retry();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(loads).toBe(2); // the data of every shown query, although none failed
    expect(result.current.shown).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(OUTAGE_HINT_AFTER_MS + OUTAGE_POLL_MS));
    expect(result.current.shown).toBe(true); // still no realtime: it may be outdated again
  });
});
