import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Outlet } from 'react-router';
import { Toaster } from 'sonner';
import { useRealtimeSync } from '../api/realtime';
import {
  refreshSession,
  refreshSessionThrottled,
  useCurrentUser,
  useSessionGeneration,
} from '../auth/session';

const toastOffset = { bottom: 'calc(5.5rem + env(safe-area-inset-bottom))' };

/** While visible, the session is re-checked this often (disabled/reset users are logged out). */
const SESSION_CHECK_INTERVAL_MS = 5 * 60_000;

export function RootLayout() {
  const user = useCurrentUser();
  const sessionGeneration = useSessionGeneration();
  const queryClient = useQueryClient();
  useRealtimeSync(user, sessionGeneration);

  // Validate / extend the stored token on start, whenever the app comes back
  // to the foreground and periodically while it is visible (revoked or
  // expired tokens end the session).
  useEffect(() => {
    void refreshSession();
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshSessionThrottled();
    };
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') refreshSessionThrottled(SESSION_CHECK_INTERVAL_MS / 2);
    }, SESSION_CHECK_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(interval);
    };
  }, []);

  // Drop cached data of the previous user on logout / user switch.
  const previousUserId = useRef(user?.id);
  useEffect(() => {
    if (previousUserId.current && previousUserId.current !== user?.id) queryClient.clear();
    previousUserId.current = user?.id;
  }, [user?.id, queryClient]);

  return (
    <>
      <Outlet />
      <Toaster
        position="bottom-center"
        theme="system"
        richColors
        visibleToasts={3}
        offset={toastOffset}
        mobileOffset={toastOffset}
        containerAriaLabel="Benachrichtigungen"
        toastOptions={{
          duration: 4000,
          classNames: {
            toast: 'rounded-2xl! text-[15px]! shadow-lg! print:hidden',
            actionButton: 'h-12! rounded-xl! bg-primary! px-4! text-sm! font-bold! text-on-primary!',
          },
        }}
      />
    </>
  );
}
