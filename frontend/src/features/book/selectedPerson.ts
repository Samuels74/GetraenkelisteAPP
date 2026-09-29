/**
 * The currently selected person on the booking screen, persisted in
 * localStorage (key `gl.selectedPersonId`) like in the legacy app and synced
 * across tabs.
 */
import { ClientResponseError } from 'pocketbase';
import { useSyncExternalStore } from 'react';
import { refreshSession, type SessionStatus } from '../../auth/session';
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
 * valid AND the person itself answers 404 is it really gone. A revoked or
 * expired token also yields empty lists / 404s – that must never cost the
 * bartender the selection.
 */
export async function isPersonConfirmedGone(id: string, deps: GoneCheckDeps = defaultDeps): Promise<boolean> {
  if ((await deps.checkSession()) !== 'valid') return false;
  try {
    await deps.fetchPerson(id);
    return false; // still there – the list was just stale
  } catch (error) {
    return error instanceof ClientResponseError && error.status === 404;
  }
}
