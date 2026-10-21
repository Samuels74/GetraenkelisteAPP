import { ClientResponseError } from 'pocketbase';
import type * as RealtimeModule from '../api/realtime';
import type * as SessionModule from '../auth/session';
import { SESSION_CHECK_TIMEOUT_MS, SESSION_EXPIRED_MESSAGE } from '../auth/session';
import { errorMessage } from '../lib/errors';
import { pb } from '../lib/pb';
import { handleGlobalError, queryClient } from './queryClient';

const session = vi.hoisted(() => ({
  checkSession: vi.fn(() => Promise.resolve<'valid' | 'invalid' | 'unknown'>('valid')),
  reauth: false,
  revoked: false,
}));
vi.mock('../auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionModule>()),
  checkSession: session.checkSession,
  isReauthenticating: () => session.reauth,
  sessionWasRevoked: () => session.revoked,
}));

const realtime = vi.hoisted(() => ({ catchUpPending: false }));
vi.mock('../api/realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof RealtimeModule>()),
  realtimeCatchUpPending: () => realtime.catchUpPending,
}));

// PocketBase's generic English messages (replaced by German text in lib/errors.ts)
const error = (status: number, data: Record<string, unknown> = {}) =>
  new ClientResponseError({ status, response: { status, message: 'Failed to create record.', data } });

/** A page of a reverse proxy instead of PocketBase's JSON (the SDK's `response` is `{}`). */
const proxyPage = (status: number) => new ClientResponseError({ status, data: {} });

describe('handleGlobalError', () => {
  beforeEach(() => {
    session.checkSession.mockReset();
    session.checkSession.mockResolvedValue('valid');
    session.reauth = false;
    session.revoked = false;
    pb.authStore.save('token', { id: 'u1', collectionName: 'users', collectionId: 'c' });
  });
  afterEach(() => {
    pb.authStore.clear();
    vi.useRealTimers();
  });

  it('checks the session immediately on 401 (instead of logging out blindly)', async () => {
    await handleGlobalError(error(401));
    expect(session.checkSession).toHaveBeenCalledExactlyOnceWith();
  });

  it('checks the session at once – not throttled – on every denial that a revoked token produces', async () => {
    await handleGlobalError(error(403));
    await handleGlobalError(error(404));
    await handleGlobalError(error(400));
    expect(session.checkSession).toHaveBeenCalledTimes(3);
    for (const call of session.checkSession.mock.calls) expect(call).toEqual([]);
  });

  it('a denial of a revoked token becomes a 401: the message says the session ended (M4)', async () => {
    session.checkSession.mockResolvedValue('invalid');
    const denied = error(400); // a booking create of a disabled user
    expect(errorMessage(denied, 'bookings')).toBe(
      'Das ist nicht möglich – dafür fehlt dir die Berechtigung oder die Eingaben sind ungültig.',
    );
    await handleGlobalError(denied);
    expect(denied.status).toBe(401);
    expect(errorMessage(denied, 'bookings')).toBe(SESSION_EXPIRED_MESSAGE);
  });

  it('a denial with a valid session stays what it is (e.g. "already cancelled" = 404)', async () => {
    const gone = error(404);
    await handleGlobalError(gone);
    expect(gone.status).toBe(404);
    session.checkSession.mockResolvedValue('unknown'); // server unreachable: no verdict
    const denied = error(403);
    await handleGlobalError(denied);
    expect(denied.status).toBe(403);
  });

  it('a mutation reports its error only after the check – with the session message', async () => {
    session.checkSession.mockResolvedValue('invalid');
    const denied = error(400);
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: () => Promise.reject(denied),
    });
    await expect(mutation.execute(undefined)).rejects.toBe(denied);
    expect(denied.status).toBe(401);
    queryClient.getMutationCache().clear();
  });

  it('ignores validation errors, other statuses and the re-login phase', async () => {
    await handleGlobalError(error(400, { name: { code: 'validation_required' } }));
    await handleGlobalError(error(500));
    await handleGlobalError(error(429));
    session.reauth = true;
    await handleGlobalError(error(401));
    expect(session.checkSession).not.toHaveBeenCalled();
  });

  it('does nothing without a session', async () => {
    pb.authStore.clear();
    await handleGlobalError(error(401));
    expect(session.checkSession).not.toHaveBeenCalled();
    expect(errorMessage(error(400), 'bookings')).toContain('Berechtigung');
  });

  it('a reverse proxy\'s 404 / 403 / 401 page (app container restarting) is no denial: no check, no logout (M1)', async () => {
    session.checkSession.mockResolvedValue('invalid'); // would end the session
    for (const status of [401, 403, 404, 400]) {
      const page = proxyPage(status);
      expect(handleGlobalError(page)).toBeUndefined();
      expect(page.status).toBe(status);
    }
    expect(session.checkSession).not.toHaveBeenCalled();
    expect(errorMessage(proxyPage(404), 'bookings')).toBe(
      'Der Server ist gerade nicht erreichbar. Bitte versuche es gleich noch einmal.',
    );
  });

  it('our hooks\' German messages are real answers: no check, no extra round trip (N5)', async () => {
    const german = (status: number, message: string) =>
      new ClientResponseError({ status, response: { status, message, data: {} } });
    await handleGlobalError(german(400, 'Dieses Angebot ist nicht aktiv und kann nicht gebucht werden.'));
    await handleGlobalError(german(400, 'Diese Person hat Buchungen und kann nicht gelöscht werden.'));
    await handleGlobalError(german(403, 'Dafür fehlt dir inzwischen die Berechtigung.'));
    expect(session.checkSession).not.toHaveBeenCalled();
    // PocketBase's generic texts are what a revoked token gets: checked
    await handleGlobalError(german(404, "The requested resource wasn't found."));
    await handleGlobalError(german(403, 'The authorized record is not allowed to perform this action.'));
    expect(session.checkSession).toHaveBeenCalledTimes(2);
  });

  it('a denial that arrives after a check ended the session is the session\'s, too (N6)', async () => {
    pb.authStore.clear(); // the minute's check found the token revoked while the tap was on its way
    session.revoked = true;
    const denied = error(400);
    expect(handleGlobalError(denied)).toBeUndefined();
    expect(denied.status).toBe(401);
    expect(errorMessage(denied, 'bookings')).toBe(SESSION_EXPIRED_MESSAGE);
    expect(session.checkSession).not.toHaveBeenCalled();
    // validation errors stay what they are
    const invalid = error(400, { name: { code: 'validation_required' } });
    void handleGlobalError(invalid);
    expect(invalid.status).toBe(400);
  });

  it('a check without an answer holds a mutation\'s error at most SESSION_CHECK_TIMEOUT_MS (L6)', async () => {
    vi.useFakeTimers();
    session.checkSession.mockReturnValue(new Promise(() => {})); // hangs
    const denied = error(404);
    let reported = false;
    void handleGlobalError(denied)!.then(() => (reported = true));
    await vi.advanceTimersByTimeAsync(SESSION_CHECK_TIMEOUT_MS - 1);
    expect(reported).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(reported).toBe(true);
    expect(denied.status).toBe(404); // "unknown": nothing is assumed
  });
});

describe('the session message', () => {
  it('is the message of a 401 (lib/errors.ts): an ended session shows one text, once', () => {
    expect(errorMessage(error(401))).toBe(SESSION_EXPIRED_MESSAGE);
  });
});

describe('query defaults', () => {
  const defaults = () => queryClient.getDefaultOptions().queries!;

  it('never send requests into an offline queue (FLOW-1)', () => {
    expect(defaults().networkMode).toBe('always');
    expect(queryClient.getDefaultOptions().mutations!.networkMode).toBe('always');
  });

  it('focus / online refetch, except while a realtime reconnect is about to refetch everything (FLOW-6)', () => {
    const query = queryClient.getQueryCache().build(queryClient, { queryKey: ['x'] });
    for (const option of [defaults().refetchOnWindowFocus, defaults().refetchOnReconnect]) {
      expect(typeof option).toBe('function');
      const refetch = option as unknown as (q: typeof query) => boolean;
      realtime.catchUpPending = false;
      expect(refetch(query)).toBe(true);
      realtime.catchUpPending = true;
      expect(refetch(query)).toBe(false);
    }
    realtime.catchUpPending = false;
    queryClient.getQueryCache().clear();
  });

  it('data does not go stale by time while realtime is connected (FLOW-12)', () => {
    const query = queryClient.getQueryCache().build(queryClient, { queryKey: ['y'] });
    const staleTime = defaults().staleTime as unknown as (q: typeof query) => number;
    const connected = vi.spyOn(pb.realtime, 'isConnected', 'get').mockReturnValue(true);
    expect(staleTime(query)).toBe(Infinity);
    connected.mockReturnValue(false);
    expect(staleTime(query)).toBe(30_000);
    connected.mockRestore();
    queryClient.getQueryCache().clear();
  });
});
