/**
 * A5 – CSV export of all bookings, as the accountant does it on Buchungen.
 *
 * The SPA's algorithm (api/keyset.ts + queries.ts fetchAllBookings): pages of
 * 500 with the booking expand, keyset pagination over (created, id) –
 * `created <= c && (created < c || (created = c && id < i))` – sequential,
 * until a page is shorter than 500. Measured alone (3 runs, median; quick: 1)
 * and once more while a bar rush (A2's device mix, 2 bookings/s) is running.
 *
 * Before the F3 fix the SPA sent the cursor condition without `created <= c`.
 * PocketBase binds every literal as a separate parameter, so SQLite could not
 * use the two `c` as one range: it collected and sorted every older row for
 * every page (MULTI-INDEX OR + TEMP B-TREE) – O(n²) in the number of
 * bookings. The redundant `created <= c` gives it a range scan on the created
 * index. For comparison the export also runs once with the pre-fix filter
 * (legacyKeysetFilter – not what the app sends any more). From the per-page
 * costs a projection estimates the export time at 10× the bookings (≈ 1.5
 * years at the seeded rate).
 */
import { latencyStats } from '../../stats.ts';
import { describeLatency } from '../analysis.ts';
import { runFleet } from '../fleet.ts';
import { HttpClient, parseJson } from '../http.ts';
import { CSV_PAGE_SIZE, keysetFilter, legacyKeysetFilter, paths } from '../requests.ts';
import { fmt, median, runScenario, sleep, type PerfContext } from '../scenario.ts';
import type { ScenarioResult } from '../types.ts';
import { rushPlan } from './a02-rush.ts';

interface PageSample {
  index: number;
  ms: number;
  bytes: number;
  rows: number;
  /** Rows older than the cursor (≈ rows the keyset query has to sort). */
  older: number;
}

interface ExportRun {
  totalMs: number;
  pages: PageSample[];
  rows: number;
  bytes: number;
  errors: string[];
}

/** fetchAllKeyset as the SPA runs it; `total` = expected rows (for the "older rows" estimate). */
async function exportAll(client: HttpClient, total: number, filter: typeof keysetFilter): Promise<ExportRun> {
  const t0 = performance.now();
  const seen = new Set<string>();
  const pages: PageSample[] = [];
  const errors: string[] = [];
  let cursor: { created: string; id: string } | null = null;
  let bytes = 0;
  for (let index = 1; ; index++) {
    const result = await client.get(paths.bookings(filter('', cursor), CSV_PAGE_SIZE), { collect: true });
    bytes += result.bytes;
    if (result.error) {
      errors.push(result.error);
      break;
    }
    const items = parseJson<{ items: Array<{ id: string; created: string }> }>(result).items;
    pages.push({ index, ms: result.ms, bytes: result.bytes, rows: items.length, older: Math.max(0, total - seen.size) });
    for (const item of items) seen.add(item.id);
    const last = items.at(-1);
    if (items.length < CSV_PAGE_SIZE || !last) break;
    cursor = { created: last.created, id: last.id };
  }
  return { totalMs: performance.now() - t0, pages, rows: seen.size, bytes, errors };
}

/**
 * Least-squares line ms = a + b · older over the full keyset pages (index ≥ 2,
 * 500 rows): the final, partial page is cheaper because it returns fewer
 * rows, not because fewer rows are older – with a flat page cost it alone
 * would fake a slope.
 */
function fitPageCost(pages: readonly PageSample[]): { a: number; b: number } {
  const points = pages.filter((p) => p.index >= 2 && p.rows === CSV_PAGE_SIZE);
  const n = points.length;
  if (n < 2) return { a: points[0]?.ms ?? 0, b: 0 };
  const mx = points.reduce((s, p) => s + p.older, 0) / n;
  const my = points.reduce((s, p) => s + p.ms, 0) / n;
  const sxx = points.reduce((s, p) => s + (p.older - mx) ** 2, 0);
  const sxy = points.reduce((s, p) => s + (p.older - mx) * (p.ms - my), 0);
  const b = sxx > 0 ? sxy / sxx : 0;
  return { a: my - b * mx, b };
}

/** Estimated export time for `rows` bookings with the measured page costs. */
function project(rows: number, firstPageMs: number, cost: { a: number; b: number }): number {
  const pages = Math.floor(rows / CSV_PAGE_SIZE) + 1;
  let total = firstPageMs;
  for (let i = 2; i <= pages; i++) total += cost.a + cost.b * Math.max(0, rows - CSV_PAGE_SIZE * (i - 1));
  return total;
}

export async function scenarioA5(ctx: PerfContext): Promise<ScenarioResult[]> {
  const result = await runScenario(
    ctx,
    {
      id: 'A5',
      title: 'CSV export of all bookings',
      simulates: 'the accountant exports the whole history on Buchungen – alone and during a bar rush',
    },
    async (rec) => {
      const client = new HttpClient(ctx.url, { token: ctx.logins.admin!.token });
      try {
        const superuser = await ctx.instance.superuserClient();
        const total = (await superuser.collection('bookings').getList(1, 1, { fields: 'id' })).totalItems;
        await exportAll(client, total, keysetFilter); // warm-up

        // alone
        const window = rec.window();
        const alone: ExportRun[] = [];
        for (let i = 0; i < (ctx.quick ? 1 : 3); i++) alone.push(await exportAll(client, total, keysetFilter));
        const reference = await exportAll(client, total, legacyKeysetFilter);
        window.stop();
        const totals = alone.map((run) => run.totalMs);
        const medianTotal = median(totals);
        const keysetPages = alone.flatMap((run) => run.pages.filter((p) => p.index >= 2).map((p) => p.ms));
        const pageStats = latencyStats(keysetPages);
        const firstPage = median(alone.map((run) => run.pages[0]?.ms ?? NaN));
        const run0 = alone[0]!;
        const mib = run0.bytes / 1024 / 1024;
        const errors = alone.flatMap((run) => run.errors);

        rec.add({
          key: 'export.total',
          label: 'export of all bookings – total time (alone, median)',
          value: Math.round(medianTotal) / 1000,
          unit: 's',
          budget: { direction: 'max', warn: 3, fail: 10, rationale: 'waiting for the download: > 3 s is noticeable, > 10 s looks broken; baseline ≈ 1.1 s on localhost' },
          detail: `${run0.pages.length} requests, ${run0.rows.toLocaleString('en')} rows; runs: ${totals.map((ms) => fmt(ms / 1000, 2)).join(', ')} s`,
          explain: (verdict) => (verdict === 'warn' || verdict === 'fail' ? `exporting takes ${fmt(medianTotal / 1000, 1)} s on localhost` : undefined),
        });
        rec.add({
          key: 'export.page.p95',
          label: 'keyset page (500 rows) – p95',
          value: pageStats.count ? pageStats.p95 : null,
          unit: 'ms',
          budget: { direction: 'max', warn: 100, rationale: 'one page of 500 rows with expand; baseline ≈ 45 ms (keyset, before the F3 fix) / 18 ms (first page)' },
          detail: `${describeLatency(pageStats)}; first page (no keyset) ${fmt(firstPage)} ms`,
        });
        rec.add({
          key: 'export.size',
          label: 'export – transferred JSON',
          value: Math.round(mib * 10) / 10,
          unit: 'MiB',
          budget: { direction: 'max', warn: 25, rationale: 'all bookings with the full expand, uncompressed; 18.4 MiB at 15k bookings = 33 s on a 5 Mbit/s phone' },
          detail: `${fmt(run0.bytes / run0.rows / 1024, 2)} KiB per booking (expand: person, offering.group, createdBy); PocketBase does not compress`,
          explain: (verdict) =>
            verdict === 'warn' ? 'the export downloads every booking with its expanded person/offering/group/user records, uncompressed' : undefined,
        });
        rec.add({
          key: 'export.errors',
          label: 'failed export requests',
          value: errors.length,
          unit: 'count',
          budget: { direction: 'max', fail: 0, rationale: 'a failed page aborts the export' },
          detail: errors.slice(0, 3).join('; ') || 'no errors',
        });

        // diagnosis: does the page cost grow with the number of older rows (O(n²) in total)?
        const cost = fitPageCost(run0.pages);
        const projected10x = project(total * 10, firstPage, cost);
        const referenceMs = reference.totalMs;
        rec.info(
          'export.reference.total',
          'same export with the keyset filter before the F3 fix (comparison, not the app)',
          Math.round(referenceMs) / 1000,
          's',
          `the pre-fix filter (created < c || (created = c && id < i)) takes ${fmt(referenceMs / medianTotal, 2)}× as long as the app's export`,
        );
        rec.add({
          key: 'export.projected10x',
          label: `projected export time at 10× the bookings (${(total * 10).toLocaleString('en')})`,
          value: Math.round(projected10x / 100) / 10,
          unit: 's',
          budget: {
            direction: 'max',
            warn: 10,
            rationale: 'estimate from the measured page costs (a + b · older rows); 10× ≈ 1.5 years at the seeded rate – the export must stay below the FAIL limit as history grows',
          },
          detail: `keyset page ≈ ${fmt(cost.a, 1)} ms + ${fmt(cost.b * 1000, 2)} µs per older row; linear part alone would be ≈ ${fmt(
            (firstPage + (Math.floor((total * 10) / CSV_PAGE_SIZE)) * Math.max(cost.a, 0)) / 1000,
            1,
          )} s`,
          explain: (verdict) =>
            verdict === 'warn'
              ? 'the keyset pages get slower the more older bookings remain (b > 0: SQLite sorts older rows per page instead of a range scan – ' +
                'check the plan of the keyset page in A1-planner and frontend/src/api/keyset.ts), so the export time grows with the square of the history'
              : undefined,
        });
        rec.table('Page time vs. page index (first export run)', {
          columns: ['page', 'ms', 'rows', 'older rows (sorted per page before the F3 fix)'],
          rows: run0.pages
            .filter((p, i, all) => i < 3 || i === all.length - 1 || p.index % 5 === 0)
            .map((p) => [p.index, Math.round(p.ms * 10) / 10, p.rows, p.older]),
        });
        rec.note(
          `Page 1 (no cursor) takes ${fmt(firstPage)} ms, keyset pages ${fmt(pageStats.p50)} ms (p50); the fitted cost per older row is ` +
            `${fmt(cost.b * 1000, 2)} µs – near 0 means every page costs the same (a range scan) and the export grows linearly. Before the F3 fix ` +
            'each page sorted all older rows (≈ 2 µs per row): the cost fell with the page index and the sum was quadratic.',
        );
        rec.note(
          `The download grows linearly: ${fmt(run0.bytes / run0.rows / 1024, 2)} KiB per booking, so 10× the history would be ` +
            `≈ ${fmt((mib * 10) / 1, 0)} MiB of JSON that the browser holds in memory before it builds the CSV.`,
        );

        // during a rush
        const plan = rushPlan(ctx, {
          phones: 5,
          laptops: 1,
          laptopPages: 1,
          personenPhones: 0,
          rate: 2,
          undoShare: 0.1,
          warmupMs: 3_000,
          measureMs: ctx.quick ? 6_000 : 10_000,
          seed: 'loadtest-A5',
        });
        const duringRush: ExportRun[] = [];
        let exporting: Promise<void> = Promise.resolve();
        await runFleet(plan, {
          signal: ctx.signal,
          onReady: () => {
            exporting = (async () => {
              await sleep(plan.warmupMs + 500, ctx.signal);
              for (let i = 0; i < (ctx.quick ? 1 : 2) && !ctx.signal.aborted; i++) duringRush.push(await exportAll(client, total, keysetFilter));
            })();
          },
        });
        await exporting;
        const rushTotal = median(duringRush.map((run) => run.totalMs));
        rec.add({
          key: 'export.total.rush',
          label: 'export – total time during a bar rush (median)',
          value: duringRush.length ? Math.round(rushTotal) / 1000 : null,
          unit: 's',
          budget: { direction: 'max', warn: 3, fail: 10, rationale: 'same limits as alone: the accountant does not care what else happens' },
          detail: `${duringRush.length} run(s) while 5 phones and a laptop handle 2 bookings/s: ${duringRush.map((run) => fmt(run.totalMs / 1000, 2)).join(', ')} s`,
        });
        rec.data.alone = alone.map((run) => ({ totalMs: Math.round(run.totalMs), pages: run.pages.length, rows: run.rows, bytes: run.bytes }));
        rec.data.reference = { totalMs: Math.round(referenceMs), pages: reference.pages.length };
        rec.data.pageCost = cost;
      } finally {
        client.close();
      }
    },
  );
  return [result];
}
