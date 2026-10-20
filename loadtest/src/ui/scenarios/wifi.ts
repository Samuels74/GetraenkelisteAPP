/**
 * U11 (report only, full run only): the phone on a busy bar Wi-Fi – the
 * uncompressed API payloads (PocketBase does not gzip API responses) become
 * the dominant cost. No budgets: the network profile is an assumption, the
 * numbers show orders of magnitude.
 */
import { gzipSync } from 'node:zlib';
import { BAR_WIFI, epochNow, paintedAt } from '../browser.ts';
import { bookingsState, exportDone } from '../conditions.ts';
import { fmtMs } from '../result.ts';
import { BOOKING_EXPAND } from '../../seed.ts';
import { buchenExpect, KiB, MiB, personenExpect, sumBytes, type UiEnv, type UiScenario } from '../scenario.ts';

/**
 * How much the biggest API responses would shrink with gzip (level 6, as a
 * reverse proxy would send them): reference totals, a page of persons and a
 * page of the CSV export.
 */
async function gzipShare(env: UiEnv, token: string): Promise<{ raw: number; gzip: number }> {
  const bodies = await Promise.all([
    env.rest.text(token, '/api/app/totals'),
    env.rest.text(token, '/api/collections/persons/records', { page: '1', perPage: '1000', skipTotal: '1' }),
    env.rest.text(token, '/api/collections/bookings/records', {
      page: '1',
      perPage: '500',
      skipTotal: '1',
      sort: '-created,-id',
      expand: BOOKING_EXPAND,
    }),
  ]);
  let raw = 0;
  let gzip = 0;
  for (const body of bodies) {
    raw += Buffer.byteLength(body);
    gzip += gzipSync(body, { level: 6 }).length;
  }
  return { raw, gzip };
}

export const U11: UiScenario = {
  id: 'U11',
  title: 'Bar Wi-Fi (report only)',
  simulates: `A phone on a busy bar Wi-Fi (${BAR_WIFI.label}) opens Buchen, Personen and Buchungen and exports the CSV.`,
  variants: (quick) => (quick ? [] : [{ id: 'U11', title: `Bar Wi-Fi, phone (${BAR_WIFI.label})`, profile: 'phone' }]),
  timeoutMs: 240_000,
  async run(env, v, r) {
    const username = 'user1';
    const login = env.login(username);
    const network = BAR_WIFI;
    const timeoutMs = 90_000;

    // Buchen cold, then reloaded (JS/CSS cached)
    const person = env.person(0);
    const buchen = await buchenExpect(env, username, person);
    let page = await env.open({ profile: v.profile, login, selectedPersonId: person.id, network, load: { conds: buchen, timeoutMs } });
    const cold = await page.load('/', { timeoutMs, label: 'buchen.cold' });
    await page.waitQuiet({ quietMs: 600, maxMs: 30_000, before: 'the reload' });
    r.add({ key: 'buchen.cold', label: 'Buchen cold start → ready', value: paintedAt(cold, 'ready'), unit: 'ms' });
    r.add({ key: 'buchen.cold.transfer', label: 'Buchen cold start: transferred', value: KiB(sumBytes(page.requests)), unit: 'KiB' });
    const mark = page.requests.length;
    const warm = await page.reload({ timeoutMs, label: 'buchen.warm' });
    await page.waitQuiet({ quietMs: 600, maxMs: 30_000, before: 'Personen' });
    r.add({ key: 'buchen.warm', label: 'Buchen reload (JS/CSS cached) → ready', value: paintedAt(warm, 'ready'), unit: 'ms' });
    r.add({ key: 'buchen.warm.transfer', label: 'Buchen reload: transferred', value: KiB(sumBytes(page.requests.slice(mark))), unit: 'KiB' });
    await page.close();
    env.log(`U11: Buchen cold ${fmtMs(paintedAt(cold, 'ready'))} ms, warm ${fmtMs(paintedAt(warm, 'ready'))} ms`);

    // Personen cold
    env.signal.throwIfAborted();
    const personen = await personenExpect(env, username);
    page = await env.open({ profile: v.profile, login, network, load: { conds: personen, timeoutMs } });
    const persons = await page.load('/personen', { timeoutMs, label: 'personen.cold' });
    await page.waitQuiet({ quietMs: 600, maxMs: 30_000, before: 'Buchungen' });
    r.add({ key: 'personen.cold', label: 'Personen cold start → ready', value: paintedAt(persons, 'ready'), unit: 'ms' });
    r.add({ key: 'personen.cold.transfer', label: 'Personen cold start: transferred', value: KiB(sumBytes(page.requests)), unit: 'KiB' });
    await page.close();
    env.log(`U11: Personen cold ${fmtMs(paintedAt(persons, 'ready'))} ms`);

    // Buchungen cold, then the CSV export of everything
    env.signal.throwIfAborted();
    const totals = await env.rest.totals(login.token);
    const list = bookingsState({ filterKey: '', count: totals.count, totalCents: totals.totalCents });
    page = await env.open({ profile: v.profile, login, network, load: { conds: { ready: list }, timeoutMs } });
    const bookings = await page.load('/buchungen', { timeoutMs, label: 'buchungen.cold' });
    await page.waitQuiet({ quietMs: 600, maxMs: 30_000, before: 'the export' });
    r.add({ key: 'buchungen.cold', label: 'Buchungen cold start → ready', value: paintedAt(bookings, 'ready'), unit: 'ms' });
    r.add({ key: 'buchungen.cold.transfer', label: 'Buchungen cold start: transferred', value: KiB(sumBytes(page.requests)), unit: 'KiB' });
    env.log(`U11: Buchungen cold ${fmtMs(paintedAt(bookings, 'ready'))} ms; exporting the CSV …`);
    const from = epochNow();
    const download = page.page.waitForEvent('download', { timeout: 180_000 });
    download.catch(() => undefined);
    const m = await page.measure(exportDone(totals.count), () => page.press(page.page.getByTestId('csv-export')), {
      timeoutMs: 180_000,
      label: 'csv',
    });
    await (await download).delete().catch(() => undefined);
    const exportBytes = sumBytes(page.requestsBetween(from).filter((x) => x.kind === 'CSV'));
    r.add({ key: 'csv', label: `CSV export of ${totals.count} bookings → saved, confirmation visible`, value: paintedAt(m, 'toast') - m.start, unit: 'ms' });
    r.add({ key: 'csv.transfer', label: 'CSV export: downloaded', value: MiB(exportBytes), unit: 'MiB' });
    await page.close();

    const { raw, gzip } = await gzipShare(env, login.token);
    const share = (100 * gzip) / raw;
    r.add({
      key: 'gzip',
      label: 'API JSON with gzip, in % of its uncompressed size (totals, persons page, CSV page)',
      value: share,
      unit: '%',
      detail: `${Math.round(KiB(raw))} KiB → ${Math.round(KiB(gzip))} KiB`,
    });
    r.note(
      `Network emulation (CDP): ${network.label}, cold HTTP cache. PocketBase does not compress API responses, so these ` +
        `sizes go over the air as they are; gzip would shrink the JSON to about ${Math.round(share)} % (measured on the ` +
        'largest responses) – a compressing reverse proxy is the cheapest fix for slow networks.',
    );
  },
};
