/**
 * A8 – deep paging on Buchungen and the refetch of all loaded pages.
 *
 * "Weitere laden" loads the next 50 bookings with offset paging (page k =
 * OFFSET 50·(k−1), PocketBase tools/search/provider.go): the deeper the page,
 * the more rows SQLite skips. And because the list is an infinite query,
 * every realtime refetch reloads all loaded pages one after the other
 * (TanStack's infiniteQueryBehavior) – with 10 pages loaded every booking
 * anywhere costs the laptop 10 sequential list requests.
 *
 * Measured: pages 1…20 of "Alle" ("Weitere laden" ×19, repeated), the very
 * last page of "Alle" and of "nur meine", and the sequential refetch of k =
 * 1 / 5 / 10 / 20 loaded pages.
 */
import { latencyStats } from '../../stats.ts';
import { describeLatency } from '../analysis.ts';
import { LIST_PAGE } from '../budgets.ts';
import { HttpClient } from '../http.ts';
import { bookingsFilter, BOOKINGS_PAGE_SIZE, paths } from '../requests.ts';
import { runScenario, type PerfContext } from '../scenario.ts';
import type { ScenarioResult } from '../types.ts';
import { bookingCount } from './common.ts';

export async function scenarioA8(ctx: PerfContext): Promise<ScenarioResult[]> {
  const result = await runScenario(
    ctx,
    {
      id: 'A8',
      title: 'Deep paging and refetch of all loaded pages',
      simulates: 'someone scrolls far back on Buchungen ("Weitere laden" many times) while bookings keep arriving',
    },
    async (rec) => {
      const user1 = ctx.logins.user1!;
      const userId = String(user1.record.id);
      const client = new HttpClient(ctx.url, { token: user1.token });
      try {
        const tz = ctx.catalog.timeZone;
        const allFilter = bookingsFilter({ period: 'all' }, Date.now(), tz);
        const mineFilter = bookingsFilter({ period: 'all', createdBy: userId }, Date.now(), tz);
        const total = await bookingCount(ctx);
        const mine = await bookingCount(ctx, `createdBy = '${userId}'`);
        const repeats = ctx.quick ? 2 : 5;
        const window = rec.window();

        // "Weitere laden" ×19: pages 1…20, repeated
        const perPage = new Map<number, number[]>();
        for (let r = 0; r < repeats + 1; r++) {
          for (let page = 1; page <= 20; page++) {
            const result = await client.get(paths.bookings(allFilter, page));
            if (r > 0) perPage.set(page, [...(perPage.get(page) ?? []), result.ms]);
          }
        }
        const page20 = latencyStats(perPage.get(20) ?? []);

        // the very last pages
        const lastAll = Math.max(1, Math.ceil(total / BOOKINGS_PAGE_SIZE));
        const lastMine = Math.max(1, Math.ceil(mine / BOOKINGS_PAGE_SIZE));
        const lastPage = async (filter: string, page: number) => {
          const ms: number[] = [];
          for (let i = 0; i < (ctx.quick ? 5 : 15); i++) {
            const result = await client.get(paths.bookings(filter, page));
            if (i >= 2) ms.push(result.ms);
          }
          return latencyStats(ms);
        };
        const deepAll = await lastPage(allFilter, lastAll);
        const deepMine = await lastPage(mineFilter, lastMine);

        // refetch of k loaded pages (sequential, like the infinite query)
        const refetch = new Map<number, number[]>();
        for (const k of [1, 5, 10, 20]) {
          const ms: number[] = [];
          for (let i = 0; i < (ctx.quick ? 4 : 12); i++) {
            const t0 = performance.now();
            for (let page = 1; page <= k; page++) await client.get(paths.bookings(allFilter, page));
            if (i >= 2) ms.push(performance.now() - t0);
          }
          refetch.set(k, ms);
        }
        window.stop();

        const k10 = latencyStats(refetch.get(10) ?? []);
        rec.add({
          key: 'refetch.k10.p95',
          label: 'refetch of 10 loaded list pages (one realtime round) – p95',
          value: k10.count ? k10.p95 : null,
          unit: 'ms',
          budget: { direction: 'max', warn: 300, fail: 1000, rationale: 'one refetch round of a laptop with 10 pages loaded; baseline ≈ 40–60 ms – it repeats after every booking' },
          detail: describeLatency(k10),
          explain: (verdict) =>
            verdict === 'warn' || verdict === 'fail'
              ? `with 10 pages loaded the laptop needs ${k10.p95} ms per realtime round – the list lags behind during a rush`
              : undefined,
        });
        rec.add({
          key: 'page.last.p95',
          label: `last page of "Alle" (page ${lastAll}, offset ${((lastAll - 1) * BOOKINGS_PAGE_SIZE).toLocaleString('en')}) – p95`,
          value: deepAll.count ? deepAll.p95 : null,
          unit: 'ms',
          budget: LIST_PAGE,
          detail: `${describeLatency(deepAll)}; offset paging skips all newer rows (O(offset))`,
          explain: (verdict) =>
            verdict === 'warn' || verdict === 'fail' ? `scrolling to the oldest bookings costs ${deepAll.p95} ms per page and grows with the history` : undefined,
        });
        rec.info('page.lastMine.p95', `last page of "nur meine" (page ${lastMine}) – p95`, deepMine.count ? deepMine.p95 : null, 'ms', describeLatency(deepMine));
        rec.info('page20.p95', 'page 20 of "Alle" ("Weitere laden" ×19) – p95', page20.count ? page20.p95 : null, 'ms');
        rec.table('"Weitere laden": time per page (Alle)', {
          columns: ['page', 'offset', 'p50 ms', 'p95 ms'],
          rows: [1, 2, 5, 10, 15, 20].map((page) => {
            const s = latencyStats(perPage.get(page) ?? []);
            return [page, (page - 1) * BOOKINGS_PAGE_SIZE, s.p50, s.p95];
          }),
        });
        rec.table('Refetch of k loaded pages (sequential, one realtime round)', {
          columns: ['k pages', 'p50 ms', 'p95 ms', 'max ms'],
          rows: [...refetch].map(([k, ms]) => {
            const s = latencyStats(ms);
            return [k, s.p50, s.p95, s.max];
          }),
        });
        rec.note(
          `A refetch round of k pages costs about k list requests in sequence: during a rush a laptop with many pages loaded multiplies ` +
            `its requests and its download (≈ 64 KB per page) by k (see A2b).`,
        );
      } finally {
        client.close();
      }
    },
  );
  return [result];
}
