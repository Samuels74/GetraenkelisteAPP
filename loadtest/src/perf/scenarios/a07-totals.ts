/**
 * A7 – the totals endpoint under load: throughput curves.
 *
 * GET /api/app/totals aggregates the filtered bookings in the JS VM
 * (backend/pb_hooks/lib/totals.js) – only the parts a screen asks for
 * (`parts=`): the summary for the Buchungen list and the Buchen card, one
 * person's row for a realtime update on Personen, the per-person rows of all
 * bookings (≈ 250 KB, the expensive part) when Personen or "Pro Person"
 * opens, after a reconnect or when more than 10 persons booked in one
 * realtime batch. Before the fixes every big screen requested all four parts
 * after every booking, so the capacity of that request bounded how many such
 * screens a rush could keep current; it is measured too ("all four parts")
 * for the comparison.
 *
 * Variants as the SPA sends them. Each at 1, 5 and 16 concurrent closed-loop
 * clients for 2 s (quick: per person + person card at 1 and 5), split over
 * worker threads from 4 clients on. Closed loop = throughput curve: latency
 * at a concurrency, not an open-loop SLO.
 */
import { runClosedLoopDistributed } from '../load.ts';
import { totalsParams, paths, type BookingQuery, type TotalsPart } from '../requests.ts';
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
      const summary: TotalsPart[] = ['summary'];
      const allVariants: Array<{ key: string; label: string; query: BookingQuery; parts?: TotalsPart[] }> = [
        { key: 'perPerson', label: 'per person, all bookings (Personen, "Pro Person")', query: { period: 'all' }, parts: ['perPerson'] },
        { key: 'full', label: 'all four parts (before the fixes: every big screen, every booking)', query: { period: 'all' } },
        { key: '30d', label: '30 Tage, summary', query: { period: '30d' }, parts: summary },
        { key: '7d', label: '7 Tage, summary', query: { period: '7d' }, parts: summary },
        { key: 'today', label: 'Heute, summary', query: { period: 'today' }, parts: summary },
        { key: 'mine', label: 'nur meine, summary', query: { period: 'all', createdBy: userId }, parts: summary },
        { key: 'person', label: 'person, summary (Buchen card)', query: { period: 'all', personId: person.id }, parts: summary },
        { key: 'personRow', label: "one person's row (realtime update on Personen)", query: { period: 'all', personId: person.id }, parts: ['perPerson'] },
      ];
      const variants = allVariants.filter((v) => !ctx.quick || v.key === 'perPerson' || v.key === 'person');
      const levels = ctx.quick ? [1, 5] : [1, 5, 16];
      const durationMs = ctx.quick ? 1_500 : 2_000;
      const warmupMs = ctx.quick ? 300 : 500;
      const window = rec.window();
      const rows: Array<Array<string | number>> = [];
      let allAt5: { p95: number; detail: string } | undefined;
      let fullAt5: { p95: number; detail: string } | undefined;
      let saturation = 0;
      try {
        for (const variant of variants) {
          for (const concurrency of levels) {
            ctx.signal.throwIfAborted();
            const path = paths.totals(totalsParams(variant.query, Date.now(), catalog.timeZone, variant.parts));
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
            const at5 = { p95: stats.latency.p95, detail: `p50 ${stats.latency.p50} ms, ${fmt(stats.perSecond)} requests/s, PocketBase CPU ${server?.cpuMeanPct ?? '?'} %` };
            if (variant.key === 'perPerson') {
              saturation = Math.max(saturation, stats.perSecond ?? 0);
              if (concurrency === 5) allAt5 = at5;
            }
            if (variant.key === 'full' && concurrency === 5) fullAt5 = at5;
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
        key: 'perPerson.c5.p95',
        label: 'totals per person (all bookings) with 5 concurrent clients – p95',
        value: allAt5?.p95 ?? null,
        unit: 'ms',
        budget: {
          direction: 'max',
          warn: 100,
          fail: 500,
          rationale:
            '5 big screens loading the per-person totals at once (opening Personen / "Pro Person", a reconnect, a batch of > 10 persons); ' +
            'before the fixes all four parts after every booking, baseline then ≈ 45 ms alone, ≈ 80 ms p95 at 5 clients',
        },
        detail: allAt5?.detail ?? 'not measured',
        explain: (verdict) =>
          verdict === 'warn' || verdict === 'fail'
            ? `with 5 screens loading the per-person totals together each waits ${allAt5?.p95} ms (p95) – the aggregation + JS row copy are CPU-bound`
            : undefined,
      });
      rec.info('perPerson.saturation.rps', 'totals per person – best throughput measured', saturation, 'rps', 'requests per second at the best concurrency level');
      if (fullAt5) {
        rec.info('full.c5.p95', 'totals, all four parts (before the fixes) with 5 concurrent clients – p95', fullAt5.p95, 'ms', fullAt5.detail);
      }
      rec.table('Throughput curve (closed loop)', {
        columns: ['variant', 'clients', 'requests/s', 'p50 ms', 'p95 ms', 'p99 ms', 'KiB per response', 'PocketBase CPU %', 'client CPU % (busiest thread)', 'errors'],
        rows,
      });
      rec.note(
        'The screens ask only for the parts they show (`parts=`): the summaries and single-person rows cost a few ms; the per-person rows of ' +
          'all bookings stay the expensive request (one row per person, CPU-bound in the JS VM), but no screen sends it per booking any more.',
      );
    },
  );
  return [result];
}
