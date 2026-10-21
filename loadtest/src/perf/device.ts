/**
 * A virtual device running the SPA – the requests a phone or laptop sends
 * while it shows one screen and bookings happen elsewhere. It mirrors the
 * frontend's data layer request by request, not its rendering:
 *
 * - Screens and their active queries (only active queries fetch):
 *     buchen       persons (getFullList → 3 pages), the selected person on
 *                  its own while that list is not loaded (getOne – app
 *                  start), groups, offerings; once the person is known (its
 *                  own request or the list) the card's totals(person P,
 *                  summary) and recent(P, 8)
 *                                          – features/book/BookPage.tsx
 *     personen     persons, totals(perPerson)
 *                                          – features/persons/PersonsPage.tsx
 *     buchungen    persons (the person filter's label/picker) and by view:
 *                  "Liste" totals(q, summary) + list(q) with k keyset pages,
 *                  "Pro Person" totals(q, summary+perPerson), "Pro Angebot"
 *                  totals(q, summary+perOffering)
 *                                          – features/bookings/BookingsPage.tsx
 *     admin        Verwaltung → Angebote: groups, offerings, totals(perOffering)
 *     admin-users  Verwaltung → Benutzer: users, totals(perUser)
 * - Start (app/RootLayout.tsx, api/realtime.ts): the session check, the
 *   realtime connect and the screen's queries start together. The first
 *   connect refetches – after the session check's answer – the queries that
 *   had settled before the subscriptions were active (FLOW-5; on a cold
 *   start usually the small ones: groups, offerings, the selected person).
 * - Realtime (api/realtime.ts): a real SSE subscription with the SPA's
 *   topics (everyone watches all users); every event schedules its
 *   collection, one 120 ms timer (started by the first event, not restarted
 *   by later ones) flushes the batch. Person events reload the persons
 *   list(s) only, user events the users list only – the new names are
 *   patched into cached rows without a request; offering/group events
 *   invalidate by prefix (INVALIDATION_MAP); booking events are applied in a
 *   targeted way (api/bookingSync.ts) – unless an offering/group event in the
 *   same batch refetches every booking and totals query anyway.
 * - Targeted booking updates (applyBookingChanges), per query:
 *     not matching the query's filter (period in the browser's time zone,
 *     person, createdBy) → nothing; inactive (a known-empty list, the card
 *     before the person is known) → marked stale; small totals (one person,
 *     or no per-person part) → refetch; totals with per-person rows and no
 *     person filter → one `person=<id>&parts=perPerson` request per booked
 *     person (> 10 persons: refetch) plus one request for the query's other
 *     parts; the Buchungen list → deletions removed locally, new bookings
 *     fetched with ONE head request (newer than the newest shown booking, or
 *     inclusive from the oldest new one if that is older) and merged into
 *     the keyset pages; the recent bookings → a shown cancelled booking
 *     removed (refetched when the list was full), another device's new
 *     booking refetched, an own one merged.
 * - Lanes (bookingSync enqueue/runLane, FLOW-2): a list or per-person totals
 *   query – and a recent list that is fetching or still patching – is never
 *   patched while it fetches (first load, refetch, "Weitere laden") or while
 *   its previous patch runs: the changes arriving meanwhile are collected
 *   and applied together once it is idle (one head request / one round of
 *   row requests for any number of batches). A patch whose query fetched or
 *   changed while its request was under way runs again on the new data
 *   (at most 3 attempts, then a refetch). Uncertain states fall back to a
 *   refetch: the query is inactive, invalidated or failed, its data shows a
 *   relative period ("Heute", 7 / 30 Tage) of an earlier day (list pages and
 *   totals record the period they were loaded for), the head request
 *   returned a full page or missed a new booking, a request failed, an
 *   `update` / malformed event, cancellations removed every loaded row while
 *   older bookings exist.
 * - invalidateSafely (api/invalidate.ts): a running fetch is never
 *   cancelled; the query is refetched once more after it settled – any
 *   number of invalidations meanwhile coalesce into that one refetch. A list
 *   refetch reloads all its loaded pages one after the other (keyset).
 * - Own mutations (api/mutations.ts): a booking tap applies the create
 *   response through the same engine (Buchen: POST + totals(person); the
 *   recent list is merged locally); "Rückgängig" applies the deletion
 *   (DELETE + totals(person), + recent(8) when the shown list was full).
 *   Whatever comes first – the response or the realtime echo – is applied,
 *   the other is skipped: one round per tap, not two.
 * - Known-empty lists (queries.ts useKnownEmpty): the recent bookings and
 *   the Buchungen list are disabled while the cached summary of the same
 *   filter says 0 bookings and is not being refetched. A query that becomes
 *   enabled fetches when it has no data or was invalidated – while realtime
 *   is connected nothing goes stale by time (queries.ts realtimeStaleTime;
 *   without a connection after 30 s).
 * - Session (auth/session.ts): `auth-refresh` at the start and 60 s after
 *   the last check of any kind (given up after 10 s); at once when a query
 *   or mutation gets a guest-style denial (401; 403, 404, 400 without field
 *   errors with one of PocketBase's generic messages – app/queryClient.ts);
 *   on every realtime reconnect, where a check of the last 15 s counts and
 *   the refetch of every query waits for the answer. The refreshed token is
 *   used from then on.
 * - Midnight (api/midnight.ts): a second after local midnight the list and
 *   totals queries of "Heute" / 7 / 30 Tage are invalidated (active ones
 *   refetch once).
 *
 * Propagation: for every booking event the device records whether it
 * changed something the screen shows (it matched one of its queries) and
 * when the work it caused – patches, head requests, refetches – finished.
 * Not modelled: rendering; retries of failed queries (TanStack retries 5xx
 * and network errors twice); focus, visibility and `online` events (a device
 * is always visible and online, so the first realtime connect never fails
 * and is retried); the logout after an invalid session.
 */
import { HttpClient, parseJson, type HttpResult, type RequestOptions } from './http.ts';
import {
  bookingBody,
  bookingsFilter,
  BOOKINGS_PAGE_SIZE,
  compareNewestFirst,
  FULL_LIST_BATCH,
  keysetFilter,
  keysetNewerFilter,
  paths,
  RECENT_BUCHEN,
  realtimeTopics,
  totalsParams,
  type BookingQuery,
  type KeysetCursor,
  type TotalsPart,
} from './requests.ts';
import { nowAbs, type SampleLog } from './samples.ts';
import { parseRecordEvent, SseClient } from './sse.ts';
import { parsePbDate, periodRanges, startOfLocalDay } from '../time.ts';

export type ScreenKind = 'buchen' | 'personen' | 'buchungen' | 'admin' | 'admin-users';

/** The Buchungen views (URL `ansicht`): list, "Pro Person", "Pro Angebot". */
export type BookingView = 'liste' | 'personen' | 'angebote';

export interface DeviceSpec {
  /** Unique within the fleet, e.g. "phone-3". */
  id: string;
  screen: ScreenKind;
  token: string;
  userId: string;
  admin: boolean;
  /** buchen: the selected person (record id). */
  personId?: string;
  /** buchungen: loaded list pages ("Weitere laden" k−1 times), the filter (default "Alle") and the view (default the list). */
  pages?: number;
  query?: BookingQuery;
  view?: BookingView;
}

/** One request of a device (for the model-vs-SPA comparison). */
export interface DeviceRequest {
  method: string;
  path: string;
  type: string;
  /** Absolute start time (ms). */
  at: number;
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
  /** Called for every request the device sends (the model check; never set in worker threads). */
  onRequest?: (request: DeviceRequest) => void;
}

/** A booking event as seen by one device. Times are absolute ms. */
export interface DeviceEvent {
  device: string;
  bookingId: string;
  action: string;
  receivedAt: number;
  /** The event changed what the screen shows (matched one of its queries, or a broad refetch covered it). */
  relevant: boolean;
  /** When the work reflecting it finished (relevant events; 0 = never: failed, or the run ended first). */
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

/** What the booking sync reads of a booking (realtime event records and create responses carry it). */
export interface BookingRef {
  id: string;
  person: string;
  createdBy: string;
  created: string;
}

interface BookingChange {
  action: string;
  /** Fields may be missing in a malformed event (then the change is not valid). */
  record: Partial<BookingRef> & { id: string };
  /** The record is the full create response (own booking). */
  expanded?: boolean;
}

type ValidChange = BookingChange & { record: BookingRef };

/**
 * frontend/src/api/realtime.ts INVALIDATION_MAP (query key prefixes). Person
 * and user events reload only their own lists: the names they change in
 * booking rows and totals are patched without a request (FLOW-7, FLOW-11).
 */
const INVALIDATION_MAP: Record<string, readonly string[]> = {
  bookings: ['bookings', 'totals'],
  persons: ['persons'],
  offerings: ['offerings', 'bookings', 'totals'],
  groups: ['groups', 'offerings', 'bookings', 'totals'],
  users: ['users'],
};

/** api/bookingSync.ts MAX_ROW_PATCHES: more persons in one batch → the per-person totals are refetched as a whole. */
const MAX_ROW_PATCHES = 10;
/** api/bookingSync.ts MAX_PATCH_ATTEMPTS: a patch that keeps meeting new data falls back to a refetch. */
const MAX_PATCH_ATTEMPTS = 3;
/** How long a handled change is remembered (bookingSync HANDLED_TTL_MS). */
const HANDLED_TTL_MS = 5 * 60_000;
/** queries.ts STALE_TIME_WITHOUT_REALTIME_MS – data goes stale by time only without a realtime connection. */
const STALE_TIME_WITHOUT_REALTIME_MS = 30_000;
/** auth/session.ts SESSION_CHECK_INTERVAL_MS */
const SESSION_CHECK_INTERVAL_MS = 60_000;
/** auth/session.ts SESSION_CHECK_TIMEOUT_MS: a check without an answer is given up ("unknown"). */
const SESSION_CHECK_TIMEOUT_MS = 10_000;
/** api/realtime.ts RECONNECT_SESSION_CHECK_MAX_AGE_MS */
const RECONNECT_SESSION_CHECK_MAX_AGE_MS = 15_000;
/** api/midnight.ts AFTER_MIDNIGHT_MS */
const AFTER_MIDNIGHT_MS = 1_000;
const RELATIVE_PERIODS: ReadonlySet<string> = new Set(['today', '7d', '30d']);

/** The end of a piece of work: when it finished and whether the screen is current afterwards. */
interface Settle {
  at: number;
  ok: boolean;
}

/** A patch either settled (applied, nothing to do, or fell back to a refetch) or must start again on new data. */
type Outcome = Settle | 'again';

type SessionStatus = 'valid' | 'invalid' | 'unknown';

const done = (ok = true): Settle => ({ at: nowAbs(), ok });

/** True for a successful response (the SDK would throw for anything else). */
const ok = (result: HttpResult) => result.status >= 200 && result.status < 300;

/** lib/errors.ts GENERIC_ENGLISH: PocketBase's own messages (the hooks answer in German). */
const GENERIC_ENGLISH = [
  /^failed to /i,
  /^something went wrong/i,
  /^the request/i,
  /^the requested/i,
  /^the authorized record/i,
  /^only superusers/i,
  /^missing /i,
  /^invalid /i,
  /^an error occurred/i,
  /^you are not allowed/i,
  /^too many requests/i,
  /^unauthorized/i,
  /^forbidden/i,
  /^not found/i,
  /^bad request/i,
  /^internal server error/i,
  /^record not found/i,
  /^sql: /i,
  /^the request doesn't satisfy/i,
];

/**
 * app/queryClient.ts handleGlobalError: a 401, or a denial as PocketBase
 * gives it to a guest (403, 404, 400 without field errors) with one of its
 * generic messages – what a revoked token gets; the session is checked at
 * once. Only PocketBase's own error body counts (`{ status, message, data }`,
 * lib/errors.ts isPocketBaseError); a hook's German message is an answer.
 */
function isGuestStyleDenial(result: HttpResult): boolean {
  if (result.status < 400 || result.status >= 500) return false;
  let body: { status?: unknown; message?: unknown; data?: Record<string, unknown> };
  try {
    body = JSON.parse(result.body?.toString('utf8') ?? '') as typeof body;
  } catch {
    return false; // not PocketBase's answer
  }
  if (typeof body?.status !== 'number' || typeof body.message !== 'string') return false;
  if (result.status === 401) return true;
  const message = body.message.trim();
  if (message && !GENERIC_ENGLISH.some((pattern) => pattern.test(message))) return false;
  if (result.status === 403 || result.status === 404) return true;
  if (result.status !== 400) return false;
  return !body.data || Object.keys(body.data).length === 0;
}

function isValidChange(change: BookingChange): change is ValidChange {
  const r = change.record;
  return (
    (change.action === 'create' || change.action === 'delete') &&
    typeof r.id === 'string' &&
    typeof r.person === 'string' &&
    typeof r.createdBy === 'string' &&
    typeof r.created === 'string' &&
    !Number.isNaN(parsePbDate(r.created))
  );
}

// --------------------------------------------------------------------------- queries

type Prefix = 'persons' | 'groups' | 'offerings' | 'users' | 'bookings' | 'totals';

/** bookingSync Lane: changes collected while the query is busy, applied together by one patch. */
interface Lane {
  changes: ValidChange[];
  done: Promise<Settle>;
}

interface Lanes {
  /** The lane that still takes changes: it waits for the query (fetching) or for the patch before it. */
  collecting: Lane | null;
  /** The end of the last lane – the next one starts after it. */
  tail: Promise<unknown>;
  /** Lanes that have not finished yet. */
  open: number;
}

/**
 * One query as TanStack holds it: fetch state, invalidation, data version
 * (TanStack's `state.data` identity), the patch lanes.
 */
abstract class Query {
  readonly name: string;
  readonly prefix: Prefix;
  protected readonly device: Device;
  status: 'pending' | 'success' | 'error' = 'pending';
  invalidated = false;
  /** Wall-clock ms of the last data change (0 = never). */
  dataUpdatedAt = 0;
  /** Wall-clock ms of the last failed fetch (0 = never). */
  errorUpdatedAt = 0;
  /** Incremented on every data change (fetch or patch). */
  version = 0;
  /** Data arrived once (TanStack keeps it across later failed fetches). */
  hasData = false;
  readonly lanes: Lanes = { collecting: null, tail: Promise.resolve(), open: 0 };
  private fetching: Promise<void> | null = null;
  private requested = false;
  private waiters: Array<(settle: Settle) => void> = [];
  /** An extra condition of the screen (the Buchen card waits for its person). */
  private readonly gate: () => boolean;

  constructor(device: Device, name: string, prefix: Prefix, gate: () => boolean = () => true) {
    this.device = device;
    this.name = name;
    this.prefix = prefix;
    this.gate = gate;
  }

  /** Active = has an enabled observer; an inactive query only gets marked stale. */
  get enabled(): boolean {
    return this.gate();
  }

  get isFetching(): boolean {
    return this.fetching !== null;
  }

  /** When the data or the error of the last fetch arrived (0 = never settled). */
  get settledAt(): number {
    return Math.max(this.dataUpdatedAt, this.errorUpdatedAt);
  }

  /** Performs the requests of one fetch and stores the data; true when all succeeded. */
  protected abstract load(): Promise<boolean>;

  /**
   * invalidateSafely(…, { exact: true }): marks the query stale and refetches
   * it if active – now, or once more after the running fetch. Resolves when
   * that fetch is done (at once for an inactive query).
   */
  refetch(): Promise<Settle> {
    this.invalidated = true;
    if (!this.enabled) return Promise.resolve(done());
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.requested = true;
      if (!this.fetching) {
        this.fetching = this.loop();
        this.device.stateChanged();
      }
    });
  }

  private async loop(): Promise<void> {
    while (this.requested) {
      this.requested = false;
      const waiters = this.waiters;
      this.waiters = [];
      let succeeded = false;
      try {
        succeeded = await this.load();
      } catch {
        // failed requests are recorded as samples; the screen keeps its (stale) data
      }
      if (succeeded) this.changed();
      else {
        // TanStack: status error, invalidated
        this.status = 'error';
        this.invalidated = true;
        this.errorUpdatedAt = Date.now();
      }
      const settle = done(succeeded);
      for (const waiter of waiters) waiter(settle);
    }
    this.fetching = null;
    this.device.stateChanged();
  }

  /** setQueryData / a successful fetch: new data. */
  changed(): void {
    this.hasData = true;
    this.status = 'success';
    this.invalidated = false;
    this.dataUpdatedAt = Date.now();
    this.version++;
  }

  /**
   * bookingSync showsCurrentPeriod: whether the data shows the query's current
   * period – relative periods move at local midnight, the data records what
   * it was loaded for. Absolute periods and the recent list: always.
   */
  showsCurrentPeriod(_nowMs: number): boolean {
    return true;
  }

  /** The booking filter of a booking/totals query (others never see booking changes). */
  filter(): BookingQuery {
    return { period: 'all' };
  }

  /** Whether the query shows a period relative to "today" (midnight.ts invalidates it). */
  get relativePeriod(): boolean {
    return false;
  }

  /** invalidate.ts whenIdle: resolves once no fetch runs (also across fetches that follow each other). */
  async whenIdle(): Promise<void> {
    while (this.fetching) await this.fetching;
  }

  /** Resolves when no fetch and no patch lane is running. */
  async settled(): Promise<void> {
    for (;;) {
      const tail = this.lanes.tail;
      await tail;
      await this.whenIdle();
      if (tail === this.lanes.tail && !this.fetching) return;
    }
  }
}

/** persons / groups / offerings / users: one or more pages, not touched by booking events. */
class RecordsQuery extends Query {
  private readonly loader: () => Promise<boolean>;
  constructor(device: Device, name: Prefix, loader: () => Promise<boolean>) {
    super(device, name, name);
    this.loader = loader;
  }
  protected load(): Promise<boolean> {
    return this.loader();
  }
}

/**
 * The selected person on its own (features/book/selectedPerson.ts
 * useRememberedPerson, key ['persons', 'one', id]): only while the persons
 * list has no data yet – an app start loads both in parallel, later it is an
 * inactive query (a reconnect or a person event only marks it stale).
 */
class RememberedPersonQuery extends Query {
  private readonly personId: string;
  constructor(device: Device, personId: string, list: Query) {
    super(device, 'person(one)', 'persons', () => !list.hasData);
    this.personId = personId;
  }
  protected async load(): Promise<boolean> {
    return ok(await this.device.load('person(one)', paths.person(this.personId)));
  }
}

class TotalsQuery extends Query {
  readonly query: BookingQuery;
  readonly parts: TotalsPart[];
  readonly type: string;
  /** The summary's count (summary-only queries; known-empty lists). */
  count: number | undefined;
  /** The period the data was computed for (queries.ts TotalsData.range). */
  range: string | undefined;

  constructor(device: Device, query: BookingQuery, parts: TotalsPart[], gate?: () => boolean) {
    super(device, `totals(${parts.join('+')})`, 'totals', gate);
    this.query = query;
    this.parts = parts;
    this.type = totalsType(query, parts);
  }

  override filter(): BookingQuery {
    return this.query;
  }

  override get relativePeriod(): boolean {
    return RELATIVE_PERIODS.has(this.query.period);
  }

  override showsCurrentPeriod(nowMs: number): boolean {
    return this.query.period === 'all' || (this.range !== undefined && this.range === this.device.rangeKey(this.query, nowMs));
  }

  protected async load(): Promise<boolean> {
    const summaryOnly = this.parts.length === 1 && this.parts[0] === 'summary';
    const now = Date.now();
    const result = await this.device.load(this.type, paths.totals(totalsParams(this.query, now, this.device.timeZone, this.parts)), {
      collect: summaryOnly,
    });
    if (!ok(result)) return false;
    if (summaryOnly) this.count = parseJson<{ count?: number }>(result).count;
    this.range = this.device.rangeKey(this.query, now);
    return true;
  }

  /** useKnownEmpty: the cached summary says "no bookings" and is not being refetched. */
  get knownEmpty(): boolean {
    return this.status === 'success' && !this.isFetching && this.count === 0;
  }
}

/** Request type of a totals request (sample statistics). */
function totalsType(query: BookingQuery, parts: readonly TotalsPart[]): string {
  if (query.personId && parts.length === 1 && parts[0] === 'perPerson') return 'totals(person row)';
  if (query.personId && parts.length === 1 && parts[0] === 'summary') return 'totals(person)';
  return `totals(${parts.join('+')})`;
}

interface ListPage {
  items: KeysetCursor[];
  /** Cursor of the next page, fixed when the page was loaded (null: no more bookings). */
  next: KeysetCursor | null;
  /** The filter the page was loaded with – page 1 resolves the period, the following pages reuse it. */
  base: string;
}

/** Ids and timestamps of a booking list response. */
function listItems(result: HttpResult): KeysetCursor[] {
  return parseJson<{ items: Array<{ id: string; created: string }> }>(result).items.map(({ id, created }) => ({ id, created }));
}

/** The Buchungen list: an infinite query of keyset pages (queries.ts bookingListOptions). */
class ListQuery extends Query {
  readonly query: BookingQuery;
  pages: ListPage[] = [];
  private readonly initialPages: number;
  private readonly summary: TotalsQuery;

  constructor(device: Device, query: BookingQuery, pages: number, summary: TotalsQuery) {
    super(device, 'list', 'bookings');
    this.query = query;
    this.initialPages = pages;
    this.summary = summary;
  }

  override get enabled(): boolean {
    return !this.summary.knownEmpty;
  }

  override filter(): BookingQuery {
    return this.query;
  }

  override get relativePeriod(): boolean {
    return RELATIVE_PERIODS.has(this.query.period);
  }

  override showsCurrentPeriod(nowMs: number): boolean {
    if (this.query.period === 'all') return true;
    if (this.pages.length === 0) return false;
    const base = bookingsFilter(this.query, nowMs, this.device.timeZone);
    return this.pages.every((page) => page.base === base);
  }

  /** A (re)fetch of every loaded page, one after the other; the cursors come from the fresh pages. */
  protected async load(): Promise<boolean> {
    const count = Math.max(1, this.pages.length || this.initialPages);
    const base = bookingsFilter(this.query, Date.now(), this.device.timeZone);
    const pages: ListPage[] = [];
    let cursor: KeysetCursor | null = null;
    for (let i = 0; i < count; i++) {
      if (i > 0 && cursor === null) break; // the previous page was the last one
      const result = await this.device.load('list page', paths.bookings(cursor ? keysetFilter(base, cursor) : base), { collect: true });
      if (!ok(result)) return false;
      const items = listItems(result);
      const last = items.at(-1);
      cursor = last && items.length >= BOOKINGS_PAGE_SIZE ? { created: last.created, id: last.id } : null;
      pages.push({ items, next: cursor, base });
    }
    this.pages = pages;
    return true;
  }
}

/** The recent bookings of the selected person (useRecentBookings). */
class RecentQuery extends Query {
  readonly personId: string;
  readonly limit: number;
  items: KeysetCursor[] = [];
  private readonly summary: TotalsQuery;

  constructor(device: Device, personId: string, limit: number, summary: TotalsQuery, gate?: () => boolean) {
    super(device, `recent(${limit})`, 'bookings', gate);
    this.personId = personId;
    this.limit = limit;
    this.summary = summary;
  }

  override get enabled(): boolean {
    return super.enabled && !this.summary.knownEmpty;
  }

  override filter(): BookingQuery {
    return { period: 'all', personId: this.personId };
  }

  protected async load(): Promise<boolean> {
    const result = await this.device.load(this.name, paths.recent(this.personId, this.limit), { collect: true });
    if (!ok(result)) return false;
    this.items = listItems(result);
    return true;
  }
}

// --------------------------------------------------------------------------- list patch helpers (bookingSync.ts)

function newestItem(pages: readonly ListPage[]): KeysetCursor | undefined {
  for (const page of pages) if (page.items.length > 0) return page.items[0];
  return undefined;
}

/** Index of the cached page a booking belongs to, or -1 if it is older than everything loaded. */
function pageIndexFor(pages: readonly ListPage[], record: KeysetCursor): number {
  return pages.findIndex((page) => page.next === null || compareNewestFirst(record, page.next) <= 0);
}

function insertSorted(items: readonly KeysetCursor[], record: KeysetCursor): KeysetCursor[] {
  const result = [...items];
  const at = result.findIndex((item) => compareNewestFirst(record, item) < 0);
  if (at < 0) result.push(record);
  else result.splice(at, 0, record);
  return result;
}

function mergeIntoPages(pages: ListPage[], records: readonly KeysetCursor[]): ListPage[] {
  const known = new Set(pages.flatMap((page) => page.items.map((item) => item.id)));
  let result = pages;
  for (const record of records) {
    if (known.has(record.id)) continue;
    const index = pageIndexFor(result, record);
    if (index < 0) continue; // comes with "Weitere laden"
    known.add(record.id);
    const entry = { id: record.id, created: record.created };
    result = result.map((page, i) => (i === index ? { ...page, items: insertSorted(page.items, entry) } : page));
  }
  return result;
}

function removeFromPages(pages: ListPage[], ids: ReadonlySet<string>): ListPage[] {
  let changed = false;
  const result = pages.map((page) => {
    if (!page.items.some((item) => ids.has(item.id))) return page;
    changed = true;
    return { ...page, items: page.items.filter((item) => !ids.has(item.id)) };
  });
  return changed ? result : pages;
}

// --------------------------------------------------------------------------- device

interface PendingEvent {
  change: BookingChange;
  receivedAt: number;
}

export class Device {
  readonly spec: DeviceSpec;
  readonly http: HttpClient;
  readonly sse: SseClient;
  readonly events: DeviceEvent[] = [];
  /** Full refetches after a realtime reconnect. */
  reconnectRefetches = 0;
  readonly timeZone: string;
  private readonly env: DeviceEnv;
  private readonly queries: Query[] = [];
  private readonly pendingCollections = new Set<string>();
  private pendingEvents: PendingEvent[] = [];
  /** `action:id` of the booking changes already applied (own mutation ↔ realtime echo). */
  private readonly handled = new Map<string, number>();
  /** The device's own bookings (create responses) – "Rückgängig" applies their deletion. */
  private readonly ownBookings = new Map<string, BookingRef>();
  private readonly work = new Set<Promise<unknown>>();
  /** Enabled state of every query at the last check (known-empty lists, the Buchen card's person). */
  private readonly wasEnabled = new Map<Query, boolean>();
  private rangesAt: { now: number; ranges: ReturnType<typeof periodRanges> } | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private sessionTimer: NodeJS.Timeout | undefined;
  private midnightTimer: NodeJS.Timeout | undefined;
  private checkInFlight: Promise<SessionStatus> | null = null;
  private lastCheckStarted = 0;
  private lastStatus: SessionStatus = 'unknown';
  private closed = false;

  constructor(spec: DeviceSpec, env: DeviceEnv) {
    this.spec = spec;
    this.env = env;
    this.timeZone = env.timeZone;
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

  // ------------------------------------------------------------------ requests

  /** Sends and records one request of this device. */
  private async request(method: string, type: string, path: string, options: RequestOptions = {}): Promise<HttpResult> {
    const at = nowAbs();
    this.env.onRequest?.({ method, path, type, at });
    const result = await this.http.request(method, path, options);
    this.env.samples.add(type, result, this.env.index);
    return result;
  }

  /** A request of the booking sync itself (head request, row patch) – its errors only lead to a refetch. */
  get(type: string, path: string, options: RequestOptions = {}): Promise<HttpResult> {
    return this.request('GET', type, path, options);
  }

  /** A query's fetch: a guest-style denial checks the session at once (QueryCache onError). */
  async load(type: string, path: string, options: RequestOptions = {}): Promise<HttpResult> {
    return this.denialChecked(await this.request('GET', type, path, options));
  }

  /** app/queryClient.ts handleGlobalError (queries and mutations). */
  private denialChecked(result: HttpResult): HttpResult {
    if (!this.closed && isGuestStyleDenial(result)) this.track(this.checkSession());
    return result;
  }

  private buildQueries(): void {
    const { spec } = this;
    const persons = new RecordsQuery(this, 'persons', async () => {
      // getFullList({ batch: 1000 }): next page while the page is full
      for (let page = 1; ; page++) {
        const result = await this.load('persons', paths.personsPage(page), { collect: true });
        if (!ok(result)) return false;
        if (parseJson<{ items: unknown[] }>(result).items.length < FULL_LIST_BATCH) return true;
      }
    });
    const simple = (name: 'groups' | 'offerings' | 'users', path: string) =>
      new RecordsQuery(this, name, async () => ok(await this.load(name, path)));
    const totals = (query: BookingQuery, parts: TotalsPart[]) => new TotalsQuery(this, query, parts);

    switch (spec.screen) {
      case 'buchen': {
        const personId = spec.personId;
        if (!personId) throw new Error(`device ${spec.id}: the Buchen screen needs a selected person`);
        const remembered = new RememberedPersonQuery(this, personId, persons);
        // the card's queries wait until the person is known – from the list, or its own request (app start)
        const known = () => persons.hasData || remembered.hasData;
        // personTotalsQuery(P) with parts=summary – shared with the recent list's known-empty check
        const card = new TotalsQuery(this, { period: 'all', personId }, ['summary'], known);
        this.queries.push(
          persons,
          remembered,
          simple('groups', paths.groups()),
          simple('offerings', paths.offerings()),
          new RecentQuery(this, personId, RECENT_BUCHEN, card, known),
          card,
        );
        break;
      }
      case 'personen':
        this.queries.push(persons, totals({ period: 'all' }, ['perPerson']));
        break;
      case 'buchungen': {
        const query: BookingQuery = spec.query ?? { period: 'all' };
        const view = spec.view ?? 'liste';
        this.queries.push(persons);
        if (view === 'liste') {
          const summary = totals(query, ['summary']);
          this.queries.push(new ListQuery(this, query, Math.max(1, spec.pages ?? 1), summary), summary);
        } else {
          this.queries.push(totals(query, view === 'personen' ? ['summary', 'perPerson'] : ['summary', 'perOffering']));
        }
        break;
      }
      case 'admin':
        this.queries.push(simple('groups', paths.groups()), simple('offerings', paths.offerings()), totals({ period: 'all' }, ['perOffering']));
        break;
      case 'admin-users':
        this.queries.push(simple('users', paths.users()), totals({ period: 'all' }, ['perUser']));
        break;
    }
    for (const query of this.queries) this.wasEnabled.set(query, query.enabled);
  }

  /**
   * The app start: session check, realtime connect and the screen's queries
   * at the same time; resolves when connected and everything – including
   * the first connect's refetches – has settled.
   */
  async open(): Promise<void> {
    this.track(this.checkSession()); // useSessionCheck
    // every query once (inactive ones – the card before its person is known – are only marked)
    const loads = Promise.all(this.queries.map((query) => query.refetch()));
    await Promise.all([this.sse.open(), loads]);
    this.armMidnight();
    await this.settled();
  }

  /**
   * useRealtimeSync onConnect. The session first: a revoked token would load
   * empty lists. A reconnect then refetches everything (events may have been
   * missed); the first connect only what settled before the subscriptions
   * were active (FLOW-5).
   */
  private onConnect(reconnect: boolean): void {
    if (this.closed) return;
    const connectedAt = Date.now();
    this.track(
      this.checkSession(RECONNECT_SESSION_CHECK_MAX_AGE_MS).then((status) => {
        if (this.closed || status === 'invalid') return undefined;
        if (reconnect) {
          this.reconnectRefetches++;
          return Promise.all(this.queries.map((query) => query.refetch())); // invalidateAllSafely([[]])
        }
        const before = this.queries.filter((query) => query.settledAt > 0 && query.settledAt < connectedAt);
        return Promise.all(before.map((query) => query.refetch())); // invalidateSettledBefore
      }),
    );
  }

  // ------------------------------------------------------------------ session (auth/session.ts)

  /**
   * checkSession(maxAgeMs): concurrent callers share one request; with
   * `maxAgeMs` a check that started less than that ago counts. Every check
   * that starts re-arms the periodic one (60 s later).
   */
  private checkSession(maxAgeMs = 0): Promise<SessionStatus> {
    if (this.checkInFlight) return this.checkInFlight;
    if (maxAgeMs > 0 && Date.now() - this.lastCheckStarted < maxAgeMs) {
      this.armSessionCheck(false);
      return Promise.resolve(this.lastStatus);
    }
    this.lastCheckStarted = Date.now();
    this.armSessionCheck(true);
    const running = this.request('POST', 'refresh', paths.refresh(), { collect: true, timeoutMs: SESSION_CHECK_TIMEOUT_MS })
      .then((result): SessionStatus => {
        if ([401, 403, 404].includes(result.status)) return 'invalid'; // the app would log out (not modelled)
        if (!ok(result)) return 'unknown';
        try {
          const token = parseJson<{ token?: string }>(result).token;
          if (!token) return 'unknown';
          this.http.token = token; // pb.authStore.save
          return 'valid';
        } catch {
          return 'unknown';
        }
      })
      .then((status) => {
        this.lastStatus = status;
        return status;
      })
      .finally(() => {
        if (this.checkInFlight === running) this.checkInFlight = null;
      });
    this.checkInFlight = running;
    return running;
  }

  /** armPeriodicCheck: the next check a minute after the last one; `restart` = count from now. */
  private armSessionCheck(restart: boolean): void {
    if (this.sessionTimer !== undefined) {
      if (!restart) return;
      clearTimeout(this.sessionTimer);
      this.sessionTimer = undefined;
    }
    if (this.closed) return;
    const due = this.lastCheckStarted + SESSION_CHECK_INTERVAL_MS - Date.now();
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = undefined;
      if (!this.closed) this.track(this.checkSession());
    }, Math.max(due, 0));
    this.sessionTimer.unref();
  }

  // ------------------------------------------------------------------ midnight (api/midnight.ts)

  private armMidnight(): void {
    if (this.closed) return;
    const now = Date.now();
    clearTimeout(this.midnightTimer);
    this.midnightTimer = setTimeout(() => this.onMidnight(), startOfLocalDay(now, this.timeZone, 1) - now + AFTER_MIDNIGHT_MS);
    this.midnightTimer.unref();
  }

  /** invalidateRelativePeriods: the lists and totals of "Heute" / 7 / 30 Tage move on to the new day. */
  private onMidnight(): void {
    this.midnightTimer = undefined;
    if (this.closed) return;
    this.armMidnight();
    for (const query of this.queries) if (query.relativePeriod) this.track(query.refetch());
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.work.add(promise);
    void promise.finally(() => this.work.delete(promise)).catch(() => undefined);
    return promise;
  }

  /**
   * A query started or finished a fetch: queries whose observer depends on
   * another query (known-empty lists, the Buchen card's person) follow it – a
   * query that becomes enabled fetches when it is stale, like TanStack does
   * when an observer is enabled: no data, invalidated, or – only without a
   * realtime connection – older than 30 s.
   */
  stateChanged(): void {
    for (const [query, before] of this.wasEnabled) {
      const now = query.enabled;
      if (now === before) continue;
      this.wasEnabled.set(query, now);
      if (!now || this.closed) continue;
      const stale =
        !query.hasData ||
        query.invalidated ||
        (!this.sse.isConnected && Date.now() - query.dataUpdatedAt > STALE_TIME_WITHOUT_REALTIME_MS);
      if (stale) this.track(query.refetch());
    }
  }

  /** queries.ts periodRangeKey: the resolved period of a filter ("from/to" in ms, "/" for "Alle"). */
  rangeKey(query: BookingQuery, nowMs: number): string {
    if (query.period === 'all') return '/';
    const { from, to } = periodRanges(nowMs, this.timeZone)[query.period];
    return `${from ?? ''}/${to ?? ''}`;
  }

  /** bookingSync matchesQuery: the server's filter rules in the browser's time zone. */
  private matches(record: BookingRef, query: BookingQuery, nowMs: number): boolean {
    if (query.personId && record.person !== query.personId) return false;
    if (query.createdBy && record.createdBy !== query.createdBy) return false;
    if (query.period === 'all') return true;
    // one batch shares one `now` – compute the period bounds once per batch
    if (this.rangesAt?.now !== nowMs) this.rangesAt = { now: nowMs, ranges: periodRanges(nowMs, this.timeZone) };
    const { from, to } = this.rangesAt.ranges[query.period];
    const created = parsePbDate(record.created);
    if (from !== undefined && created < from) return false;
    if (to !== undefined && created >= to) return false;
    return true;
  }

  /** bookingSync relevantChanges: the changes that concern a query (every one, if it shows a period that has passed). */
  private relevantChanges(query: Query, changes: readonly ValidChange[], nowMs: number): ValidChange[] {
    if (!query.showsCurrentPeriod(nowMs)) return [...changes];
    const filter = query.filter();
    return changes.filter((change) => this.matches(change.record, filter, nowMs));
  }

  // ------------------------------------------------------------------ realtime

  private onMessage(event: string, data: string, at: number): void {
    if (this.closed) return;
    const collection = event.split('/')[0] ?? '';
    if (!(collection in INVALIDATION_MAP)) return;
    if (collection === 'bookings') {
      const parsed = parseRecordEvent(data);
      const change: BookingChange = parsed
        ? { action: parsed.action, record: { ...parsed.record, id: parsed.id } }
        : { action: 'unknown', record: { id: '' } };
      this.pendingEvents.push({ change, receivedAt: performance.timeOrigin + at });
    }
    this.pendingCollections.add(collection);
    this.debounceTimer ??= setTimeout(() => this.flush(), this.env.debounceMs ?? 120);
  }

  /** flushRealtimeBatch: prefix invalidation for the other collections, targeted updates for bookings. */
  private flush(): void {
    this.debounceTimer = undefined;
    if (this.closed) return;
    const nowMs = Date.now();
    const prefixes = new Set<string>();
    for (const collection of this.pendingCollections) {
      if (collection === 'bookings') continue;
      for (const prefix of INVALIDATION_MAP[collection] ?? []) prefixes.add(prefix);
    }
    this.pendingCollections.clear();
    const events = this.pendingEvents;
    this.pendingEvents = [];
    // offering / group events: every booking and totals query is refetched anyway
    const broad = prefixes.has('bookings') && prefixes.has('totals');

    const prefixWork = new Map<string, Promise<Settle>[]>();
    for (const query of this.queries) {
      if (!prefixes.has(query.prefix)) continue;
      const promise = this.track(query.refetch());
      prefixWork.set(query.prefix, [...(prefixWork.get(query.prefix) ?? []), promise]);
    }

    let work = new Map<BookingChange, Promise<Settle>[]>();
    const changes = events.map((event) => event.change);
    if (changes.length > 0) {
      if (broad) {
        // the broad refetch covers the booking changes (markBookingChangesHandled)
        const covering = [...(prefixWork.get('bookings') ?? []), ...(prefixWork.get('totals') ?? [])];
        for (const change of this.claim(changes, nowMs)) work.set(change, covering);
      } else {
        work = this.applyBookingChanges(changes, nowMs);
      }
    }
    for (const event of events) this.record(event, work.get(event.change) ?? []);
  }

  /** Records a booking event and fills in when the work it caused finished. */
  private record(event: PendingEvent, work: readonly Promise<Settle>[]): void {
    const entry: DeviceEvent = {
      device: this.spec.id,
      bookingId: event.change.record.id,
      action: event.change.action,
      receivedAt: event.receivedAt,
      relevant: work.length > 0,
      doneAt: work.length > 0 ? 0 : event.receivedAt,
    };
    this.events.push(entry);
    if (work.length === 0) return;
    void Promise.all(work).then((settles) => {
      if (settles.every((s) => s.ok)) entry.doneAt = Math.max(...settles.map((s) => s.at));
    });
  }

  /** Marks the changes as handled and returns the ones that were not handled before (bookingSync claim). */
  private claim(changes: readonly BookingChange[], nowMs: number): BookingChange[] {
    for (const [key, at] of this.handled) {
      if (nowMs - at <= HANDLED_TTL_MS) break;
      this.handled.delete(key);
    }
    const fresh: BookingChange[] = [];
    for (const change of changes) {
      const key = `${change.action}:${change.record.id}`;
      if (this.handled.has(key)) continue;
      this.handled.set(key, nowMs);
      fresh.push(change);
    }
    return fresh;
  }

  /**
   * bookingSync applyBookingChanges / updateQuery: every booking / totals
   * query decides what the changes mean for it. Returns the work per fresh
   * change (empty list = nothing on this screen changed).
   */
  private applyBookingChanges(changes: readonly BookingChange[], nowMs: number): Map<BookingChange, Promise<Settle>[]> {
    const work = new Map<BookingChange, Promise<Settle>[]>();
    const fresh = this.claim(changes, nowMs);
    for (const change of fresh) work.set(change, []);
    if (fresh.length === 0) return work;
    if (!fresh.every(isValidChange)) {
      // `update` (superusers only) or an unexpected record: refetch everything that depends on bookings
      const promises = this.queries.filter((q) => q.prefix === 'bookings' || q.prefix === 'totals').map((q) => this.track(q.refetch()));
      for (const change of fresh) work.get(change)?.push(...promises);
      return work;
    }
    const valid = fresh as ValidChange[];
    // the SPA walks the ['bookings'] queries first, then the ['totals'] ones
    const ordered = [...this.queries.filter((q) => q.prefix === 'bookings'), ...this.queries.filter((q) => q.prefix === 'totals')];
    for (const query of ordered) {
      const relevant = this.relevantChanges(query, valid, nowMs);
      if (relevant.length === 0) continue;
      if (!query.enabled) {
        void query.refetch(); // inactive: only marked stale
        continue;
      }
      let promise: Promise<Settle>;
      if (query instanceof TotalsQuery && (query.query.personId || !query.parts.includes('perPerson'))) {
        promise = query.refetch(); // one person's totals or no per-person rows: small – refetch (once after a running fetch)
      } else if (query instanceof RecentQuery && !query.isFetching && query.lanes.open === 0) {
        // an idle recent list: at once (a removal shows in this very update)
        promise = this.patchRecent(query, relevant, nowMs).then((outcome) => (outcome === 'again' ? done() : outcome));
      } else if (query instanceof TotalsQuery || query instanceof ListQuery || query instanceof RecentQuery) {
        promise = this.enqueue(query, relevant);
      } else {
        promise = query.refetch();
      }
      this.track(promise);
      for (const change of relevant) work.get(change)?.push(promise);
    }
    return work;
  }

  // ------------------------------------------------------------------ patch lanes (bookingSync enqueue / runLane)

  /**
   * Applies `changes` once the query is idle and its earlier patches are done
   * – together with all changes that arrive until then.
   */
  private enqueue(query: Query, changes: readonly ValidChange[]): Promise<Settle> {
    const { lanes } = query;
    if (lanes.collecting) {
      lanes.collecting.changes.push(...changes);
      return lanes.collecting.done;
    }
    const lane: Lane = { changes: [...changes], done: Promise.resolve(done()) };
    lanes.collecting = lane;
    lanes.open += 1;
    lane.done = lanes.tail
      .then(() => this.runLane(query, lane))
      .catch(() => done(false))
      .finally(() => {
        if (lanes.collecting === lane) lanes.collecting = null; // (only if it failed before it started)
        lanes.open -= 1;
      });
    lanes.tail = lane.done;
    return lane.done;
  }

  private async runLane(query: Query, lane: Lane): Promise<Settle> {
    for (let attempt = 1; ; attempt += 1) {
      await query.whenIdle();
      if (query.lanes.collecting === lane) query.lanes.collecting = null; // later changes: the next lane
      if (this.closed) return done(false);
      const outcome = await this.patchQuery(query, lane.changes, Date.now());
      if (outcome !== 'again') return outcome;
      if (attempt >= MAX_PATCH_ATTEMPTS) return query.refetch();
    }
  }

  /** The data may be another one by now (a refetch, midnight): which changes concern it? */
  private patchQuery(query: Query, changes: readonly ValidChange[], nowMs: number): Promise<Outcome> {
    const relevant = this.relevantChanges(query, changes, nowMs);
    if (relevant.length === 0) return Promise.resolve(done());
    if (query instanceof TotalsQuery) return this.patchPersonRows(query, relevant, nowMs);
    if (query instanceof ListQuery) return this.patchList(query, relevant, nowMs);
    if (query instanceof RecentQuery) return this.patchRecent(query, relevant, nowMs);
    return query.refetch();
  }

  /** bookingSync patchBlocker: `busy` – fetching (start again once idle); `outdated` – refetch; null – go. */
  private patchBlocker(query: Query, nowMs: number): 'busy' | 'outdated' | null {
    if (query.isFetching) return 'busy';
    if (!query.enabled || query.status !== 'success' || !query.hasData || query.invalidated || !query.showsCurrentPeriod(nowMs)) {
      return 'outdated';
    }
    return null;
  }

  /** bookingSync blocked: wait while busy, refetch when outdated, else null (go). */
  private blocked(query: Query, nowMs: number): Promise<Outcome> | null {
    const blocker = this.patchBlocker(query, nowMs);
    if (blocker === 'busy') return Promise.resolve('again');
    if (blocker === 'outdated') return query.refetch();
    return null;
  }

  /** bookingSync unchanged: the same, settled data as when the patch started? */
  private unchanged(query: Query, version: number, nowMs: number): boolean {
    return query.version === version && this.patchBlocker(query, nowMs) === null;
  }

  /** Totals with per-person rows (Personen, "Pro Person"): fetch the rows of the booked persons, refetch the other parts. */
  private async patchPersonRows(query: TotalsQuery, changes: readonly ValidChange[], nowMs: number): Promise<Outcome> {
    const stop = this.blocked(query, nowMs);
    if (stop) return stop;
    const persons = [...new Set(changes.map((change) => change.record.person))];
    if (persons.length > MAX_ROW_PATCHES) return query.refetch();
    const version = query.version;
    const others = query.parts.filter((part) => part !== 'perPerson');
    const requests = persons.map((personId) =>
      this.get('totals(person row)', paths.totals(totalsParams({ ...query.query, personId }, nowMs, this.timeZone, ['perPerson']))),
    );
    if (others.length > 0) {
      requests.push(this.get(totalsType(query.query, others), paths.totals(totalsParams(query.query, nowMs, this.timeZone, others))));
    }
    const results = await Promise.all(requests);
    if (!results.every(ok)) return query.refetch();
    // fetched or changed meanwhile: patch the new data instead
    if (!this.unchanged(query, version, nowMs)) return 'again';
    query.changed();
    return done();
  }

  /** The Buchungen list: local removals, one head request for other devices' new bookings, merged into the keyset pages. */
  private async patchList(query: ListQuery, changes: readonly ValidChange[], nowMs: number): Promise<Outcome> {
    const stop = this.blocked(query, nowMs);
    if (stop) return stop;
    const base = query.pages;
    const version = query.version;
    const deleted = new Set(changes.filter((c) => c.action === 'delete').map((c) => c.record.id));
    const created = changes.filter((c) => c.action === 'create' && !deleted.has(c.record.id));
    const direct = created.filter((c) => c.expanded).map((c) => c.record);
    const remote = created.filter((c) => !c.expanded).map((c) => c.record);

    let fetched: KeysetCursor[] = [];
    if (remote.length > 0) {
      // newer than the newest cached booking – or from the oldest new one on, if that is older
      const newest = newestItem(base);
      const oldestNew = [...remote].sort(compareNewestFirst).at(-1) as BookingRef;
      const fromOldestNew = !newest || compareNewestFirst(oldestNew, newest) > 0;
      const filter = keysetNewerFilter(
        bookingsFilter(query.query, nowMs, this.timeZone),
        fromOldestNew ? oldestNew : (newest as KeysetCursor),
        fromOldestNew,
      );
      const result = await this.get('list head', paths.bookings(filter), { collect: true });
      if (!ok(result)) return query.refetch();
      fetched = listItems(result);
      // a full page: there may be more new bookings than one request returns
      if (fetched.length >= BOOKINGS_PAGE_SIZE) return query.refetch();
      // a refetch or "Weitere laden" landed meanwhile: patch the new pages instead
      if (!this.unchanged(query, version, nowMs)) return 'again';
    }
    const next = removeFromPages(mergeIntoPages(base, [...fetched, ...direct]), deleted);
    // every new booking within the loaded range must be there now (else it was committed out of order)
    const present = new Set(next.flatMap((page) => page.items.map((item) => item.id)));
    if (created.some((c) => !present.has(c.record.id) && pageIndexFor(next, c.record) >= 0)) return query.refetch();
    if (next !== base) {
      query.pages = next;
      query.changed();
    }
    // cancellations removed every loaded row, but older bookings exist: reload, so they show
    if (present.size === 0 && next.at(-1)?.next) return query.refetch();
    return done();
  }

  /** The recent bookings of a person: synchronous patch, refetch only when the server must fill in. */
  private patchRecent(query: RecentQuery, changes: readonly ValidChange[], nowMs: number): Promise<Outcome> {
    const stop = this.blocked(query, nowMs);
    if (stop) return stop;
    const base = query.items;
    let items = base;
    let incomplete = false;
    for (const change of changes) {
      const present = items.some((item) => item.id === change.record.id);
      if (change.action === 'delete') {
        if (!present) continue; // older than the shown ones (or never there): the list stays as it is
        items = items.filter((item) => item.id !== change.record.id);
        // a full list: the next older booking moves up – only the server knows it
        if (base.length >= query.limit) incomplete = true;
      } else if (change.expanded) {
        if (!present) items = insertSorted(items, { id: change.record.id, created: change.record.created }).slice(0, query.limit);
      } else {
        incomplete = true; // other devices' events carry no expand (offering, user)
      }
    }
    if (items !== base) {
      query.items = items;
      query.changed();
    }
    return incomplete ? query.refetch() : Promise.resolve(done());
  }

  // ------------------------------------------------------------------ own mutations

  /** A booking tap (useCreateBooking): the response is applied like a realtime change – unless its echo came first. */
  async book(personId: string, offeringId: string, intended: number): Promise<MutationRecord> {
    const result = this.denialChecked(
      await this.request('POST', 'create', paths.createBooking(), {
        body: bookingBody(personId, offeringId, this.spec.userId),
        collect: true,
      }),
    );
    let id: string | undefined;
    if (result.status === 200) {
      try {
        const record = parseJson<BookingRef>(result);
        id = record.id;
        const own: BookingRef = { id: record.id, person: record.person, createdBy: record.createdBy, created: record.created };
        this.ownBookings.set(own.id, own);
        if (!this.closed) this.applyBookingChanges([{ action: 'create', record: own, expanded: true }], Date.now());
      } catch {
        // counted as success by status; the id is only needed for undo/propagation
      }
    }
    const sent = performance.timeOrigin + result.startedAt;
    return { device: this.spec.id, id, intended, sent, done: sent + result.ms, status: result.status, error: result.error };
  }

  /** "Rückgängig" (useDeleteBooking): onSettled applies the deletion (also after a 404); any other failure refetches broadly. */
  async undo(bookingId: string, intended: number): Promise<MutationRecord> {
    const result = this.denialChecked(await this.request('DELETE', 'delete', paths.booking(bookingId)));
    if (!this.closed) {
      const record = this.ownBookings.get(bookingId);
      if ((ok(result) || result.status === 404) && record) {
        this.applyBookingChanges([{ action: 'delete', record }], Date.now());
      } else {
        for (const query of this.queries) if (query.prefix === 'bookings' || query.prefix === 'totals') this.track(query.refetch());
      }
    }
    const sent = performance.timeOrigin + result.startedAt;
    return { device: this.spec.id, id: bookingId, intended, sent, done: sent + result.ms, status: result.status, error: result.error };
  }

  /** Resolves when no query is fetching, no patch lane and no other work is running (a pending debounce is not waited for). */
  async settled(): Promise<void> {
    for (;;) {
      await Promise.all([...this.queries.map((query) => query.settled()), ...this.work]);
      if (this.work.size === 0 && this.queries.every((query) => !query.isFetching && query.lanes.open === 0)) return;
    }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.debounceTimer);
    clearTimeout(this.sessionTimer);
    clearTimeout(this.midnightTimer);
    this.sse.close();
    this.http.close();
  }
}
