import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ClientResponseError } from 'pocketbase';
import { isReauthenticating, refreshSession, refreshSessionThrottled } from '../auth/session';
import { pb } from '../lib/pb';

/**
 * - 401 from the API: the session is checked right away and ends if the
 *   current token is invalid (→ the route guard shows the login). A stale 401
 *   of a request sent before a re-login does not end the new session.
 * - A revoked token (disabled user, password reset by an admin) is treated by
 *   PocketBase like a guest: denials come back as 400/403/404. Such errors
 *   therefore trigger a (throttled) session check that logs out if needed.
 */
export function handleGlobalError(error: unknown): void {
  if (!(error instanceof ClientResponseError) || !pb.authStore.token || isReauthenticating()) return;
  if (error.status === 401) {
    void refreshSession();
    return;
  }
  const data = (error.response as { data?: Record<string, unknown> } | undefined)?.data;
  const hasFieldErrors = Boolean(data && Object.keys(data).length > 0);
  if (error.status === 403 || error.status === 404 || (error.status === 400 && !hasFieldErrors)) {
    refreshSessionThrottled(10_000);
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleGlobalError }),
  mutationCache: new MutationCache({ onError: handleGlobalError }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      retry: (failureCount, error) => {
        if (error instanceof ClientResponseError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },
});
