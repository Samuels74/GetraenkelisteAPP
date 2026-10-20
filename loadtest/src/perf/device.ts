/**
 * A virtual device running the SPA – the requests a phone or laptop sends
 * while it shows one screen and bookings happen elsewhere (1B inventory §2
 * and §6.1). It mirrors the frontend's data layer, not its rendering:
 *
 * - Screens and their active queries (only active queries refetch on
 *   invalidation):
 *     buchen     persons (getFullList → 3 pages), groups, offerings,
 *                totals(person), recent(8)        – features/book/BookPage.tsx
 *     personen   persons, totals(all)             – features/persons/PersonsPage.tsx
 *     buchungen  persons (for the person <select>), totals(q), list(q) with k
 *                loaded pages                     – features/bookings/BookingsPage.tsx
 *     admin      groups, offerings, totals(all)   – features/admin/OfferingsAdmin.tsx
 * - Realtime (api/realtime.ts): a real SSE subscription with the SPA's
 *   topics; every event schedules its collection, one 120 ms timer (started
 *   by the first event, not restarted by later ones) flushes the union of
 *   INVALIDATION_MAP prefixes (bookings → bookings + totals, …).
 * - invalidateSafely (api/invalidate.ts): a query that is fetching is not
 *   cancelled; it is refetched once more after it settled – any number of
 *   invalidations meanwhile coalesce into that one refetch.
 * - An infinite query (the Buchungen list) refetches all loaded pages one
 *   after the other.
 * - Own mutations (api/mutations.ts): after a booking create (onSuccess) or
 *   delete (onSettled) bookings + totals are invalidated at once; the own
 *   realtime echo then causes a second round – 5 requests per tap on Buchen.
 * - Reconnect (PB_CONNECT after the first): refetch of all active queries,
 *   plus the throttled session refresh (15 s); with `sessionRefresh` also the
 *   5-minute session check of app/RootLayout.tsx.
 *
 * Propagation: for every booking event the device records when the refetch
 * that reflects it finished – the moment the screen shows the change: all
 * queries invalidated by the flush have completed a fetch that started after
 * the flush. Not modelled: rendering, the 30 s staleness refetches on
 * remount/focus, retries.
 */
import { HttpClient, parseJson, type HttpResult } from './http.ts';
import {
  bookingBody,
  bookingsFilter,
  paths,
  realtimeTopics,
  totalsParams,
  type BookingQuery,
  RECENT_BUCHEN,
  FULL_LIST_BATCH,
} from './requests.ts';
import { nowAbs, type SampleLog } from './samples.ts';
import { parseRecordEvent, SseClient } from './sse.ts';

export type ScreenKind = 'buchen' | 'personen' | 'buchungen' | 'admin';

export interface DeviceSpec {
  /** Unique within the fleet, e.g. "phone-3". */
  id: string;
  screen: ScreenKind;
  token: string;
  userId: string;
  admin: boolean;
  /** buchen: the selected person (record id). */
  personId?: string;
  /** buchungen: loaded list pages ("Weitere laden" k−1 times) and the filter (default "Alle"). */
  pages?: number;
  query?: BookingQuery;
  /** Session check every 5 minutes (app/RootLayout.tsx) – long runs only. */
  sessionRefresh?: boolean;
}

export interface DeviceEnv {
  url: string;
  /** The browser's time zone (period filters). */
  timeZone: string;
  samples: SampleLog;
  /** Index of the device in its fleet (stored with every sample). */
  index: number;
  /** Realtime debounce (frontend/src/api/realtime.ts DEBOUNCE_MS). */
  debounceMs?: number;
}

/** A booking event as seen by one device. Times are absolute ms. */
export interface DeviceEvent {
  device: string;
  bookingId: string;
  action: string;
  receivedAt: number;
  /** When the refetch reflecting it finished (0 = never, e.g. the run ended first). */
  doneAt: number;
}

/** Outcome of a create or delete sent by a device. Times are absolute ms. */
export interface MutationRecord {
  device: string;
  /** Booking id (create: from the response; undefined when it failed). */
  id?: string;
  /** Intended send time (open-loop schedule). */
  intended: number;
  /** Actual send time. */
  sent: number;
  /** Response complete. */
  done: number;
  status: number;
  error?: string;
}

/** frontend/src/api/realtime.ts INVALIDATION_MAP (query key prefixes). */
const INVALIDATION_MAP: Record<string, readonly string[]> = {
  bookings: ['bookings', 'totals'],
  persons: ['persons', 'bookings', 'totals'],
  offerings: ['offerings', 'bookings', 'totals'],
  groups: ['groups', 'offerings', 'bookings', 'totals'],
  users: ['users', 'bookings', 'totals'],
};

const SESSION_CHECK_MS = 5 * 60_000;
const SESSION_THROTTLE_MS = 15_000;

/**
 * Completion tracker of one flush: done when every invalidated query
 * refetched once successfully. A failed refetch leaves the screen stale, so
 * the waiter never completes and the event counts as a missing delivery.
 */
class Waiter {
  private remaining: number;
  private doneAt = 0;
  private failed = false;
  private readonly onDone: (doneAt: number) => void;

  constructor(queries: number, onDone: (doneAt: number) => void) {
    this.remaining = queries;
    this.onDone = onDone;
  }

  done(at: number, ok: boolean): void {
    if (!ok) this.failed = true;
    this.doneAt = Math.max(this.doneAt, at);
    if (--this.remaining === 0 && !this.failed) this.onDone(this.doneAt);
  }
}

/** True for a successful response (the SDK would throw for anything else). */
const ok = (result: HttpResult) => result.status >= 200 && result.status < 300;

/** One active query observer with TanStack's fetch state as invalidateSafely sees it. */
class ActiveQuery {
  readonly key: string;
  readonly prefix: string;
  /** Resolves true when every request of the fetch succeeded. */
  private readonly fetchFn: () => Promise<boolean>;
  private fetching: Promise<void> | null = null;
  private requested = false;
  private waiters: Waiter[] = [];

  constructor(key: string, prefix: string, fetchFn: () => Promise<boolean>) {
    this.key = key;
    this.prefix = prefix;
    this.fetchFn = fetchFn;
  }

  /** Refetch now – or once more after the running fetch (never cancels it). */
  invalidate(waiter?: Waiter): void {
    if (waiter) this.waiters.push(waiter);
    this.requested = true;
    this.fetching ??= this.loop();
  }

  private async loop(): Promise<void> {
    while (this.requested) {
      this.requested = false;
      const waiters = this.waiters;
      this.waiters = [];
      let succeeded = false;
      try {
        succeeded = await this.fetchFn();
      } catch {
        // failed requests are recorded as samples; the screen keeps its (stale) data
      }
      const end = nowAbs();
      for (const waiter of waiters) waiter.done(end, succeeded);
    }
    this.fetching = null;
  }

  /** Resolves when no fetch is running. */
  async settled(): Promise<void> {
    while (this.fetching) await this.fetching;
  }
}

export class Device {
  readonly spec: DeviceSpec;
  readonly http: HttpClient;
  readonly sse: SseClient;
  readonly events: DeviceEvent[] = [];
  /** Full refetches after a realtime reconnect. */
  reconnectRefetches = 0;
  private readonly env: DeviceEnv;
  private readonly queries: ActiveQuery[] = [];
  private readonly pendingCollections = new Set<string>();
  private pendingEvents: Array<{ bookingId: string; action: string; receivedAt: number }> = [];
  private debounceTimer: NodeJS.Timeout | undefined;
  private sessionTimer: NodeJS.Timeout | undefined;
  private lastRefresh = 0;
  private closed = false;

  constructor(spec: DeviceSpec, env: DeviceEnv) {
    this.spec = spec;
    this.env = env;
    this.http = new HttpClient(env.url, { token: spec.token });
    this.sse = new SseClient({
      url: env.url,
      client: this.http,
      topics: realtimeTopics(spec.userId, spec.admin),
      onMessage: (event, data, at) => this.onMessage(event, data, at),
      onConnect: ({ reconnect }) => this.onConnect(reconnect),
    });
    this.buildQueries();
  }

  /** Records a request of this device. */
  private record(type: string, result: HttpResult): HttpResult {
    this.env.samples.add(type, result, this.env.index);
    return result;
  }

  private get(type: string, path: string): Promise<HttpResult> {
    return this.http.get(path).then((result) => this.record(type, result));
  }

  private buildQueries(): void {
    const { spec } = this;
    const persons = new ActiveQuery('persons', 'persons', async () => {
      // getFullList({ batch: 1000 }): next page while the page is full
      for (let page = 1; ; page++) {
        const result = this.record('persons', await this.http.get(paths.personsPage(page), { collect: true }));
        if (!ok(result)) return false;
        const items = parseJson<{ items: unknown[] }>(result).items.length;
        if (items < FULL_LIST_BATCH) return true;
      }
    });
    const groups = new ActiveQuery('groups', 'groups', async () => ok(await this.get('groups', paths.groups())));
    const offerings = new ActiveQuery('offerings', 'offerings', async () => ok(await this.get('offerings', paths.offerings())));
    const totalsAll = new ActiveQuery('totals(all)', 'totals', async () => ok(await this.get('totals(all)', paths.totals())));

    switch (spec.screen) {
      case 'buchen': {
        const personId = spec.personId;
        if (!personId) throw new Error(`device ${spec.id}: the Buchen screen needs a selected person`);
        const query: BookingQuery = { period: 'all', personId };
        this.queries.push(
          persons,
          groups,
          offerings,
          new ActiveQuery('totals(person)', 'totals', async () =>
            ok(await this.get('totals(person)', paths.totals(totalsParams(query, Date.now(), this.env.timeZone)))),
          ),
          new ActiveQuery('recent(8)', 'bookings', async () => ok(await this.get('recent(8)', paths.recent(personId, RECENT_BUCHEN)))),
        );
        break;
      }
      case 'personen':
        this.queries.push(persons, totalsAll);
        break;
      case 'buchungen': {
        const query: BookingQuery = spec.query ?? { period: 'all' };
        const pages = Math.max(1, spec.pages ?? 1);
        const isReference = query.period === 'all' && !query.personId && !query.createdBy;
        this.queries.push(
          persons,
          // "Alle" without person/mine shares the reference totals' query key
          new ActiveQuery(isReference ? 'totals(all)' : 'totals(q)', 'totals', async () =>
            ok(await this.get(isReference ? 'totals(all)' : 'totals(q)', paths.totals(totalsParams(query, Date.now(), this.env.timeZone)))),
          ),
          new ActiveQuery('list', 'bookings', async () => {
            // the infinite query refetches all loaded pages in sequence; a failed page fails the refetch
            const filter = bookingsFilter(query, Date.now(), this.env.timeZone);
            for (let page = 1; page <= pages; page++) if (!ok(await this.get('list page', paths.bookings(filter, page)))) return false;
            return true;
          }),
        );
        break;
      }
      case 'admin':
        this.queries.push(groups, offerings, totalsAll);
        break;
    }
  }

  /** Connects realtime and loads the screen (all queries once). */
  async open(): Promise<void> {
    await this.sse.open();
    await this.loadAll();
    if (this.spec.sessionRefresh) {
      this.sessionTimer = setInterval(() => void this.refreshSession(SESSION_CHECK_MS / 2), SESSION_CHECK_MS);
      this.sessionTimer.unref();
    }
  }

  /** Fetches all queries of the screen once and waits for them. */
  async loadAll(): Promise<void> {
    for (const query of this.queries) query.invalidate();
    await this.settled();
  }

  private onConnect(reconnect: boolean): void {
    if (this.closed) return;
    if (reconnect) {
      // invalidateAllSafely(queryClient, [[]]): events may have been missed
      this.reconnectRefetches++;
      for (const query of this.queries) query.invalidate();
    }
    if (this.spec.sessionRefresh) void this.refreshSession(SESSION_THROTTLE_MS);
  }

  /** refreshSessionThrottled(minIntervalMs) */
  private async refreshSession(minIntervalMs: number): Promise<void> {
    const now = Date.now();
    if (now - this.lastRefresh < minIntervalMs) return;
    this.lastRefresh = now;
    this.record('refresh', await this.http.post(paths.refresh(), undefined));
  }

  private onMessage(event: string, data: string, at: number): void {
    if (this.closed) return;
    const collection = event.split('/')[0] ?? '';
    if (!(collection in INVALIDATION_MAP)) return;
    // only admins schedule "users" events (everyone else only watches the own record)
    if (collection === 'users' && !this.spec.admin) return;
    if (collection === 'bookings') {
      const parsed = parseRecordEvent(data);
      if (parsed) this.pendingEvents.push({ bookingId: parsed.id, action: parsed.action, receivedAt: performance.timeOrigin + at });
    }
    this.pendingCollections.add(collection);
    this.debounceTimer ??= setTimeout(() => this.flush(), this.env.debounceMs ?? 120);
  }

  private flush(): void {
    this.debounceTimer = undefined;
    const prefixes = new Set<string>();
    for (const collection of this.pendingCollections) for (const prefix of INVALIDATION_MAP[collection] ?? []) prefixes.add(prefix);
    this.pendingCollections.clear();
    const events = this.pendingEvents;
    this.pendingEvents = [];
    const targets = this.queries.filter((query) => prefixes.has(query.prefix));
    if (targets.length === 0) return;
    const waiter =
      events.length > 0
        ? new Waiter(targets.length, (doneAt) => {
            for (const e of events) this.events.push({ device: this.spec.id, ...e, doneAt });
          })
        : undefined;
    for (const query of targets) query.invalidate(waiter);
  }

  /** Own mutation settled: invalidate bookings + totals at once. */
  private invalidateOwn(): void {
    for (const query of this.queries) if (query.prefix === 'bookings' || query.prefix === 'totals') query.invalidate();
  }

  /** A booking tap (useCreateBooking). `intended` = absolute time it was due. */
  async book(personId: string, offeringId: string, intended: number): Promise<MutationRecord> {
    const result = this.record(
      'create',
      await this.http.post(paths.createBooking(), bookingBody(personId, offeringId, this.spec.userId), { collect: true }),
    );
    let id: string | undefined;
    if (result.status === 200) {
      try {
        id = parseJson<{ id: string }>(result).id;
      } catch {
        // counted as success by status; the id is only needed for undo/propagation
      }
      this.invalidateOwn();
    }
    const sent = performance.timeOrigin + result.startedAt;
    return { device: this.spec.id, id, intended, sent, done: sent + result.ms, status: result.status, error: result.error };
  }

  /** "Rückgängig" (useDeleteBooking): onSettled invalidates in any case. */
  async undo(bookingId: string, intended: number): Promise<MutationRecord> {
    const result = this.record('delete', await this.http.delete(paths.booking(bookingId)));
    this.invalidateOwn();
    const sent = performance.timeOrigin + result.startedAt;
    return { device: this.spec.id, id: bookingId, intended, sent, done: sent + result.ms, status: result.status, error: result.error };
  }

  /** Resolves when no query is fetching (a pending debounce is not waited for). */
  async settled(): Promise<void> {
    await Promise.all(this.queries.map((query) => query.settled()));
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.debounceTimer);
    clearInterval(this.sessionTimer);
    this.sse.close();
    this.http.close();
  }
}
