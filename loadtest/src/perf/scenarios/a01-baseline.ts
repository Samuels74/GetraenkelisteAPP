/**
 * A1 – single-request baseline: one client, nothing else running. Every
 * request type the SPA sends, sequentially, after a warm-up: what each costs
 * on an idle server, and how big it is. The reference for everything else.
 *
 * Two companion results:
 *
 * A1-planner – planner statistics, fresh vs. production steady state
 *   (planner.ts). When A1 runs first after seeding, the list/totals filter
 *   variants are measured on the freshly seeded database (no statistics for
 *   the app tables), then the nightly "PRAGMA optimize" is applied and they
 *   are measured again; EXPLAIN QUERY PLAN shows which plans differ. All other
 *   measurements of the run use the steady state.
 *
 * A1-empty – PocketBase's throttle for empty searches (apis/record_crud.go):
 *   a list request with a filter that matches nothing is delayed by a random
 *   0–500 ms once more than 3 such requests came from the same client IP in
 *   its current 3-s window (fixed, starting at a whole second; per
 *   collection) – anti timing-attack, on even when the rate
 *   limiter is off, not for superusers. The SPA sends such requests for
 *   empty views ("Heute + nur meine" before the first booking of the day, a
 *   person without bookings). Behind one NAT / proxy address the whole bar
 *   shares the 3-per-3-s allowance.
 *
 * So that A1 measures query cost and not that throttle, A1 creates its
 * CREATE samples first: user1 then has bookings "today", and "Heute + nur
 * meine" is never empty, whatever the time of day. They are deleted again at
 * the end (the DELETE samples), as are the persons of the P-CREATE samples.
 */
import { latencyStats, type LatencyStats } from '../../stats.ts';
import { describeLatency } from '../analysis.ts';
import { LIST_PAGE, PERSONS_SEQUENCE, SMALL_REQUEST, TOTALS_ALL_SIZE, TOTALS_LARGE } from '../budgets.ts';
import { HttpClient, parseJson, type HttpResult } from '../http.ts';
import { explainPlan } from '../planner.ts';
import {
  bookingBody,
  bookingsFilter,
  keysetFilter,
  keysetNewerFilter,
  paths,
  RECENT_BUCHEN,
  RECENT_DETAIL,
  totalsParams,
  toPbDate,
  type BookingQuery,
  type KeysetCursor,
  type TotalsPart,
} from '../requests.ts';
import { fmt, sleep, startScenario, type PerfContext, type ScenarioRecorder } from '../scenario.ts';
import type { Budget, ScenarioResult } from '../types.ts';
import { periodRanges } from '../../time.ts';

interface Sample {
  ms: number;
  bytes: number;
  error?: string;
}

interface Measured {
  key: string;
  label: string;
  latency: LatencyStats;
  bytesMean: number;
  errors: string[];
  /** The measured requests returned an empty list (see A1-empty). */
  empty?: boolean;
}

const single = (result: HttpResult): Sample => ({ ms: result.ms, bytes: result.bytes, error: result.error });

/** `warmup` unmeasured + `n` measured sequential runs of `run`. */
async function measure(key: string, label: string, warmup: number, n: number, run: (i: number) => Promise<Sample>): Promise<Measured> {
  for (let i = 0; i < warmup; i++) await run(i);
  const samples: Sample[] = [];
  for (let i = 0; i < n; i++) samples.push(await run(warmup + i));
  const errors = samples.filter((s) => s.error !== undefined).map((s) => s.error as string);
  return {
    key,
    label,
    latency: latencyStats(samples.map((s) => s.ms)),
    bytesMean: samples.length ? Math.round(samples.reduce((sum, s) => sum + s.bytes, 0) / samples.length) : 0,
    errors,
  };
}

/** Number of items of a list response (collected body). */
function itemCount(result: HttpResult): number {
  return parseJson<{ items: unknown[] }>(result).items.length;
}

interface ListVariant {
  key: string;
  label: string;
  query: BookingQuery;
  /** Totals variants: the parts the screen requests (undefined = all four, no `parts` parameter). */
  parts?: TotalsPart[];
}

/** The newest bookings of a list response (ids + created). */
function cursors(result: HttpResult): KeysetCursor[] {
  return parseJson<{ items: Array<{ id: string; created: string }> }>(result).items.map(({ id, created }) => ({ id, created }));
}

export async function scenarioA1(ctx: PerfContext): Promise<ScenarioResult[]> {
  const main = startScenario(ctx, {
    id: 'A1',
    title: 'Single-request baseline',
    simulates: 'one device on an otherwise idle server: what every request type of the SPA costs on its own',
  });
  // the companion results start when their measurements start
  let planner: ReturnType<typeof startScenario> | undefined;
  let empty: ReturnType<typeof startScenario> | undefined;
  const startPlanner = () =>
    (planner = startScenario(ctx, {
      id: 'A1-planner',
      title: 'Planner statistics: freshly seeded vs. production steady state',
      simulates: 'the same list / totals requests on a database without and with the statistics PocketBase gathers every night',
    }));
  const startEmpty = () =>
    (empty = startScenario(ctx, {
      id: 'A1-empty',
      title: "Empty filtered lists: PocketBase's search throttle",
      simulates: 'several devices behind one IP address showing filtered views without results (e.g. a person without bookings)',
    }));
  let plannerResult: ScenarioResult | undefined;
  let emptyResult: ScenarioResult | undefined;
  const user1 = new HttpClient(ctx.url, { token: ctx.logins.user1!.token });
  const admin = new HttpClient(ctx.url, { token: ctx.logins.admin!.token });
  const createdBookings: string[] = [];
  const createdPersons: string[] = [];
  try {
    const rec = main.rec;
    const { catalog } = ctx;
    const n = ctx.quick ? 10 : 30;
    const warmup = ctx.quick ? 3 : 5;
    const tz = catalog.timeZone;
    const user1Id = String(ctx.logins.user1!.record.id);
    const bookingPerson = catalog.persons.at(-1)!; // "2000": receives A1's create samples
    const otherPerson = catalog.persons[Math.floor(catalog.persons.length / 2)]!; // "1000": person filter variants
    const offering = catalog.offerings[0]!;
    const results: Measured[] = [];
    const get = (client: HttpClient, path: string) => client.get(path).then(single);

    // 1. CREATE samples first – user1 then has bookings "today" (see header)
    const window = rec.window();
    results.push(
      await measure('create', 'booking create (POST with expand)', warmup, n, async () => {
        const result = await user1.post(paths.createBooking(), bookingBody(bookingPerson.id, offering.id, user1Id), { collect: true });
        if (result.status === 200) createdBookings.push(parseJson<{ id: string }>(result).id);
        return single(result);
      }),
    );

    // 2. + 3. planner comparison (only on a freshly seeded database), then the steady state
    const listVariants: ListVariant[] = [
      { key: 'list.all', label: 'list p1 – Alle', query: { period: 'all' } },
      { key: 'list.today', label: 'list p1 – Heute', query: { period: 'today' } },
      { key: 'list.7d', label: 'list p1 – 7 Tage', query: { period: '7d' } },
      { key: 'list.30d', label: 'list p1 – 30 Tage', query: { period: '30d' } },
      { key: 'list.person', label: 'list p1 – person filter', query: { period: 'all', personId: otherPerson.id } },
      { key: 'list.mine', label: 'list p1 – nur meine', query: { period: 'all', createdBy: user1Id } },
      { key: 'list.today-mine', label: 'list p1 – Heute + nur meine', query: { period: 'today', createdBy: user1Id } },
      { key: 'list.7d-mine', label: 'list p1 – 7 Tage + nur meine', query: { period: '7d', createdBy: user1Id } },
      { key: 'list.30d-mine', label: 'list p1 – 30 Tage + nur meine', query: { period: '30d', createdBy: user1Id } },
    ];
    // the totals requests as the screens send them (`parts`, docs/ARCHITECTURE.md §5)
    const summary: TotalsPart[] = ['summary'];
    const totalsVariants: ListVariant[] = [
      { key: 'totals.perPerson', label: 'totals – per person, all bookings (Personen)', query: { period: 'all' }, parts: ['perPerson'] },
      { key: 'totals.all', label: 'totals – Alle, summary (Buchungen list)', query: { period: 'all' }, parts: summary },
      { key: 'totals.today', label: 'totals – Heute, summary', query: { period: 'today' }, parts: summary },
      { key: 'totals.7d', label: 'totals – 7 Tage, summary', query: { period: '7d' }, parts: summary },
      { key: 'totals.30d', label: 'totals – 30 Tage, summary', query: { period: '30d' }, parts: summary },
      { key: 'totals.mine', label: 'totals – nur meine, summary', query: { period: 'all', createdBy: user1Id }, parts: summary },
      { key: 'totals.today-mine', label: 'totals – Heute + nur meine, summary', query: { period: 'today', createdBy: user1Id }, parts: summary },
      { key: 'totals.proPerson', label: 'totals – Alle, summary + per person ("Pro Person")', query: { period: 'all' }, parts: ['summary', 'perPerson'] },
      { key: 'totals.perOffering', label: 'totals – per offering (Verwaltung → Angebote)', query: { period: 'all' }, parts: ['perOffering'] },
      { key: 'totals.perUser', label: 'totals – per user (Verwaltung → Benutzer)', query: { period: 'all' }, parts: ['perUser'] },
      { key: 'totals.person', label: 'totals – person, summary (Buchen card)', query: { period: 'all', personId: otherPerson.id }, parts: summary },
      {
        key: 'totals.personRow',
        label: "totals – one person's row (realtime update on Personen)",
        query: { period: 'all', personId: otherPerson.id },
        parts: ['perPerson'],
      },
      { key: 'totals.full', label: 'totals – all four parts (no "parts"; what the big screens requested before the fixes)', query: { period: 'all' } },
    ];
    const listPath = (v: ListVariant) => paths.bookings(bookingsFilter(v.query, Date.now(), tz));
    const totalsPath = (v: ListVariant) => paths.totals(totalsParams(v.query, Date.now(), tz, v.parts));
    const comparison = [
      ...listVariants.filter((v) => ['list.all', 'list.today', 'list.30d', 'list.mine', 'list.today-mine', 'list.7d-mine', 'list.30d-mine'].includes(v.key)),
      ...totalsVariants.filter((v) => ['totals.30d', 'totals.mine', 'totals.today-mine'].includes(v.key)),
    ];
    const measureComparison = async () => {
      const out: Measured[] = [];
      for (const v of comparison) {
        const path = v.key.startsWith('list') ? listPath(v) : totalsPath(v);
        out.push(await measure(v.key, v.label, 3, ctx.quick ? 5 : 15, () => get(user1, path)));
      }
      return out;
    };
    const plans = async () => explainSet(ctx, user1Id, tz);

    let fresh: { measured: Measured[]; plans: Record<string, string[]>; stat1: unknown } | null = null;
    let plannerWindow: ReturnType<ScenarioRecorder['window']> | undefined;
    if (ctx.plannerState() === 'fresh') {
      plannerWindow = startPlanner().rec.window();
      const superuser = await ctx.instance.superuserClient();
      const status = (await superuser.send('/api/loadtest/planner-stats', { method: 'POST', body: { action: 'status' } })) as {
        stat1: Array<{ tbl: string }>;
      };
      fresh = { measured: await measureComparison(), plans: await plans(), stat1: status.stat1 };
    }
    const steadyInfo = await ctx.ensureSteadyState();
    if (fresh && planner) {
      const steady = { measured: await measureComparison(), plans: await plans() };
      plannerWindow?.stop();
      reportPlanner(planner.rec, fresh, steady, steadyInfo);
      plannerResult = planner.finish();
    }

    // 4. everything else, in the steady state
    results.push(
      await measure('persons', 'persons list (getFullList: 3 sequential pages)', warmup, n, async () => {
        let ms = 0;
        let bytes = 0;
        for (let page = 1; ; page++) {
          const result = await user1.get(paths.personsPage(page), { collect: true });
          ms += result.ms;
          bytes += result.bytes;
          if (result.error) return { ms, bytes, error: result.error };
          if (itemCount(result) < 1000) return { ms, bytes };
        }
      }),
      await measure('groups', 'groups', warmup, n, () => get(user1, paths.groups())),
      await measure('offerings', 'offerings', warmup, n, () => get(user1, paths.offerings())),
      await measure('users', 'users (admin screen)', warmup, n, () => get(admin, paths.users())),
    );
    for (const v of listVariants) {
      const probe = await user1.get(listPath(v), { collect: true });
      const m = await measure(v.key, v.label, warmup, n, () => get(user1, listPath(v)));
      if (probe.status === 200 && itemCount(probe) === 0) m.empty = true;
      results.push(m);
    }
    // "Weitere laden" (keyset page 2) and the realtime head request: one new booking, newer than the newest shown one
    const first = cursors(await user1.get(paths.bookings(''), { collect: true }));
    const lastOfPage1 = first.at(-1);
    if (lastOfPage1) {
      results.push(await measure('list.page2', 'list p2 – Alle ("Weitere laden", keyset)', warmup, n, () => get(user1, paths.bookings(keysetFilter('', lastOfPage1)))));
    }
    const secondNewest = first[1];
    if (secondNewest) {
      results.push(
        await measure('list.head', 'list – realtime head request (Alle, 1 new booking)', warmup, n, () =>
          get(user1, paths.bookings(keysetNewerFilter('', secondNewest))),
        ),
      );
    }
    results.push(
      await measure('recent8', 'recent bookings of a person (8, Buchen)', warmup, n, () => get(user1, paths.recent(otherPerson.id, RECENT_BUCHEN))),
      await measure('recent20', 'recent bookings of a person (20, person detail)', warmup, n, () =>
        get(user1, paths.recent(otherPerson.id, RECENT_DETAIL)),
      ),
    );
    for (const v of totalsVariants) results.push(await measure(v.key, v.label, warmup, n, () => get(user1, totalsPath(v))));
    results.push(await measure('refresh', 'session refresh (auth-refresh)', warmup, n, () => user1.post(paths.refresh(), undefined).then(single)));

    // 5. DELETE samples: A1's own bookings
    const toDelete = [...createdBookings];
    results.push(
      await measure('delete', 'booking delete (Rückgängig)', 0, toDelete.length, async (i) => {
        const result = await user1.delete(paths.booking(toDelete[i]!));
        if (result.status === 204) createdBookings.splice(createdBookings.indexOf(toDelete[i]!), 1);
        return single(result);
      }),
    );

    // 6. P-CREATE samples (persons created by admin like on the Personen screen)
    const stamp = Date.now().toString(36).slice(-6);
    results.push(
      await measure('person-create', 'person create (Personen → Neu)', warmup, n, async (i) => {
        const result = await admin.post(paths.persons(), { number: `lt-a1-${stamp}-${i}`, name: `Lasttest A1 ${i}`, nickname: '' }, { collect: true });
        if (result.status === 200) createdPersons.push(parseJson<{ id: string }>(result).id);
        return single(result);
      }),
    );
    const server = window.stop();

    // 7. A1-empty: a person without bookings – one of those just created
    if (createdPersons.length > 0) {
      const rec = startEmpty().rec;
      const emptyWindow = rec.window();
      await measureEmptyThrottle(rec, user1, createdPersons[0]!, ctx);
      emptyWindow.stop();
      emptyResult = empty!.finish();
    }

    // 8. cleanup (measured as info)
    const toRemove = [...createdPersons];
    results.push(
      await measure('person-delete', 'person delete (cleanup)', 0, toRemove.length, async (i) => {
        const result = await admin.delete(paths.person(toRemove[i]!));
        if (result.status === 204) createdPersons.splice(createdPersons.indexOf(toRemove[i]!), 1);
        return single(result);
      }),
    );

    reportBaseline(rec, results, server.server?.cpuMeanPct ?? null);
  } catch (error) {
    const done = main.finish(error);
    return [done, ...(plannerResult ? [plannerResult] : []), ...(emptyResult ? [emptyResult] : [])];
  } finally {
    // never leave A1's records behind (they would change the dataset of later scenarios / the UI checks)
    for (const id of createdBookings) await user1.delete(paths.booking(id));
    for (const id of createdPersons) await admin.delete(paths.person(id));
    user1.close();
    admin.close();
  }
  if (!plannerResult) {
    main.rec.note(
      'A1-planner was not measured: the database was no longer in its freshly seeded state (A1 did not run first after seeding).',
    );
  }
  const out = [main.finish()];
  if (plannerResult) out.push(plannerResult);
  if (emptyResult) out.push(emptyResult);
  return out;
}

// ------------------------------------------------------------------- A1

const BUDGET_OF: Record<string, Budget> = {
  create: SMALL_REQUEST,
  delete: SMALL_REQUEST,
  'person-create': SMALL_REQUEST,
  groups: SMALL_REQUEST,
  offerings: SMALL_REQUEST,
  users: SMALL_REQUEST,
  recent8: SMALL_REQUEST,
  recent20: SMALL_REQUEST,
  refresh: SMALL_REQUEST,
  'totals.person': SMALL_REQUEST,
  'totals.personRow': SMALL_REQUEST,
  persons: PERSONS_SEQUENCE,
};

function budgetFor(key: string): Budget | undefined {
  if (BUDGET_OF[key]) return BUDGET_OF[key];
  if (key === 'totals.full') return undefined; // not sent by the app any more – the comparison with the baseline
  if (key.startsWith('list.')) return LIST_PAGE;
  if (key.startsWith('totals.')) return TOTALS_LARGE;
  return undefined;
}

const CONSEQUENCE: Record<string, string> = {
  persons: 'the persons list is loaded on every app start, after every persons change and every realtime reconnect',
  'totals.perPerson': 'Personen and "Pro Person" load these rows when they open, and again after a reconnect or when more than 10 persons booked at once',
  'totals.all': 'Buchungen ("Alle") refetches its summary after every booking anywhere – a slow answer delays every laptop on Buchungen',
  'list.head': 'every laptop on Buchungen sends this request after a booking elsewhere (one for all bookings that arrive while it runs)',
  'totals.personRow': 'every phone on Personen sends one of these per booked person after every booking elsewhere',
  create: 'every booking tap waits for this answer before the toast appears',
  delete: '"Rückgängig" waits for this answer',
  refresh: 'every device checks the session at the start, every minute and on every realtime reconnect',
};

function reportBaseline(rec: ScenarioRecorder, results: Measured[], serverCpu: number | null): void {
  for (const m of results) {
    const budget = budgetFor(m.key);
    const sizeKiB = Math.round((m.bytesMean / 1024) * 10) / 10;
    rec.add({
      key: `${m.key}.p95`,
      label: `${m.label} – p95`,
      value: m.latency.count ? m.latency.p95 : null,
      unit: 'ms',
      budget,
      detail: `${describeLatency(m.latency)}; ${sizeKiB} KiB per response${m.empty ? '; EMPTY result (see A1-empty)' : ''}${
        m.errors.length ? `; ${m.errors.length} errors: ${m.errors[0]}` : ''
      }`,
      explain: (verdict) =>
        verdict === 'warn' || verdict === 'fail'
          ? `on an idle server this request already takes ${m.latency.p95} ms (p95)${CONSEQUENCE[m.key] ? ` – ${CONSEQUENCE[m.key]}` : ''}`
          : undefined,
    });
    if (m.errors.length > 0) {
      rec.add({
        key: `${m.key}.errors`,
        label: `${m.label} – errors`,
        value: m.errors.length,
        unit: 'count',
        budget: { direction: 'max', fail: 0, rationale: 'a request of an idle server must not fail' },
        detail: m.errors.slice(0, 3).join('; '),
      });
    }
  }
  const perPerson = results.find((m) => m.key === 'totals.perPerson');
  if (perPerson) {
    const kib = Math.round((perPerson.bytesMean / 1024) * 10) / 10;
    rec.add({
      key: 'totals.perPerson.size',
      label: 'totals – per person (all bookings): response size',
      value: kib,
      unit: 'KiB',
      budget: TOTALS_ALL_SIZE,
      detail: `uncompressed JSON (PocketBase does not compress API responses; a reverse proxy can – deploy/reverse-proxy.md); downloaded when Personen or "Pro Person" opens, after a reconnect and when more than 10 persons booked in one realtime batch – single bookings update one row (totals.personRow)`,
      explain: (verdict) =>
        verdict === 'warn' ? 'the per-person rows make this response grow with the number of persons – every full load downloads all of them' : undefined,
    });
  }
  if (serverCpu !== null) rec.info('server.cpu.mean', 'PocketBase CPU during A1 (mean)', serverCpu, '%');
  rec.table('All request types (sequential, warm)', {
    columns: ['request', 'n', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms', 'KiB per response'],
    rows: results.map((m) => [
      `${m.label}${m.empty ? ' (empty)' : ''}`,
      m.latency.count,
      m.latency.p50,
      m.latency.p95,
      m.latency.p99,
      m.latency.max,
      Math.round((m.bytesMean / 1024) * 10) / 10,
    ]),
  });
  const slowest = [...results].sort((a, b) => b.latency.p50 - a.latency.p50).slice(0, 3);
  rec.note(`Most expensive requests (p50): ${slowest.map((m) => `${m.label} ${m.latency.p50} ms`).join(', ')}.`);
  if (results.some((m) => m.empty)) {
    rec.note('Some list variants returned no rows: their timings include PocketBase\'s empty-search throttle (A1-empty).');
  }
}

// ----------------------------------------------------------- A1-planner

/** The SQL PocketBase generates for the requests (bound parameters; see 1B sql-trace). */
async function explainSet(ctx: PerfContext, userId: string, tz: string): Promise<Record<string, string[]>> {
  const superuser = await ctx.instance.superuserClient();
  const ranges = periodRanges(Date.now(), tz);
  const today = { from: toPbDate(ranges.today.from!), to: toPbDate(ranges.today.to!) };
  const d30 = { from: toPbDate(ranges['30d'].from!), to: toPbDate(ranges['30d'].to!) };
  const list = (where: string) =>
    `SELECT bookings.* FROM bookings WHERE ({:auth} IS NOT '') AND (${where}) ORDER BY bookings.created DESC, bookings.id DESC LIMIT 50`;
  // backend/pb_hooks/lib/totals.js AGGREGATES (they decide whether an index covers the query)
  const agg = 'COUNT(*), COALESCE(SUM(b."quantity"), 0), COALESCE(SUM(b."quantity" * b."unitPriceCents"), 0)';
  const statements: Record<string, [string, Record<string, string>]> = {
    'list Heute + nur meine': [
      list('(bookings.created >= {:f} AND bookings.created < {:t} AND bookings.createdBy = {:u})'),
      { auth: userId, f: today.from, t: today.to, u: userId },
    ],
    'list 30 Tage + nur meine': [
      list('(bookings.created >= {:f} AND bookings.created < {:t} AND bookings.createdBy = {:u})'),
      { auth: userId, f: d30.from, t: d30.to, u: userId },
    ],
    'list nur meine': [list('bookings.createdBy = {:u}'), { auth: userId, u: userId }],
    'totals Heute + nur meine (summary)': [
      `SELECT ${agg} FROM "bookings" b WHERE b."created" >= {:f} AND b."created" < {:t} AND b."createdBy" = {:u}`,
      { f: today.from, t: today.to, u: userId },
    ],
    'totals nur meine (summary)': [`SELECT ${agg} FROM "bookings" b WHERE b."createdBy" = {:u}`, { u: userId }],
    // backend/pb_hooks/lib/totals.js: the breakdowns aggregate first and join the result rows afterwards
    'totals 30 Tage (per person)': [
      `SELECT t."personId", p."number" FROM (SELECT b."person" AS "personId", ${agg} FROM "bookings" b ` +
        'WHERE b."created" >= {:f} AND b."created" < {:t} GROUP BY b."person") t LEFT JOIN "persons" p ON p."id" = t."personId" ' +
        'ORDER BY p."number" COLLATE NOCASE, t."personId"',
      { f: d30.from, t: d30.to },
    ],
    'totals per user (Benutzer)': [
      `SELECT t."userId", u."username" FROM (SELECT b."createdBy" AS "userId", ${agg} FROM "bookings" b GROUP BY b."createdBy") t ` +
        'LEFT JOIN "users" u ON u."id" = t."userId" ORDER BY u."username", t."userId"',
      {},
    ],
    // the Buchungen list's realtime head request (keysetNewerFilter): newer than the newest shown booking
    'list head request (Alle)': [
      list('bookings.created >= {:c0} AND (bookings.created > {:c1} OR (bookings.created = {:c2} AND bookings.id > {:i}))'),
      { auth: userId, c0: today.from, c1: today.from, c2: today.from, i: '' },
    ],
    // the CSV export's / "Weitere laden" keyset page: PocketBase binds every cursor literal separately
    'keyset page (as sent: created <= c && …)': [
      `SELECT bookings.* FROM bookings WHERE ({:auth} IS NOT '') AND (bookings.created <= {:c0} AND (bookings.created < {:c1} OR (bookings.created = {:c2} AND bookings.id < {:i}))) ORDER BY bookings.created DESC, bookings.id DESC LIMIT 500`,
      { auth: userId, c0: d30.from, c1: d30.from, c2: d30.from, i: 'zzzzzzzzzzzzzzz' },
    ],
    'keyset page before the F3 fix (comparison)': [
      `SELECT bookings.* FROM bookings WHERE ({:auth} IS NOT '') AND ((bookings.created < {:c1} OR (bookings.created = {:c2} AND bookings.id < {:i}))) ORDER BY bookings.created DESC, bookings.id DESC LIMIT 500`,
      { auth: userId, c1: d30.from, c2: d30.from, i: 'zzzzzzzzzzzzzzz' },
    ],
  };
  const out: Record<string, string[]> = {};
  for (const [label, [sql, params]] of Object.entries(statements)) out[label] = await explainPlan(superuser, sql, params);
  return out;
}

function reportPlanner(
  rec: ScenarioRecorder,
  fresh: { measured: Measured[]; plans: Record<string, string[]>; stat1: unknown },
  steady: { measured: Measured[]; plans: Record<string, string[]> },
  steadyInfo: { stat1: Array<{ tbl: string; idx: string; stat: string }>; optimizeMs?: number; appTables: string[] },
): void {
  const rows: Array<Array<string | number>> = [];
  for (const f of fresh.measured) {
    const s = steady.measured.find((m) => m.key === f.key);
    if (!s) continue;
    const ratio = s.latency.p50 > 0 ? Math.round((f.latency.p50 / s.latency.p50) * 100) / 100 : NaN;
    rows.push([f.label, f.latency.p50, f.latency.p95, s.latency.p50, s.latency.p95, Number.isFinite(ratio) ? `${ratio}×` : '']);
    if (f.key === 'list.today-mine' || f.key === 'list.30d-mine' || f.key === 'totals.today-mine') {
      rec.info(`fresh.${f.key}.p50`, `${f.label} – fresh database (p50)`, f.latency.p50, 'ms');
      rec.info(`steady.${f.key}.p50`, `${f.label} – with statistics (p50)`, s.latency.p50, 'ms');
    }
  }
  rec.table('p50 / p95 in ms: freshly seeded database vs. with planner statistics', {
    columns: ['request', 'fresh p50', 'fresh p95', 'steady p50', 'steady p95', 'fresh / steady (p50)'],
    rows,
  });
  const planRows: Array<Array<string | number>> = [];
  const changed: string[] = [];
  for (const [label, freshPlan] of Object.entries(fresh.plans)) {
    const steadyPlan = steady.plans[label] ?? [];
    const same = freshPlan.join(' | ') === steadyPlan.join(' | ');
    if (!same) changed.push(label);
    planRows.push([label, freshPlan.join(' → '), same ? '(same)' : steadyPlan.join(' → ')]);
  }
  rec.table('Query plans (EXPLAIN QUERY PLAN)', { columns: ['statement', 'fresh database', 'with statistics'], rows: planRows });
  const bookingsStats = steadyInfo.stat1.filter((row) => row.tbl === 'bookings').map((row) => `${row.idx} "${row.stat}"`);
  const freshRows = Array.isArray(fresh.stat1) ? (fresh.stat1 as Array<{ tbl: string; stat?: string }>) : [];
  const freshApp = [...new Set(freshRows.filter((row) => steadyInfo.appTables.includes(row.tbl)).map((row) => row.tbl))];
  rec.note(
    `PocketBase runs "PRAGMA optimize" itself every night at 00:00 UTC and after schema changes; a freshly seeded database has statistics ` +
      `for PocketBase's system tables` +
      (freshApp.length > 0
        ? ` and seed-state rows for ${freshApp.join(', ')} (written by the optimize after the app's last index migration, while those ` +
          'tables still held only their seed rows – the nightly optimize does not refresh them for small tables)'
        : ' only') +
      `. After the optimize (${steadyInfo.optimizeMs ?? '?'} ms) sqlite_stat1 covers ${steadyInfo.appTables.join(', ')} (bookings: ${bookingsStats.join(', ')}).`,
  );
  rec.note(
    changed.length > 0
      ? `Plans that differ without statistics: ${changed.join('; ')} – a database that has not seen a night with data yet ` +
          '(new installation, restored backup before its first night) uses the "fresh" plans.'
      : 'No plan differs between the two states for the statements checked.',
  );
  rec.data.planner = { freshStat1: fresh.stat1, steady: steadyInfo };
}

// ------------------------------------------------------------- A1-empty

async function measureEmptyThrottle(rec: ScenarioRecorder, client: HttpClient, personId: string, ctx: PerfContext): Promise<void> {
  const path = paths.recent(personId, RECENT_BUCHEN);
  // PocketBase's allowance is a fixed window of 3 s that starts at the whole second of the first counted
  // request (apis/middlewares_rate_limit.go: start = time.Now().Unix()). Measure inside exactly one window:
  await sleep(3200, ctx.signal); // any earlier window has expired
  await sleep(1000 - (Date.now() % 1000) + 20, ctx.signal); // start just after a whole second
  const windowEnd = Math.floor(Date.now() / 1000) * 1000 + 3000;
  const ms: number[] = [];
  while (Date.now() < windowEnd - 20 && ms.length < 60 && !ctx.signal.aborted) ms.push((await client.get(path)).ms);
  await sleep(3200, ctx.signal); // let the window expire again before other scenarios run
  const firstThree = latencyStats(ms.slice(0, 3));
  const throttled = latencyStats(ms.slice(3));
  rec.info('empty.first3.max', 'empty filtered list – requests 1–3 of a 3-s window (max)', firstThree.count ? firstThree.max : null, 'ms');
  rec.add({
    key: 'empty.throttled.max',
    label: `empty filtered list – requests 4 … ${ms.length} of the same 3-s window from one IP (max of ${throttled.count})`,
    value: throttled.count ? throttled.max : null,
    unit: 'ms',
    budget: {
      direction: 'max',
      warn: 200,
      rationale:
        'an empty list should appear as fast as any list (LIST budget); WARN, not FAIL: only empty results are delayed, and only beyond 3 per window; ' +
        'with ≥ 5 throttled requests the max of uniform 0–500 ms sleeps exceeds 200 ms with > 99 % probability',
    },
    detail: `median ${throttled.p50} ms of ${throttled.count} requests; requests 1–3: ${ms
      .slice(0, 3)
      .map((v) => fmt(v))
      .join(', ')} ms; request: recent bookings (${RECENT_BUCHEN}) of a person without bookings, back to back`,
    explain: (verdict) =>
      verdict === 'warn'
        ? 'PocketBase sleeps a random 0–500 ms (apis/record_crud.go, "randomizedThrottle") before answering an empty filtered list once ' +
          'more than 3 came from the same IP in its current 3-second window – the screen shows "no bookings" up to half a second late; all phones behind one ' +
          'NAT/proxy address share that allowance'
        : undefined,
  });
  rec.info('empty.throttled.median', 'empty filtered list – throttled requests (median)', throttled.count ? throttled.p50 : null, 'ms');
  rec.table("Latency per request (same empty query, back to back, inside one of PocketBase's 3-s windows)", {
    columns: ['request #', 'ms'],
    rows: ms.map((v, i) => [i + 1, Math.round(v * 10) / 10]),
  });
  rec.note(
    'Where the SPA sends filtered lists that can be empty: Buchungen with "Heute" / person / "nur meine" before matching bookings exist, ' +
      'the recent bookings of a person without bookings (Buchen card, person detail), the last keyset page of a CSV export. ' +
      'Unfiltered requests ("Alle", the persons pages) are not throttled. The window is fixed and starts at a whole second, so ' +
      'the allowance renews every 3 s.',
  );
}
