import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import type { ClientResponseError } from 'pocketbase';
import { realtimeCatchUpPending } from '../api/realtime';
import { realtimeStaleTime } from '../api/queries';
import {
  checkSession,
  isReauthenticating,
  SESSION_CHECK_TIMEOUT_MS,
  sessionWasRevoked,
  type SessionStatus,
} from '../auth/session';
import { isGenericEnglishMessage, isPocketBaseError } from '../lib/errors';
import { pb } from '../lib/pb';

/**
 * A denial as PocketBase gives it to a guest: 403, 404, or 400 without field
 * errors (a denied create) – with one of PocketBase's generic messages. A
 * message of our hooks (German: inactive offering, delete guards, last admin,
 * "inzwischen keine Berechtigung") is a real answer for this user and needs no
 * session check – it would only delay the message by a round trip.
 */
function isGuestStyleDenial(error: ClientResponseError): boolean {
  const response = error.response as { message?: string; data?: Record<string, unknown> };
  if (response.message && !isGenericEnglishMessage(response.message)) return false;
  if (error.status === 403 || error.status === 404) return true;
  if (error.status !== 400) return false;
  return !response.data || Object.keys(response.data).length === 0;
}

/** The check's verdict – or "unknown" once it took longer than a check may (it is aborted then anyway). */
function sessionVerdict(): Promise<SessionStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SessionStatus>((resolve) => {
    timer = setTimeout(() => resolve('unknown'), SESSION_CHECK_TIMEOUT_MS);
  });
  return Promise.race([checkSession(), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Errors of queries and mutations with a session:
 * - 401, or a denial as PocketBase gives it to a guest – which is also what a
 *   revoked token gets (disabled user, password reset by an admin): the
 *   session is checked at once (concurrent errors share one check). If it has
 *   ended, the error is a 401 from then on: the screen's own message reads
 *   "Deine Sitzung ist abgelaufen …" instead of "dafür fehlt dir die
 *   Berechtigung", and the login follows. TanStack waits for this before a
 *   mutation's caller sees the error, so a tap shows the right message – at
 *   most SESSION_CHECK_TIMEOUT_MS later (a check without an answer is "unknown").
 * - Only PocketBase's own answers count: the same statuses from a proxy in
 *   front of it (a 404 page while the app container restarts) mean "server
 *   unreachable" – no check, no logout (M1).
 * - A request that was on its way when a check ended the session: its denial
 *   is the session's as well (no "dafür fehlt dir die Berechtigung" next to
 *   "Sitzung abgelaufen").
 * - A stale 401 of a request sent before a re-login does not end the new
 *   session (session.ts checks the current token).
 */
export function handleGlobalError(error: unknown): Promise<void> | undefined {
  if (!isPocketBaseError(error) || isReauthenticating()) return undefined;
  if (error.status !== 401 && !isGuestStyleDenial(error)) return undefined;
  if (!pb.authStore.token) {
    if (sessionWasRevoked()) error.status = 401;
    return undefined;
  }
  return sessionVerdict().then((status) => {
    if (status === 'invalid') error.status = 401;
  });
}

/**
 * Focus / `online`: no refetch while a realtime reconnect is pending – it
 * refetches everything once connected; both together loaded everything twice
 * after every unlock (FLOW-6). While realtime is connected nothing goes stale
 * by time (realtimeStaleTime), so only failed or invalidated queries refetch.
 */
const refetchUnlessRealtimeCatchesUp = () => !realtimeCatchUpPending();

/**
 * `networkMode: 'always'`: requests are sent even while the browser reports
 * "offline" and fail at once ("Keine Verbindung zum Server …"). TanStack's
 * default ('online') pauses them instead and sends them when the network
 * returns – an invisible offline queue: taps made without a connection booked
 * minutes later, for the person selected at tap time, and abandoned
 * cancellations ran anyway. There is no offline mode (ARCHITECTURE.md §6).
 * With 'always' TanStack no longer refetches on reconnect by default
 * (`refetchOnReconnect` defaults to `networkMode !== 'always'`): it is set
 * again, so what failed while offline loads once the network is back (by the
 * realtime reconnect, if one is pending – see above).
 */
export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (error) => void handleGlobalError(error) }),
  // a mutation's caller sees the error only after this (the session check) has settled
  mutationCache: new MutationCache({ onError: (error) => handleGlobalError(error) }),
  defaultOptions: {
    queries: {
      networkMode: 'always',
      refetchOnReconnect: refetchUnlessRealtimeCatchesUp,
      refetchOnWindowFocus: refetchUnlessRealtimeCatchesUp,
      // never stale by time while realtime is connected, else after 30 s (api/queries.ts)
      staleTime: realtimeStaleTime,
      gcTime: 10 * 60_000,
      // PocketBase's 4xx are answers (retrying changes nothing); network errors,
      // 5xx and a proxy's pages (the app restarting) are worth two more tries
      retry: (failureCount, error) => {
        if (isPocketBaseError(error) && error.status < 500) return false;
        return failureCount < 2;
      },
    },
    mutations: {
      networkMode: 'always',
      retry: false,
    },
  },
});
