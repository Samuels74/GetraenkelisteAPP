/**
 * PocketBase SDK helpers for Node. One SDK client per logged-in identity:
 * each client gets its own in-memory auth store (never a shared storage key)
 * and auto-cancellation is off – otherwise concurrent requests with the same
 * request key (e.g. many booking creates) would cancel each other.
 */
import PocketBase, { BaseAuthStore, ClientResponseError } from 'pocketbase';

export interface SuperuserCredentials {
  email: string;
  password: string;
}

export function createClient(url: string): PocketBase {
  const pb = new PocketBase(url, new BaseAuthStore());
  pb.autoCancellation(false);
  return pb;
}

/** Hint for HTTP 429 on logins: the app's login throttling (migration 1790550002). */
function loginFailure(what: string, url: string, error: unknown): Error {
  const { status, message } = describeError(error);
  const hint =
    status === 429
      ? ' – the login rate limiter allows 10 logins / 60 s per client IP: wait a minute or switch it off ' +
        '(dashboard → Settings → Rate limits, or setRateLimiting())'
      : '';
  return new Error(`${what} at ${url} failed: ${message}${hint}`, { cause: error });
}

export async function loginSuperuser(url: string, credentials: SuperuserCredentials): Promise<PocketBase> {
  const pb = createClient(url);
  try {
    await pb.collection('_superusers').authWithPassword(credentials.email, credentials.password);
  } catch (error) {
    throw loginFailure(`superuser login (${credentials.email})`, url, error);
  }
  return pb;
}

/** Logs in an app user (collection `users`). */
export async function loginUser(url: string, username: string, password: string): Promise<PocketBase> {
  const pb = createClient(url);
  try {
    await pb.collection('users').authWithPassword(username, password);
  } catch (error) {
    throw loginFailure(`login of "${username}"`, url, error);
  }
  return pb;
}

/** Number of records (optionally matching a filter) – one request with the total count. */
export async function countRecords(pb: PocketBase, collection: string, filter = ''): Promise<number> {
  const result = await pb.collection(collection).getList(1, 1, { filter, fields: 'id' });
  return result.totalItems;
}

export interface RateLimitRule {
  label: string;
  audience: string;
  duration: number;
  maxRequests: number;
}

export interface RateLimitSettings {
  enabled: boolean;
  rules: RateLimitRule[];
}

/** The rate limiter settings (superuser client). */
export async function getRateLimits(superuser: PocketBase): Promise<RateLimitSettings> {
  const settings = (await superuser.settings.getAll()) as { rateLimits?: RateLimitSettings };
  if (!settings.rateLimits) throw new Error('the settings response has no rateLimits');
  return settings.rateLimits;
}

/**
 * Switches PocketBase's rate limiter on or off (superuser client); the rules
 * themselves – the app's login throttling `*:auth` 10 / 60 s per IP from
 * migration 1790550002 – stay untouched. Verifies the stored result.
 */
export async function setRateLimiting(superuser: PocketBase, enabled: boolean): Promise<RateLimitSettings> {
  const settings = (await superuser.settings.update({ rateLimits: { enabled } })) as { rateLimits?: RateLimitSettings };
  if (settings.rateLimits?.enabled !== enabled) {
    throw new Error(`could not ${enabled ? 'enable' : 'disable'} the rate limiter: ${JSON.stringify(settings.rateLimits)}`);
  }
  return settings.rateLimits;
}

export interface ErrorInfo {
  /** HTTP status; 0 = no response (network error, abort). */
  status: number;
  message: string;
}

/** Status and a one-line message (incl. field errors) for any thrown value. */
export function describeError(error: unknown): ErrorInfo {
  if (error instanceof ClientResponseError) {
    const response = error.response as { message?: string; data?: Record<string, { message?: string }> };
    const fields = Object.entries(response?.data ?? {})
      .map(([field, detail]) => `${field}: ${detail?.message ?? JSON.stringify(detail)}`)
      .join('; ');
    let message = response?.message || error.message || 'request failed';
    if (fields) message += ` (${fields})`;
    if (error.status === 0) {
      const cause = error.originalError instanceof Error ? error.originalError : undefined;
      message = error.isAbort ? 'request aborted' : `no response: ${cause?.cause ?? cause?.message ?? message}`;
    }
    return { status: error.status, message: error.status ? `HTTP ${error.status}: ${message}` : message };
  }
  return { status: 0, message: error instanceof Error ? error.message : String(error) };
}
