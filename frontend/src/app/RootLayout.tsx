import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Outlet } from 'react-router';
import { Toaster } from 'sonner';
import { useMidnightRefresh } from '../api/midnight';
import { useRealtimeSync } from '../api/realtime';
import { useCurrentUser, useSessionCheck, useSessionGeneration } from '../auth/session';

const toastOffset = { bottom: 'calc(5.5rem + env(safe-area-inset-bottom))' };

export function RootLayout() {
  const user = useCurrentUser();
  const sessionGeneration = useSessionGeneration();
  const queryClient = useQueryClient();
  useRealtimeSync(user, sessionGeneration);
  // Validate / extend the stored token on start, when the app comes back to
  // the foreground and every minute while it is visible (revoked or expired
  // tokens end the session).
  useSessionCheck();
  // "Heute" / 7 / 30 Tage move on at local midnight.
  useMidnightRefresh();

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
