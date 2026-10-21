/**
 * A2 – bar rush (realistic) and A2b – the same rush with heavy screens open.
 *
 * A2: 5 phones on Buchen (user1 … user5, each with a person selected) and
 * one laptop on Buchungen "Alle" (1 page loaded). Bookings arrive open-loop
 * at 2 per second in total (exactly 2/s per window, Poisson spacing),
 * round-robin over the phones – each phone books its own selected person –,
 * offerings weighted like the dataset; about 10 % are undone ("Rückgängig")
 * 1–3 s later. Every device runs the SPA's realtime logic (device.ts): a
 * tap costs the booking phone POST + its person's summary, the other phones
 * nothing (another person), the laptop its summary + one head request.
 *
 * A2b: A2 plus 2 phones on Personen (each booking → the booked person's row,
 * ≈ 0.4 KB) and the laptop with 10 pages loaded ("Weitere laden" ×9 – still
 * one head request per booking). Before the fixes every booking made these
 * screens reload the complete totals (≈ 250 KB) and all 10 list pages –
 * 757 KiB per booking on the laptop (docs/LOADTEST-FINDINGS.md F2).
 *
 * Measured: create/delete latency from the scheduled time, propagation to the
 * devices whose screen shows the booking, requests and bytes per type and
 * device, errors, PocketBase CPU/RSS, the load generator's health.
 */
import { deriveRandom } from '../../random.ts';
import { analyzeFleet, describeLatency, typeTable, type FleetAnalysis } from '../analysis.ts';
import { MUTATION_UNDER_LOAD, NO_ERRORS, PROPAGATION } from '../budgets.ts';
import type { DeviceSpec } from '../device.ts';
import { runFleet, type FleetBooking, type FleetPlan } from '../fleet.ts';
import { poissonArrivalsExact } from '../load.ts';
import { formatErrorGroups } from '../samples.ts';
import { fmt, runScenario, type PerfContext, type ScenarioRecorder } from '../scenario.ts';
import type { Budget, ScenarioResult } from '../types.ts';

/** Numbers of the persons the phones have selected (spread over the list). */
const PHONE_PERSONS = [17, 342, 777, 1234, 1999];

export interface RushOptions {
  /** Phones on Buchen (users round-robin). */
  phones: number;
  /** Laptops on Buchungen "Alle". */
  laptops: number;
  /** Loaded list pages of the laptops. */
  laptopPages: number;
  /** Phones on Personen. */
  personenPhones: number;
  /** Bookings per second in total. */
  rate: number;
  undoShare: number;
  warmupMs: number;
  measureMs: number;
  seed: string;
}

/** The fleet plan of a rush: devices + an open-loop booking schedule. */
export function rushPlan(ctx: PerfContext, options: RushOptions): FleetPlan {
  const { catalog } = ctx;
  const users = ['user1', 'user2', 'user3', 'user4', 'user5'].map((name) => ctx.logins[name]!);
  const admin = ctx.logins.admin!;
  const person = (i: number) => {
    const wanted = PHONE_PERSONS[i % PHONE_PERSONS.length]! + Math.floor(i / PHONE_PERSONS.length) * 13;
    return catalog.persons[(wanted - 1) % catalog.persons.length]!;
  };
  const devices: DeviceSpec[] = [];
  for (let i = 0; i < options.phones; i++) {
    const login = users[i % users.length]!;
    devices.push({ id: `phone-${i + 1}`, screen: 'buchen', token: login.token, userId: String(login.record.id), admin: false, personId: person(i).id });
  }
  for (let i = 0; i < options.laptops; i++) {
    devices.push({
      id: `laptop-${i + 1}`,
      screen: 'buchungen',
      token: admin.token,
      userId: String(admin.record.id),
      admin: true,
      pages: options.laptopPages,
      query: { period: 'all' },
    });
  }
  for (let i = 0; i < options.personenPhones; i++) {
    const login = users[(i + 2) % users.length]!;
    devices.push({ id: `personen-${i + 1}`, screen: 'personen', token: login.token, userId: String(login.record.id), admin: false });
  }

  const random = deriveRandom(options.seed, 'bookings');
  const phones = devices.filter((d) => d.screen === 'buchen');
  const weights = catalog.offerings.map((o) => o.weight);
  // exactly rate × duration bookings in the warm-up and in the measurement window (Poisson spacing)
  const arrivals = [
    ...poissonArrivalsExact(options.rate, options.warmupMs, random),
    ...poissonArrivalsExact(options.rate, options.measureMs, random).map((at) => at + options.warmupMs),
  ];
  const bookings: FleetBooking[] = arrivals.map((at, n) => {
    const phone = phones[n % phones.length]!;
    const undo = random.chance(options.undoShare);
    return {
      at,
      device: phone.id,
      personId: phone.personId!,
      offeringId: catalog.offerings[random.weightedIndex(weights)]!.id,
      ...(undo ? { undoAfterMs: 1000 + random.int(0, 2000) } : {}),
    };
  });
  return { url: ctx.url, timeZone: catalog.timeZone, devices, bookings, warmupMs: options.warmupMs, measureMs: options.measureMs, drainMs: 1500 };
}

const LAPTOP_BANDWIDTH: Budget = {
  direction: 'max',
  warn: 1024,
  rationale: 'KiB/s one laptop on Buchungen downloads during the rush – > 1 MiB/s (8 Mbit/s) competes with the phones on bar Wi-Fi',
};

const PERSONEN_BANDWIDTH: Budget = {
  direction: 'max',
  warn: 512,
  rationale: 'KiB/s one phone on Personen downloads during the rush – > 512 KiB/s (4 Mbit/s) per idle-looking phone is mobile data and Wi-Fi airtime',
};

const SERVER_CPU: Budget = {
  direction: 'max',
  warn: 100,
  rationale: 'mean PocketBase CPU (% of one core) at a realistic rush; baseline ≈ 20 % – more than a full core leaves little headroom on a small server',
};

/** Metrics shared by A2, A2b and other rush-like scenarios. */
export function reportRush(rec: ScenarioRecorder, a: FleetAnalysis, options: { bandwidth: boolean }): void {
  rec.add({
    key: 'create.p95',
    label: 'booking create – p95 from the scheduled time',
    value: a.creates.count ? a.creates.latency.p95 : null,
    unit: 'ms',
    budget: MUTATION_UNDER_LOAD,
    detail: describeLatency(a.creates.latency),
    explain: (verdict) =>
      verdict === 'warn' || verdict === 'fail' ? `a booking tap waits ${a.creates.latency.p95} ms (p95) for the server during the rush` : undefined,
  });
  rec.add({
    key: 'delete.p95',
    label: 'booking delete (Rückgängig) – p95 from the scheduled time',
    value: a.deletes.count ? a.deletes.latency.p95 : null,
    unit: 'ms',
    budget: a.deletes.count ? MUTATION_UNDER_LOAD : undefined,
    detail: a.deletes.count ? describeLatency(a.deletes.latency) : 'no undo in the window',
  });
  const screens = Object.entries(a.propagation.byScreen)
    .map(([screen, stats]) => `${screen} p95 ${stats?.p95} ms`)
    .join(', ');
  rec.add({
    key: 'propagation.p95',
    label: 'booking → shown on the other devices – p95',
    value: a.propagation.all.count ? a.propagation.all.p95 : null,
    unit: 'ms',
    budget: PROPAGATION,
    detail:
      `${describeLatency(a.propagation.all)}; ${screens || 'no screen showed the bookings'}; missing deliveries ${a.propagation.missing}; ` +
      `${a.propagation.unaffected.toLocaleString('en')} device/booking pairs needed no update (another person's Buchen phone)`,
    explain: (verdict) =>
      verdict === 'warn' || verdict === 'fail'
        ? `another device shows a new booking only after ${a.propagation.all.p95} ms (p95) – staff see different totals for a while`
        : undefined,
  });
  rec.add({
    key: 'errors',
    label: 'failed requests',
    value: a.totalErrors,
    unit: 'count',
    budget: NO_ERRORS,
    detail: formatErrorGroups(a.errors),
  });
  const all = a.types.find((t) => t.type === 'all');
  rec.info('requests.perSecond', 'requests per second (all devices)', all?.perSecond ?? null, 'rps', `${fmt(a.bookingsPerSecond)} bookings/s achieved`);

  const laptop = a.byScreen.buchungen;
  if (laptop) {
    rec.add({
      key: 'laptop.kibps',
      label: 'laptop on Buchungen – download',
      value: laptop.maxKiBps,
      unit: 'KiB/s',
      budget: options.bandwidth ? LAPTOP_BANDWIDTH : undefined,
      detail: `response bodies + realtime stream; ${laptop.devices} laptop(s), mean ${laptop.meanKiBps} KiB/s = ${fmt(laptop.maxKiBps / a.bookingsPerSecond, 0)} KiB per booking`,
      explain: (verdict) =>
        verdict === 'warn'
          ? `the laptop downloads ${fmt(laptop.maxKiBps / 1024, 2)} MiB/s ≈ ${fmt((laptop.maxKiBps * 8) / 1024, 1)} Mbit/s at ${fmt(a.bookingsPerSecond)} ` +
            'bookings/s – a booking should cost it its summary and one head request (≈ 2 KB); check the request table for full refetches'
          : undefined,
    });
  }
  const personen = a.byScreen.personen;
  if (personen) {
    rec.add({
      key: 'personen.kibps',
      label: 'phone on Personen – download',
      value: personen.maxKiBps,
      unit: 'KiB/s',
      budget: options.bandwidth ? PERSONEN_BANDWIDTH : undefined,
      detail: `response bodies + realtime stream; ${personen.devices} phone(s), mean ${personen.meanKiBps} KiB/s = ${fmt(personen.maxKiBps / a.bookingsPerSecond, 0)} KiB per booking`,
      explain: (verdict) =>
        verdict === 'warn'
          ? `a phone that just shows the Personen list downloads ${fmt(personen.maxKiBps)} KiB/s ≈ ${fmt((personen.maxKiBps * 8) / 1024, 1)} Mbit/s at ` +
            `${fmt(a.bookingsPerSecond)} bookings/s – a booking should cost it one row (≈ 0.4 KB); check the request table for full refetches`
          : undefined,
    });
  }
  const phone = a.byScreen.buchen;
  if (phone) rec.info('phone.kibps', 'phone on Buchen – download (mean)', phone.meanKiBps, 'KiB/s', `max ${phone.maxKiBps} KiB/s; response bodies + realtime stream`);
  if (laptop) rec.info('laptop.kibPerBooking', 'laptop on Buchungen – download per booking', Math.round(laptop.maxKiBps / a.bookingsPerSecond), 'KiB');
  if (personen) rec.info('personen.kibPerBooking', 'phone on Personen – download per booking', Math.round(personen.maxKiBps / a.bookingsPerSecond), 'KiB');
  rec.table('Requests in the measurement window', typeTable(a.types));
  rec.table('Traffic per device (response bodies + realtime stream; headers and requests not counted)', {
    columns: ['device', 'screen', 'requests', 'KiB/s'],
    rows: a.traffic.map((t) => [t.id, t.screen, t.requests, t.kibPerSecond]),
  });
  rec.addClientHealth(a.health);
  rec.data.realtime = a.realtime;
  rec.data.propagation = a.propagation;
}

function reportServer(rec: ScenarioRecorder, server: { cpuMeanPct: number; cpuPeakPct: number; rssMaxMiB: number } | null): void {
  if (!server) return;
  rec.add({
    key: 'server.cpu.mean',
    label: 'PocketBase CPU (mean, % of one core)',
    value: server.cpuMeanPct,
    unit: '%',
    budget: SERVER_CPU,
    detail: `peak (1 s) ${server.cpuPeakPct} %`,
    explain: (verdict) => (verdict === 'warn' ? 'the server spends more than a core on a realistic rush – little headroom on a small VPS / Raspberry Pi' : undefined),
  });
  rec.info('server.rss.max', 'PocketBase memory (max RSS)', server.rssMaxMiB, 'MiB');
}

export function scenarioA2(variant: 'A2' | 'A2b') {
  return async (ctx: PerfContext): Promise<ScenarioResult[]> => {
    const heavy = variant === 'A2b';
    const options: RushOptions = {
      phones: 5,
      laptops: 1,
      laptopPages: heavy ? 10 : 1,
      personenPhones: heavy ? 2 : 0,
      rate: 2,
      undoShare: 0.1,
      warmupMs: ctx.quick ? 3_000 : 10_000,
      measureMs: heavy ? (ctx.quick ? 20_000 : 45_000) : ctx.quick ? 25_000 : 60_000,
      seed: `loadtest-${variant}`,
    };
    const result = await runScenario(
      ctx,
      {
        id: variant,
        title: heavy ? 'Bar rush with heavy screens open' : 'Bar rush (realistic)',
        simulates: heavy
          ? '5 phones booking, 2 phones left on the Personen list and the laptop on Buchungen with 10 pages loaded, 2 bookings/s'
          : '5 phones on Buchen booking 2 times per second in total, one laptop on Buchungen ("Alle")',
      },
      async (rec) => {
        const plan = rushPlan(ctx, options);
        let window: ReturnType<ScenarioRecorder['window']> | undefined;
        const raws = await runFleet(plan, { signal: ctx.signal, onReady: () => (window = rec.window()) });
        const stats = window?.stop(raws[0]?.window);
        const analysis = analyzeFleet(raws, plan);
        reportRush(rec, analysis, { bandwidth: true });
        reportServer(rec, stats?.server ?? null);
        rec.data.plan = {
          devices: plan.devices.map((d) => `${d.id} (${d.screen}${d.pages ? `, ${d.pages} pages` : ''})`),
          bookingsPerSecond: options.rate,
          bookings: plan.bookings.length,
          undos: plan.bookings.filter((b) => b.undoAfterMs !== undefined).length,
          warmupMs: options.warmupMs,
          measureMs: options.measureMs,
        };
        const roundsNote = heavy
          ? 'Every booking costs each Personen phone the booked person\'s row (≈ 0.4 KB) and the laptop its summary plus one head request – ' +
            'the 10 loaded pages are not reloaded (before the fixes: the complete totals per Personen phone, all 10 pages + the totals on the laptop).'
          : 'Requests per booking: 2 on the booking phone (create + its person\'s summary; the realtime echo is skipped), none on the other phones ' +
            '(another person), 2 on the laptop (summary + head request); an undo costs DELETE + summary (+ the recent list when it was full), ' +
            'the laptop only its summary. Before the fixes: 5, 2 and k + 1 per booking.';
        rec.note(`${roundsNote} Propagation is measured on the screens that show the booking and is dominated by the SPA's 120 ms realtime debounce.`);
      },
    );
    return [result];
  };
}
