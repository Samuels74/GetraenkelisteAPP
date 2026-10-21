/**
 * Whether the browser reports a network connection (TanStack Query's
 * onlineManager: the window's online/offline events). There is no offline
 * mode – requests are sent anyway and fail at once (networkMode 'always',
 * app/queryClient.ts); this only drives the "Keine Verbindung" banner and
 * disables the offering tiles while offline.
 */
import { onlineManager } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

function subscribe(listener: () => void): () => void {
  return onlineManager.subscribe(() => listener());
}

function isOnline(): boolean {
  return onlineManager.isOnline();
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, isOnline, () => true);
}
