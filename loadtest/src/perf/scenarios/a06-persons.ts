/**
 * A6 – burst of full persons-list loads.
 *
 * The SPA loads all persons with getFullList (3 sequential pages of 1000 for
 * 2000 persons, ≈ 421 KB) on every app start, when the person picker opens
 * on stale data (> 30 s), after every persons change and after every
 * realtime reconnect. When the server restarts or the Wi-Fi drops, all
 * devices reconnect at once and load it together. Measured: 5 and 20
 * simultaneous loads (repeated bursts), time per complete list.
 */
import { latencyStats } from '../../stats.ts';
import { describeLatency } from '../analysis.ts';
import { PERSONS_SEQUENCE } from '../budgets.ts';
import { HttpClient, parseJson } from '../http.ts';
import { FULL_LIST_BATCH, paths } from '../requests.ts';
import { fmt, runScenario, sleep, type PerfContext } from '../scenario.ts';
import type { ScenarioResult } from '../types.ts';

/** getFullList({ batch: 1000 }) of the persons: total ms, bytes, error. */
async function loadPersons(client: HttpClient): Promise<{ ms: number; bytes: number; error?: string }> {
  const t0 = performance.now();
  let bytes = 0;
  for (let page = 1; ; page++) {
    const result = await client.get(paths.personsPage(page), { collect: true });
    bytes += result.bytes;
    if (result.error) return { ms: performance.now() - t0, bytes, error: result.error };
    if (parseJson<{ items: unknown[] }>(result).items.length < FULL_LIST_BATCH) return { ms: performance.now() - t0, bytes };
  }
}

export async function scenarioA6(ctx: PerfContext): Promise<ScenarioResult[]> {
  const result = await runScenario(
    ctx,
    {
      id: 'A6',
      title: 'Persons list burst',
      simulates: 'all devices load the complete persons list at the same moment (reconnect storm, picker opened everywhere)',
    },
    async (rec) => {
      const users = ['user1', 'user2', 'user3', 'user4', 'user5', 'admin'].map((name) => ctx.logins[name]!);
      const levels: Array<{ devices: number; bursts: number }> = ctx.quick
        ? [
            { devices: 5, bursts: 3 },
            { devices: 20, bursts: 2 },
          ]
        : [
            { devices: 5, bursts: 10 },
            { devices: 20, bursts: 5 },
          ];
      const rows: Array<Array<string | number>> = [];
      for (const level of levels) {
        const clients = Array.from({ length: level.devices }, (_, i) => new HttpClient(ctx.url, { token: users[i % users.length]!.token }));
        try {
          await Promise.all(clients.map((client) => loadPersons(client))); // warm-up (connections, caches)
          const window = rec.window();
          const samples: Array<{ ms: number; bytes: number; error?: string }> = [];
          for (let burst = 0; burst < level.bursts; burst++) {
            samples.push(...(await Promise.all(clients.map((client) => loadPersons(client)))));
            await sleep(200, ctx.signal);
          }
          const stats = window.stop();
          const lat = latencyStats(samples.map((s) => s.ms));
          const errors = samples.filter((s) => s.error);
          const kib = samples.length ? samples.reduce((sum, s) => sum + s.bytes, 0) / samples.length / 1024 : 0;
          rec.add({
            key: `burst${level.devices}.p95`,
            label: `${level.devices} devices load the persons list at once – time to the complete list (p95)`,
            value: lat.count ? lat.p95 : null,
            unit: 'ms',
            budget: PERSONS_SEQUENCE,
            detail: `${describeLatency(lat)}; ${fmt(kib)} KiB per device${errors.length ? `; ${errors.length} errors: ${errors[0]!.error}` : ''}`,
            explain: (verdict) =>
              verdict === 'warn' || verdict === 'fail'
                ? `when ${level.devices} devices reconnect together, each waits ${lat.p95} ms (p95) for the person list (3 × ≈ 210 KB)`
                : undefined,
          });
          if (errors.length > 0) {
            rec.add({
              key: `burst${level.devices}.errors`,
              label: `${level.devices} devices – failed loads`,
              value: errors.length,
              unit: 'count',
              budget: { direction: 'max', fail: 0, rationale: 'a failed load leaves the picker empty' },
              detail: errors[0]!.error,
            });
          }
          rows.push([level.devices, level.bursts, lat.count, lat.p50, lat.p95, lat.max, Math.round(kib), stats.server?.cpuPeakPct ?? 'n/a']);
        } finally {
          for (const client of clients) client.close();
        }
      }
      rec.table('Complete persons list (3 sequential requests per device)', {
        columns: ['devices at once', 'bursts', 'loads', 'p50 ms', 'p95 ms', 'max ms', 'KiB per load', 'PocketBase CPU peak %'],
        rows,
      });
      rec.note('Each load is 3 requests in sequence (1000 + 1000 + 0 persons): the SDK asks for the next page until one is not full.');
    },
  );
  return [result];
}
