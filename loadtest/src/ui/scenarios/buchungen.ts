/**
 * U7–U8: the Buchungen screen – the booking list with its filters, "Weitere
 * laden", the per-person / per-offering views, and the CSV export of the whole
 * history.
 */
import { readFile } from 'node:fs/promises';
import { uiBudget } from '../budgets.ts';
import { describeKinds, epochNow, paintedAt, type UiPage } from '../browser.ts';
import { BOOKINGS_PAGE_SIZE, bookingsState, exportDone, perOfferingState, perPersonState } from '../conditions.ts';
import type { Cond } from '../probe.ts';
import { fmtMs, max, median } from '../result.ts';
import type { Totals } from '../rest.ts';
import { sortPersons } from '../search.ts';
import { periodRanges, type PeriodKey } from '../../time.ts';
import {
  addPageSize,
  KiB,
  mediansByLabel,
  MiB,
  pageSize,
  perProfile,
  sumBytes,
  type PageSize,
  type UiEnv,
  type UiScenario,
} from '../scenario.ts';

const TIME_ZONE = 'Europe/Vienna';

interface FilterState {
  period?: PeriodKey;
  personId?: string;
  mine?: boolean;
  view?: 'liste' | 'personen' | 'angebote';
}

const PERIOD_PARAM: Record<PeriodKey, string> = { today: 'heute', '7d': '7-tage', '30d': '30-tage', all: 'alle' };

/** BookingsPage's filterToParams(): the URL / data-filter of a filter state. */
export function filterKey(state: FilterState): string {
  const params = new URLSearchParams();
  if (state.period && state.period !== 'all') params.set('zeitraum', PERIOD_PARAM[state.period]);
  if (state.personId) params.set('person', state.personId);
  if (state.mine) params.set('meine', '1');
  if (state.view && state.view !== 'liste') params.set('ansicht', state.view);
  return params.toString();
}

/** The totals the screen will show for a filter (same period bounds as the browser in Vienna). */
async function expected(env: UiEnv, username: string, state: FilterState): Promise<Totals> {
  const login = env.login(username);
  const range = state.period && state.period !== 'all' ? periodRanges(Date.now(), TIME_ZONE)[state.period] : {};
  return env.rest.totals(login.token, {
    from: range.from,
    to: range.to,
    person: state.personId,
    createdBy: state.mine ? String(login.record.id) : undefined,
  });
}

async function listCond(env: UiEnv, username: string, state: FilterState, pages = 1): Promise<{ cond: Cond; totals: Totals }> {
  const totals = await expected(env, username, state);
  return { cond: bookingsState({ filterKey: filterKey(state), count: totals.count, totalCents: totals.totalCents, pages }), totals };
}

/** Opens Buchungen ("Alle") cold and returns the page and its load timing. */
async function openBuchungen(env: UiEnv, profile: 'phone' | 'desktop', username: string, label: string) {
  const { cond, totals } = await listCond(env, username, {});
  const page = await env.open({ profile, login: env.login(username), load: { conds: { ready: cond } } });
  const load = await page.load('/buchungen', { label });
  return { page, load, totals };
}

interface StepSample {
  label: string;
  ms: number;
}

/**
 * The steps of U7 on one loaded "Alle" page: 8 filter changes, "Weitere laden"
 * up to `clicks` times, "Pro Person", "Pro Angebot". Each timing ends when the
 * new filter's list, count and sum (or the view) are painted.
 */
async function runSteps(env: UiEnv, page: UiPage, username: string, clicks: number, run: number) {
  const steps: StepSample[] = [];
  const counts = new Map<string, number>();
  const person = env.person(6);
  const period = (label: string) => () => page.press(page.page.getByTestId('period-filter').getByText(label, { exact: true }));
  const plan: Array<{ label: string; state: FilterState; act: () => Promise<unknown> }> = [
    { label: 'Heute', state: { period: 'today' }, act: period('Heute') },
    { label: '7 Tage', state: { period: '7d' }, act: period('7 Tage') },
    { label: '30 Tage', state: { period: '30d' }, act: period('30 Tage') },
    { label: 'Alle', state: { period: 'all' }, act: period('Alle') },
    { label: `Person ${person.number}`, state: { personId: person.id }, act: () => page.page.getByTestId('person-filter').selectOption(person.id) },
    { label: 'Alle Personen', state: {}, act: () => page.page.getByTestId('person-filter').selectOption('') },
    { label: 'Nur meine', state: { mine: true }, act: () => page.press(page.page.getByTestId('only-mine')) },
    { label: 'Nur meine aus', state: {}, act: () => page.press(page.page.getByTestId('only-mine')) },
  ];
  for (const step of plan) {
    env.signal.throwIfAborted();
    const { cond, totals } = await listCond(env, username, step.state);
    const m = await page.measure({ list: cond }, step.act, { label: `step ${step.label} (run ${run})` });
    steps.push({ label: step.label, ms: paintedAt(m, 'list') - m.start });
    counts.set(step.label, totals.count);
    await page.waitQuiet({ quietMs: 400, before: 'the next filter step' });
  }

  // "Weitere laden" on "Alle"
  const more: StepSample[] = [];
  const all = await expected(env, username, {});
  for (let k = 1; k <= clicks && BOOKINGS_PAGE_SIZE * k < all.count; k++) {
    env.signal.throwIfAborted();
    const cond = bookingsState({ filterKey: '', count: all.count, totalCents: all.totalCents, pages: k + 1 });
    const m = await page.measure({ list: cond }, () => page.press(page.page.getByRole('button', { name: 'Weitere laden' })), {
      label: `"Weitere laden" #${k} (run ${run})`,
    });
    more.push({ label: `#${k} → ${BOOKINGS_PAGE_SIZE * (k + 1)} rows`, ms: paintedAt(m, 'list') - m.start });
    await page.waitQuiet({ quietMs: 300, before: 'the next "Weitere laden"' });
  }

  // views rendered from the totals
  const numbers = sortPersons(all.perPerson.map((e) => ({ ...e, id: e.personId }))).map((e) => e.number);
  const perPerson = await page.measure(
    { view: perPersonState(numbers) },
    () => page.press(page.page.getByTestId('view-switch').getByText('Pro Person', { exact: true })),
    { label: `"Pro Person" (run ${run})` },
  );
  const perPersonMs = paintedAt(perPerson, 'view') - perPerson.start;
  await page.waitQuiet({ quietMs: 400, before: '"Pro Angebot"' });
  const perPersonTask = (await page.longTasks(perPerson.start, paintedAt(perPerson, 'view'))).max;
  const perOffering = await page.measure(
    { view: perOfferingState(all.perOffering.length) },
    () => page.press(page.page.getByTestId('view-switch').getByText('Pro Angebot', { exact: true })),
    { label: `"Pro Angebot" (run ${run})` },
  );
  const perOfferingMs = paintedAt(perOffering, 'view') - perOffering.start;
  await page.waitQuiet({ quietMs: 300, before: 'closing the page' });
  return { steps, counts, more, perPersonMs, perPersonTask, perOfferingMs, persons: numbers.length, offerings: all.perOffering.length, bookings: all.count };
}

// ------------------------------------------------------------------ U7

export const U7: UiScenario = {
  id: 'U7',
  title: 'Buchungen list and filters',
  simulates:
    'The host checks the bookings: opens Buchungen (whole history), switches periods, filters by person and "Nur meine", loads more rows and opens the per-person and per-offering views.',
  variants: perProfile('U7', 'Buchungen list and filters', ['phone', 'desktop'], ['phone']),
  timeoutMs: 240_000,
  async run(env, v, r) {
    const username = 'user1';
    const cold: number[] = [];
    const requests: number[] = [];
    const kib: number[] = [];
    const steps: StepSample[] = [];
    const more: StepSample[] = [];
    const perPerson: number[] = [];
    const perPersonTask: number[] = [];
    const perOffering: number[] = [];
    let kinds = '';
    let size: PageSize | undefined;
    let last: Awaited<ReturnType<typeof runSteps>> | undefined;
    const clicks = env.quick ? 3 : 10;
    // every cold run also does all steps, so each step has a median of `runs` samples
    for (let run = 1; run <= env.runs; run++) {
      env.signal.throwIfAborted();
      const opened = await openBuchungen(env, v.profile, username, `cold (run ${run})`);
      const ready = paintedAt(opened.load, 'ready');
      cold.push(ready);
      await opened.page.waitQuiet({ quietMs: 500, before: 'counting the requests' });
      const api = opened.page.requests.filter((x) => x.api);
      requests.push(api.length);
      kinds = describeKinds(api);
      kib.push(KiB(sumBytes(opened.page.requests)));
      if (run === 1) size = await pageSize(opened.page, `Buchungen, ${BOOKINGS_PAGE_SIZE} rows`);
      last = await runSteps(env, opened.page, username, clicks, run);
      steps.push(...last.steps);
      more.push(...last.more);
      perPerson.push(last.perPersonMs);
      perPersonTask.push(last.perPersonTask);
      perOffering.push(last.perOfferingMs);
      await opened.page.close();
      env.log(`${v.id}: run ${run}/${env.runs}: ready ${fmtMs(ready)} ms, Pro Person ${fmtMs(last.perPersonMs)} ms`);
    }
    if (!last) return;
    const counts = last.counts;
    r.addSamples('cold', 'Cold start ("Alle") → 50 rows, count and sum painted', cold, uiBudget('U7.cold', v.profile));
    r.add({ key: 'requests', label: 'API requests of the screen', value: median(requests), unit: 'count', detail: `${kinds} (Phase 1B: 9)` });
    r.add({ key: 'transfer', label: 'Transferred on a cold start', value: median(kib), unit: 'KiB' });

    const stepMedians = mediansByLabel(steps);
    r.add({
      key: 'step.max',
      label: `Filter change → list, count and sum painted (slowest step, median of ${env.runs})`,
      value: max(stepMedians.map((s) => s.ms)),
      unit: 'ms',
      budget: uiBudget('U7.step', v.profile),
      detail: stepMedians.map((s) => `${s.label} (${counts.get(s.label) ?? '?'}) ${fmtMs(s.ms)}`).join(' · ') + ' ms',
    });

    const moreMedians = mediansByLabel(more);
    if (moreMedians.length > 0) {
      r.add({
        key: 'more.max',
        label: `"Weitere laden" → 50 more rows painted (slowest click, median of ${env.runs})`,
        value: max(moreMedians.map((s) => s.ms)),
        unit: 'ms',
        budget: uiBudget('U7.more', v.profile),
        detail: moreMedians.map((s) => `${s.label} ${fmtMs(s.ms)}`).join(' · ') + ' ms',
      });
    } else {
      r.add({
        key: 'more.max',
        label: '"Weitere laden" → 50 more rows painted',
        value: null,
        unit: 'ms',
        detail: `not applicable: "Alle" has only ${last.bookings} bookings – one page, no "Weitere laden" button`,
      });
    }
    r.addSamples('perPerson', `View "Pro Person" (${last.persons} rows) painted`, perPerson, uiBudget('U7.perPerson', v.profile), `longest task ${fmtMs(median(perPersonTask) ?? 0)} ms`);
    r.addSamples('perOffering', `View "Pro Angebot" (${last.offerings} rows) painted`, perOffering);
    addPageSize(r, size);
    r.data.steps = stepMedians;
    r.data.more = moreMedians;
  },
};

// ------------------------------------------------------------------ U8

export const U8: UiScenario = {
  id: 'U8',
  title: 'CSV export (all bookings)',
  simulates: 'The accountant exports the whole booking history as CSV from the Buchungen screen.',
  variants: perProfile('U8', 'CSV export of all bookings', ['phone', 'desktop'], ['desktop']),
  timeoutMs: 180_000,
  async run(env, v, r) {
    const username = 'user1';
    const times: number[] = [];
    const requests: number[] = [];
    const mib: number[] = [];
    const longest: number[] = [];
    const rows: number[] = [];
    let expectedRows = 0;
    for (let run = 1; run <= env.runs; run++) {
      env.signal.throwIfAborted();
      const { page, totals } = await openBuchungen(env, v.profile, username, '');
      try {
        await page.waitQuiet({ quietMs: 500, before: 'the export' });
        expectedRows = totals.count;
        const from = epochNow();
        const download = page.page.waitForEvent('download', { timeout: 120_000 });
        download.catch(() => undefined);
        const m = await page.measure(exportDone(totals.count), () => page.press(page.page.getByTestId('csv-export')), {
          timeoutMs: 120_000,
          label: `export (run ${run})`,
        });
        const done = paintedAt(m, 'toast');
        times.push(done - m.start);
        const file = await download;
        const csv = await readFile(await file.path(), 'utf8');
        rows.push(csv.split('\r\n').length - 2); // header + trailing CRLF
        await file.delete().catch(() => undefined);
        await page.waitQuiet({ quietMs: 300, before: 'counting the requests' });
        const pages = page.requestsBetween(from).filter((x) => x.kind === 'CSV');
        requests.push(pages.length);
        mib.push(MiB(sumBytes(pages)));
        longest.push((await page.longTasks(m.start, done)).max);
        env.log(`${v.id}: run ${run}/${env.runs}: ${fmtMs(done - m.start)} ms, ${pages.length} requests`);
      } finally {
        await page.close();
      }
    }
    r.addSamples(
      'export',
      `Click "CSV" → file of ${expectedRows} bookings saved, confirmation visible`,
      times,
      uiBudget('U8.export', v.profile),
    );
    r.add({
      key: 'requests',
      label: 'Requests of the export',
      value: median(requests),
      unit: 'count',
      detail: `keyset pages of 500 with expand (Phase 1B: ${Math.floor(expectedRows / 500) + 1})`,
    });
    r.add({ key: 'transfer', label: 'Downloaded for the export (JSON pages)', value: median(mib), unit: 'MiB' });
    r.add({ key: 'longTask.max', label: 'Longest main-thread task during the export', value: median(longest), unit: 'ms' });
    const fileRows = median(rows);
    r.add({ key: 'rows', label: 'Data rows in the CSV file', value: fileRows, unit: 'count', detail: `expected ${expectedRows}` });
    if (fileRows !== expectedRows) r.note(`The CSV file has ${fileRows} data rows, the totals say ${expectedRows}.`);
  },
};
