/**
 * Targeted cache updates for booking changes – the realtime events of other
 * devices and the device's own bookings and cancellations
 * (docs/LOADTEST-FINDINGS.md F2, ARCHITECTURE.md §6 "Data flow").
 *
 * Before, every booking event invalidated all booking and totals queries: each
 * screen refetched everything it showed (the Buchungen list all loaded pages,
 * Personen the complete totals), and an own booking cost two rounds (the
 * mutation's and its realtime echo's). Now every cached query decides what the
 * change means for it:
 *
 * - Not affected (the booking does not match the query's filter, e.g. another
 *   person's booking on a Buchen phone): nothing.
 * - Inactive (no mounted screen): marked stale – refetched when shown again.
 * - Small totals (anything of one person, the summary, per offering, per
 *   user): refetched – a few hundred bytes.
 * - Totals with per-person rows (Personen, "Pro Person"): the rows of the
 *   affected persons are fetched (`person=<id>&parts=perPerson` plus the
 *   query's filters) and patched in (insert / update / remove at 0); the other
 *   parts of the query (summary, …) are refetched without the per-person part.
 * - The Buchungen list (keyset pages, see queries.ts): a cancelled booking is
 *   removed from the cached pages; new bookings are loaded with one "head"
 *   request – newer than the newest cached booking (or, if a new booking is
 *   older than that, from it on) – and merged in. Own bookings come with the
 *   full record and are merged directly.
 * - Recent bookings of a person: a cancelled one is removed (refetched when the
 *   list was full, so the next older one moves up); new ones are refetched
 *   (events carry no expand) – own ones are merged directly.
 *
 * One patch per query at a time, and none while the query is fetching (its
 * first load, a refetch, "Weitere laden"): changes that arrive meanwhile are
 * collected and applied together once it is idle – a head request or row
 * patch on the fresh data. (A refetch per batch that met a running fetch
 * turned a booking stream on a slow network into back-to-back full refetches
 * that never ended while the stream lasted – FLOW-2.) A patch whose query
 * fetched or changed while its request was under way starts again on the new
 * data.
 *
 * Correctness first: whenever the cache state is uncertain the query is
 * refetched instead (invalidateSafely – a running fetch is never cancelled,
 * one refetch follows it): the query is invalidated or failed; a period
 * relative to "today" crossed midnight since the data was loaded; the head
 * fetch returned a full page or missed a new booking (one committed out of
 * order); a request failed; too many persons at once; a patch could not
 * settle after a few attempts; an `update` event (superusers only) or an
 * unexpected record.
 *
 * Own changes and their realtime echo cost one round: whichever arrives first
 * is applied, the other one is skipped (action + booking id).
 *
 * Person and user events: their new names are patched into the cached rows
 * (applyPersonUpdates / applyUserUpdates) – no request.
 */
import type { Query, QueryClient, QueryKey } from '@tanstack/react-query';
import { buildBookingsFilter, parsePbDate, type PeriodKey } from '../lib/dates';
import type {
  BookingRecord,
  PersonRecord,
  Totals,
  TotalsPart,
  TotalsPerPerson,
  TotalsPerUser,
  UserRecord,
} from '../lib/types';
import { invalidateAllSafely, invalidateSafely, whenIdle, whenSettled } from './invalidate';
import { compareNewestFirst, keysetNewerFilter } from './keyset';
import {
  BOOKINGS_PAGE_SIZE,
  fetchBookings,
  fetchTotals,
  periodRangeKey,
  queryKeys,
  resolveBookingQuery,
  type BookingListData,
  type BookingPage,
  type BookingQuery,
  type TotalsData,
} from './queries';
import { ALL_TOTALS_PARTS } from './totals';

export interface BookingChange {
  /** PocketBase realtime action: `create`, `update` or `delete`. */
  action: string;
  record: BookingRecord;
  /** The record carries the full expand (own booking: the create response). */
  expanded?: boolean;
}

/** Network and clock, replaceable in tests. */
export interface SyncDeps {
  fetchTotals: (query: BookingQuery, parts: readonly TotalsPart[], now: Date) => Promise<Totals>;
  fetchBookings: (filter: string, limit: number) => Promise<BookingRecord[]>;
  now: () => Date;
}

const defaultDeps: SyncDeps = { fetchTotals, fetchBookings, now: () => new Date() };

/** More persons in one batch → the per-person totals are refetched as a whole. */
export const MAX_ROW_PATCHES = 10;

/** How often a patch starts again on new data (the query fetched or changed meanwhile) before it refetches. */
export const MAX_PATCH_ATTEMPTS = 3;

/** How long a handled change is remembered (its echo arrives within a second). */
const HANDLED_TTL_MS = 5 * 60_000;

const RELATIVE_PERIODS: ReadonlySet<PeriodKey> = new Set(['today', '7d', '30d']);

// ---------------------------------------------------------------------------
// Own change + echo: remember what was applied (per QueryClient)

const handledByClient = new WeakMap<QueryClient, Map<string, number>>();

const changeId = (change: BookingChange) => `${change.action}:${change.record.id}`;

function handledMap(queryClient: QueryClient, nowMs: number): Map<string, number> {
  let handled = handledByClient.get(queryClient);
  if (!handled) {
    handled = new Map();
    handledByClient.set(queryClient, handled);
  }
  // insertion order = time order: drop expired entries from the front
  for (const [key, at] of handled) {
    if (nowMs - at <= HANDLED_TTL_MS) break;
    handled.delete(key);
  }
  return handled;
}

/** Marks the changes as handled and returns the ones that were not handled before. */
function claim(queryClient: QueryClient, changes: readonly BookingChange[], nowMs: number): BookingChange[] {
  const handled = handledMap(queryClient, nowMs);
  const fresh: BookingChange[] = [];
  for (const change of changes) {
    const id = changeId(change);
    if (handled.has(id)) continue;
    handled.set(id, nowMs);
    fresh.push(change);
  }
  return fresh;
}

/** Whether this change was already applied (own mutation or realtime). */
export function isBookingChangeHandled(queryClient: QueryClient, change: BookingChange): boolean {
  return handledByClient.get(queryClient)?.has(changeId(change)) ?? false;
}

/** Records changes that are covered otherwise (a broad invalidation), so their own/echo twin is skipped. */
export function markBookingChangesHandled(queryClient: QueryClient, changes: readonly BookingChange[]): void {
  claim(queryClient, changes, Date.now());
}

// ---------------------------------------------------------------------------
// Query keys → what a query shows (key shapes: queries.ts queryKeys)

type Target =
  | { kind: 'totals'; query: BookingQuery; parts: TotalsPart[] }
  | { kind: 'list'; query: BookingQuery }
  | { kind: 'recent'; personId: string; limit: number };

function isBookingQuery(value: unknown): value is BookingQuery {
  return typeof value === 'object' && value !== null && typeof (value as BookingQuery).period === 'string';
}

function isParts(value: unknown): value is TotalsPart[] {
  return Array.isArray(value) && value.every((part) => ALL_TOTALS_PARTS.includes(part as TotalsPart));
}

function describeKey(key: QueryKey): Target | null {
  if (key[0] === 'totals' && key.length === 3 && isBookingQuery(key[1]) && isParts(key[2])) {
    return { kind: 'totals', query: key[1], parts: key[2] };
  }
  if (key[0] === 'bookings' && key[1] === 'list' && key.length === 3 && isBookingQuery(key[2])) {
    return { kind: 'list', query: key[2] };
  }
  if (key[0] === 'bookings' && key[1] === 'recent' && key.length === 4 && typeof key[2] === 'string' && typeof key[3] === 'number') {
    return { kind: 'recent', personId: key[2], limit: key[3] };
  }
  return null;
}

/** Whether a query shows a period relative to "today" ("Heute", 7 / 30 Tage) – it moves at local midnight. */
export function showsRelativePeriod(key: QueryKey): boolean {
  const target = describeKey(key);
  return target !== null && target.kind !== 'recent' && RELATIVE_PERIODS.has(target.query.period);
}

function isValidChange(change: BookingChange): boolean {
  const r = change.record as Partial<BookingRecord> | undefined;
  return (
    (change.action === 'create' || change.action === 'delete') &&
    typeof r?.id === 'string' &&
    typeof r.person === 'string' &&
    typeof r.createdBy === 'string' &&
    typeof r.created === 'string' &&
    !Number.isNaN(parsePbDate(r.created).getTime())
  );
}

/** Whether a booking falls under a booking filter (same rules as the server's filter). */
export function matchesQuery(record: BookingRecord, query: BookingQuery, now: Date): boolean {
  const { range, personId, createdBy } = resolveBookingQuery(query, now);
  if (personId && record.person !== personId) return false;
  if (createdBy && record.createdBy !== createdBy) return false;
  const created = parsePbDate(record.created).getTime();
  if (range.from && created < range.from.getTime()) return false;
  if (range.to && created >= range.to.getTime()) return false;
  return true;
}

/**
 * Whether cached data shows the query's current period. "Heute" and 7 / 30
 * Tage move at local midnight; the data records what it was loaded for (the
 * pages' `base` filter, the totals' `range`) – `dataUpdatedAt` would not do:
 * it is the time of the last write, also of a patch or of "Weitere laden"
 * after midnight on a list of the day before.
 */
function showsCurrentPeriod(target: Target, data: unknown, now: Date): boolean {
  if (target.kind === 'recent' || !RELATIVE_PERIODS.has(target.query.period)) return true;
  if (data === undefined) return false;
  if (target.kind === 'list') {
    const base = buildBookingsFilter(resolveBookingQuery(target.query, now));
    return (data as BookingListData).pages.every((page) => page.base === base);
  }
  return (data as TotalsData).range === periodRangeKey(target.query, now);
}

function filterOf(target: Target): BookingQuery {
  return target.kind === 'recent' ? { period: 'all', personId: target.personId } : target.query;
}

/** The changes that concern a query (every one, if it shows a period that has passed). */
function relevantChanges(target: Target, changes: readonly BookingChange[], data: unknown, now: Date) {
  if (!showsCurrentPeriod(target, data, now)) return [...changes];
  const filter = filterOf(target);
  return changes.filter((change) => matchesQuery(change.record, filter, now));
}

/**
 * Whether a patch can start now: `busy` – the query is fetching (start again
 * once it is idle); `outdated` – it must be refetched (not mounted, no settled
 * data, invalidated, or a period that midnight has moved on); null – go.
 */
function patchBlocker(query: Query, target: Target, now: Date): 'busy' | 'outdated' | null {
  const { state } = query;
  if (state.fetchStatus !== 'idle') return 'busy';
  if (
    !query.isActive() ||
    state.status !== 'success' ||
    state.data === undefined ||
    state.isInvalidated ||
    !showsCurrentPeriod(target, state.data, now)
  ) {
    return 'outdated';
  }
  return null;
}

/** The fallback: refetch (active) or mark stale (inactive), never cancelling a running fetch. */
function refetch(queryClient: QueryClient, query: Query): Promise<void> {
  return invalidateSafely(queryClient, query.queryKey, { exact: true });
}

/** A patch either finished (applied, nothing to do, or fell back to a refetch) or must start again on new data. */
type Outcome = 'done' | 'again';

const DONE: Promise<Outcome> = Promise.resolve('done');
const AGAIN: Promise<Outcome> = Promise.resolve('again');

function fallBack(queryClient: QueryClient, query: Query): Promise<Outcome> {
  return refetch(queryClient, query).then(() => 'done' as const);
}

/** The usual start of a patch: wait while busy, refetch when outdated, else null (go). */
function blocked(queryClient: QueryClient, query: Query, target: Target, now: Date): Promise<Outcome> | null {
  const blocker = patchBlocker(query, target, now);
  if (blocker === 'busy') return AGAIN;
  if (blocker === 'outdated') return fallBack(queryClient, query);
  return null;
}

/** Still the same cache entry with the same, settled data as when the patch started? */
function unchanged(queryClient: QueryClient, query: Query, data: unknown, target: Target, now: Date): boolean {
  return (
    queryClient.getQueryCache().get(query.queryHash) === query &&
    query.state.data === data &&
    patchBlocker(query, target, now) === null
  );
}

// ---------------------------------------------------------------------------
// One patch per query at a time; changes arriving meanwhile are applied together

interface Lane {
  changes: BookingChange[];
  done: Promise<void>;
}

interface Lanes {
  /** The lane that still takes changes: it waits for the query (fetching) or for the patch before it. */
  collecting: Lane | null;
  /** The end of the last lane – the next one starts after it. */
  tail: Promise<void>;
  /** Lanes that have not finished yet. */
  open: number;
}

const lanesByQuery = new WeakMap<Query, Lanes>();

function hasOpenLane(query: Query): boolean {
  return (lanesByQuery.get(query)?.open ?? 0) > 0;
}

/**
 * Applies `changes` to the query once it is idle and its earlier patches are
 * done – together with all changes that arrive until then (one head request
 * or one row patch for any number of batches).
 */
function enqueue(
  queryClient: QueryClient,
  query: Query,
  target: Target,
  changes: readonly BookingChange[],
  deps: SyncDeps,
): Promise<void> {
  let lanes = lanesByQuery.get(query);
  if (!lanes) {
    lanes = { collecting: null, tail: Promise.resolve(), open: 0 };
    lanesByQuery.set(query, lanes);
  }
  if (lanes.collecting) {
    lanes.collecting.changes.push(...changes);
    return lanes.collecting.done;
  }
  const state = lanes;
  const lane: Lane = { changes: [...changes], done: Promise.resolve() };
  state.collecting = lane;
  state.open += 1;
  lane.done = state.tail
    .then(() => runLane(queryClient, query, target, lane, state, deps))
    .catch(() => undefined)
    .finally(() => {
      if (state.collecting === lane) state.collecting = null; // (only if it failed before it started)
      state.open -= 1;
    });
  state.tail = lane.done;
  return lane.done;
}

async function runLane(
  queryClient: QueryClient,
  query: Query,
  target: Target,
  lane: Lane,
  lanes: Lanes,
  deps: SyncDeps,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    await whenIdle(queryClient, query);
    if (lanes.collecting === lane) lanes.collecting = null; // later changes: the next lane
    if (queryClient.getQueryCache().get(query.queryHash) !== query) return; // removed meanwhile
    const outcome = await patchQuery(queryClient, query, target, lane.changes, deps, deps.now());
    if (outcome === 'done') return;
    if (attempt >= MAX_PATCH_ATTEMPTS) return refetch(queryClient, query);
  }
}

function patchQuery(
  queryClient: QueryClient,
  query: Query,
  target: Target,
  changes: readonly BookingChange[],
  deps: SyncDeps,
  now: Date,
): Promise<Outcome> {
  // the data may be another one by now (a refetch, midnight): which changes concern it?
  const relevant = relevantChanges(target, changes, query.state.data, now);
  if (relevant.length === 0) return DONE;
  switch (target.kind) {
    case 'totals':
      return patchPersonRows(queryClient, query, target, relevant, deps, now);
    case 'list':
      return patchList(queryClient, query, target, relevant, deps, now);
    case 'recent':
      return patchRecent(queryClient, query, target, relevant, now);
  }
}

// ---------------------------------------------------------------------------
// Totals

/** The server's order of `perPerson`: number (ASCII case-insensitive – numbers are ASCII), then person id. */
function comparePersonRows(a: TotalsPerPerson, b: TotalsPerPerson): number {
  const an = a.number.toLowerCase();
  const bn = b.number.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  if (a.personId !== b.personId) return a.personId < b.personId ? -1 : 1;
  return 0;
}

/** Inserts, replaces or (no row / count 0) removes the row of one person. */
export function replacePersonRow(
  rows: readonly TotalsPerPerson[],
  personId: string,
  row: TotalsPerPerson | undefined,
): TotalsPerPerson[] {
  const index = rows.findIndex((entry) => entry.personId === personId);
  if (!row || row.count <= 0) return index < 0 ? [...rows] : rows.filter((_, i) => i !== index);
  const rest = index < 0 ? [...rows] : rows.filter((_, i) => i !== index);
  const at = rest.findIndex((entry) => comparePersonRows(row, entry) < 0);
  if (at < 0) rest.push(row);
  else rest.splice(at, 0, row);
  return rest;
}

async function patchPersonRows(
  queryClient: QueryClient,
  query: Query,
  target: Extract<Target, { kind: 'totals' }>,
  changes: readonly BookingChange[],
  deps: SyncDeps,
  now: Date,
): Promise<Outcome> {
  const stop = blocked(queryClient, query, target, now);
  if (stop) return stop;
  const base = query.state.data as Totals;
  const persons = [...new Set(changes.map((change) => change.record.person))];
  if (!base.perPerson || persons.length > MAX_ROW_PATCHES) return fallBack(queryClient, query);

  const otherParts = target.parts.filter((part) => part !== 'perPerson');
  let rows: Totals[];
  let others: Totals | undefined;
  try {
    [rows, others] = await Promise.all([
      Promise.all(persons.map((personId) => deps.fetchTotals({ ...target.query, personId }, ['perPerson'], now))),
      otherParts.length > 0 ? deps.fetchTotals(target.query, otherParts, now) : Promise.resolve(undefined),
    ]);
  } catch {
    return fallBack(queryClient, query);
  }
  // fetched or changed meanwhile: patch the new data instead (the rows are absolute values – fetched again)
  if (!unchanged(queryClient, query, base, target, now)) return 'again';

  let perPerson: TotalsPerPerson[] = base.perPerson;
  persons.forEach((personId, i) => {
    const row = rows[i]?.perPerson?.find((entry) => entry.personId === personId);
    perPerson = replacePersonRow(perPerson, personId, row);
  });
  queryClient.setQueryData<Totals>(query.queryKey, { ...base, ...others, perPerson });
  return 'done';
}

// ---------------------------------------------------------------------------
// Buchungen list (keyset pages)

function newestItem(data: BookingListData): BookingRecord | undefined {
  for (const page of data.pages) if (page.items.length > 0) return page.items[0];
  return undefined;
}

/** Index of the cached page a booking belongs to, or -1 if it is older than everything loaded. */
function pageIndexFor(pages: readonly BookingPage[], record: BookingRecord): number {
  return pages.findIndex((page) => page.next === null || compareNewestFirst(record, page.next) <= 0);
}

function insertSorted(items: readonly BookingRecord[], record: BookingRecord): BookingRecord[] {
  const result = [...items];
  const at = result.findIndex((item) => compareNewestFirst(record, item) < 0);
  if (at < 0) result.push(record);
  else result.splice(at, 0, record);
  return result;
}

/** Merges new bookings into the pages they belong to (skipping known ids and anything older than the loaded range). */
export function mergeIntoPages(data: BookingListData, records: readonly BookingRecord[]): BookingListData {
  const known = new Set(data.pages.flatMap((page) => page.items.map((item) => item.id)));
  let pages = data.pages;
  for (const record of records) {
    if (known.has(record.id)) continue;
    const index = pageIndexFor(pages, record);
    if (index < 0) continue; // comes with "Weitere laden"
    known.add(record.id);
    pages = pages.map((page, i) => (i === index ? { ...page, items: insertSorted(page.items, record) } : page));
  }
  return pages === data.pages ? data : { ...data, pages };
}

/** Removes bookings from every cached page (each page keeps its cursor). */
export function removeFromPages(data: BookingListData, ids: ReadonlySet<string>): BookingListData {
  let changed = false;
  const pages = data.pages.map((page) => {
    if (!page.items.some((item) => ids.has(item.id))) return page;
    changed = true;
    return { ...page, items: page.items.filter((item) => !ids.has(item.id)) };
  });
  return changed ? { ...data, pages } : data;
}

async function patchList(
  queryClient: QueryClient,
  query: Query,
  target: Extract<Target, { kind: 'list' }>,
  changes: readonly BookingChange[],
  deps: SyncDeps,
  now: Date,
): Promise<Outcome> {
  const stop = blocked(queryClient, query, target, now);
  if (stop) return stop;
  const base = query.state.data as BookingListData;
  const deleted = new Set(changes.filter((c) => c.action === 'delete').map((c) => c.record.id));
  const created = changes.filter((c) => c.action === 'create' && !deleted.has(c.record.id));
  const direct = created.filter((c) => c.expanded).map((c) => c.record);
  const remote = created.filter((c) => !c.expanded).map((c) => c.record);

  let fetched: BookingRecord[] = [];
  if (remote.length > 0) {
    // newer than the newest cached booking – or from the oldest new one on, if that is older
    const newest = newestItem(base);
    const oldestNew = [...remote].sort(compareNewestFirst).at(-1)!;
    const fromOldestNew = !newest || compareNewestFirst(oldestNew, newest) > 0;
    const filter = keysetNewerFilter(
      buildBookingsFilter(resolveBookingQuery(target.query, now)),
      fromOldestNew ? oldestNew : newest,
      fromOldestNew,
    );
    try {
      fetched = await deps.fetchBookings(filter, BOOKINGS_PAGE_SIZE);
    } catch {
      return fallBack(queryClient, query);
    }
    // a full page: there may be more new bookings than one request returns
    if (fetched.length >= BOOKINGS_PAGE_SIZE) return fallBack(queryClient, query);
    // a refetch or "Weitere laden" landed meanwhile: patch the new pages instead (never the old ones)
    if (!unchanged(queryClient, query, base, target, now)) return 'again';
  }

  const next = removeFromPages(mergeIntoPages(base, [...fetched, ...direct]), deleted);
  // every new booking within the loaded range must be there now (else it was committed out of order)
  const present = new Set(next.pages.flatMap((page) => page.items.map((item) => item.id)));
  if (created.some((c) => !present.has(c.record.id) && pageIndexFor(next.pages, c.record) >= 0)) {
    return fallBack(queryClient, query);
  }
  if (next !== base) queryClient.setQueryData<BookingListData>(query.queryKey, next);
  // cancellations removed every loaded row, but older bookings exist: reload, so they show
  if (present.size === 0 && next.pages.at(-1)?.next) return fallBack(queryClient, query);
  return 'done';
}

// ---------------------------------------------------------------------------
// Recent bookings of a person

/** Synchronous (no request of its own), so the result is visible right away. */
function patchRecent(
  queryClient: QueryClient,
  query: Query,
  target: Extract<Target, { kind: 'recent' }>,
  changes: readonly BookingChange[],
  now: Date,
): Promise<Outcome> {
  const stop = blocked(queryClient, query, target, now);
  if (stop) return stop;
  const base = query.state.data as BookingRecord[];
  let items = base;
  let incomplete = false;
  for (const change of changes) {
    const present = items.some((item) => item.id === change.record.id);
    if (change.action === 'delete') {
      if (!present) continue; // older than the shown ones (or never there): the list stays as it is
      items = items.filter((item) => item.id !== change.record.id);
      // a full list: the next older booking moves up – only the server knows it
      if (base.length >= target.limit) incomplete = true;
    } else if (change.expanded) {
      if (!present) items = insertSorted(items, change.record).slice(0, target.limit);
    } else {
      incomplete = true; // other devices' events carry no expand (offering, user)
    }
  }
  // removals show at once, also when the refetch follows
  if (items !== base) queryClient.setQueryData<BookingRecord[]>(query.queryKey, items);
  return incomplete ? fallBack(queryClient, query) : DONE;
}

// ---------------------------------------------------------------------------

function updateQuery(
  queryClient: QueryClient,
  query: Query,
  changes: readonly BookingChange[],
  deps: SyncDeps,
  now: Date,
): Promise<void> {
  const target = describeKey(query.queryKey);
  if (!target) return refetch(queryClient, query); // unknown booking/totals query: be safe
  const relevant = relevantChanges(target, changes, query.state.data, now);
  if (relevant.length === 0) return Promise.resolve();
  if (!query.isActive()) return refetch(queryClient, query); // marks it stale only

  // one person's totals or no per-person rows: small – refetched (once after a running fetch)
  if (target.kind === 'totals' && (target.query.personId || !target.parts.includes('perPerson'))) {
    return refetch(queryClient, query);
  }
  // recent bookings of an idle query: at once (a removal shows in this very update)
  if (target.kind === 'recent' && query.state.fetchStatus === 'idle' && !hasOpenLane(query)) {
    return patchRecent(queryClient, query, target, relevant, now).then(() => undefined);
  }
  return enqueue(queryClient, query, target, relevant, deps);
}

/**
 * Applies booking changes to all cached booking and totals queries (see the
 * header). Changes applied before (own change ↔ realtime echo) are skipped.
 * Resolves when every resulting request and patch has settled.
 */
export function applyBookingChanges(
  queryClient: QueryClient,
  changes: readonly BookingChange[],
  options: { deps?: Partial<SyncDeps> } = {},
): Promise<void> {
  const deps: SyncDeps = { ...defaultDeps, ...options.deps };
  const now = deps.now();
  const fresh = claim(queryClient, changes, now.getTime());
  if (fresh.length === 0) return Promise.resolve();
  if (!fresh.every(isValidChange)) {
    // `update` (superusers only) or an unexpected record: refetch everything that depends on bookings
    return invalidateAllSafely(queryClient, [queryKeys.bookings, queryKeys.totals]);
  }
  const queries = bookingAndTotalsQueries(queryClient);
  return Promise.all(queries.map((query) => updateQuery(queryClient, query, fresh, deps, now))).then(() => undefined);
}

function bookingAndTotalsQueries(queryClient: QueryClient): Query[] {
  const cache = queryClient.getQueryCache();
  return [...cache.findAll({ queryKey: queryKeys.bookings }), ...cache.findAll({ queryKey: queryKeys.totals })];
}

// ---------------------------------------------------------------------------
// Person and user fields in cached rows (person / user events)

/**
 * Edits the data of every cached booking and totals query – once it is idle
 * (a running fetch may still return the old names). Invalidated queries are
 * left alone: they are refetched anyway, and setQueryData would clear the mark.
 */
function editCachedRows(queryClient: QueryClient, edit: (target: Target, data: unknown) => unknown): void {
  const cache = queryClient.getQueryCache();
  for (const query of bookingAndTotalsQueries(queryClient)) {
    const target = describeKey(query.queryKey);
    if (!target) continue;
    const apply = () => {
      const { data, isInvalidated } = query.state;
      if (data === undefined || isInvalidated || cache.get(query.queryHash) !== query) return;
      const next = edit(target, data);
      if (next !== data) queryClient.setQueryData(query.queryKey, next);
    };
    if (query.state.fetchStatus === 'idle') apply();
    else void whenSettled(queryClient, query).then(apply);
  }
}

/** Replaces bookings in list pages / recent lists; the same data when `replace` changed nothing. */
function editBookings(target: Target, data: unknown, replace: (booking: BookingRecord) => BookingRecord): unknown {
  const editItems = (items: BookingRecord[]) => {
    let changed = false;
    const next = items.map((item) => {
      const replaced = replace(item);
      if (replaced !== item) changed = true;
      return replaced;
    });
    return changed ? next : items;
  };
  if (target.kind === 'recent') return editItems(data as BookingRecord[]);
  if (target.kind !== 'list') return data;
  const list = data as BookingListData;
  let changed = false;
  const pages = list.pages.map((page) => {
    const items = editItems(page.items);
    if (items === page.items) return page;
    changed = true;
    return { ...page, items };
  });
  return changed ? { ...list, pages } : list;
}

/**
 * New number / name / nickname of persons in the cached rows: `expand.person`
 * of the bookings, the per-person totals (re-sorted – the server orders them
 * by number). Bookings of a created or deleted person cannot be cached (only
 * persons without bookings can be deleted), so only updates matter.
 */
export function applyPersonUpdates(queryClient: QueryClient, persons: readonly PersonRecord[]): void {
  if (persons.length === 0) return;
  const byId = new Map(persons.map((person) => [person.id, person]));
  editCachedRows(queryClient, (target, data) => {
    if (target.kind !== 'totals') {
      return editBookings(target, data, (booking) => {
        const person = byId.get(booking.person);
        const shown = booking.expand?.person;
        if (!person || !shown || samePersonFields(shown, person)) return booking;
        return { ...booking, expand: { ...booking.expand, person: { ...shown, ...person } } };
      });
    }
    const totals = data as Totals;
    if (!totals.perPerson) return data;
    let rows = totals.perPerson;
    for (const person of persons) {
      const row = rows.find((entry) => entry.personId === person.id);
      if (!row || samePersonFields(row, person)) continue;
      rows = replacePersonRow(rows, person.id, {
        ...row,
        number: person.number,
        name: person.name,
        nickname: person.nickname,
      });
    }
    return rows === totals.perPerson ? data : { ...totals, perPerson: rows };
  });
}

function samePersonFields(a: Pick<PersonRecord, 'number' | 'name' | 'nickname'>, b: PersonRecord): boolean {
  return a.number === b.number && a.name === b.name && a.nickname === b.nickname;
}

/** The server's order of `perUser`: username (binary – usernames are lowercase ASCII), then user id. */
function compareUserRows(a: TotalsPerUser, b: TotalsPerUser): number {
  if (a.username !== b.username) return a.username < b.username ? -1 : 1;
  if (a.userId !== b.userId) return a.userId < b.userId ? -1 : 1;
  return 0;
}

/**
 * New username / name of users in the cached rows: `expand.createdBy` of the
 * bookings ("von …"), the per-user totals (re-sorted by username). Users with
 * bookings cannot be deleted, so only updates matter.
 */
export function applyUserUpdates(queryClient: QueryClient, users: readonly UserRecord[]): void {
  if (users.length === 0) return;
  const byId = new Map(users.map((user) => [user.id, user]));
  editCachedRows(queryClient, (target, data) => {
    if (target.kind !== 'totals') {
      return editBookings(target, data, (booking) => {
        const user = byId.get(booking.createdBy);
        const shown = booking.expand?.createdBy;
        if (!user || !shown || (shown.username === user.username && shown.name === user.name)) return booking;
        return { ...booking, expand: { ...booking.expand, createdBy: { ...shown, ...user } } };
      });
    }
    const totals = data as Totals;
    if (!totals.perUser) return data;
    let changed = false;
    const rows = totals.perUser.map((row) => {
      const user = byId.get(row.userId);
      if (!user || (row.username === user.username && row.name === user.name)) return row;
      changed = true;
      return { ...row, username: user.username, name: user.name };
    });
    return changed ? { ...totals, perUser: rows.sort(compareUserRows) } : data;
  });
}
