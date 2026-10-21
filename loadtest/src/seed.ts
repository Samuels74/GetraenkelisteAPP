/**
 * The seeder: turns the dataset plan (dataset.ts) into records of a running
 * instance – through the REST API, so API rules and hooks run as in
 * production – then backdates the bookings through the test-only support
 * route and verifies the result (verify.ts). See docs/LOADTEST.md.
 *
 * Steps and what they measure (SeedSummary.steps):
 *   setup     superuser login, safety check, offering prices, users, logins
 *   persons   POST /api/collections/persons/records as `admin` (like the SPA)
 *   bookings  POST /api/collections/bookings/records as the planned user, with
 *             the SPA's request shape (createdBy + expand), `concurrency`
 *             requests in flight, in the chronological order of the planned
 *             timestamps (dataset.ts creationOrder – production stores rows
 *             in `created` order; in-flight creates may land slightly out of
 *             order)
 *   backdate  POST /api/loadtest/backdate-bookings (superuser, batches)
 *   verify    read back + checks
 * The create steps report throughput and request latencies ("write path
 * under seeding load").
 *
 * Failed requests are never hidden and never blindly repeated: a create
 * request is not idempotent, and a failed one may still have been committed
 * (lost response, error after the commit). So after a create step the server
 * is asked first – persons by their unique number, bookings by person +
 * offering + user minus the ids already known – and records found there are
 * adopted ("found on the server"); only the rest is retried, once, and
 * checked again afterwards. Every failed request is counted and reported,
 * more than `maxErrors` failures abort the seed, and after each create step
 * the server's record count must equal "before + created" – also without
 * `verify` – so duplicates can never go unnoticed.
 *
 * Safety: refuses instances that are not fresh – persons, bookings, users
 * besides `admin`, an `admin` whose password was changed or offering prices
 * set – unless `force` is given (the dataset is then added: persons with an
 * existing number are reused, users are updated), and only talks to `url`.
 */
import type PocketBase from 'pocketbase';
import type { RecordModel } from 'pocketbase';
import {
  countRecords,
  describeError,
  loginSuperuser,
  loginUser,
  type SuperuserCredentials,
} from './api.ts';
import {
  buildDataset,
  creationOrder,
  DEFAULT_PASSWORD,
  resolveTimestamps,
  timestampWindow,
  type Dataset,
  type DatasetOptions,
  type ResolvedDatasetOptions,
} from './dataset.ts';
import { runPool } from './pool.ts';
import { latencyStats, now, perSecond, type LatencyStats } from './stats.ts';
import { countPerPeriod, toPbDate, type PeriodKey } from './time.ts';
import { verifyDataset, type CheckResult, type ContentDump } from './verify.ts';

/** Relations the SPA expands when it creates a booking (frontend/src/lib/pb.ts BOOKING_EXPAND). */
export const BOOKING_EXPAND = 'person,offering.group,createdBy';
export const BACKDATE_ROUTE = '/api/loadtest/backdate-bookings';

const int = (value: number) => value.toLocaleString('en');

export interface SeedOptions extends DatasetOptions {
  /** Base URL of the instance – the seeder talks to nothing else. */
  url: string;
  superuser: SuperuserCredentials;
  /** Password set for `admin` and all generated users (default "loadtest"). */
  password?: string;
  /** Create requests in flight (default 10). */
  concurrency?: number;
  /** Abort when more requests than this failed (default 10). */
  maxErrors?: number;
  /** Seed although the instance is not fresh (persons, bookings, users, changed admin, prices). */
  force?: boolean;
  /** Spread the bookings over `days` via the support route (default true). */
  backdate?: boolean;
  /** Bookings per backdate request (default 500, at most 1000). */
  backdateBatchSize?: number;
  /** Read everything back and check it (default true). */
  verify?: boolean;
  /** Reference time: timestamps lie in [now − days, now). Default: the seed start; must not be later. */
  now?: Date;
  /** Progress output (default: none). */
  log?: (line: string) => void;
  /** Interval of the progress lines of the create steps in ms (default 2000). */
  progressIntervalMs?: number;
  signal?: AbortSignal;
}

export interface StepResult {
  /** Records (or requests) processed successfully. */
  count: number;
  durationMs: number;
  /** count / duration */
  perSecond: number;
  /** Failed requests (non-2xx or no response), incl. failed retries. */
  errors: number;
  /** Latency of the individual create requests (create steps; successful first attempts only). */
  latency?: LatencyStats;
  /** Requests sent (backdate step). */
  requests?: number;
}

export interface SeedSummary {
  /** Every planned record exists exactly once on the server and every check passed. */
  ok: boolean;
  url: string;
  options: ResolvedDatasetOptions & {
    concurrency: number;
    maxErrors: number;
    force: boolean;
    backdate: boolean;
    backdateBatchSize: number;
    verify: boolean;
  };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** All seeded bookings lie in [from, to); `to` = the seed start (or `now`). */
  window: { from: string; to: string; days: number; timeZone: string };
  /** Records found before seeding (non-zero only with `force`). */
  existing: { persons: number; bookings: number };
  counts: {
    persons: number;
    personsCreated: number;
    users: number;
    bookings: number;
    perUser: Record<string, number>;
    perOffering: Record<string, number>;
    /** Number of persons per booking count, e.g. { "5": 331, … }. */
    perPersonHistogram: Record<string, number>;
    /** Seeded bookings per period preset of the Buchungen screen, at the seed start (dataset time zone). */
    perPeriod: Record<PeriodKey, number>;
    /**
     * Where bookings / perUser / perOffering / perPersonHistogram / value come
     * from: 'instance' = read back (verify), 'plan' = the created plan items
     * (verify off; the server count check still guarantees no extra records).
     */
    source: 'instance' | 'plan';
  };
  value: { quantity: number; totalCents: number };
  users: Array<{ username: string; name: string; role: string; id: string }>;
  offerings: Array<{ name: string; id: string; priceCents: number }>;
  steps: { setup: StepResult; persons: StepResult; bookings: StepResult; backdate: StepResult; verify: StepResult };
  errors: {
    /** Failed requests (incl. failed retries and failed server checks). */
    total: number;
    byStatus: Record<string, number>;
    samples: string[];
    /** Creates sent again after the server showed they had not been applied. */
    retried: number;
    /** Failed creates whose record exists now: found on the server or retried successfully. */
    recovered: number;
    /** Failed creates that had been committed anyway (lost response) – adopted, not repeated. */
    foundOnServer: number;
  };
  checks: CheckResult[];
  /**
   * The order the bookings were created in: chronological by their planned
   * timestamps (since 2026-10-20; before, a seeded shuffle – plan
   * fingerprints of earlier seeds differ for that reason).
   */
  creationOrder: 'chronological';
  fingerprints: {
    /** sha256 of the dataset plan (options, persons, users, bookings with their local times; generation order). */
    plan: string;
    /** sha256 of the read-back content without ids/timestamps (verify only). */
    content?: string;
  };
}

export interface SeedResult {
  summary: SeedSummary;
  /** The plan that was seeded. */
  dataset: Dataset;
  /** Read-back content (verify only) – e.g. to diff two seeds. */
  content?: ContentDump;
}

/** The instance is not fresh and `force` was not given. */
export class SeedRefusedError extends Error {
  override name = 'SeedRefusedError';
}

/** The seed was aborted (too many failed requests, missing support route, …). */
export class SeedError extends Error {
  override name = 'SeedError';
}

class ErrorLog {
  total = 0;
  retried = 0;
  recovered = 0;
  foundOnServer = 0;
  readonly byStatus: Record<string, number> = {};
  readonly samples: string[] = [];
  private readonly maxErrors: number;

  constructor(maxErrors: number) {
    this.maxErrors = maxErrors;
  }

  /** Counts a failed request; throws once more than `maxErrors` requests failed. */
  record(step: string, what: string, error: unknown): void {
    const { status, message } = describeError(error);
    this.total++;
    this.byStatus[String(status)] = (this.byStatus[String(status)] ?? 0) + 1;
    if (this.samples.length < 10) this.samples.push(`${step} ${what}: ${message}`);
    if (this.total > this.maxErrors) {
      throw new SeedError(
        `aborting: ${this.total} requests failed (more than maxErrors = ${this.maxErrors}). First errors:\n  ` +
          this.samples.join('\n  '),
      );
    }
  }
}

interface CreateStep {
  /** Record id per item position; undefined = the record does not exist. */
  ids: (string | undefined)[];
  latencies: number[];
  durationMs: number;
  errors: number;
}

/**
 * Creates items with `concurrency` requests in flight. Failed items are never
 * sent again blindly: `findCreated` first looks for records that the failed
 * requests created anyway, those are adopted; the rest is retried once
 * (sequentially) and looked for again afterwards (the retry's response may be
 * lost as well). If the server cannot be asked, nothing is retried.
 */
async function createAll<T>(
  step: string,
  items: readonly T[],
  options: {
    concurrency: number;
    errors: ErrorLog;
    log: (line: string) => void;
    progressIntervalMs: number;
    signal?: AbortSignal;
    describe: (item: T, index: number) => string;
    create: (item: T, index: number) => Promise<string>;
    /** Positions → ids of records the failed creates committed anyway (`known` = ids of this run). */
    findCreated: (positions: number[], known: ReadonlySet<string>) => Promise<Map<number, string>>;
  },
): Promise<CreateStep> {
  const { errors, signal } = options;
  const ids = new Array<string | undefined>(items.length);
  const latencies: number[] = [];
  const failed: number[] = [];
  const errorsBefore = errors.total;
  const started = now();
  let done = 0;
  const progress = setInterval(() => {
    const elapsed = now() - started;
    options.log(`  ${step}: ${int(done)} / ${int(items.length)} (${perSecond(done, elapsed)}/s)`);
  }, options.progressIntervalMs);
  progress.unref();

  try {
    await runPool(
      items,
      options.concurrency,
      async (item, index) => {
        const t0 = now();
        try {
          ids[index] = await options.create(item, index);
          latencies.push(now() - t0);
          done++;
        } catch (error) {
          if (signal?.aborted) throw signal.reason;
          failed.push(index);
          errors.record(step, options.describe(item, index), error);
        }
      },
      { signal },
    );

    let pending = failed.sort((a, b) => a - b);
    for (let round = 0; pending.length > 0; round++) {
      signal?.throwIfAborted();
      let found: Map<number, string>;
      try {
        const known = new Set(ids.filter((id): id is string => id !== undefined));
        found = await options.findCreated(pending, known);
      } catch (error) {
        // without an answer from the server a retry could duplicate records
        errors.record(`${step} (server check)`, `of ${pending.length} failed creates`, error);
        break;
      }
      for (const [index, id] of found) {
        ids[index] = id;
        errors.foundOnServer++;
        errors.recovered++;
        done++;
      }
      pending = pending.filter((index) => !found.has(index));
      if (round === 1) break; // after the one retry round: adopt only
      const stillFailed: number[] = [];
      for (const index of pending) {
        signal?.throwIfAborted();
        errors.retried++;
        try {
          ids[index] = await options.create(items[index] as T, index);
          errors.recovered++;
          done++;
        } catch (error) {
          if (signal?.aborted) throw signal.reason;
          stillFailed.push(index);
          errors.record(`${step} (retry)`, options.describe(items[index] as T, index), error);
        }
      }
      pending = stillFailed;
    }
  } finally {
    clearInterval(progress);
  }
  return { ids, latencies, durationMs: now() - started, errors: errors.total - errorsBefore };
}

function createStepResult(step: CreateStep): StepResult {
  const count = step.ids.filter((id) => id !== undefined).length;
  return {
    count,
    durationMs: Math.round(step.durationMs),
    perSecond: perSecond(step.latencies.length, step.durationMs),
    errors: step.errors,
    latency: latencyStats(step.latencies),
  };
}

function simpleStep(count: number, durationMs: number, extra: Partial<StepResult> = {}): StepResult {
  return { count, durationMs: Math.round(durationMs), perSecond: perSecond(count, durationMs), errors: 0, ...extra };
}

/** The server's record count after a create step must be exactly "before + created". */
function serverCountCheck(
  what: 'persons' | 'bookings',
  onServer: number,
  before: number,
  created: number,
  planned: number,
): CheckResult {
  const problems: string[] = [];
  if (onServer !== before + created) {
    problems.push(`${int(onServer)} on the server, expected ${int(before)} before + ${int(created)} created`);
  }
  if (created !== planned) problems.push(`only ${int(created)} of ${int(planned)} planned ${what} exist`);
  return {
    name: `${what}: server count = before + created`,
    ok: problems.length === 0,
    detail:
      problems.join('; ') ||
      `${int(onServer)} on the server${before ? ` (${int(before)} before + ${int(created)} created)` : ''}`,
  };
}

/**
 * Fails before anything is written when the instance lacks the support route:
 * an empty body is answered with 400 (validation) by the route, 404 without it.
 */
async function assertBackdateRoute(superuser: PocketBase, url: string): Promise<void> {
  try {
    await superuser.send(BACKDATE_ROUTE, { method: 'POST', body: {} });
  } catch (error) {
    const { status } = describeError(error);
    if (status === 400) return;
    if (status === 404) {
      throw new SeedError(
        `${url} has no load-test support route (${BACKDATE_ROUTE}) – start the instance with ` +
          'startInstance() / make loadtest-dev, or seed without backdating (--no-backdate)',
      );
    }
    throw error;
  }
  throw new SeedError(`unexpected answer of ${BACKDATE_ROUTE} to an empty request`);
}

/** Why the instance is not fresh (empty = fresh: only the seeded admin, prices 0, no persons/bookings). */
function notFreshReasons(
  existing: { persons: number; bookings: number },
  users: RecordModel[],
  offerings: RecordModel[],
): string[] {
  const reasons: string[] = [];
  if (existing.persons > 0) reasons.push(`${int(existing.persons)} persons`);
  if (existing.bookings > 0) reasons.push(`${int(existing.bookings)} bookings`);
  const others = users.filter((user) => user.username !== 'admin').map((user) => String(user.username));
  if (others.length > 0) {
    reasons.push(`${others.length} users besides admin (${others.slice(0, 3).join(', ')}${others.length > 3 ? ', …' : ''})`);
  }
  if (users.some((user) => user.username === 'admin' && user.mustChangePassword === false)) {
    reasons.push('an admin whose password was already changed');
  }
  const priced = offerings.filter((offering) => Number(offering.priceCents) !== 0);
  if (priced.length > 0) reasons.push(`prices set for ${priced.length} offerings`);
  return reasons;
}

async function findByUsername(superuser: PocketBase, username: string): Promise<RecordModel | null> {
  const result = await superuser.collection('users').getList(1, 1, {
    filter: superuser.filter('username = {:username}', { username }),
  });
  return result.items[0] ?? null;
}

/**
 * Creates or updates an app user with the given password and clears
 * `mustChangePassword`: the users hooks set it whenever somebody else sets a
 * password, a later update of only the flag is allowed (users.pb.js).
 */
async function upsertUser(
  superuser: PocketBase,
  user: { username: string; name?: string; role: 'admin' | 'user' },
  password: string,
): Promise<RecordModel> {
  const existing = await findByUsername(superuser, user.username);
  const fields = {
    ...(user.name !== undefined ? { name: user.name } : {}),
    role: user.role,
    disabled: false,
    password,
    passwordConfirm: password,
  };
  const record = existing
    ? await superuser.collection('users').update(existing.id, fields)
    : await superuser.collection('users').create({ username: user.username, ...fields });
  return superuser.collection('users').update(record.id, { mustChangePassword: false });
}

async function loginAppUser(url: string, username: string, password: string): Promise<{ client: PocketBase; id: string }> {
  const client = await loginUser(url, username, password);
  const record = client.authStore.record;
  if (!record || record.mustChangePassword !== false) {
    throw new SeedError(`"${username}" would be forced to change the password (mustChangePassword is still set)`);
  }
  return { client, id: record.id };
}

/** Seeds the dataset and returns the summary (see runSeed() for the plan and the read-back content). */
export async function seedDataset(options: SeedOptions): Promise<SeedSummary> {
  return (await runSeed(options)).summary;
}

export async function runSeed(options: SeedOptions): Promise<SeedResult> {
  const startedAt = Date.now();
  const started = now();
  const dataset = buildDataset(options);
  const opts = {
    ...dataset.options,
    concurrency: options.concurrency ?? 10,
    maxErrors: options.maxErrors ?? 10,
    force: options.force ?? false,
    backdate: options.backdate ?? true,
    backdateBatchSize: options.backdateBatchSize ?? 500,
    verify: options.verify ?? true,
  };
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) throw new RangeError('concurrency must be ≥ 1');
  if (!Number.isInteger(opts.maxErrors) || opts.maxErrors < 0) throw new RangeError('maxErrors must be ≥ 0');
  if (!Number.isInteger(opts.backdateBatchSize) || opts.backdateBatchSize < 1 || opts.backdateBatchSize > 1000) {
    throw new RangeError('backdateBatchSize must be between 1 and 1000');
  }
  const anchorMs = options.now?.getTime() ?? startedAt;
  if (!(anchorMs <= startedAt)) throw new RangeError('`now` must not lie after the seed start');
  const url = options.url.replace(/\/+$/, '');
  const password = options.password ?? DEFAULT_PASSWORD;
  const log = options.log ?? (() => undefined);
  const { signal } = options;
  const errors = new ErrorLog(opts.maxErrors);
  const progressIntervalMs = options.progressIntervalMs ?? 2_000;
  const checks: CheckResult[] = [];

  // ------------------------------------------------------------------ setup
  const setupStart = now();
  const superuser = await loginSuperuser(url, options.superuser);
  const existing = {
    persons: await countRecords(superuser, 'persons'),
    bookings: await countRecords(superuser, 'bookings'),
  };
  const offeringRecords = await superuser.collection('offerings').getFullList({ batch: 1000 });
  const userRecords = await superuser.collection('users').getFullList({
    batch: 1000,
    fields: 'id,username,mustChangePassword',
  });
  const reasons = notFreshReasons(existing, userRecords, offeringRecords);
  if (reasons.length > 0 && !opts.force) {
    throw new SeedRefusedError(
      `${url} is not a fresh instance – it already has ${reasons.join(', ')} – refusing to seed ` +
        '(use a fresh instance, or --force / force: true to add the dataset anyway)',
    );
  }

  if (opts.backdate) await assertBackdateRoute(superuser, url);

  // all offerings are validated before the first price is changed
  const offeringMatches = dataset.offerings.map((plan) => {
    const matches = offeringRecords.filter((record) => record.name === plan.name);
    if (matches.length !== 1) {
      throw new SeedError(`expected exactly one offering "${plan.name}" (seed migration), found ${matches.length}`);
    }
    const record = matches[0] as RecordModel;
    if (!record.active) throw new SeedError(`offering "${plan.name}" is inactive – it cannot be booked`);
    return { plan, record };
  });
  const offerings: SeedSummary['offerings'] = [];
  for (const { plan, record } of offeringMatches) {
    if (record.priceCents !== plan.priceCents) {
      await superuser.collection('offerings').update(record.id, { priceCents: plan.priceCents });
    }
    offerings.push({ name: plan.name, id: record.id, priceCents: plan.priceCents });
  }
  const offeringIds = offerings.map((o) => o.id);

  // with force: bookings of earlier runs are never mistaken for this run's
  const preexistingBookings =
    existing.bookings > 0
      ? new Set((await superuser.collection('bookings').getFullList({ batch: 1000, fields: 'id' })).map((r) => r.id))
      : new Set<string>();

  const admin = await upsertUser(superuser, { username: 'admin', role: 'admin' }, password);
  for (const user of dataset.users) await upsertUser(superuser, { ...user, role: 'user' }, password);
  const adminLogin = await loginAppUser(url, 'admin', password);
  const userLogins: Array<{ client: PocketBase; id: string }> = [];
  for (const user of dataset.users) userLogins.push(await loginAppUser(url, user.username, password));
  const userIds = userLogins.map((login) => login.id);
  const setupMs = now() - setupStart;
  log(`  setup: prices, admin + ${dataset.users.length} users ready (${Math.round(setupMs)} ms)`);

  // ---------------------------------------------------------------- persons
  const personIds = new Array<string>(dataset.persons.length);
  const toCreate: number[] = [];
  if (existing.persons > 0) {
    const records = await superuser.collection('persons').getFullList({ batch: 1000, fields: 'id,number' });
    const idByNumber = new Map(records.map((r) => [String(r.number).toLowerCase(), r.id]));
    dataset.persons.forEach((person, index) => {
      const id = idByNumber.get(person.number.toLowerCase());
      if (id) personIds[index] = id;
      else toCreate.push(index);
    });
  } else {
    toCreate.push(...dataset.persons.keys());
  }
  const personsStep = await createAll('persons', toCreate, {
    concurrency: opts.concurrency,
    errors,
    log,
    progressIntervalMs,
    signal,
    describe: (index) => `"${dataset.persons[index]!.number}"`,
    create: async (index) => {
      const { number, name, nickname } = dataset.persons[index]!;
      return (await adminLogin.client.collection('persons').create({ number, name, nickname }, { signal })).id;
    },
    // the number is unique: a person with the planned number and data was created by the failed request
    findCreated: async (positions) => {
      const found = new Map<number, string>();
      for (const position of positions) {
        const plan = dataset.persons[toCreate[position]!]!;
        const result = await superuser.collection('persons').getList(1, 1, {
          filter: superuser.filter('number = {:number}', { number: plan.number }),
          fields: 'id,number,name,nickname',
        });
        const record = result.items[0];
        if (record && record.number === plan.number && record.name === plan.name && record.nickname === plan.nickname) {
          found.set(position, record.id);
        }
      }
      return found;
    },
  });
  toCreate.forEach((planIndex, position) => {
    const id = personsStep.ids[position];
    if (id) personIds[planIndex] = id;
  });
  const persons = createStepResult(personsStep);
  checks.push(
    serverCountCheck('persons', await countRecords(superuser, 'persons'), existing.persons, persons.count, toCreate.length),
  );
  const missingPersons = dataset.persons.filter((_, index) => !personIds[index]);
  if (missingPersons.length > 0) {
    throw new SeedError(`${missingPersons.length} persons could not be created (e.g. "${missingPersons[0]!.number}")`);
  }
  log(
    `  persons: ${int(persons.count)} created in ${(persons.durationMs / 1000).toFixed(1)} s ` +
      `(${persons.perSecond}/s, p50 ${persons.latency?.p50} ms, p95 ${persons.latency?.p95} ms)`,
  );

  // --------------------------------------------------------------- bookings
  // chronological creation order: the table's row order then follows the (backdated) `created`, as in production
  const planned = resolveTimestamps(dataset, anchorMs);
  const ordered = creationOrder(dataset, planned);
  const bookingsStep = await createAll('bookings', ordered, {
    concurrency: opts.concurrency,
    errors,
    log,
    progressIntervalMs,
    signal,
    describe: (booking) => `#${booking.seq}`,
    create: async (booking) => {
      const record = await userLogins[booking.user]!.client.collection('bookings').create(
        {
          person: personIds[booking.person],
          offering: offeringIds[booking.offering],
          quantity: booking.quantity,
          // ignored by the server (set by the request hook) – sent like the SPA does
          createdBy: userIds[booking.user],
        },
        { expand: BOOKING_EXPAND, signal },
      );
      return record.id;
    },
    // bookings have no natural key: records with the failed items' person +
    // offering + user that are neither known from this run nor older than it
    findCreated: async (positions, known) => {
      const groups = new Map<string, number[]>();
      for (const position of positions) {
        const booking = ordered[position]!;
        const key = `${booking.person}|${booking.offering}|${booking.user}`;
        groups.set(key, [...(groups.get(key) ?? []), position]);
      }
      const found = new Map<number, string>();
      for (const group of groups.values()) {
        const booking = ordered[group[0]!]!;
        const records = await superuser.collection('bookings').getFullList({
          batch: 1000,
          fields: 'id',
          sort: 'id',
          filter: superuser.filter('person = {:person} && offering = {:offering} && createdBy = {:user}', {
            person: personIds[booking.person],
            offering: offeringIds[booking.offering],
            user: userIds[booking.user],
          }),
        });
        const unknown = records.map((r) => r.id).filter((id) => !known.has(id) && !preexistingBookings.has(id));
        group.forEach((position, i) => {
          if (unknown[i]) found.set(position, unknown[i]);
        });
      }
      return found;
    },
  });
  // record ids by plan index (`seq`)
  const bookingIds = new Array<string | undefined>(dataset.bookings.length);
  ordered.forEach((booking, position) => {
    bookingIds[booking.seq] = bookingsStep.ids[position];
  });
  const bookings = createStepResult(bookingsStep);
  checks.push(
    serverCountCheck(
      'bookings',
      await countRecords(superuser, 'bookings'),
      existing.bookings,
      bookings.count,
      dataset.bookings.length,
    ),
  );
  log(
    `  bookings: ${int(bookings.count)} created in ${(bookings.durationMs / 1000).toFixed(1)} s ` +
      `(${bookings.perSecond}/s, p50 ${bookings.latency?.p50} ms, p95 ${bookings.latency?.p95} ms, ` +
      `max ${bookings.latency?.max} ms, ${errors.total} errors)`,
  );

  // --------------------------------------------------------------- backdate
  // without backdating the server's own clock stamps the bookings: allow some skew
  const CLOCK_TOLERANCE_MS = 5 * 60_000;
  const window = opts.backdate
    ? timestampWindow(dataset, anchorMs)
    : { from: startedAt - CLOCK_TOLERANCE_MS, to: Date.now() + CLOCK_TOLERANCE_MS };
  let timestamps: number[] | undefined;
  let backdate = simpleStep(0, 0, { requests: 0 });
  if (opts.backdate) {
    timestamps = planned;
    const items = ordered
      .filter((booking) => bookingIds[booking.seq] !== undefined)
      .map((booking) => ({ id: bookingIds[booking.seq] as string, created: toPbDate(planned[booking.seq]!) }));
    const backdateStart = now();
    let requests = 0;
    for (let i = 0; i < items.length; i += opts.backdateBatchSize) {
      signal?.throwIfAborted();
      try {
        await superuser.send(BACKDATE_ROUTE, {
          method: 'POST',
          body: { items: items.slice(i, i + opts.backdateBatchSize) },
          signal,
        });
        requests++;
      } catch (error) {
        throw new SeedError(`backdating failed: ${describeError(error).message}`);
      }
    }
    backdate = simpleStep(items.length, now() - backdateStart, { requests });
    log(`  backdate: ${int(items.length)} bookings in ${requests} requests (${backdate.durationMs} ms)`);
  }

  // ----------------------------------------------------------------- verify
  let content: ContentDump | undefined;
  let contentFingerprint: string | undefined;
  let actual: Awaited<ReturnType<typeof verifyDataset>>['actual'] | undefined;
  let verify = simpleStep(0, 0);
  if (opts.verify) {
    const verifyStart = now();
    const result = await verifyDataset({
      dataset,
      superuser,
      appUser: userLogins[0]!.client,
      personIds,
      createdPersons: new Set(toCreate),
      bookingIds,
      offeringIds,
      userIds,
      timestamps,
      window,
      existing,
      countChecks: false, // the server count checks above cover them
    });
    checks.push(...result.checks);
    content = result.content;
    contentFingerprint = result.fingerprint;
    actual = result.actual;
    verify = simpleStep(result.checks.length, now() - verifyStart);
    const failed = result.checks.filter((c) => !c.ok).length;
    log(`  verify: ${result.checks.length - failed} of ${result.checks.length} checks passed (${verify.durationMs} ms)`);
  }

  // ---------------------------------------------------------------- summary
  const created = dataset.bookings.filter((booking) => bookingIds[booking.seq] !== undefined);
  const fromPlan = {
    perUser: Object.fromEntries(dataset.users.map((user) => [user.username, 0])) as Record<string, number>,
    perOffering: Object.fromEntries(dataset.offerings.map((offering) => [offering.name, 0])) as Record<string, number>,
    perPerson: new Map<number, number>(),
    quantity: 0,
    totalCents: 0,
  };
  for (const booking of created) {
    fromPlan.perUser[dataset.users[booking.user]!.username]! += 1;
    fromPlan.perOffering[dataset.offerings[booking.offering]!.name]! += 1;
    fromPlan.perPerson.set(booking.person, (fromPlan.perPerson.get(booking.person) ?? 0) + 1);
    fromPlan.quantity += booking.quantity;
    fromPlan.totalCents += booking.quantity * dataset.offerings[booking.offering]!.priceCents;
  }
  const planHistogram: Record<string, number> = {};
  dataset.persons.forEach((_, index) => {
    const count = String(fromPlan.perPerson.get(index) ?? 0);
    planHistogram[count] = (planHistogram[count] ?? 0) + 1;
  });
  const perPeriod = countPerPeriod(
    created.map((booking) => (timestamps ? timestamps[booking.seq]! : anchorMs)),
    anchorMs,
    dataset.options.timeZone,
  );

  const summary: SeedSummary = {
    ok: created.length === dataset.bookings.length && checks.every((c) => c.ok),
    url,
    options: opts,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(now() - started),
    window: {
      from: new Date(window.from).toISOString(),
      to: new Date(window.to).toISOString(),
      days: opts.days,
      timeZone: opts.timeZone,
    },
    existing,
    counts: {
      persons: dataset.persons.length,
      personsCreated: persons.count,
      users: dataset.users.length,
      bookings: actual?.bookings ?? created.length,
      perUser: actual?.perUser ?? fromPlan.perUser,
      perOffering: actual?.perOffering ?? fromPlan.perOffering,
      perPersonHistogram: actual?.perPersonHistogram ?? planHistogram,
      perPeriod,
      source: actual ? 'instance' : 'plan',
    },
    value: actual
      ? { quantity: actual.quantity, totalCents: actual.totalCents }
      : { quantity: fromPlan.quantity, totalCents: fromPlan.totalCents },
    users: [
      { username: 'admin', name: String(admin.name ?? ''), role: 'admin', id: adminLogin.id },
      ...dataset.users.map((user, index) => ({ username: user.username, name: user.name, role: 'user', id: userIds[index]! })),
    ],
    offerings,
    steps: { setup: simpleStep(dataset.users.length + 1, setupMs), persons, bookings, backdate, verify },
    errors: {
      total: errors.total,
      byStatus: errors.byStatus,
      samples: errors.samples,
      retried: errors.retried,
      recovered: errors.recovered,
      foundOnServer: errors.foundOnServer,
    },
    checks,
    creationOrder: 'chronological',
    fingerprints: { plan: dataset.fingerprint, content: contentFingerprint },
  };
  return { summary, dataset, content };
}
