import { act, renderHook } from '@testing-library/react';
import { ClientResponseError } from 'pocketbase';
import { toast } from 'sonner';
import type { MockInstance } from 'vitest';
import { pb } from '../lib/pb';
import {
  changeOwnPassword,
  checkSession,
  SESSION_CHECK_INTERVAL_MS,
  SESSION_CHECK_TIMEOUT_MS,
  SESSION_EXPIRED_MESSAGE,
  sessionWasRevoked,
  useCurrentUser,
  useSessionCheck,
  useSessionGeneration,
} from './session';

/** A token the SDK considers valid (it only reads `exp`). */
function token(name: string): string {
  const payload = btoa(JSON.stringify({ id: 'u1', type: 'auth', exp: Math.floor(Date.now() / 1000) + 7 * 86_400 }));
  return `eyJhbGciOiJIUzI1NiJ9.${payload.replace(/=+$/, '')}.${name}`;
}

const record = { id: 'u1', collectionId: 'c_users', collectionName: 'users', username: 'anna', name: 'Anna', role: 'user' };

const REFRESH = '/api/collections/users/auth-refresh';

let visibility: DocumentVisibilityState;
let refresh: (() => Promise<unknown>) | null;

function refreshCalls(send: MockInstance<typeof pb.send>): number {
  return send.mock.calls.filter(([path]) => path === REFRESH).length;
}

/** Fires the due timers and lets the promises of the checks settle. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

let send: MockInstance<typeof pb.send>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T18:00:00Z'));
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  pb.authStore.save(token('start'), record);
  refresh = null;
  send = vi.spyOn(pb, 'send').mockImplementation(async (path: string) => {
    if (path === REFRESH) return refresh ? refresh() : { token: token(`t${Date.now()}`), record };
    return {};
  });
});

afterEach(() => {
  pb.authStore.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('periodic session checks while visible (FLOW-3/4, FLOW-9)', () => {
  it('every 60 s – counted from the last check, whatever started it', async () => {
    const { unmount } = renderHook(() => useSessionCheck());
    await advance(0);
    expect(refreshCalls(send)).toBe(1); // at start
    await advance(60_000);
    expect(refreshCalls(send)).toBe(2);
    await advance(30_000);
    await act(() => checkSession().then(() => undefined)); // e.g. a realtime reconnect at 90 s
    expect(refreshCalls(send)).toBe(3);
    await advance(50_000); // 140 s: the old interval would have checked at 120 s – no need
    expect(refreshCalls(send)).toBe(3);
    await advance(10_000); // 150 s = 60 s after the last check
    expect(refreshCalls(send)).toBe(4);
    // never more than a minute apart: before, an interval of 5 min with a throttle of 2.5 min left gaps of 7.5 min
    unmount();
    await advance(10 * 60_000);
    expect(refreshCalls(send)).toBe(4); // not mounted: no timer
  });

  it('no checks while hidden; becoming visible checks when one is due', async () => {
    const { unmount } = renderHook(() => useSessionCheck());
    await advance(0);
    visibility = 'hidden';
    await advance(10 * 60_000);
    expect(refreshCalls(send)).toBe(1);
    visibility = 'visible';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refreshCalls(send)).toBe(2);
    await advance(60_000);
    expect(refreshCalls(send)).toBe(3); // and the minute goes on
    unmount();
  });

  it('a check of the last seconds counts (e.g. the realtime connect right after the start)', async () => {
    await act(() => checkSession().then(() => undefined));
    expect(await checkSession(15_000)).toBe('valid');
    expect(refreshCalls(send)).toBe(1);
    // concurrent callers share one request
    let answer = () => {};
    refresh = () => new Promise((resolve) => (answer = () => resolve({ token: token('x'), record })));
    const first = checkSession();
    const second = checkSession();
    expect(refreshCalls(send)).toBe(2);
    answer();
    expect(await first).toBe('valid');
    expect(await second).toBe('valid');
  });
});

describe('a revoked token ends the session', () => {
  const revoked = () => Promise.reject(new ClientResponseError({ status: 401, response: { status: 401, message: 'x', data: {} } }));

  it('disabled user (idle app): logged out by the next check – within a minute – with one message', async () => {
    const error = vi.spyOn(toast, 'error');
    const { result, unmount } = renderHook(() => ({ user: useCurrentUser(), session: useSessionCheck() }));
    await advance(0);
    expect(result.current.user?.id).toBe('u1');
    refresh = revoked; // the admin disabled the account: PocketBase refreshed its tokenKey
    await advance(SESSION_CHECK_INTERVAL_MS);
    expect(pb.authStore.token).toBe('');
    expect(result.current.user).toBeNull();
    await advance(10); // the toast follows in the next task
    expect(error).toHaveBeenCalledExactlyOnceWith(SESSION_EXPIRED_MESSAGE, { id: 'session-expired' });
    toast.dismiss();
    unmount();
  });

  it('password reset by an admin, found by a tap (a guest-style denial): the screen\'s message is the only one', async () => {
    const error = vi.spyOn(toast, 'error');
    refresh = revoked;
    const check = checkSession(); // app/queryClient.ts on the 400 of the booking
    expect(await check).toBe('invalid');
    // the tap's own error toast with the session text (the error became a 401) comes first …
    toast.error(SESSION_EXPIRED_MESSAGE, { id: 'booking' });
    await advance(0);
    // … so the session's toast is not shown a second time
    expect(error.mock.calls.map(([message, options]) => [message, (options as { id: string }).id])).toEqual([
      [SESSION_EXPIRED_MESSAGE, 'booking'],
    ]);
    toast.dismiss();
  });

  it('a 401 of a token that was replaced meanwhile (re-login) does not end the new session', async () => {
    refresh = async () => {
      pb.authStore.save(token('relogin'), record);
      throw new ClientResponseError({ status: 401, response: { status: 401, message: 'x', data: {} } });
    };
    expect(await checkSession()).toBe('unknown');
    expect(pb.authStore.token).toContain('relogin');
  });

  it('PocketBase\'s 403 (auth rule: disabled) ends it as well; afterwards the session counts as revoked', async () => {
    refresh = () =>
      Promise.reject(
        new ClientResponseError({
          status: 403,
          response: { status: 403, message: "The request doesn't satisfy the collection requirements to authenticate.", data: {} },
        }),
      );
    expect(sessionWasRevoked()).toBe(false);
    expect(await checkSession()).toBe('invalid');
    expect(pb.authStore.token).toBe('');
    expect(sessionWasRevoked()).toBe(true);
    await advance(10);
    toast.dismiss();
  });
});

describe('only PocketBase\'s own answer ends a session (M1)', () => {
  /** What the SDK makes of a page that is not PocketBase's JSON: `response` is `{}`. */
  const page = (status: number) => () => Promise.reject(new ClientResponseError({ status, data: {} }));

  it('a reverse proxy\'s 404 page (Traefik while the app container restarts) keeps the session – periodic check', async () => {
    const error = vi.spyOn(toast, 'error');
    const { result, unmount } = renderHook(() => ({ user: useCurrentUser(), session: useSessionCheck() }));
    await advance(0);
    refresh = page(404);
    await advance(SESSION_CHECK_INTERVAL_MS);
    expect(refreshCalls(send)).toBe(2);
    expect(pb.authStore.token).toContain('.t'); // still the refreshed token of the first check
    expect(result.current.user?.id).toBe('u1');
    // … and the next minute, the server is back: still logged in
    refresh = null;
    await advance(SESSION_CHECK_INTERVAL_MS);
    expect(refreshCalls(send)).toBe(3);
    expect(result.current.user?.id).toBe('u1');
    expect(error).not.toHaveBeenCalled();
    unmount();
  });

  it('403 / 401 pages of something in front of PocketBase and every 5xx keep it, too (captive portal, WAF)', async () => {
    for (const status of [401, 403, 404, 500, 502, 503, 504]) {
      refresh = page(status);
      expect(await checkSession()).toBe('unknown');
      expect(pb.authStore.token).not.toBe('');
    }
    // a JSON body of another kind is no PocketBase answer either
    refresh = () => Promise.reject(new ClientResponseError({ status: 404, response: { message: 'no Route matched' } }));
    expect(await checkSession()).toBe('unknown');
    expect(pb.authStore.token).not.toBe('');
    expect(sessionWasRevoked()).toBe(false);
  });

  it('a real revoked token (PocketBase\'s JSON 401) still ends it', async () => {
    refresh = () => Promise.reject(new ClientResponseError({ status: 401, response: { status: 401, message: 'x', data: {} } }));
    expect(await checkSession()).toBe('invalid');
    expect(pb.authStore.token).toBe('');
    await advance(10);
    toast.dismiss();
  });
});

describe('a check without an answer (L6)', () => {
  /** A request that never answers – it only ends when its signal aborts (like fetch). */
  function hangingSend(aborted: { count: number }) {
    return async (path: string, options?: { signal?: AbortSignal }) => {
      if (path !== REFRESH) return {};
      return new Promise((_, reject) => {
        options?.signal?.addEventListener('abort', () => {
          aborted.count += 1;
          reject(new ClientResponseError({ isAbort: true }));
        });
      });
    };
  }

  it('is given up after SESSION_CHECK_TIMEOUT_MS: "unknown", the session stays, later checks run', async () => {
    const aborted = { count: 0 };
    send.mockImplementation(hangingSend(aborted) as never);
    const { result, unmount } = renderHook(() => ({ user: useCurrentUser(), session: useSessionCheck() }));
    let status: string | undefined;
    void checkSession().then((value) => (status = value)); // shares the start's check
    await advance(SESSION_CHECK_TIMEOUT_MS - 1);
    expect(status).toBeUndefined();
    await advance(1);
    expect(status).toBe('unknown');
    expect(aborted.count).toBe(1);
    expect(result.current.user?.id).toBe('u1');

    // the next check is not stuck behind it: a minute after the last start, and it answers
    send.mockImplementation(async (path: string) => (path === REFRESH ? { token: token('back'), record } : {}));
    await advance(SESSION_CHECK_INTERVAL_MS - SESSION_CHECK_TIMEOUT_MS);
    expect(refreshCalls(send)).toBe(2);
    expect(pb.authStore.token).toContain('back');
    unmount();
  });
});

describe('several tabs of one browser', () => {
  it('the own password change in another tab: this tab subscribes again with the new token (FLOW-4)', () => {
    const { result } = renderHook(() => useSessionGeneration());
    const before = result.current;
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'gl.sessionGeneration', newValue: 'x' }));
    });
    expect(result.current).toBe(before + 1);
  });

  it('a token refresh in another tab changes nothing here: no new subscriptions, no re-render', () => {
    const generation = renderHook(() => useSessionGeneration());
    const user = renderHook(() => useCurrentUser());
    const before = { generation: generation.result.current, user: user.result.current };
    act(() => {
      const value = JSON.stringify({ token: token('refreshed'), record });
      window.localStorage.setItem('pocketbase_auth', value);
      window.dispatchEvent(new StorageEvent('storage', { key: 'pocketbase_auth', newValue: value }));
    });
    expect(pb.authStore.token).toContain('refreshed');
    expect(generation.result.current).toBe(before.generation);
    expect(user.result.current).toBe(before.user);
  });

  it('the own password change tells the other tabs', async () => {
    vi.spyOn(pb.collection('users'), 'authWithPassword').mockImplementation(async () => {
      pb.authStore.save(token('new'), record);
      return { token: pb.authStore.token, record };
    });
    const { result } = renderHook(() => useSessionGeneration());
    const before = result.current;
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    await act(() => changeOwnPassword({ oldPassword: 'a', password: 'bbbbbbbb', passwordConfirm: 'bbbbbbbb' }));
    expect(result.current).toBe(before + 1);
    expect(setItem).toHaveBeenCalledWith('gl.sessionGeneration', expect.any(String));
  });
});
