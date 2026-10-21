/**
 * Session handling on top of the SDK auth store (token in localStorage).
 *
 * A revoked token – account disabled, password reset by an admin, the own
 * password changed elsewhere – is not rejected by PocketBase's record
 * endpoints: they answer as for a guest (lists 200 without rows, creates 400,
 * views / deletes 404). And PocketBase drops the realtime connection's auth
 * *before* it broadcasts the user's record update (apis/realtime.go), so the
 * own-record event never arrives and the connection delivers nothing more.
 * The session is therefore checked (`auth-refresh`, 401 = revoked):
 * - at start and when the app becomes visible again (if the last check is a
 *   minute old),
 * - every 60 s while the app is visible – a disabled or reset account is
 *   logged out within about a minute,
 * - at once on a guest-style denial of a request (app/queryClient.ts) – the
 *   user then reads "Sitzung abgelaufen", not "keine Berechtigung",
 * - on every realtime (re)connect (api/realtime.ts).
 * Only PocketBase's own answer ends a session: a reverse proxy's 404 page
 * while the app container restarts, a captive portal, a timeout or a 5xx
 * mean "server unreachable" – the session stays (M1).
 */
import type { RecordModel } from 'pocketbase';
import { useEffect, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { isPocketBaseError } from '../lib/errors';
import { pb, usersCollection } from '../lib/pb';
import { writeStorage } from '../lib/storage';
import type { UserRecord } from '../lib/types';

function readUser(): UserRecord | null {
  const record = pb.authStore.record;
  if (!pb.authStore.token || !record || record.collectionName !== 'users') return null;
  return record as unknown as UserRecord;
}

/** Same fields, same values (the record has no nested objects that matter). */
function sameRecord(a: UserRecord | null, b: UserRecord | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a) as Array<keyof UserRecord>;
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]));
}

// The LocalAuthStore getters re-parse localStorage on every access, so the
// snapshot for useSyncExternalStore is cached and refreshed on changes. It is
// replaced only when the user record changed: the token is refreshed every
// minute (in every tab), which must not re-render the app each time.
let snapshot: UserRecord | null = readUser();

function updateSnapshot(): void {
  const next = readUser();
  if (!sameRecord(snapshot, next)) snapshot = next;
}

pb.authStore.onChange(updateSnapshot);

function subscribe(onChange: () => void): () => void {
  return pb.authStore.onChange(() => {
    updateSnapshot();
    onChange();
  });
}

function getSnapshot(): UserRecord | null {
  return snapshot;
}

/** The logged-in app user (collection `users`) or `null`. Re-renders on login/logout and changes of the record. */
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
// changes (password change), so realtime subscriptions are re-established
// with the new token whenever this number changes (see useRealtimeSync).
// After the own password change the other tabs of this browser follow through
// a localStorage key: the SDK hands them the new token (same user, so nothing
// else would re-subscribe – their realtime would stay deaf). A token refresh
// does not count: same tokenKey, and it happens every minute in every tab.

const GENERATION_KEY = 'gl.sessionGeneration';

let generation = 0;
const generationListeners = new Set<() => void>();

function bumpGeneration({ otherTabs }: { otherTabs: boolean }): void {
  generation += 1;
  for (const listener of generationListeners) listener();
  if (otherTabs) writeStorage(GENERATION_KEY, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    // the SDK's own storage listener has applied the new token by now (its key was written first)
    if (event.key === GENERATION_KEY && event.newValue) bumpGeneration({ otherTabs: false });
  });
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
  sessionChecked('valid');
  // other tabs follow the new user through the SDK's storage event (user change → new subscriptions)
  bumpGeneration({ otherTabs: false });
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

/** The toast of an ended session (also the text of a 401, lib/errors.ts). */
export const SESSION_EXPIRED_MESSAGE = 'Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.';

/** Ends an invalid session (revoked/expired token) with a hint for the user. */
export function endSession(): void {
  if (!pb.authStore.token) return;
  rememberedLoginPassword = null;
  lastStatus = 'invalid';
  pb.authStore.clear();
  // After the current task: an action that failed because of the session
  // shows this very text in its own error toast (the error is a 401 by then,
  // app/queryClient.ts) – then once is enough.
  window.setTimeout(showSessionExpired, 0);
}

function showSessionExpired(): void {
  const shown = toast.getToasts().some((item) => 'title' in item && item.title === SESSION_EXPIRED_MESSAGE);
  if (!shown) toast.error(SESSION_EXPIRED_MESSAGE, { id: 'session-expired' });
}

// ---------------------------------------------------------------------------
// Session checks

export type SessionStatus = 'valid' | 'invalid' | 'unknown';

/** While the app is visible, the session is checked at least this often. */
export const SESSION_CHECK_INTERVAL_MS = 60_000;

/**
 * A check without an answer after this long is given up: "unknown" (the
 * session stays). Without it a stalled request (weak Wi-Fi, a captive portal)
 * held every later check – the periodic timer is armed by checks – and every
 * mutation error that waits for a check (app/queryClient.ts) (L6).
 */
export const SESSION_CHECK_TIMEOUT_MS = 10_000;

let checkInFlight: Promise<SessionStatus> | null = null;
let lastCheckStarted = 0;
let lastStatus: SessionStatus = 'unknown';
/** > 0 while useSessionCheck is mounted: the periodic checks run. */
let periodicUsers = 0;
let periodicTimer: ReturnType<typeof setTimeout> | undefined;

function sessionChecked(status: SessionStatus): void {
  lastStatus = status;
  lastCheckStarted = Date.now();
  armPeriodicCheck(true);
}

/**
 * The next periodic check: a minute after the last check, whatever started
 * it (an interval that ignored the other checks could be up to 7.5 min apart
 * – FLOW-9). `restart`: count from the last check (a check just started);
 * otherwise an armed timer is kept.
 */
function armPeriodicCheck(restart: boolean): void {
  if (periodicTimer !== undefined) {
    if (!restart) return;
    clearTimeout(periodicTimer);
    periodicTimer = undefined;
  }
  if (periodicUsers === 0) return;
  const due = lastCheckStarted + SESSION_CHECK_INTERVAL_MS - Date.now();
  periodicTimer = setTimeout(() => {
    periodicTimer = undefined;
    // hidden: no check – becoming visible checks (and arms the timer again)
    if (document.visibilityState === 'visible') void checkSession();
  }, Math.max(due, 0));
}

/**
 * Checks the session: refreshes the token and the user record; a revoked or
 * expired token (PocketBase's 401/403/404) ends the session; network errors,
 * timeouts, server errors and pages of a proxy keep it (the server may just be
 * unreachable for a moment). Concurrent callers share one request. With
 * `maxAgeMs`, a check that started less than that ago counts (its result, or
 * the running check).
 */
export function checkSession(maxAgeMs = 0): Promise<SessionStatus> {
  if (checkInFlight) return checkInFlight;
  if (maxAgeMs > 0 && Date.now() - lastCheckStarted < maxAgeMs) {
    armPeriodicCheck(false);
    return Promise.resolve(lastStatus);
  }
  lastCheckStarted = Date.now();
  armPeriodicCheck(true);
  const running: Promise<SessionStatus> = doCheckSession()
    .then((status) => {
      lastStatus = status;
      return status;
    })
    .finally(() => {
      if (checkInFlight === running) checkInFlight = null;
    });
  checkInFlight = running;
  return running;
}

/** Checks the session now (see checkSession). */
export function refreshSession(): Promise<SessionStatus> {
  return checkSession();
}

/** Checks the session unless the last check started less than `minIntervalMs` ago. */
export function refreshSessionThrottled(minIntervalMs = SESSION_CHECK_INTERVAL_MS): void {
  void checkSession(minIntervalMs);
}

/** True after a check (or the own record's deletion) ended the session – until the next login. */
export function sessionWasRevoked(): boolean {
  return !pb.authStore.token && lastStatus === 'invalid';
}

async function doCheckSession(): Promise<SessionStatus> {
  if (!pb.authStore.token) return 'invalid';
  if (!pb.authStore.isValid) {
    endSession();
    return 'invalid';
  }
  if (reauthenticating > 0) return 'unknown';
  const token = pb.authStore.token;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), SESSION_CHECK_TIMEOUT_MS);
  try {
    // Not `authRefresh()`: if the page unloads while the response body is
    // read, the SDK treats the response as `{}` and stores an empty auth
    // state (= logged out). Only a complete answer is stored here.
    const data = await pb.send<{ token?: string; record?: RecordModel }>('/api/collections/users/auth-refresh', {
      method: 'POST',
      signal: timeout.signal,
    });
    if (!data?.token || !data.record) return 'unknown';
    if (pb.authStore.token === token) pb.authStore.save(data.token, data.record);
    return 'valid';
  } catch (error) {
    // PocketBase's own 401 (token invalid), 403 (auth rule: disabled) or 404
    // (no auth record) – not the same statuses from a proxy in front of it
    // (Traefik's "404 page not found" while the container restarts): those,
    // like network errors and the timeout (an abort), leave the session alone.
    if (isPocketBaseError(error) && [401, 403, 404].includes(error.status)) {
      // only if the rejected token is still the current one (no re-login meanwhile)
      if (reauthenticating === 0 && pb.authStore.token === token) {
        endSession();
        return 'invalid';
      }
      return 'unknown';
    }
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The checks of a running app (app/RootLayout.tsx): at start, when the app
 * becomes visible again (if the last check is a minute old) and every minute
 * while it is visible.
 */
export function useSessionCheck(): void {
  useEffect(() => {
    periodicUsers += 1;
    void checkSession();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void checkSession(SESSION_CHECK_INTERVAL_MS);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      periodicUsers -= 1;
      if (periodicUsers === 0 && periodicTimer !== undefined) {
        clearTimeout(periodicTimer);
        periodicTimer = undefined;
      }
    };
  }, []);
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
 * when the password changes – also those of the other tabs, which follow
 * (session generation).
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
    sessionChecked('valid');
    bumpGeneration({ otherTabs: true });
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
  // (Disabling refreshes the tokenKey: PocketBase then no longer delivers this
  // event – the session checks end the session. A deletion does arrive.)
  if (action === 'delete' || record.disabled) {
    endSession();
    return;
  }
  pb.authStore.save(pb.authStore.token, { ...current, ...record });
}
