/**
 * Session handling on top of the SDK auth store (token in localStorage).
 */
import { ClientResponseError, type RecordModel } from 'pocketbase';
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { pb, usersCollection } from '../lib/pb';
import type { UserRecord } from '../lib/types';

function readUser(): UserRecord | null {
  const record = pb.authStore.record;
  if (!pb.authStore.token || !record || record.collectionName !== 'users') return null;
  return record as unknown as UserRecord;
}

// The LocalAuthStore getters re-parse localStorage on every access, so the
// snapshot for useSyncExternalStore is cached and refreshed on changes.
let snapshot: UserRecord | null = readUser();
pb.authStore.onChange(() => {
  snapshot = readUser();
});

function subscribe(onChange: () => void): () => void {
  return pb.authStore.onChange(() => {
    snapshot = readUser();
    onChange();
  });
}

function getSnapshot(): UserRecord | null {
  return snapshot;
}

/** The logged-in app user (collection `users`) or `null`. Re-renders on login/logout/refresh. */
export function useCurrentUser(): UserRecord | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getCurrentUser(): UserRecord | null {
  return getSnapshot();
}

export { isAdminUser as isAdmin } from '../lib/permissions';

// ---------------------------------------------------------------------------
// Session generation: incremented whenever the token is replaced by a (re-)
// login. PocketBase drops a client's realtime auth when the user's tokenKey
// changes (own password change), so realtime subscriptions are re-established
// with the new token whenever this number changes (see useRealtimeSync).

let generation = 0;
const generationListeners = new Set<() => void>();

function bumpGeneration(): void {
  generation += 1;
  for (const listener of generationListeners) listener();
}

export function useSessionGeneration(): number {
  return useSyncExternalStore(
    (listener) => {
      generationListeners.add(listener);
      return () => generationListeners.delete(listener);
    },
    () => generation,
    () => generation,
  );
}

// ---------------------------------------------------------------------------
// Login / logout

/** Usernames are stored lowercase (ARCHITECTURE.md §4). */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

// Password typed on the login form, kept in memory only (never persisted) so
// the mandatory password change right after login does not ask for it again.
let rememberedLoginPassword: string | null = null;

export function getRememberedLoginPassword(): string | null {
  return rememberedLoginPassword;
}

export function forgetRememberedLoginPassword(): void {
  rememberedLoginPassword = null;
}

let explicitLogout = false;

// > 0 while the own password is being changed (old token already revoked).
let reauthenticating = 0;

/** True after the user clicked "Abmelden" (until the next login). */
export function wasLoggedOutExplicitly(): boolean {
  return explicitLogout;
}

export async function login(username: string, password: string): Promise<UserRecord> {
  const result = await usersCollection().authWithPassword(normalizeUsername(username), password);
  explicitLogout = false;
  rememberedLoginPassword = result.record.mustChangePassword ? password : null;
  bumpGeneration();
  return result.record;
}

export function logout(): void {
  explicitLogout = true;
  rememberedLoginPassword = null;
  // Realtime subscriptions are torn down by useRealtimeSync when the user
  // becomes null; unsubscribe here as well so nothing lingers.
  pb.realtime.unsubscribe().catch(() => undefined);
  pb.authStore.clear();
}

/** Ends an invalid session (revoked/expired token) with a hint for the user. */
export function endSession(): void {
  if (!pb.authStore.token) return;
  rememberedLoginPassword = null;
  pb.authStore.clear();
  toast.error('Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.', { id: 'session-expired' });
}

// ---------------------------------------------------------------------------
// Refresh

export type SessionStatus = 'valid' | 'invalid' | 'unknown';

/**
 * Refreshes the auth token and user record. Invalid/expired/revoked tokens
 * (401/403/404) end the session; network errors keep it (the server may just
 * be unreachable for a moment).
 */
let refreshInFlight: Promise<SessionStatus> | null = null;

export function refreshSession(): Promise<SessionStatus> {
  // concurrent callers share one request
  refreshInFlight ??= doRefreshSession().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefreshSession(): Promise<SessionStatus> {
  if (!pb.authStore.token) return 'invalid';
  if (!pb.authStore.isValid) {
    endSession();
    return 'invalid';
  }
  if (reauthenticating > 0) return 'unknown';
  const token = pb.authStore.token;
  try {
    // Not `authRefresh()`: if the page unloads while the response body is
    // read, the SDK treats the response as `{}` and stores an empty auth
    // state (= logged out). Only a complete answer is stored here.
    const data = await pb.send<{ token?: string; record?: RecordModel }>('/api/collections/users/auth-refresh', {
      method: 'POST',
    });
    if (!data?.token || !data.record) return 'unknown';
    if (pb.authStore.token === token) pb.authStore.save(data.token, data.record);
    return 'valid';
  } catch (error) {
    if (error instanceof ClientResponseError && [401, 403, 404].includes(error.status)) {
      // only if the rejected token is still the current one (no re-login meanwhile)
      if (reauthenticating === 0 && pb.authStore.token === token) endSession();
      return 'invalid';
    }
    return 'unknown';
  }
}

let lastRefresh = 0;

/** Throttled refresh (app becomes visible, realtime reconnects, periodic check, suspicious errors). */
export function refreshSessionThrottled(minIntervalMs = 60_000): void {
  const now = Date.now();
  if (now - lastRefresh < minIntervalMs) return;
  lastRefresh = now;
  void refreshSession();
}

// ---------------------------------------------------------------------------
// Own password change

/** True while the own password is being changed (the old token is revoked by the server). */
export function isReauthenticating(): boolean {
  return reauthenticating > 0;
}

/**
 * Changes the own password (the server verifies `oldPassword`) and logs in
 * again with the new one: PocketBase revokes all existing tokens of the user
 * when the password changes.
 */
export async function changeOwnPassword(input: {
  oldPassword: string;
  password: string;
  passwordConfirm: string;
}): Promise<void> {
  const user = getSnapshot();
  if (!user) throw new Error('not logged in');
  reauthenticating++;
  try {
    // Plain request instead of `update()`: the SDK would copy the response into
    // the auth store right away – with the now revoked token – and the UI would
    // continue (e.g. leave the password screen) before the re-login finished.
    await pb.send(`/api/collections/users/records/${encodeURIComponent(user.id)}`, {
      method: 'PATCH',
      body: input,
    });
    await usersCollection().authWithPassword(user.username, input.password);
    rememberedLoginPassword = null;
    bumpGeneration();
  } finally {
    reauthenticating--;
  }
}

/** Applies a realtime update of the own user record to the auth store. */
export function applyOwnRecordUpdate(action: string, record: UserRecord): void {
  const current = getSnapshot();
  if (!current || current.id !== record.id) return;
  // During the own password change the re-login delivers the fresh record.
  if (reauthenticating > 0) return;
  if (action === 'delete' || record.disabled) {
    endSession();
    return;
  }
  pb.authStore.save(pb.authStore.token, { ...current, ...record });
}
