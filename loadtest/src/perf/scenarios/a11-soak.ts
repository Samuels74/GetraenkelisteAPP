/**
 * A11 – soak (opt-in, LOADTEST_SOAK=1): one evening in fast motion.
 *
 * A2's devices (5 phones on Buchen, a laptop on Buchungen) for 35 minutes
 * (LOADTEST_SOAK_MINUTES): rush phases at 1 booking/s alternate with quiet
 * phases of more than 5 minutes. PocketBase closes realtime streams that got
 * no message for 5 minutes and every stream after 30 minutes
 * (apis/realtime.go); the SPA then reconnects and refetches every active
 * query – on Buchen the persons list (≈ 421 KB) included. The devices also
 * run the 5-minute session check. Watched: reconnects and the refetch bursts
 * they cause, PocketBase's memory over time, and the growth of auxiliary.db
 * (PocketBase logs every API request there).
 */
import { analyzeFleet, describeLatency } from '../analysis.ts';
import { MUTATION_UNDER_LOAD, NO_ERRORS, PROPAGATION } from '../budgets.ts';
import { runFleet, type FleetBooking } from '../fleet.ts';
import { poissonArrivalsExact } from '../load.ts';
import { formatErrorGroups, summarize } from '../samples.ts';
import { fmt, runScenario, type PerfContext } from '../scenario.ts';
import type { ScenarioResult } from '../types.ts';
import { rushPlan } from './a02-rush.ts';
import { deriveRandom } from '../../random.ts';

const MINUTE = 60_000;

/** [start, end) of the rush phases in ms, for a soak of `totalMs`. */
export function soakPhases(totalMs: number): Array<[number, number]> {
  if (totalMs >= 30 * MINUTE) {
    // rush 23 % · quiet 19 % · rush 23 % · quiet 19 % · rush 16 % (35 min: quiet phases of 6.7 min)
    const at = (share: number) => Math.round(totalMs * share);
    return [
      [0, at(0.23)],
      [at(0.42), at(0.65)],
      [at(0.84), totalMs],
    ];
  }
  // short validation runs: one long quiet phase in the middle
  return [
    [0, Math.round(totalMs * 0.15)],
    [Math.round(totalMs * 0.85), totalMs],
  ];
}

export async function scenarioA11(ctx: PerfContext): Promise<ScenarioResult[]> {
  const minutes = Math.max(1, Number(process.env.LOADTEST_SOAK_MINUTES) || 35);
  const totalMs = minutes * MINUTE;
  const result = await runScenario(
    ctx,
    {
      id: 'A11',
      title: `Soak (${minutes} min)`,
      simulates: 'an evening: rush phases at 1 booking/s and quiet phases with nothing to do, on the same open devices',
    },
    async (rec) => {
      const base = rushPlan(ctx, {
        phones: 5,
        laptops: 1,
        laptopPages: 1,
        personenPhones: 0,
        rate: 0,
        undoShare: 0,
        warmupMs: 0,
        measureMs: totalMs,
        seed: 'loadtest-A11',
      });
      const random = deriveRandom('loadtest-A11', 'bookings');
      const phones = base.devices.filter((d) => d.screen === 'buchen');
      const weights = ctx.catalog.offerings.map((o) => o.weight);
      const bookings: FleetBooking[] = [];
      for (const [from, to] of soakPhases(totalMs)) {
        for (const offset of poissonArrivalsExact(1, to - from, random)) {
          const phone = phones[bookings.length % phones.length]!;
          bookings.push({
            at: from + offset,
            device: phone.id,
            personId: phone.personId!,
            offeringId: ctx.catalog.offerings[random.weightedIndex(weights)]!.id,
            ...(random.chance(0.1) ? { undoAfterMs: 1000 + random.int(0, 2000) } : {}),
          });
        }
      }
      const plan = { ...base, bookings, devices: base.devices.map((d) => ({ ...d, sessionRefresh: true })) };
      const before = rec.dbSizes();
      let window: ReturnType<typeof rec.window> | undefined;
      ctx.log(`    A11: soak for ${minutes} min (${bookings.length} bookings in ${soakPhases(totalMs).length} rush phases) …`);
      const raws = await runFleet(plan, { signal: ctx.signal, onReady: () => (window = rec.window()) });
      const stats = window?.stop(raws[0]?.window);
      const after = rec.dbSizes();
      const a = analyzeFleet(raws, plan);
      rec.addClientHealth(a.health);
      const hours = totalMs / (60 * MINUTE);
      const auxGrowth = after.auxiliary + after.auxiliaryWal - (before.auxiliary + before.auxiliaryWal);
      const rssGrowth = stats?.server ? stats.server.rssEndMiB - stats.server.rssStartMiB : null;

      rec.add({
        key: 'create.p95',
        label: 'booking create – p95 from the scheduled time',
        value: a.creates.count ? a.creates.latency.p95 : null,
        unit: 'ms',
        budget: MUTATION_UNDER_LOAD,
        detail: describeLatency(a.creates.latency),
      });
      rec.add({
        key: 'propagation.p95',
        label: 'booking → refetched on the other devices – p95',
        value: a.propagation.all.count ? a.propagation.all.p95 : null,
        unit: 'ms',
        budget: PROPAGATION,
        detail: `${describeLatency(a.propagation.all)}; missing deliveries ${a.propagation.missing}`,
      });
      rec.add({ key: 'errors', label: 'failed requests', value: a.totalErrors, unit: 'count', budget: NO_ERRORS, detail: formatErrorGroups(a.errors) });
      rec.info(
        'realtime.reconnects',
        'realtime reconnects (server closed idle / old streams)',
        a.realtime.reconnects,
        'count',
        `${a.realtime.serverCloses} streams closed by the server, ${a.realtime.connects} subscriptions in total for ${plan.devices.length} devices`,
      );
      // persons / groups / offerings are only fetched on (re)connect – after the initial screen load (before the start) only by reconnects
      const reconnectTypes = summarize(
        raws.map((r) => r.samples),
        { from: raws[0]!.window.from },
      ).filter((t) => t.type === 'persons' || t.type === 'groups' || t.type === 'offerings');
      const burstBytes = reconnectTypes.reduce((sum, t) => sum + t.bytes, 0);
      rec.info(
        'reconnect.refetch.kib',
        'download caused by reconnect refetches (persons, groups, offerings)',
        Math.round(burstBytes / 1024),
        'KiB',
        `${a.realtime.reconnectRefetches} full refetches; ${reconnectTypes.map((t) => `${t.type} ×${t.count}`).join(', ')}`,
      );
      rec.add({
        key: 'server.rss.growth',
        label: 'PocketBase memory growth over the soak (RSS end − start)',
        value: rssGrowth === null ? null : Math.round(rssGrowth * 10) / 10,
        unit: 'MiB',
        budget: { direction: 'max', warn: 100, rationale: 'steady load must not grow memory without bound (leaks, caches)' },
        detail: stats?.server ? `start ${stats.server.rssStartMiB} MiB, end ${stats.server.rssEndMiB} MiB, max ${stats.server.rssMaxMiB} MiB` : 'not sampled',
      });
      rec.add({
        key: 'aux.growth.perHour',
        label: 'auxiliary.db growth (request log) per hour',
        value: Math.round((auxGrowth / hours) * 10) / 10,
        unit: 'MiB',
        budget: { direction: 'max', warn: 50, rationale: 'PocketBase logs every API request (≈ 0.6 KB each); the log is pruned after the retention period' },
        detail: `${fmt(before.auxiliary + before.auxiliaryWal, 2)} → ${fmt(after.auxiliary + after.auxiliaryWal, 2)} MiB in ${minutes} min`,
        explain: (verdict) => (verdict === 'warn' ? 'the request log grows quickly – check the log retention (Settings → Logs) for long events' : undefined),
      });
      rec.data.phases = soakPhases(totalMs);
      rec.data.realtime = a.realtime;
      rec.note(
        'After a quiet phase of more than 5 minutes PocketBase closes every realtime stream; each device reconnects and refetches all its ' +
          'active queries (Buchen: persons list, groups, offerings, totals, recent bookings) – a burst at the moment the next rush begins.',
      );
    },
  );
  return [result];
}
