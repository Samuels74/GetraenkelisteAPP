/**
 * Plain REST calls of the browser checks, with the tokens of ctx.logins (no
 * logins of their own – the login rate limiter must not matter):
 * - expected values for the "ready" conditions (persons, offerings, totals),
 *   fetched right before each measurement so concurrent changes cannot make
 *   a condition wrong;
 * - background activity of the scenarios that need it (bookings of other
 *   devices during U5, cleanup of the bookings the checks created).
 */
import { BOOKING_EXPAND } from '../seed.ts';
import { sortPersons } from './search.ts';

export interface Person {
  id: string;
  number: string;
  name: string;
  nickname: string;
}

export interface Offering {
  id: string;
  name: string;
  priceCents: number;
  active: boolean;
  group: string;
  sortOrder: number;
}

export interface User {
  id: string;
  username: string;
  name: string;
  role: string;
}

export interface Totals {
  count: number;
  quantity: number;
  totalCents: number;
  perPerson: Array<{ personId: string; number: string; name: string; nickname: string; count: number; totalCents: number }>;
  perOffering: Array<{ offeringId: string; name: string; count: number; totalCents: number }>;
  perUser: Array<{ userId: string; count: number; totalCents: number }>;
}

export interface TotalsQuery {
  /** inclusive, UTC ms */
  from?: number;
  /** exclusive, UTC ms */
  to?: number;
  person?: string;
  createdBy?: string;
}

export interface BookingRecord {
  id: string;
  person: string;
  offering: string;
  unitPriceCents: number;
  created: string;
}

const TIMEOUT_MS = 30_000;

export class RestError extends Error {
  override name = 'RestError';
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class Rest {
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }

  async request<T>(token: string, method: string, path: string, query?: Record<string, string>, body?: unknown): Promise<T> {
    const target = new URL(path, this.url);
    for (const [key, value] of Object.entries(query ?? {})) target.searchParams.set(key, value);
    const response = await fetch(target, {
      method,
      headers: { Authorization: token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new RestError(`${method} ${target.pathname} → HTTP ${response.status}: ${text.slice(0, 200)}`, response.status);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** The raw response body of a GET (for size comparisons). */
  async text(token: string, path: string, query: Record<string, string> = {}): Promise<string> {
    const target = new URL(path, this.url);
    for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
    const response = await fetch(target, { headers: { Authorization: token }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await response.text();
    if (!response.ok) throw new RestError(`GET ${target.pathname} → HTTP ${response.status}`, response.status);
    return body;
  }

  /** All records of a collection, paged like the SPA's getFullList({ batch: 1000 }). */
  async fullList<T>(token: string, collection: string, sort?: string): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      const query: Record<string, string> = { page: String(page), perPage: '1000', skipTotal: '1' };
      if (sort) query.sort = sort;
      const list = await this.request<{ items: T[] }>(token, 'GET', `/api/collections/${collection}/records`, query);
      items.push(...list.items);
      if (list.items.length < 1000) return items;
    }
  }

  /** All persons in the SPA's order (natural sort by number). */
  async persons(token: string): Promise<Person[]> {
    const records = await this.fullList<Person>(token, 'persons');
    return sortPersons(records.map(({ id, number, name, nickname }) => ({ id, number, name, nickname })));
  }

  async offerings(token: string): Promise<Offering[]> {
    return this.fullList<Offering>(token, 'offerings', 'sortOrder,name');
  }

  /** Users (visible to admins; a normal user only sees itself). */
  async users(token: string): Promise<User[]> {
    return this.fullList<User>(token, 'users', 'username');
  }

  /** GET /api/app/totals with the SPA's query format (ISO 8601 bounds). */
  totals(token: string, q: TotalsQuery = {}): Promise<Totals> {
    const query: Record<string, string> = {};
    if (q.from !== undefined) query.from = new Date(q.from).toISOString();
    if (q.to !== undefined) query.to = new Date(q.to).toISOString();
    if (q.person) query.person = q.person;
    if (q.createdBy) query.createdBy = q.createdBy;
    return this.request<Totals>(token, 'GET', '/api/app/totals', query);
  }

  /** A booking exactly like the SPA creates it (createdBy + expand), as the token's user. */
  createBooking(token: string, person: string, offering: string, createdBy: string): Promise<BookingRecord> {
    return this.request<BookingRecord>(
      token,
      'POST',
      '/api/collections/bookings/records',
      { expand: BOOKING_EXPAND },
      { person, offering, quantity: 1, createdBy },
    );
  }

  /**
   * Ids of the bookings created at or after `since` (epoch ms) by one of the
   * given users – for the final cleanup sweep of the UI checks.
   */
  async bookingIdsSince(token: string, since: number, createdBy: readonly string[]): Promise<string[]> {
    if (createdBy.length === 0) return [];
    const quote = (value: string) => `'${value.replace(/'/g, "\\'")}'`;
    const pbDate = new Date(since).toISOString().replace('T', ' ');
    const filter = `created >= ${quote(pbDate)} && (${createdBy.map((id) => `createdBy = ${quote(id)}`).join(' || ')})`;
    const ids: string[] = [];
    for (let page = 1; ; page++) {
      const list = await this.request<{ items: Array<{ id: string }> }>(token, 'GET', '/api/collections/bookings/records', {
        page: String(page),
        perPage: '500',
        skipTotal: '1',
        sort: '-created,-id',
        fields: 'id',
        filter,
      });
      ids.push(...list.items.map((item) => item.id));
      if (list.items.length < 500) return ids;
    }
  }

  /** Deletes a booking; false when it was already gone (404). */
  async deleteBooking(token: string, id: string): Promise<boolean> {
    try {
      await this.request(token, 'DELETE', `/api/collections/bookings/records/${encodeURIComponent(id)}`);
      return true;
    } catch (error) {
      if (error instanceof RestError && error.status === 404) return false;
      throw error;
    }
  }
}
