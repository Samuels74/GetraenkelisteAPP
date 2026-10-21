/**
 * The currently selected person on the booking screen, persisted in
 * localStorage (key `gl.selectedPersonId`) like in the legacy app and synced
 * across tabs.
 */
import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { queryKeys } from '../../api/queries';
import { refreshSession, type SessionStatus } from '../../auth/session';
import { isPocketBaseNotFound } from '../../lib/errors';
import { personsCollection } from '../../lib/pb';
import { readStorage, writeStorage } from '../../lib/storage';

export const SELECTED_PERSON_KEY = 'gl.selectedPersonId';

const listeners = new Set<() => void>();

export function getSelectedPersonId(): string | null {
  return readStorage(SELECTED_PERSON_KEY);
}

export function setSelectedPersonId(id: string | null): void {
  if (getSelectedPersonId() === id) return;
  writeStorage(SELECTED_PERSON_KEY, id);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === SELECTED_PERSON_KEY || event.key === null) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function useSelectedPersonId(): string | null {
  return useSyncExternalStore(subscribe, getSelectedPersonId, () => null);
}

/**
 * The remembered person on its own (≈1 KB) while the person list is not
 * loaded yet – at app start the list takes seconds on a slow network, and
 * without this the card claimed "Keine Person ausgewählt" meanwhile. The key
 * starts with `persons`, so person events invalidate it like the list.
 */
export function useRememberedPerson(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: [...queryKeys.persons, 'one', id ?? ''],
    queryFn: () => personsCollection().getOne(id ?? ''),
    enabled: enabled && Boolean(id),
  });
}

/**
 * PocketBase's 404: the person (or, with a revoked token, everything) is not
 * there – see isPersonConfirmedGone. (A proxy's 404 page while the server
 * restarts says nothing about the person.)
 */
export function isNotFound(error: unknown): boolean {
  return isPocketBaseNotFound(error);
}

interface GoneCheckDeps {
  checkSession: () => Promise<SessionStatus>;
  fetchPerson: (id: string) => Promise<unknown>;
}

const defaultDeps: GoneCheckDeps = {
  checkSession: refreshSession,
  fetchPerson: (id) => personsCollection().getOne(id),
};

/**
 * The selected person is missing from the person list. Only if the session is
 * valid AND PocketBase itself answers 404 for the person is it really gone. A
 * revoked or expired token also yields empty lists / 404s, a proxy answers 404
 * while the server restarts – that must never cost the bartender the selection.
 */
export async function isPersonConfirmedGone(id: string, deps: GoneCheckDeps = defaultDeps): Promise<boolean> {
  if ((await deps.checkSession()) !== 'valid') return false;
  try {
    await deps.fetchPerson(id);
    return false; // still there – the list was just stale
  } catch (error) {
    return isPocketBaseNotFound(error);
  }
}
