/**
 * A3 – concurrency sweep: the A2 device mix scaled up until something gives.
 *
 * Levels of 5 / 10 / 20 / 40 / 60 / 80 devices (quick: 5 and 20), each a fresh
 * fleet (new realtime connections) for 30 s (quick 10 s) after a warm-up:
 * one laptop on Buchungen ("Alle", 3 pages loaded) per 8 devices, the rest
 * phones on Buchen booking 0.5 times per second each (open loop, Poisson,
 * 10 % undo). The devices are spread over up to 4 worker threads so the load
 * generator does not become the bottleneck.
 *
 * The knee is the first level where propagation p95 exceeds twice its value
 * at the smallest level, where the request throughput stops rising (< 10 %
 * more than the previous level), where requests fail or where deliveries go
 * missing (a refetch that failed or did not finish). It lies between the last
 * good level and that one, and it is this host's knee: PocketBase and the
 * load generator share the machine, a smaller server saturates much earlier
 * (the table shows PocketBase's CPU per level, and the CPU other processes
 * took meanwhile – a busy machine moves the knee down). Closed loops hide
 * queueing, so this sweep stays open loop; its curve is reported per level.
 */
import { analyzeFleet } from '../analysis.ts';
import { runFleet } from '../fleet.ts';
import { judgeClient } from '../health.ts';
import { formatErrorGroups } from '../samples.ts';
import os from 'node:os';
import { BUSY_MACHINE_CORES, fmt, runScenario, type PerfContext } from '../scenario.ts';
import type { ScenarioResult } from '../types.ts';
import { rushPlan } from './a02-rush.ts';

interface Level {
  devices: number;
  phones: number;
  laptops: number;
  bookingsPerSecond: number;
  requestsPerSecond: number;
  createP95: number;
  propagationP95: number;
  phoneP95: number;
  laptopP95: number;
  serverCpu: number | null;
  /** busy cores of other processes during the level (another container, a build …) */
  otherCores: number | null;
  clientCpuMax: number;
  clientBound: boolean;
  errors: number;
  errorDetail: string;
  missing: number;
}

export async function scenarioA3(ctx: PerfContext): Promise<ScenarioResult[]> {
  const result = await runScenario(
    ctx,
    {
      id: 'A3',
      title: 'Concurrency sweep (knee)',
      simulates: 'a growing crowd: 5 → 80 devices on Buchen / Buchungen, every phone booking every 2 s',
    },
    async (rec) => {
      const levels = ctx.quick ? [5, 20] : [5, 10, 20, 40, 60, 80];
      const measureMs = ctx.quick ? 10_000 : 30_000;
      const warmupMs = ctx.quick ? 2_000 : 5_000;
      const window = rec.window();
      const rows: Level[] = [];
      try {
        for (const devices of levels) {
          ctx.signal.throwIfAborted();
          const laptops = Math.max(1, Math.round(devices / 8));
          const phones = devices - laptops;
          const plan = rushPlan(ctx, {
            phones,
            laptops,
            laptopPages: 3,
            personenPhones: 0,
            rate: 0.5 * phones,
            undoShare: 0.1,
            warmupMs,
            measureMs,
            seed: `loadtest-A3-${devices}`,
          });
          ctx.log(`    A3: ${devices} devices (${phones} phones, ${laptops} laptops), ${fmt(0.5 * phones)} bookings/s …`);
          const raws = await runFleet(plan, { workers: Math.min(4, devices), signal: ctx.signal, startDelayMs: 500 });
          const a = analyzeFleet(raws, plan);
          const server = window.server(raws[0]!.window);
          rec.addClientHealth(a.health);
          const health = judgeClient(a.health);
          rows.push({
            devices,
            phones,
            laptops,
            bookingsPerSecond: a.bookingsPerSecond,
            requestsPerSecond: a.types.find((t) => t.type === 'all')?.perSecond ?? 0,
            createP95: a.creates.latency.p95,
            propagationP95: a.propagation.all.p95,
            phoneP95: a.propagation.byScreen.buchen?.p95 ?? NaN,
            laptopP95: a.propagation.byScreen.buchungen?.p95 ?? NaN,
            serverCpu: server?.cpuMeanPct ?? null,
            otherCores: server?.otherBusyCores ?? null,
            clientCpuMax: Math.max(...a.health.map((h) => h.cpuPct)),
            clientBound: health.flagged,
            errors: a.totalErrors,
            errorDetail: formatErrorGroups(a.errors, 3),
            missing: a.propagation.missing,
          });
        }
      } finally {
        window.stop();
      }

      // knee: first level that degrades compared to the smallest one / the previous one
      const base = rows[0];
      let knee: Level | undefined;
      let reason = '';
      for (let i = 1; i < rows.length && base; i++) {
        const row = rows[i]!;
        const prev = rows[i - 1]!;
        if (row.propagationP95 > 2 * base.propagationP95) reason = `propagation p95 ${row.propagationP95} ms > 2 × ${base.propagationP95} ms`;
        else if (row.requestsPerSecond < 1.1 * prev.requestsPerSecond)
          reason = `throughput ${fmt(row.requestsPerSecond)} rps (${fmt(prev.requestsPerSecond)} rps at ${prev.devices} devices)`;
        else if (row.errors > 0) reason = `${row.errors} failed requests`;
        else if (row.missing > 0) reason = `${row.missing} booking deliveries missing (refetch failed or unfinished)`;
        if (reason) {
          knee = row;
          break;
        }
      }
      const maxLevel = levels.at(-1)!;
      const lastGood = knee ? rows[rows.indexOf(knee) - 1] : rows.at(-1);
      const cores = os.availableParallelism();
      // a level measured while other processes took more than a quarter of the CPUs can degrade for that reason alone
      const busyLevels = knee ? rows.filter((r) => r.devices <= knee.devices && r.otherCores !== null && r.otherCores > BUSY_MACHINE_CORES) : [];
      rec.data.knee = {
        found: Boolean(knee),
        firstDegraded: knee?.devices ?? null,
        lastGood: lastGood?.devices ?? null,
        reason: reason || null,
        logicalCpus: cores,
        busyLevels: busyLevels.map((r) => r.devices),
      };
      rec.add({
        key: 'knee.devices',
        label: 'knee – first device count that degrades (this host)',
        value: knee ? knee.devices : maxLevel,
        unit: 'devices',
        // without a knee the value is a lower bound: WARN can only be judged when ≥ 40 devices were tested
        budget:
          knee || maxLevel >= 40
            ? { direction: 'min', warn: 40, fail: 15, rationale: 'a club evening has 5–10 devices; the knee should lie far above (≥ 40 devices)' }
            : { direction: 'min', fail: 15, rationale: 'quick mode: only the FAIL limit (15 devices) can be judged' },
        detail:
          (knee
            ? `knee between ${lastGood?.devices ?? '?'} and ${knee.devices} devices: ${reason}${knee.clientBound ? ' (load generator saturated at that level – see client-bound flag)' : ''}`
            : `no knee up to ${maxLevel} devices`) +
          (busyLevels.length > 0
            ? ` (machine busy: other processes used ${busyLevels.map((r) => `${fmt(r.otherCores, 1)} cores at ${r.devices}`).join(', ')} – on a quiet machine the knee may lie higher)`
            : '') +
          `; on this host (${cores} logical CPUs, shared with the load generator) – PocketBase used ${rows
            .map((r) => `${r.serverCpu === null ? '?' : fmt(r.serverCpu / 100, 1)} cores at ${r.devices}`)
            .join(', ')}`,
        explain: (verdict) =>
          verdict === 'warn' || verdict === 'fail'
            ? `with ${knee?.devices} devices the server can no longer keep every screen current – bookings show up late on the other devices`
            : undefined,
      });
      const upTo40 = rows.filter((r) => r.devices <= 40);
      const errors40 = upTo40.reduce((sum, r) => sum + r.errors, 0);
      rec.add({
        key: 'errors.upTo40',
        label: 'failed requests at ≤ 40 devices',
        value: errors40,
        unit: 'count',
        budget: { direction: 'max', fail: 0, rationale: 'no request may fail at a load the app is meant for' },
        detail: upTo40.filter((r) => r.errors > 0).map((r) => `${r.devices} devices: ${r.errorDetail}`).join(' | ') || 'no errors',
      });
      for (const row of rows) {
        rec.info(`level${row.devices}.propagation.p95`, `${row.devices} devices – propagation p95`, row.propagationP95, 'ms');
        rec.info(`level${row.devices}.rps`, `${row.devices} devices – requests per second`, row.requestsPerSecond, 'rps');
      }
      const top = rows.at(-1);
      if (top?.serverCpu !== null && top?.serverCpu !== undefined) {
        rec.info('server.cpu.top', `PocketBase CPU at ${top.devices} devices (mean)`, top.serverCpu, '%');
      }
      rec.table('Per level (open loop, 0.5 bookings/s per phone)', {
        columns: [
          'devices',
          'phones / laptops',
          'bookings/s',
          'requests/s',
          'create p95 ms',
          'propagation p95 ms',
          'phones p95',
          'laptops p95',
          'PocketBase CPU %',
          'other processes (cores)',
          'client CPU % (busiest thread)',
          'errors',
          'missing deliveries',
        ],
        rows: rows.map((r) => [
          r.devices,
          `${r.phones} / ${r.laptops}`,
          r.bookingsPerSecond,
          r.requestsPerSecond,
          r.createP95,
          r.propagationP95,
          r.phoneP95,
          r.laptopP95,
          r.serverCpu ?? 'n/a',
          r.otherCores ?? 'n/a',
          `${r.clientCpuMax}${r.clientBound ? ' (saturated)' : ''}`,
          r.errors,
          r.missing,
        ]),
      });
      rec.data.levels = rows;
      rec.note(
        'Each phone refetches at most about once per 120 ms debounce + round trip, so the request rate grows with the number of devices, ' +
          'not with the booking rate; laptops reload the complete totals (≈ 250 KB, ≈ 45 ms of server CPU) and their list pages per round.',
      );
    },
  );
  return [result];
}
