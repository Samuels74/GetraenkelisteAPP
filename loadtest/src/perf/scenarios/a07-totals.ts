/**
 * A7 – the totals endpoint under load: throughput curves.
 *
 * GET /api/app/totals runs 4 aggregate queries in the JS VM and copies the
 * rows into JS objects (backend/pb_hooks/lib/totals.js); for all bookings
 * the answer has 2000 per-person rows (≈ 250 KB) and costs ≈ 45 ms of CPU.
 * Personen, Buchungen and the admin screens refetch it after every booking,
 * so its capacity bounds how many such screens a rush can keep current.
 *
 * Variants as the SPA sends them: all (reference), 30 Tage, 7 Tage, Heute,
 * nur meine, person (the Buchen card). Each at 1, 5 and 16 concurrent
 * closed-loop clients for 2 s (quick: all + person at 1 and 5), split over worker
 * threads from 4 clients on. Closed loop = throughput curve: latency at a
 * concurrency, not an open-loop SLO.
 */
import { runClosedLoopDistributed } from '../load.ts';
import { totalsParams, paths, type BookingQuery } from '../requests.ts';
import { summarize } from '../samples.ts';
import { fmt, runScenario, type PerfContext } from '../scenario.ts';
import type { ScenarioResult } from '../types.ts';
import { judgeClient } from '../health.ts';

export async function scenarioA7(ctx: PerfContext): Promise<ScenarioResult[]> {
  const result = await runScenario(
    ctx,
    {
      id: 'A7',
      title: 'Totals variants under load',
      simulates: 'several big screens (Personen, Buchungen, admin) refetching the totals at the same time',
    },
    async (rec) => {
      const { catalog } = ctx;
      const user1 = ctx.logins.user1!;
      const userId = String(user1.record.id);
      const person = catalog.persons[Math.floor(catalog.persons.length / 2)]!;
      const allVariants: Array<{ key: string; label: string; query: BookingQuery }> = [
        { key: 'all', label: 'all (reference)', query: { period: 'all' } },
        { key: '30d', label: '30 Tage', query: { period: '30d' } },
        { key: '7d', label: '7 Tage', query: { period: '7d' } },
        { key: 'today', label: 'Heute', query: { period: 'today' } },
        { key: 'mine', label: 'nur meine', query: { period: 'all', createdBy: userId } },
        { key: 'person', label: 'person (Buchen card)', query: { period: 'all', personId: person.id } },
      ];
      const variants = allVariants.filter((v) => !ctx.quick || v.key === 'all' || v.key === 'person');
      const levels = ctx.quick ? [1, 5] : [1, 5, 16];
      const durationMs = ctx.quick ? 1_500 : 2_000;
      const warmupMs = ctx.quick ? 300 : 500;
      const window = rec.window();
      const rows: Array<Array<string | number>> = [];
      let allAt5: { p95: number; detail: string } | undefined;
      let saturation = 0;
      try {
        for (const variant of variants) {
          for (const concurrency of levels) {
            ctx.signal.throwIfAborted();
            const path = paths.totals(totalsParams(variant.query, Date.now(), catalog.timeZone));
            const raws = await runClosedLoopDistributed(
              {
                url: ctx.url,
                tokens: [user1.token],
                requests: [{ type: 'totals', method: 'GET', path }],
                concurrency,
                warmupMs,
                durationMs,
              },
              concurrency >= 4 ? 4 : 1,
              ctx.signal,
            );
            const range = raws[0]!.window;
            const stats = summarize(
              raws.map((raw) => raw.samples),
              range,
              range.to - range.from,
            ).find((t) => t.type === 'totals');
            const server = window.server(range);
            rec.addClientHealth(raws.map((raw) => raw.health));
            const client = judgeClient(raws.map((raw) => raw.health));
            const clientCpu = Math.max(...raws.map((raw) => raw.health.cpuPct));
            if (!stats) continue;
            rows.push([
              variant.label,
              concurrency,
              stats.perSecond ?? 0,
              stats.latency.p50,
              stats.latency.p95,
              stats.latency.p99,
              Math.round((stats.bytesMean / 1024) * 10) / 10,
              server?.cpuMeanPct ?? 'n/a',
              `${clientCpu}${client.flagged ? ' (saturated)' : ''}`,
              stats.errors,
            ]);
            if (variant.key === 'all') {
              saturation = Math.max(saturation, stats.perSecond ?? 0);
              if (concurrency === 5) {
                allAt5 = { p95: stats.latency.p95, detail: `p50 ${stats.latency.p50} ms, ${fmt(stats.perSecond)} requests/s, PocketBase CPU ${server?.cpuMeanPct ?? '?'} %` };
              }
            }
            if (stats.errors > 0) {
              rec.add({
                key: `${variant.key}.c${concurrency}.errors`,
                label: `totals ${variant.label} at ${concurrency} clients – errors`,
                value: stats.errors,
                unit: 'count',
                budget: { direction: 'max', fail: 0, rationale: 'the endpoint must not fail under load' },
              });
            }
          }
        }
      } finally {
        window.stop();
      }
      rec.add({
        key: 'all.c5.p95',
        label: 'totals (all) with 5 concurrent clients – p95',
        value: allAt5?.p95 ?? null,
        unit: 'ms',
        budget: { direction: 'max', warn: 100, fail: 500, rationale: '5 big screens refetching at once; baseline ≈ 45 ms alone, ≈ 64 ms p95 at 4 clients' },
        detail: allAt5?.detail ?? 'not measured',
        explain: (verdict) =>
          verdict === 'warn' || verdict === 'fail'
            ? `with 5 screens refetching the totals together each waits ${allAt5?.p95} ms (p95) – the 4 aggregate queries + JS row copy are CPU-bound`
            : undefined,
      });
      rec.info('all.saturation.rps', 'totals (all) – best throughput measured', saturation, 'rps', 'requests per second at the best concurrency level');
      rec.table('Throughput curve (closed loop)', {
        columns: ['variant', 'clients', 'requests/s', 'p50 ms', 'p95 ms', 'p99 ms', 'KiB per response', 'PocketBase CPU %', 'client CPU % (busiest thread)', 'errors'],
        rows,
      });
      rec.note(
        `Every totals request runs all 4 aggregates (total, per person, per offering, per user) even when the screen needs one of them – ` +
          `the Buchen card only shows count and sum (backend/pb_hooks/lib/totals.js:142-212).`,
      );
    },
  );
  return [result];
}
