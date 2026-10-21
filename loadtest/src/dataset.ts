/**
 * The load-test dataset as a pure, deterministic plan (no I/O): who exists,
 * which bookings are created by which user, and when each booking supposedly
 * happened. seed.ts turns the plan into records through the REST API –
 * creating the bookings in the chronological order of their timestamps
 * (creationOrder), like production stores them; docs/LOADTEST.md describes
 * the dataset.
 *
 * Defaults (the user's request): 2000 persons numbered "1" … "2000", 5 users
 * user1 … user5, per person 5–10 bookings, each assigned uniformly at random
 * to one of the users, spread over the last 60 days with a bar's evening
 * rhythm in Europe/Vienna local time. Everything is derived from `seed`.
 */
import { createHash } from 'node:crypto';
import { generateName } from './names.ts';
import { deriveRandom } from './random.ts';
import {
  addDays,
  assertTimeZone,
  DAY_MS,
  localDateOf,
  localTimeOfDayMs,
  zonedTimeToUtc,
} from './time.ts';

export const DEFAULT_SEED = 'getraenkeliste';
/** Password of the seeded `admin` and of all generated users (≥ 8 characters, the API minimum). */
export const DEFAULT_PASSWORD = 'loadtest';
export const DEFAULT_TIME_ZONE = 'Europe/Vienna';

export interface OfferingPlan {
  /** Name of an offering created by the seed migration (1790550001_seed_data.js). */
  name: string;
  priceCents: number;
  /** Relative booking frequency. */
  weight: number;
}

/** The seeded offerings with load-test prices (set before any booking) and booking weights. */
export const OFFERINGS: readonly OfferingPlan[] = [
  { name: 'Bier/Wein', priceCents: 350, weight: 40 },
  { name: 'Redbull', priceCents: 300, weight: 10 },
  { name: 'Murelli', priceCents: 250, weight: 12 },
  { name: 'Mineralwasser', priceCents: 200, weight: 14 },
  { name: 'Fruchtsäfte', priceCents: 250, weight: 10 },
  { name: 'Kaffee', priceCents: 200, weight: 9 },
  { name: 'Pfand', priceCents: 100, weight: 5 },
];

/**
 * Relative booking frequency per local hour (index = hour 0–23): mostly in
 * the evening, a tail after midnight, a little during the day, closed 02–10.
 */
export const HOUR_WEIGHTS: readonly number[] = [
  4, 2, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 2, 2, 3, 5, 8, 11, 13, 13, 11, 8,
];

export interface DatasetOptions {
  /** Any string; the same seed always produces the same dataset. */
  seed?: string;
  /** Number of persons; their numbers are "1" … "<persons>". */
  persons?: number;
  /** Number of users user1 … user<n> (role "user"). */
  users?: number;
  minBookingsPerPerson?: number;
  maxBookingsPerPerson?: number;
  /** Booking timestamps are spread over this many days before the seed start. */
  days?: number;
  /** Share of persons with a nickname. */
  nicknameRate?: number;
  /** Local time zone of the bar (evening rhythm, period counts). */
  timeZone?: string;
}

export type ResolvedDatasetOptions = Required<DatasetOptions>;

export const DATASET_DEFAULTS: ResolvedDatasetOptions = {
  seed: DEFAULT_SEED,
  persons: 2000,
  users: 5,
  minBookingsPerPerson: 5,
  maxBookingsPerPerson: 10,
  days: 60,
  nicknameRate: 1 / 3,
  timeZone: DEFAULT_TIME_ZONE,
};

export interface PersonPlan {
  /** The user-visible person "ID" (QR payload): "1" … "2000". */
  number: string;
  name: string;
  nickname: string;
  /** Number of bookings planned for this person. */
  bookings: number;
}

export interface UserPlan {
  username: string;
  /** Display name, e.g. "Testbenutzer 1". */
  name: string;
}

export interface BookingPlan {
  /** Index in the plan (generation order: person by person). seed.ts creates the bookings in creationOrder(). */
  seq: number;
  /** Index into `Dataset.persons`. */
  person: number;
  /** Index into `Dataset.offerings`. */
  offering: number;
  /** Index into `Dataset.users`: the user who creates (and owns) the booking. */
  user: number;
  quantity: number;
  /** Local calendar days back from the latest occurrence of `timeOfDayMs` before the seed start. */
  daysAgo: number;
  /** Local wall-clock time of the booking in ms after midnight. */
  timeOfDayMs: number;
}

export interface Dataset {
  options: ResolvedDatasetOptions;
  persons: PersonPlan[];
  users: UserPlan[];
  offerings: readonly OfferingPlan[];
  /** In generation order (index = `seq`); the creation order is chronological (creationOrder). */
  bookings: BookingPlan[];
  expected: {
    bookings: number;
    quantity: number;
    totalCents: number;
    /** Bookings per user (index like `users`). */
    perUser: number[];
    /** Bookings per offering (index like `offerings`). */
    perOffering: number[];
    /** Number of persons per booking count, e.g. { 5: 331, 6: 340, … }. */
    perPersonHistogram: Record<number, number>;
  };
  /** sha256 of the whole plan – equal plans have equal fingerprints (the creation order follows from it and the seed start). */
  fingerprint: string;
}

function assertInteger(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max} (got ${value})`);
  }
}

export function resolveDatasetOptions(options: DatasetOptions = {}): ResolvedDatasetOptions {
  // only the dataset keys: callers pass wider option objects (seed options
  // with URL and credentials), which must not end up in the plan or summary
  const resolved: ResolvedDatasetOptions = { ...DATASET_DEFAULTS };
  for (const key of Object.keys(DATASET_DEFAULTS) as (keyof ResolvedDatasetOptions)[]) {
    const value = options[key];
    if (value !== undefined) Object.assign(resolved, { [key]: value });
  }
  if (typeof resolved.seed !== 'string' || resolved.seed === '') throw new RangeError('seed must be a non-empty string');
  assertInteger('persons', resolved.persons, 1, 1_000_000);
  assertInteger('users', resolved.users, 1, 999);
  assertInteger('minBookingsPerPerson', resolved.minBookingsPerPerson, 0, 10_000);
  assertInteger('maxBookingsPerPerson', resolved.maxBookingsPerPerson, resolved.minBookingsPerPerson, 10_000);
  assertInteger('days', resolved.days, 1, 3650);
  if (!(resolved.nicknameRate >= 0 && resolved.nicknameRate <= 1)) {
    throw new RangeError(`nicknameRate must be between 0 and 1 (got ${resolved.nicknameRate})`);
  }
  assertTimeZone(resolved.timeZone);
  return resolved;
}

export function buildDataset(options: DatasetOptions = {}): Dataset {
  const opts = resolveDatasetOptions(options);
  const namesRandom = deriveRandom(opts.seed, 'names');
  const bookingsRandom = deriveRandom(opts.seed, 'bookings');
  const timesRandom = deriveRandom(opts.seed, 'times');

  const users: UserPlan[] = Array.from({ length: opts.users }, (_, i) => ({
    username: `user${i + 1}`,
    name: `Testbenutzer ${i + 1}`,
  }));

  const persons: PersonPlan[] = [];
  const bookings: BookingPlan[] = [];
  const offeringWeights = OFFERINGS.map((offering) => offering.weight);

  for (let p = 0; p < opts.persons; p++) {
    const { name, nickname } = generateName(namesRandom, opts.nicknameRate);
    const count = bookingsRandom.int(opts.minBookingsPerPerson, opts.maxBookingsPerPerson);
    persons.push({ number: String(p + 1), name, nickname, bookings: count });
    for (let i = 0; i < count; i++) {
      const hour = timesRandom.weightedIndex(HOUR_WEIGHTS);
      bookings.push({
        seq: bookings.length,
        person: p,
        offering: bookingsRandom.weightedIndex(offeringWeights),
        user: bookingsRandom.int(0, opts.users - 1),
        quantity: 1, // the UI books one item per tap
        daysAgo: timesRandom.int(0, opts.days - 1),
        timeOfDayMs: hour * 3_600_000 + timesRandom.int(0, 3_599_999),
      });
    }
  }

  const perUser = users.map(() => 0);
  const perOffering = OFFERINGS.map(() => 0);
  const perPersonHistogram: Record<number, number> = {};
  let quantity = 0;
  let totalCents = 0;
  for (const booking of bookings) {
    perUser[booking.user]! += 1;
    perOffering[booking.offering]! += 1;
    quantity += booking.quantity;
    totalCents += booking.quantity * OFFERINGS[booking.offering]!.priceCents;
  }
  for (const person of persons) perPersonHistogram[person.bookings] = (perPersonHistogram[person.bookings] ?? 0) + 1;

  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ opts, users, persons, offerings: OFFERINGS, bookings }))
    .digest('hex');

  return {
    options: opts,
    persons,
    users,
    offerings: OFFERINGS,
    bookings,
    expected: { bookings: bookings.length, quantity, totalCents, perUser, perOffering, perPersonHistogram },
    fingerprint,
  };
}

/** The time window all booking timestamps fall into: [from, to) with to = the seed start. */
export function timestampWindow(dataset: Dataset, anchorMs: number): { from: number; to: number } {
  return { from: anchorMs - dataset.options.days * DAY_MS, to: anchorMs };
}

/**
 * Absolute booking timestamps (UTC ms, index = `seq`) for a seed started at
 * `anchorMs`: the latest occurrence of the booking's local wall-clock time
 * strictly before the anchor, moved back `daysAgo` local calendar days, kept
 * inside timestampWindow() (DST shifts are folded back by one day).
 */
export function resolveTimestamps(dataset: Dataset, anchorMs: number): number[] {
  const { timeZone } = dataset.options;
  const { from, to } = timestampWindow(dataset, anchorMs);
  const anchorDate = localDateOf(anchorMs, timeZone);
  const anchorTimeOfDay = localTimeOfDayMs(anchorMs, timeZone);
  const result = new Array<number>(dataset.bookings.length);
  for (const booking of dataset.bookings) {
    const latestDayOffset = booking.timeOfDayMs < anchorTimeOfDay ? 0 : -1;
    let t = zonedTimeToUtc(addDays(anchorDate, latestDayOffset - booking.daysAgo), booking.timeOfDayMs, timeZone);
    while (t >= to) t -= DAY_MS;
    while (t < from) t += DAY_MS;
    if (t >= to) t = to - 1; // only for windows shorter than a day plus a DST shift
    result[booking.seq] = t;
  }
  return result;
}

/**
 * The order in which seed.ts creates the bookings: chronological by their
 * resolved timestamps (ties by `seq`). Production inserts bookings as they
 * happen, so the table's row order follows `created`; creating them in that
 * order keeps index range scans (e.g. "nur meine" over (createdBy, created))
 * as local as in production – a shuffled creation order with backdated
 * timestamps made them jump randomly through the table (several times
 * slower than in production at 150k bookings). The order depends on the
 * seed start (`timestamps`), so it is not part of the plan.
 */
export function creationOrder(dataset: Dataset, timestamps: readonly number[]): BookingPlan[] {
  return [...dataset.bookings].sort((a, b) => (timestamps[a.seq] as number) - (timestamps[b.seq] as number) || a.seq - b.seq);
}
