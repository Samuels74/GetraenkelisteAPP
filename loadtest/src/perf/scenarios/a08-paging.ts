/**
 * A8 – deep paging on Buchungen and the refetch of all loaded pages.
 *
 * "Weitere laden" loads the next 50 bookings with a keyset cursor: page k+1
 * = the base filter plus "older than the last booking of page k"
 * (frontend/src/api/queries.ts fetchBookingPage, api/keyset.ts keysetFilter
 * with `created <= c` in front), so its cost does not depend on the depth
 * (before the fixes the list used offsets: page k = OFFSET 50·(k−1)). The
 * list is an infinite query: a full refetch – after a reconnect, or when a
 * realtime patch falls back to it – reloads all loaded pages one after the
 * other, each cursor taken from the freshly loaded previous page (realtime
 * bookings themselves now cost one small head request, see A2b).
 *
 * Measured: pages 1…20 of "Alle" ("Weitere laden" ×19, repeated), the very
 * last page of "Alle" and of "nur meine", and the sequential refetch of k =
 * 1 / 5 / 10 / 20 loaded pages – every page parsed for its cursor, as the
 * SPA does.
 */
import { latencyStats } from '../../stats.ts';
import { describeLatency } from '../analysis.ts';
import { LIST_PAGE } from '../budgets.ts';
import { HttpClient, parseJson, type HttpResult } from '../http.ts';
import { bookingsFilter, BOOKINGS_PAGE_SIZE, keysetFilter, paths, queryString, type KeysetCursor } from '../requests.ts';
import { runScenario, type PerfContext } from '../scenario.ts';
import type { ScenarioResult } from '../types.ts';
import { bookingCount } from './common.ts';

/** The cursor a page's last booking gives the next page (null: it was the last page). */
function nextCursor(result: HttpResult): KeysetCursor | null {
  const items = parseJson<{ items: Array<{ id: string; created: string }> }>(result).items;
  const last = items.at(-1);
  return last && items.length >= BOOKINGS_PAGE_SIZE ? { created: last.created, id: last.id } : null;
}

/** Loads `pages` keyset pages of `base` one after the other (the infinite query); ms per page. */
async function walk(client: HttpClient, base: string, pages: number): Promise<number[]> {
  const ms: number[] = [];
  let cursor: KeysetCursor | null = null;
  for (let page = 1; page <= pages; page++) {
    if (page > 1 && cursor === null) break;
    const t0 = performance.now();
    const result = await client.get(paths.bookings(cursor ? keysetFilter(base, cursor) : base), { collect: true });
    if (result.error) throw new Error(`list page ${page}: ${result.error}`);
    cursor = nextCursor(result);
    ms.push(performance.now() - t0);
  }
  return ms;
}

/**
 * The cursor of the last page of a filter (the last booking of the page before
 * it) – looked up once with an offset query that the SPA never sends.
 */
async function lastPageCursor(client: HttpClient, filter: string, total: number): Promise<{ cursor: KeysetCursor | null; page: number }> {
  const page = Math.max(1, Math.ceil(total / BOOKINGS_PAGE_SIZE));
  if (page === 1) return { cursor: null, page };
  const query = queryString({ page: page - 1, perPage: BOOKINGS_PAGE_SIZE, skipTotal: 1, sort: '-created,-id', fields: 'id,created', filter });
  const result = await client.get(`/api/collections/bookings/records?${query}`, { collect: true });
  if (result.error) throw new Error(`looking up the last page: ${result.error}`);
  return { cursor: nextCursor(result), page };
}

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

        // "Weitere laden" ×19: pages 1…20 (keyset), repeated
        const perPage = new Map<number, number[]>();
        for (let r = 0; r < repeats + 1; r++) {
          const ms = await walk(client, allFilter, 20);
          if (r > 0) ms.forEach((value, i) => perPage.set(i + 1, [...(perPage.get(i + 1) ?? []), value]));
        }
        const page20 = latencyStats(perPage.get(20) ?? []);

        // the very last pages: the keyset request "Weitere laden" sends there
        const lastAll = await lastPageCursor(client, allFilter, total);
        const lastMine = await lastPageCursor(client, mineFilter, mine);
        const lastPage = async (filter: string, cursor: KeysetCursor | null) => {
          const ms: number[] = [];
          for (let i = 0; i < (ctx.quick ? 5 : 15); i++) {
            const result = await client.get(paths.bookings(cursor ? keysetFilter(filter, cursor) : filter));
            if (i >= 2) ms.push(result.ms);
          }
          return latencyStats(ms);
        };
        const deepAll = await lastPage(allFilter, lastAll.cursor);
        const deepMine = await lastPage(mineFilter, lastMine.cursor);

        // refetch of k loaded pages (sequential, like the infinite query: each cursor from the fresh previous page)
        const refetch = new Map<number, number[]>();
        for (const k of [1, 5, 10, 20]) {
          const ms: number[] = [];
          for (let i = 0; i < (ctx.quick ? 4 : 12); i++) {
            const t0 = performance.now();
            await walk(client, allFilter, k);
            if (i >= 2) ms.push(performance.now() - t0);
          }
          refetch.set(k, ms);
        }
        window.stop();

        const k10 = latencyStats(refetch.get(10) ?? []);
        rec.add({
          key: 'refetch.k10.p95',
          label: 'refetch of 10 loaded list pages (keyset, one after the other) – p95',
          value: k10.count ? k10.p95 : null,
          unit: 'ms',
          budget: {
            direction: 'max',
            warn: 300,
            fail: 1000,
            rationale:
              'a full refetch of a laptop with 10 pages loaded (after a reconnect or a realtime fallback; before the fixes after every booking); baseline ≈ 30–60 ms',
          },
          detail: describeLatency(k10),
          explain: (verdict) =>
            verdict === 'warn' || verdict === 'fail'
              ? `with 10 pages loaded a full refetch takes ${k10.p95} ms – the list lags behind after a reconnect`
              : undefined,
        });
        rec.add({
          key: 'page.last.p95',
          label: `last page of "Alle" (page ${lastAll.page}, keyset) – p95`,
          value: deepAll.count ? deepAll.p95 : null,
          unit: 'ms',
          budget: LIST_PAGE,
          detail: `${describeLatency(deepAll)}; a keyset page seeks to its cursor – independent of the depth (offset paging before the fixes skipped all newer rows)`,
          explain: (verdict) =>
            verdict === 'warn' || verdict === 'fail' ? `scrolling to the oldest bookings costs ${deepAll.p95} ms per page` : undefined,
        });
        rec.info('page.lastMine.p95', `last page of "nur meine" (page ${lastMine.page}, keyset) – p95`, deepMine.count ? deepMine.p95 : null, 'ms', describeLatency(deepMine));
        rec.info('page20.p95', 'page 20 of "Alle" ("Weitere laden" ×19) – p95', page20.count ? page20.p95 : null, 'ms');
        rec.table('"Weitere laden": time per page (Alle, keyset; incl. parsing the page for the next cursor)', {
          columns: ['page', 'p50 ms', 'p95 ms'],
          rows: [1, 2, 5, 10, 15, 20].map((page) => {
            const s = latencyStats(perPage.get(page) ?? []);
            return [page, s.p50, s.p95];
          }),
        });
        rec.table('Refetch of k loaded pages (sequential keyset pages)', {
          columns: ['k pages', 'p50 ms', 'p95 ms', 'max ms'],
          rows: [...refetch].map(([k, ms]) => {
            const s = latencyStats(ms);
            return [k, s.p50, s.p95, s.max];
          }),
        });
        rec.note(
          'A full refetch of k pages costs k list requests in sequence (≈ 64 KB each). Since the fixes a booking elsewhere costs the list ' +
            'one head request instead (A2b); full refetches remain for reconnects and the fallbacks of the realtime patch.',
        );
      } finally {
        client.close();
      }
    },
  );
  return [result];
}
