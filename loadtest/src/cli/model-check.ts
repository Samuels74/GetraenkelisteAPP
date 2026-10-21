/**
 * `node src/cli/model-check.ts` (npm run model-check) – checks the API device
 * model (src/perf/device.ts, src/perf/requests.ts) against the real SPA,
 * request by request. The performance scenarios A2/A2b/A3/A5/A11 trust that
 * model; whenever the SPA's data layer changes (frontend/src/api/**), run
 * this before trusting their numbers.
 *
 * On a throw-away instance with the load-test dataset, the same screens run
 * twice – first as real pages in Chromium (the built SPA), then as model
 * devices – and the same sequence of booking events is played against each
 * set: bookings and cancellations made elsewhere (REST, as user2), an own
 * booking tap and its "Rückgängig", batches within one realtime debounce, a
 * person without bookings (known-empty list), a batch of more than 10
 * persons, a renamed person and a renamed user, and a quiet minute. For
 * every event and screen the requests (method, path, decoded query
 * parameters in order) must be the same multiset; ids and timestamps of the
 * bookings created during the run are replaced by tokens (B1, T1 …) first,
 * everything else must match literally. Session checks (auth-refresh) are
 * driven by time, not by the events: they are left out of the steps and
 * checked on their own – every screen checks at the start and then every
 * 60 s. The cold loads are compared as sets of distinct requests (without
 * the realtime subscription and the session checks): the first realtime
 * connect refetches what had loaded before it (FLOW-5), and which queries
 * that is depends on timing – the repeats are listed, not compared.
 *
 * Exit code: 0 = no difference, 1 = a difference or an error, 2 = usage
 * error, 130/143 = interrupted.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loginUser } from '../api.ts';
import { DEFAULT_PASSWORD } from '../dataset.ts';
import { startInstance, type Instance } from '../instance.ts';
import { defaultPaths, displayPath, removeOwnedDir, snapshotSpa } from '../paths.ts';
import { Device, type DeviceRequest, type DeviceSpec } from '../perf/device.ts';
import { HttpClient, parseJson } from '../perf/http.ts';
import { bookingBody, paths, pbQuote } from '../perf/requests.ts';
import { SampleLog } from '../perf/samples.ts';
import type { Login } from '../perf/types.ts';
import { seedDataset } from '../seed.ts';
import { BrowserHolder, sleep, UiPage } from '../ui/browser.ts';
import { abortOnSignals, signalExitCode, UsageError } from './args.ts';

const HELP = `Usage: node src/cli/model-check.ts [options]      (in loadtest/)

Compares the API device model with the real SPA (Chromium, the built SPA in
frontend/dist): the same screens and booking events, request by request.

  --public-dir <dir>   SPA build to serve (default: frontend/dist, copied)
  --verbose            print every request of every step
  -h, --help`;

const log = (line: string) => process.stdout.write(`${line}\n`);
const TIME_ZONE = 'Europe/Vienna';
/** Quiet period that ends a step (no request of any screen). */
const QUIET_MS = 900;
/** frontend/src/auth/session.ts SESSION_CHECK_INTERVAL_MS, and the tolerance of the cadence check. */
const SESSION_CHECK_MS = 60_000;
const SESSION_TOLERANCE_MS = 1_500;

interface ScreenDef {
  name: string;
  username: string;
  spec: Omit<DeviceSpec, 'id' | 'token' | 'userId' | 'admin'>;
  /** Browser path; `selected` = the person selected on Buchen. */
  path: string;
  selected?: string;
  /** Browser: "Weitere laden" clicks after the load. */
  more?: number;
}

/** A request as compared: "GET /path?name=value&…" with decoded values. */
type Normalized = string;

interface Phase {
  /** Requests per step label and screen. */
  steps: Map<string, Map<string, Normalized[]>>;
  cold: Map<string, Normalized[]>;
  /** Start times (epoch ms) of the session checks per screen, over the whole phase. */
  sessionChecks: Map<string, number[]>;
  /** Ids / created timestamps of bookings created in this phase → tokens. */
  tokens: Map<string, string>;
  /** Bookings created so far in this phase. */
  created: number;
}

function normalize(method: string, url: string, tokens: ReadonlyMap<string, string>): Normalized {
  const target = new URL(url, 'http://x');
  const query = [...target.searchParams].map(([key, value]) => `${key}=${value}`).join('&');
  let text = `${method} ${decodeURIComponent(target.pathname)}${query ? `?${query}` : ''}`;
  for (const [value, token] of tokens) text = text.split(value).join(token);
  return text;
}

/** The distinct requests and the repeats (second and later occurrences). */
function distinct(items: readonly string[]): { unique: string[]; repeats: string[] } {
  const seen = new Set<string>();
  const repeats: string[] = [];
  for (const item of items) {
    if (seen.has(item)) repeats.push(item);
    else seen.add(item);
  }
  return { unique: [...seen].sort(), repeats };
}

/** "2 checks, 60.0 s apart" – and whether the cadence is the SPA's (start + every 60 s). */
function describeChecks(times: readonly number[]): { text: string; ok: boolean } {
  const sorted = [...times].sort((x, y) => x - y);
  const gaps = sorted.slice(1).map((t, i) => t - (sorted[i] as number));
  const ok = sorted.length >= 2 && gaps.every((gap) => Math.abs(gap - SESSION_CHECK_MS) <= SESSION_TOLERANCE_MS);
  const apart = gaps.length ? `, ${gaps.map((gap) => (gap / 1000).toFixed(1)).join(' / ')} s apart` : '';
  return { text: `${sorted.length} check${sorted.length === 1 ? '' : 's'}${apart}`, ok };
}

function multisetDiff(a: readonly string[], b: readonly string[]): { onlyA: string[]; onlyB: string[] } {
  const rest = [...b];
  const onlyA: string[] = [];
  for (const item of a) {
    const i = rest.indexOf(item);
    if (i >= 0) rest.splice(i, 1);
    else onlyA.push(item);
  }
  return { onlyA, onlyB: rest };
}

async function main(): Promise<number> {
  let values: { 'public-dir'?: string; verbose: boolean; help: boolean };
  try {
    values = parseArgs({
      options: {
        'public-dir': { type: 'string' },
        verbose: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }).values as typeof values;
    if (values.help) {
      log(HELP);
      return 0;
    }
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP}\n`);
    return 2;
  }

  const { controller, received } = abortOnSignals((signal) => log(`\n${signal} received – stopping …`));
  const source = path.resolve(values['public-dir'] ?? defaultPaths().publicDir);
  let snapshot: { root: string; publicDir: string } | undefined;
  let instance: Instance | undefined;
  const holder = new BrowserHolder();
  const pages = new Map<string, UiPage>();
  const devices = new Map<string, Device>();
  const clients: HttpClient[] = [];
  let differences = 0;
  try {
    if (!(await stat(path.join(source, 'index.html')).catch(() => null))) {
      throw new UsageError(`no SPA build in ${displayPath(source)} – run: cd frontend && npm run build`);
    }
    snapshot = await snapshotSpa(source);
    instance = await startInstance({ paths: { publicDir: snapshot.publicDir } });
    log(`PocketBase ${instance.url}; SPA ${displayPath(source)}`);
    await instance.setRateLimiting(false);
    const seed = await seedDataset({ url: instance.url, superuser: instance.superuser, signal: controller.signal });
    if (!seed.ok) throw new Error('seeding failed');
    log(`seeded ${seed.counts.bookings.toLocaleString('en')} bookings, ${seed.counts.persons} persons`);
    const logins: Record<string, Login> = {};
    for (const username of ['admin', 'user1', 'user2', 'user3', 'user4']) {
      const pb = await loginUser(instance.url, username, DEFAULT_PASSWORD);
      logins[username] = { username, password: DEFAULT_PASSWORD, token: pb.authStore.token, record: pb.authStore.record ?? {} };
    }
    const url = instance.url;
    const client = (username: string) => {
      const c = new HttpClient(url, { token: logins[username]!.token });
      clients.push(c);
      return c;
    };
    const admin = client('admin');
    const booker = client('user2');
    const user1 = client('user1');

    // fixtures: P (Buchen with a booking phone), Q (uninvolved Buchen phone), R (other), E (no bookings), 12 more
    const persons = new Map<string, string>();
    for (let page = 1; ; page++) {
      const items = parseJson<{ items: Array<{ id: string; number: string }> }>(await admin.get(paths.personsPage(page), { collect: true })).items;
      for (const item of items) persons.set(item.number, item.id);
      if (items.length < 1000) break;
    }
    const id = (number: number) => persons.get(String(number)) as string;
    const P = id(17);
    const Q = id(342);
    const R = id(777);
    const twelve = Array.from({ length: 12 }, (_, i) => id(1000 + i * 37));
    const E = parseJson<{ id: string }>(
      await admin.post(paths.persons(), { number: `mc-${Date.now().toString(36)}`, name: 'Ohne Buchungen', nickname: '' }, { collect: true }),
    ).id;
    const offering = parseJson<{ items: Array<{ id: string; active: boolean }> }>(await admin.get(paths.offerings(), { collect: true })).items.find(
      (o) => o.active,
    )?.id as string;
    const userId = (username: string) => String(logins[username]!.record.id);
    // a person and a user to rename (realtime events of persons / users) – restored afterwards
    const nicknameOfR = parseJson<{ nickname: string }>(await admin.get(paths.person(R), { collect: true })).nickname;
    const renamedUser = userId('user4');
    const nameOfUser = parseJson<{ name: string }>(await admin.get(`/api/collections/users/records/${renamedUser}`, { collect: true })).name;
    const patch = async (path: string, body: Record<string, unknown>) => {
      const result = await admin.request('PATCH', path, { body });
      if (result.status !== 200) throw new Error(`PATCH ${path} failed: ${result.error}`);
    };

    const screens: ScreenDef[] = [
      { name: 'Buchungen Alle, 10 pages', username: 'admin', spec: { screen: 'buchungen', pages: 10 }, path: '/buchungen', more: 9 },
      { name: 'Buchungen Heute', username: 'user3', spec: { screen: 'buchungen', query: { period: 'today' } }, path: '/buchungen?zeitraum=heute' },
      { name: 'Buchungen 7 Tage + nur meine', username: 'user2', spec: { screen: 'buchungen', query: { period: '7d', createdBy: userId('user2') } }, path: '/buchungen?zeitraum=7-tage&meine=1' },
      { name: 'Buchungen Pro Person', username: 'admin', spec: { screen: 'buchungen', view: 'personen' }, path: '/buchungen?ansicht=personen' },
      { name: 'Buchungen Pro Angebot', username: 'admin', spec: { screen: 'buchungen', view: 'angebote' }, path: '/buchungen?ansicht=angebote' },
      { name: 'Personen', username: 'user1', spec: { screen: 'personen' }, path: '/personen' },
      { name: 'Buchen P (books)', username: 'user1', spec: { screen: 'buchen', personId: P }, path: '/', selected: P },
      { name: 'Buchen Q (uninvolved)', username: 'user3', spec: { screen: 'buchen', personId: Q }, path: '/', selected: Q },
      { name: 'Buchen E (no bookings)', username: 'user4', spec: { screen: 'buchen', personId: E }, path: '/', selected: E },
      { name: 'Verwaltung Angebote', username: 'admin', spec: { screen: 'admin' }, path: '/verwaltung/angebote' },
      { name: 'Verwaltung Benutzer', username: 'admin', spec: { screen: 'admin-users' }, path: '/verwaltung/benutzer' },
    ];

    // the event sequence; `ownTap` / `ownUndo` are played by the phase's Buchen P screen
    const created: Array<{ id: string; created: string }> = [];
    const remoteCreate = async (person: string) => {
      const record = parseJson<{ id: string; created: string }>(
        await booker.post(paths.createBooking(), bookingBody(person, offering, userId('user2')), { collect: true }),
      );
      created.push(record);
      return record;
    };
    const remoteDelete = async (bookingId: string) => {
      const result = await booker.delete(paths.booking(bookingId));
      if (result.status !== 204) throw new Error(`delete failed: ${result.error}`);
    };
    /** The newest booking of user1 – the own tap's booking (no other step books as user1). */
    const ownBooking = async () => {
      const filter = `createdBy = ${pbQuote(userId('user1'))}`;
      const items = parseJson<{ items: Array<{ id: string; created: string }> }>(
        await user1.get(`/api/collections/bookings/records?page=1&perPage=1&skipTotal=1&sort=-created,-id&fields=id,created&filter=${encodeURIComponent(filter)}`, {
          collect: true,
        }),
      ).items;
      return items[0] as { id: string; created: string };
    };
    interface Actor {
      tap(): Promise<void>;
      undo(): Promise<void>;
    }
    const steps: Array<{ label: string; run: (actor: Actor) => Promise<void> }> = [];
    const batch: Array<{ id: string; created: string }> = [];
    let single: { id: string; created: string } | undefined;
    let other: { id: string; created: string } | undefined;
    steps.push(
      { label: 'remote create for P', run: async () => void (single = await remoteCreate(P)) },
      { label: 'remote create for R (no Buchen screen shows R)', run: async () => void (other = await remoteCreate(R)) },
      { label: 'remote delete of the P booking', run: () => remoteDelete(single!.id) },
      { label: 'remote delete of the R booking', run: () => remoteDelete(other!.id) },
      { label: 'own tap on Buchen P', run: async (actor) => actor.tap() },
      { label: 'own "Rückgängig" on Buchen P', run: async (actor) => actor.undo() },
      {
        label: 'two remote creates in one batch (P, R)',
        run: async () => {
          batch.length = 0;
          batch.push(...(await Promise.all([remoteCreate(P), remoteCreate(R)])));
        },
      },
      { label: 'two remote deletes in one batch', run: async () => void (await Promise.all(batch.map((b) => remoteDelete(b.id)))) },
      { label: 'remote create for E (known-empty list)', run: async () => void (single = await remoteCreate(E)) },
      { label: 'remote delete of the E booking', run: () => remoteDelete(single!.id) },
      {
        label: 'batch of 12 creates for 12 persons (> 10)',
        run: async () => {
          batch.length = 0;
          batch.push(...(await Promise.all(twelve.map((person) => remoteCreate(person)))));
        },
      },
      { label: 'batch of their 12 deletes', run: async () => void (await Promise.all(batch.map((b) => remoteDelete(b.id)))) },
      { label: 'person R renamed (person event)', run: () => patch(paths.person(R), { nickname: `mc-${nicknameOfR}`.slice(0, 40) }) },
      { label: 'person R renamed back', run: () => patch(paths.person(R), { nickname: nicknameOfR }) },
      { label: 'user4 renamed (user event)', run: () => patch(`/api/collections/users/records/${renamedUser}`, { name: nameOfUser ? `${nameOfUser} MC`.slice(0, 60) : 'MC' }) },
      { label: 'user4 renamed back', run: () => patch(`/api/collections/users/records/${renamedUser}`, { name: nameOfUser }) },
      // nothing happens for a minute: no refetch by time while realtime is connected – only the minute's session check (checked below)
      { label: 'a quiet minute (no event)', run: () => sleep(SESSION_CHECK_MS + 2_000) },
    );

    const bookingCount = async () => {
      const superuser = await instance!.superuserClient();
      return (await superuser.collection('bookings').getList(1, 1, { fields: 'id' })).totalItems;
    };
    const before = await bookingCount();

    /** Runs the steps; `collect(t0, t1)` returns the requests per screen in that window. */
    const play = async (
      phase: Phase,
      actor: Actor,
      quiet: () => Promise<void>,
      collect: (from: number, to: number) => Map<string, Array<{ method: string; url: string }>>,
    ) => {
      for (const step of steps) {
        controller.signal.throwIfAborted();
        const ownBefore = created.length;
        const t0 = performance.timeOrigin + performance.now();
        await step.run(actor);
        if (step.label.startsWith('own tap')) created.push(await ownBooking());
        for (const record of created.slice(ownBefore)) {
          const n = ++phase.created;
          phase.tokens.set(record.id, `B${n}`);
          if (!phase.tokens.has(record.created)) phase.tokens.set(record.created, `T${n}`);
        }
        await quiet();
        const t1 = performance.timeOrigin + performance.now();
        const perScreen = new Map<string, Normalized[]>();
        for (const [screen, requests] of collect(t0, t1)) {
          perScreen.set(screen, requests.map((r) => normalize(r.method, r.url, phase.tokens)).sort());
        }
        phase.steps.set(step.label, perScreen);
      }
    };

    // ------------------------------------------------------------------ phase A: the SPA
    log('Phase A: the SPA in Chromium …');
    const spa: Phase = { steps: new Map(), cold: new Map(), sessionChecks: new Map(), tokens: new Map(), created: 0 };
    const browser = await holder.get();
    for (const screen of screens) {
      pages.set(
        screen.name,
        await UiPage.open(browser, url, { profile: 'desktop', login: logins[screen.username]!, selectedPersonId: screen.selected }),
      );
    }
    await Promise.all(screens.map((screen) => pages.get(screen.name)!.page.goto(screen.path)));
    for (const screen of screens) {
      const page = pages.get(screen.name)!;
      await page.waitQuiet({ quietMs: 600, maxMs: 30_000 });
      for (let k = 2; k <= (screen.more ?? 0) + 1; k++) {
        await page.page.getByRole('button', { name: 'Weitere laden' }).click();
        await page.page.locator('[data-testid="booking-item"]').nth(k * 50 - 1).waitFor({ timeout: 15_000 });
      }
    }
    const browserQuiet = async () => {
      await sleep(300);
      await Promise.all([...pages.values()].map((page) => page.waitQuiet({ quietMs: QUIET_MS, maxMs: 20_000 })));
    };
    await browserQuiet();
    const isData = (r: { api: boolean; sse: boolean; kind: string }) => r.api && !r.sse;
    for (const [name, page] of pages) {
      spa.cold.set(
        name,
        page.requests
          .filter((r) => isData(r) && r.kind !== 'RT-SUB' && r.kind !== 'REFRESH')
          .map((r) => normalize(r.method, r.url, spa.tokens))
          .sort(),
      );
    }
    const tapPage = pages.get('Buchen P (books)')!;
    await play(
      spa,
      {
        tap: () => tapPage.page.locator('[data-testid="offering-tile"]').first().click(),
        undo: () => tapPage.page.locator('[data-sonner-toast] [data-button]', { hasText: 'Rückgängig' }).click(),
      },
      browserQuiet,
      (from, to) =>
        new Map(
          [...pages].map(([name, page]) => [
            name,
            page
              .requestsBetween(from, to)
              .filter((r) => isData(r) && r.kind !== 'REFRESH')
              .map((r) => ({ method: r.method, url: r.url })),
          ]),
        ),
    );
    for (const [name, page] of pages) spa.sessionChecks.set(name, page.requests.filter((r) => r.kind === 'REFRESH').map((r) => r.start));
    for (const page of pages.values()) await page.close();
    pages.clear();
    await holder.close(true);
    const afterSpa = await bookingCount();
    if (afterSpa !== before) throw new Error(`phase A left ${afterSpa - before} bookings behind`);
    created.length = 0;

    // ------------------------------------------------------------------ phase B: the device model
    log('Phase B: the device model …');
    const model: Phase = { steps: new Map(), cold: new Map(), sessionChecks: new Map(), tokens: new Map(), created: 0 };
    const requests: Array<DeviceRequest & { screen: string }> = [];
    const samples = new SampleLog();
    screens.forEach((screen, index) => {
      const login = logins[screen.username]!;
      const spec: DeviceSpec = { ...screen.spec, id: screen.name, token: login.token, userId: String(login.record.id), admin: login.record.role === 'admin' };
      devices.set(
        screen.name,
        new Device(spec, { url, timeZone: TIME_ZONE, samples, index, onRequest: (request) => requests.push({ ...request, screen: screen.name }) }),
      );
    });
    for (const device of devices.values()) await device.open();
    const modelQuiet = async () => {
      await sleep(300);
      for (;;) {
        await Promise.all([...devices.values()].map((device) => device.settled()));
        const last = requests.at(-1)?.at ?? 0;
        const now = performance.timeOrigin + performance.now();
        if (now - last >= QUIET_MS) return;
        await sleep(QUIET_MS - (now - last));
      }
    };
    await modelQuiet();
    for (const screen of screens) {
      model.cold.set(
        screen.name,
        requests
          .filter((r) => r.screen === screen.name && r.type !== 'refresh')
          .map((r) => normalize(r.method, r.path, model.tokens))
          .sort(),
      );
    }
    const tapDevice = devices.get('Buchen P (books)')!;
    let ownId: string | undefined;
    await play(
      model,
      {
        tap: async () => {
          const record = await tapDevice.book(P, offering, performance.timeOrigin + performance.now());
          ownId = record.id;
        },
        undo: async () => void (await tapDevice.undo(ownId as string, performance.timeOrigin + performance.now())),
      },
      modelQuiet,
      (from, to) =>
        new Map(
          screens.map((screen) => [
            screen.name,
            requests
              .filter((r) => r.screen === screen.name && r.type !== 'refresh' && r.at >= from && r.at < to)
              .map((r) => ({ method: r.method, url: r.path })),
          ]),
        ),
    );
    for (const screen of screens) {
      model.sessionChecks.set(screen.name, requests.filter((r) => r.screen === screen.name && r.type === 'refresh').map((r) => r.at));
    }
    for (const device of devices.values()) device.close();
    devices.clear();
    const afterModel = await bookingCount();
    if (afterModel !== before) throw new Error(`phase B left ${afterModel - before} bookings behind`);
    await admin.delete(paths.person(E));

    // ------------------------------------------------------------------ comparison
    const report = (
      label: string,
      perScreenA: ReadonlyMap<string, Normalized[]>,
      perScreenB: ReadonlyMap<string, Normalized[]>,
      { distinctOnly = false } = {},
    ) => {
      log(`\n${label}`);
      for (const screen of screens) {
        let a = perScreenA.get(screen.name) ?? [];
        let b = perScreenB.get(screen.name) ?? [];
        let repeats = '';
        if (distinctOnly) {
          const da = distinct(a);
          const db = distinct(b);
          a = da.unique;
          b = db.unique;
          if (da.repeats.length + db.repeats.length > 0) {
            const short = (items: string[]) => (items.length ? items.map((item) => item.split('?')[0]).join(', ') : 'none');
            repeats = `\n          repeated (first connect): SPA ${short(da.repeats)} · model ${short(db.repeats)}`;
          }
        }
        const { onlyA, onlyB } = multisetDiff(a, b);
        const same = onlyA.length === 0 && onlyB.length === 0;
        if (!same) differences++;
        log(`  ${same ? 'same' : 'DIFF'}  ${screen.name.padEnd(30)} SPA ${String(a.length).padStart(2)} · model ${String(b.length).padStart(2)}${repeats}`);
        for (const item of onlyA) log(`          only SPA:   ${item}`);
        for (const item of onlyB) log(`          only model: ${item}`);
        if (values.verbose && same) for (const item of a) log(`          ${item}`);
      }
    };
    report('Cold load – distinct requests (without the realtime subscription and the session checks)', spa.cold, model.cold, {
      distinctOnly: true,
    });
    for (const step of steps) report(`Step: ${step.label}`, spa.steps.get(step.label) ?? new Map(), model.steps.get(step.label) ?? new Map());
    log(`\nSession checks (auth-refresh at the start, then every ${SESSION_CHECK_MS / 1000} s ± ${SESSION_TOLERANCE_MS / 1000} s)`);
    for (const screen of screens) {
      const a = describeChecks(spa.sessionChecks.get(screen.name) ?? []);
      const b = describeChecks(model.sessionChecks.get(screen.name) ?? []);
      const same = a.ok && b.ok;
      if (!same) differences++;
      log(`  ${same ? 'same' : 'DIFF'}  ${screen.name.padEnd(30)} SPA ${a.text} · model ${b.text}`);
    }
    log(`\n${differences === 0 ? 'No difference' : `${differences} difference(s)`} between the SPA and the device model.`);
  } catch (error) {
    if (!received()) {
      process.stderr.write(`model check failed: ${(error as Error).stack ?? String(error)}\n`);
      return error instanceof UsageError ? 2 : 1;
    }
  } finally {
    for (const page of pages.values()) await page.close().catch(() => undefined);
    await holder.close(true).catch(() => undefined);
    for (const device of devices.values()) device.close();
    for (const c of clients) c.close();
    await instance?.stop();
    if (snapshot) await removeOwnedDir(snapshot.root).catch((error: unknown) => log(`could not remove ${snapshot?.root}: ${(error as Error).message}`));
  }
  const signal = received();
  if (signal) return signalExitCode(signal);
  return differences === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${(error as Error)?.stack ?? String(error)}\n`);
    process.exit(1);
  },
);
