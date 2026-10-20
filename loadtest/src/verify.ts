/**
 * Read-back verification of a seeded dataset through the REST API: counts,
 * record contents against the plan, the server-side hook results
 * (createdBy, unitPriceCents), the backdated timestamps, the bookings per
 * person as stored in the instance and the totals endpoint as one of the
 * users. Also computes a content fingerprint that is independent of record
 * ids and timestamps, so two seeds with the same seed value can be compared,
 * and the read-back aggregates the seed summary reports.
 *
 * Scope: on an instance that was empty before the seed, everything in it is
 * checked; after a seed with `force` (data existed before) the checks cover
 * this run's records, and their names say so.
 */
import { createHash } from 'node:crypto';
import type PocketBase from 'pocketbase';
import type { Dataset } from './dataset.ts';
import { parsePbDate } from './time.ts';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyInput {
  dataset: Dataset;
  /** Superuser client (reads everything). */
  superuser: PocketBase;
  /** A `users` client for GET /api/app/totals. */
  appUser: PocketBase;
  /** Record id per planned person (index like dataset.persons). */
  personIds: readonly string[];
  /** Indexes of the persons created by this run (the others existed already). */
  createdPersons: ReadonlySet<number>;
  /** Record id per planned booking (index = seq); undefined = not created. */
  bookingIds: readonly (string | undefined)[];
  offeringIds: readonly string[];
  userIds: readonly string[];
  /** Planned timestamps (index = seq) when the bookings were backdated. */
  timestamps?: readonly number[];
  /** All timestamps must lie in [from, to). */
  window: { from: number; to: number };
  /** Counts before the seed (non-zero only with `force`). */
  existing: { persons: number; bookings: number };
  /** Include the "persons: count" / "bookings: count" checks (default true; the seeder has its own). */
  countChecks?: boolean;
}

/** Canonical, id- and time-free representation of the instance's data. */
export interface ContentDump {
  persons: Array<{ number: string; name: string; nickname: string; bookings: number }>;
  /** [person number, offering name, username, quantity, unitPriceCents], sorted. */
  bookings: Array<[string, string, string, number, number]>;
  perUser: Record<string, number>;
}

/** Aggregates as stored in the instance – all bookings, or this run's after a `force` seed (`scope`). */
export interface ReadBackAggregates {
  scope: 'instance' | 'run';
  bookings: number;
  quantity: number;
  totalCents: number;
  /** username → bookings */
  perUser: Record<string, number>;
  /** offering name → bookings */
  perOffering: Record<string, number>;
  /** bookings per planned person → number of persons, e.g. { "5": 331, … } */
  perPersonHistogram: Record<string, number>;
}

export interface VerifyResult {
  checks: CheckResult[];
  fingerprint: string;
  content: ContentDump;
  actual: ReadBackAggregates;
}

interface PersonRow {
  id: string;
  number: string;
  name: string;
  nickname: string;
}

interface BookingRow {
  id: string;
  person: string;
  offering: string;
  createdBy: string;
  quantity: number;
  unitPriceCents: number;
  created: string;
  updated: string;
}

interface TotalsResponse {
  count: number;
  quantity: number;
  totalCents: number;
  perUser: Array<{ userId: string; username: string; count: number; totalCents: number }>;
}

const MAX_LISTED = 5;

function sample(items: readonly string[]): string {
  const listed = items.slice(0, MAX_LISTED).join('; ');
  return items.length > MAX_LISTED ? `${listed}; … (${items.length} in total)` : listed;
}

export async function verifyDataset(input: VerifyInput): Promise<VerifyResult> {
  const { dataset, superuser, personIds, bookingIds, offeringIds, userIds, timestamps, window, existing } = input;
  const checks: CheckResult[] = [];
  const check = (name: string, problems: string[], okDetail: string) =>
    checks.push({ name, ok: problems.length === 0, detail: problems.length === 0 ? okDetail : sample(problems) });

  const [persons, bookings, users, offerings] = await Promise.all([
    superuser.collection('persons').getFullList<PersonRow>({ batch: 1000, sort: 'id', fields: 'id,number,name,nickname' }),
    superuser.collection('bookings').getFullList<BookingRow>({
      batch: 1000,
      sort: 'id',
      fields: 'id,person,offering,createdBy,quantity,unitPriceCents,created,updated',
    }),
    superuser.collection('users').getFullList<{ id: string; username: string }>({ batch: 1000, fields: 'id,username' }),
    superuser.collection('offerings').getFullList<{ id: string; name: string }>({ batch: 1000, fields: 'id,name' }),
  ]);
  const personById = new Map(persons.map((p) => [p.id, p]));
  const bookingById = new Map(bookings.map((b) => [b.id, b]));
  const usernameById = new Map(users.map((u) => [u.id, u.username]));
  const offeringNameById = new Map(offerings.map((o) => [o.id, o.name]));

  const createdBookings = dataset.bookings.filter((b) => bookingIds[b.seq] !== undefined);
  const instanceWasEmpty = existing.persons === 0 && existing.bookings === 0;
  // the bookings the per-person / aggregate checks look at: everything in the
  // instance, or – after a force seed on top of other data – this run's records
  const runIds = new Set(createdBookings.map((plan) => bookingIds[plan.seq] as string));
  const scoped = instanceWasEmpty ? bookings : bookings.filter((b) => runIds.has(b.id));
  const scopeLabel = instanceWasEmpty ? '' : " (this run's)";

  // ------------------------------------------------------------ persons
  if (input.countChecks ?? true) {
    const expectedPersons = existing.persons + input.createdPersons.size;
    check(
      'persons: count',
      persons.length === expectedPersons ? [] : [`${persons.length} persons, expected ${expectedPersons}`],
      `${persons.length} persons${instanceWasEmpty ? '' : ` (${existing.persons} existed before)`}`,
    );
  }
  const personProblems: string[] = [];
  dataset.persons.forEach((plan, index) => {
    const record = personById.get(personIds[index] ?? '');
    if (!record) personProblems.push(`person "${plan.number}" is missing`);
    else if (record.number !== plan.number) personProblems.push(`person ${record.id}: number "${record.number}" ≠ "${plan.number}"`);
    else if (input.createdPersons.has(index) && (record.name !== plan.name || record.nickname !== plan.nickname)) {
      personProblems.push(`person "${plan.number}": "${record.name}"/"${record.nickname}" ≠ "${plan.name}"/"${plan.nickname}"`);
    }
  });
  const reused = dataset.persons.length - input.createdPersons.size;
  check(
    'persons: numbers 1…n, names, nicknames',
    personProblems,
    reused === 0
      ? `all ${dataset.persons.length} persons as planned`
      : `all ${dataset.persons.length} numbers present; ${input.createdPersons.size} persons created as planned, ` +
          `${reused} existed before and kept their names`,
  );

  // ----------------------------------------------------------- bookings
  if (input.countChecks ?? true) {
    const expectedBookings = existing.bookings + createdBookings.length;
    const countProblems: string[] = [];
    if (bookings.length !== expectedBookings) countProblems.push(`${bookings.length} bookings, expected ${expectedBookings}`);
    if (createdBookings.length !== dataset.bookings.length) {
      countProblems.push(`only ${createdBookings.length} of ${dataset.bookings.length} planned bookings were created`);
    }
    check('bookings: count', countProblems, `${bookings.length} bookings${instanceWasEmpty ? '' : ` (${existing.bookings} existed before)`}`);
  }

  const contentProblems: string[] = [];
  const priceProblems: string[] = [];
  const timeProblems: string[] = [];
  for (const plan of createdBookings) {
    const id = bookingIds[plan.seq] as string;
    const record = bookingById.get(id);
    if (!record) {
      contentProblems.push(`booking ${id} (#${plan.seq}) is missing`);
      continue;
    }
    if (
      record.person !== personIds[plan.person] ||
      record.offering !== offeringIds[plan.offering] ||
      record.createdBy !== userIds[plan.user] ||
      record.quantity !== plan.quantity
    ) {
      contentProblems.push(`booking ${id} (#${plan.seq}) differs from the plan`);
    }
    const price = dataset.offerings[plan.offering]!.priceCents;
    if (record.unitPriceCents !== price) {
      priceProblems.push(`booking ${id}: unitPriceCents ${record.unitPriceCents} ≠ ${price}`);
    }
    const created = parsePbDate(record.created);
    if (!(created >= window.from && created < window.to)) {
      timeProblems.push(`booking ${id}: created ${record.created} outside the window`);
    } else if (timestamps && created !== timestamps[plan.seq]) {
      timeProblems.push(`booking ${id}: created ${record.created} ≠ planned ${new Date(timestamps[plan.seq]!).toISOString()}`);
    }
    // backdated: both set by the support route; otherwise PocketBase's autodate
    // may set `updated` a millisecond after `created`
    if (timestamps ? record.updated !== record.created : parsePbDate(record.updated) < created) {
      timeProblems.push(`booking ${id}: updated ${record.updated} vs. created ${record.created}`);
    }
  }
  check('bookings: person, offering, createdBy, quantity as planned', contentProblems, `all ${createdBookings.length} bookings as planned`);
  check('bookings: unitPriceCents = offering price (server hook)', priceProblems, 'all prices snapshotted correctly');
  check(
    'bookings: timestamps',
    timeProblems,
    timestamps
      ? `created = planned, updated = created, all in [${new Date(window.from).toISOString()}, ${new Date(window.to).toISOString()})`
      : 'not backdated: all created during the seed run (±5 min clock tolerance), updated ≥ created',
  );

  const userSet = new Set(userIds);
  const foreign = scoped.filter((b) => !userSet.has(b.createdBy)).map((b) => `booking ${b.id}: createdBy ${b.createdBy}`);
  check(
    `bookings${scopeLabel}: createdBy ∈ ${dataset.users.map((u) => u.username).join(', ')}`,
    foreign,
    `${instanceWasEmpty ? 'every booking' : "every booking of this run"} belongs to one of the ${userIds.length} users`,
  );

  // per person as stored: grouped by the records' own `person` field, so an
  // extra or misassigned booking can never hide behind the plan
  const storedPerPerson = new Map<string, number>();
  for (const b of scoped) storedPerPerson.set(b.person, (storedPerPerson.get(b.person) ?? 0) + 1);
  const { minBookingsPerPerson: min, maxBookingsPerPerson: max } = dataset.options;
  const perPersonProblems: string[] = [];
  const perPersonHistogram: Record<string, number> = {};
  let lowest = Infinity;
  let highest = 0;
  dataset.persons.forEach((plan, index) => {
    const count = storedPerPerson.get(personIds[index] ?? '') ?? 0;
    lowest = Math.min(lowest, count);
    highest = Math.max(highest, count);
    perPersonHistogram[String(count)] = (perPersonHistogram[String(count)] ?? 0) + 1;
    if (count < min || count > max) perPersonProblems.push(`person "${plan.number}": ${count} bookings (allowed ${min}–${max})`);
    else if (count !== plan.bookings) perPersonProblems.push(`person "${plan.number}": ${count} bookings, planned ${plan.bookings}`);
  });
  const planned = new Set(personIds);
  const strays = [...storedPerPerson.keys()].filter((personId) => !planned.has(personId));
  for (const personId of strays.slice(0, MAX_LISTED)) {
    perPersonProblems.push(`${storedPerPerson.get(personId)} bookings for person ${personId}, which is not in the dataset`);
  }
  check(
    `bookings per person within ${min}–${max}${scopeLabel ? ` (this run's bookings, read back)` : ' (read back)'}`,
    perPersonProblems,
    `min ${lowest}, max ${highest}, as planned for every person`,
  );

  // -------------------------------------------------------- totals API
  const totals = await input.appUser.send<TotalsResponse>('/api/app/totals', { method: 'GET' });
  const expectedCents = createdBookings.reduce(
    (sum, plan) => sum + plan.quantity * dataset.offerings[plan.offering]!.priceCents,
    0,
  );
  const totalsProblems: string[] = [];
  if (totals.count !== bookings.length) totalsProblems.push(`count ${totals.count} ≠ ${bookings.length}`);
  if (instanceWasEmpty && totals.totalCents !== expectedCents) {
    totalsProblems.push(`totalCents ${totals.totalCents} ≠ ${expectedCents}`);
  }
  dataset.users.forEach((user, index) => {
    const plannedForUser = createdBookings.filter((plan) => plan.user === index).length;
    const row = totals.perUser.find((r) => r.userId === userIds[index]);
    if (instanceWasEmpty ? row?.count !== plannedForUser : (row?.count ?? 0) < plannedForUser) {
      totalsProblems.push(`${user.username}: ${row?.count ?? 0} bookings, expected ${plannedForUser}`);
    }
  });
  check(
    'GET /api/app/totals (as an app user)',
    totalsProblems,
    `count ${totals.count}, total ${(totals.totalCents / 100).toFixed(2)} €, per-user counts as planned`,
  );

  // ---------------------------------------------------- read-back aggregates
  const actual: ReadBackAggregates = {
    scope: instanceWasEmpty ? 'instance' : 'run',
    bookings: scoped.length,
    quantity: 0,
    totalCents: 0,
    perUser: Object.fromEntries(dataset.users.map((user) => [user.username, 0])),
    perOffering: Object.fromEntries(dataset.offerings.map((offering) => [offering.name, 0])),
    perPersonHistogram: Object.fromEntries(
      Object.entries(perPersonHistogram).sort(([a], [b]) => Number(a) - Number(b)),
    ),
  };
  for (const b of scoped) {
    const username = usernameById.get(b.createdBy) ?? b.createdBy;
    const offering = offeringNameById.get(b.offering) ?? b.offering;
    actual.perUser[username] = (actual.perUser[username] ?? 0) + 1;
    actual.perOffering[offering] = (actual.perOffering[offering] ?? 0) + 1;
    actual.quantity += b.quantity;
    actual.totalCents += b.quantity * b.unitPriceCents;
  }

  // -------------------------------------------------- content fingerprint
  const bookingCountByPerson = new Map<string, number>();
  for (const b of bookings) bookingCountByPerson.set(b.person, (bookingCountByPerson.get(b.person) ?? 0) + 1);
  const perUser: Record<string, number> = {};
  for (const b of bookings) {
    const username = usernameById.get(b.createdBy) ?? b.createdBy;
    perUser[username] = (perUser[username] ?? 0) + 1;
  }
  // total orders only (a locale collation may rank distinct strings equal,
  // which would leave the order – and the fingerprint – to the record ids)
  const collator = new Intl.Collator('de', { numeric: true });
  const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const naturally = (a: string, b: string) => collator.compare(a, b) || byCodeUnits(a, b);
  const content: ContentDump = {
    persons: persons
      .map((p) => ({ number: p.number, name: p.name, nickname: p.nickname, bookings: bookingCountByPerson.get(p.id) ?? 0 }))
      .sort((a, b) => naturally(a.number, b.number) || byCodeUnits(JSON.stringify(a), JSON.stringify(b))),
    bookings: bookings
      .map((b): [string, string, string, number, number] => [
        personById.get(b.person)?.number ?? b.person,
        offeringNameById.get(b.offering) ?? b.offering,
        usernameById.get(b.createdBy) ?? b.createdBy,
        b.quantity,
        b.unitPriceCents,
      ])
      .sort((a, b) => naturally(a[0], b[0]) || byCodeUnits(JSON.stringify(a), JSON.stringify(b))),
    perUser: Object.fromEntries(Object.entries(perUser).sort(([a], [b]) => byCodeUnits(a, b))),
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(content)).digest('hex');

  return { checks, fingerprint, content, actual };
}
