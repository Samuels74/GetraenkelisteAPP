import { ClientResponseError } from 'pocketbase';
import type * as SessionModule from '../auth/session';
import { pb } from '../lib/pb';
import { handleGlobalError } from './queryClient';

const session = vi.hoisted(() => ({
  refreshSession: vi.fn(() => Promise.resolve('valid' as const)),
  refreshSessionThrottled: vi.fn(),
  reauth: false,
}));
vi.mock('../auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionModule>()),
  refreshSession: session.refreshSession,
  refreshSessionThrottled: session.refreshSessionThrottled,
  isReauthenticating: () => session.reauth,
}));

const error = (status: number, data: Record<string, unknown> = {}) =>
  new ClientResponseError({ status, response: { status, message: 'x', data } });

describe('handleGlobalError', () => {
  beforeEach(() => {
    session.refreshSession.mockClear();
    session.refreshSessionThrottled.mockClear();
    session.reauth = false;
    pb.authStore.save('token', { id: 'u1', collectionName: 'users', collectionId: 'c' });
  });
  afterEach(() => pb.authStore.clear());

  it('checks the session immediately on 401 (instead of logging out blindly)', () => {
    handleGlobalError(error(401));
    expect(session.refreshSession).toHaveBeenCalledOnce();
  });

  it('checks the session (throttled) on denials that a revoked token produces', () => {
    handleGlobalError(error(403));
    handleGlobalError(error(404));
    handleGlobalError(error(400));
    expect(session.refreshSessionThrottled).toHaveBeenCalledTimes(3);
  });

  it('ignores validation errors, other statuses and the re-login phase', () => {
    handleGlobalError(error(400, { name: { code: 'validation_required' } }));
    handleGlobalError(error(500));
    handleGlobalError(error(429));
    session.reauth = true;
    handleGlobalError(error(401));
    expect(session.refreshSession).not.toHaveBeenCalled();
    expect(session.refreshSessionThrottled).not.toHaveBeenCalled();
  });

  it('does nothing without a session', () => {
    pb.authStore.clear();
    handleGlobalError(error(401));
    expect(session.refreshSession).not.toHaveBeenCalled();
  });
});
