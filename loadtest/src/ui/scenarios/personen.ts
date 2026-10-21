/**
 * U4–U6: the person screens – the Personen list with its search and "Weitere
 * 100 anzeigen", the same list while other devices book, and the QR print
 * sheet. Personen renders the first 100 matches (memoized rows, the list
 * follows the search field as a deferred value); the QR sheet renders all
 * persons, step by step. Before the fixes both rendered every person in one
 * commit (docs/LOADTEST-FINDINGS.md F1, F4).
 */
import path from 'node:path';
import { uiBudget } from '../budgets.ts';
import { describeKinds, epochNow, paintedAt, sleep, type UiPage } from '../browser.ts';
import { buchenTiles, LIST_PAGE_SIZE, personenSignature, personenState, personRowTotal, qrSheetLoad, SEL } from '../conditions.ts';
import type { Cond } from '../probe.ts';
import { fmtMs, max, median } from '../result.ts';
import { searchPersons } from '../search.ts';
import {
  addPageSize,
  deleteBookings,
  KiB,
  mediansByLabel,
  pageSize,
  personenExpect,
  perProfile,
  sumBytes,
  type PageSize,
  type UiScenario,
} from '../scenario.ts';
import { keystrokes, timeKeystrokes } from './buchen.ts';

// ------------------------------------------------------------------ U4

export const U4: UiScenario = {
  id: 'U4',
  title: 'Personen list',
  simulates: 'Someone opens the Personen tab (the first 100 persons with their totals), shows 100 more and searches for a guest by name.',
  variants: perProfile('U4', 'Personen list and search', ['phone', 'desktop'], ['phone', 'desktop']),
  timeoutMs: 150_000,
  async run(env, v, r) {
    const username = 'user1';
    const login = env.login(username);
    const n = env.fixtures.persons.length;
    const ready: number[] = [];
    const rows: number[] = [];
    const requests: number[] = [];
    const kib: number[] = [];
    const longTaskSum: number[] = [];
    const longTaskMax: number[] = [];
    const more: number[] = [];
    let kinds = '';
    let last: UiPage | undefined;
    let size: PageSize | undefined;
    // "Weitere 100 anzeigen": tap → 200 rows and the footer "200 von <n>" painted
    const showMore = async (page: UiPage, run: number) => {
      const button = page.page.locator(SEL.personsMore).getByRole('button', { name: /^(Weitere \d+|1 weitere) anzeigen$/ });
      const m = await page.measure({ list: personenState(env.fixtures.persons, 2 * LIST_PAGE_SIZE) }, () => page.press(button), {
        label: `"Weitere 100 anzeigen" (run ${run})`,
      });
      more.push(paintedAt(m, 'list') - m.start);
      await page.waitQuiet({ quietMs: 400, before: 'closing the page' });
    };
    for (let run = 1; run <= env.runs; run++) {
      env.signal.throwIfAborted();
      const conds = await personenExpect(env, username);
      const page = await env.open({ profile: v.profile, login, load: { conds } });
      const trace = env.trace && v.profile === 'phone' && run === 1;
      if (trace) await page.startTrace(path.join(env.ctx.resultsDir, 'ui-trace-U4-phone.json'));
      const load = await page.load('/personen', { label: `ready (cold run ${run})` });
      const done = paintedAt(load, 'ready');
      ready.push(done);
      rows.push(paintedAt(load, 'rows'));
      await page.waitQuiet({ quietMs: 500, before: 'counting the requests' });
      if (trace) {
        await page.stopTrace();
        r.data.trace = { file: 'ui-trace-U4-phone.json', ready: done, rows: paintedAt(load, 'rows'), origin: load.origin };
      }
      const api = page.requests.filter((x) => x.api);
      requests.push(api.length);
      kinds = describeKinds(api);
      kib.push(KiB(sumBytes(page.requests)));
      const lt = await page.longTasks(0, done);
      longTaskSum.push(lt.total);
      longTaskMax.push(lt.max);
      if (run === 1) size = await pageSize(page, `Personen, ${Math.min(LIST_PAGE_SIZE, n)} of ${n} rows`);
      env.log(`${v.id}: run ${run}/${env.runs}: ready ${fmtMs(done)} ms (rows ${fmtMs(rows.at(-1) as number)} ms)`);
      if (run < env.runs) {
        if (n > LIST_PAGE_SIZE) await showMore(page, run);
        await page.close();
      } else {
        last = page;
      }
    }
    const shownRows = Math.min(LIST_PAGE_SIZE, n);
    r.addSamples('ready', `Cold start → the first ${shownRows} of ${n} rows with totals painted`, ready, uiBudget('U4.ready', v.profile));
    r.addSamples('rows', `Cold start → the first ${shownRows} rows painted (totals still loading)`, rows);
    r.add({ key: 'requests', label: 'API requests of the screen', value: median(requests), unit: 'count', detail: `${kinds} (before the fixes: 8)` });
    r.add({ key: 'transfer', label: 'Transferred on a cold start', value: median(kib), unit: 'KiB' });
    r.add({ key: 'longTasks.sum', label: 'Long tasks until ready (sum)', value: median(longTaskSum), unit: 'ms' });
    r.add({ key: 'longTasks.max', label: 'Longest task until ready', value: median(longTaskMax), unit: 'ms' });
    addPageSize(r, size);

    // search: one character at a time, then clear (Phase 1B: "m", "mü", clear) – repeated in the
    // full run (median per keystroke): this budget can fail the run, one noisy sample must not decide
    if (last) {
      const page = last;
      await page.page.locator(SEL.personsSearch).focus();
      const all = env.fixtures.persons;
      const repetitions = env.runs;
      const samples: Array<{ label: string; ms: number; block: number }> = [];
      for (let rep = 1; rep <= repetitions; rep++) {
        env.signal.throwIfAborted();
        const keys = await timeKeystrokes(
          page,
          keystrokes(['mü', '']),
          (value) => {
            const results = searchPersons(all, value);
            return { cond: personenState(results), signature: personenSignature(results) };
          },
          personenSignature(all),
          ` (sequence ${rep})`,
        );
        samples.push(...keys);
      }
      const perKey = mediansByLabel(samples).map((k) => ({
        ...k,
        block: median(samples.filter((s) => s.label === k.label).map((s) => s.block)) as number,
      }));
      const worst = perKey.reduce((a, b) => (b.ms > a.ms ? b : a), perKey[0] ?? { label: '', ms: NaN, block: 0, runs: [] });
      const keystroke = r.add({
        key: 'keystroke.max',
        label: `Search keystroke → filtered list painted (slowest keystroke, median of ${repetitions})`,
        value: max(perKey.map((k) => k.ms)),
        unit: 'ms',
        budget: uiBudget('U4.keystroke', v.profile),
        detail:
          perKey.map((k) => `${k.label} ${fmtMs(k.ms)} (long tasks ${fmtMs(k.block)})`).join(' · ') +
          ` ms${repetitions > 1 ? `; runs: ${perKey.map((k) => `${k.label} ${k.runs.map(fmtMs).join('/')}`).join(', ')}` : ''}`,
      });
      r.data.keystrokes = perKey;
      if (keystroke.verdict === 'warn' || keystroke.verdict === 'fail') {
        r.note(
          `Typing in the Personen search: "${worst.label}" takes ${fmtMs(worst.ms)} ms until the list is updated, ` +
            `${fmtMs(worst.block)} ms of it blocking the main thread (PersonsPage.tsx renders the first ${LIST_PAGE_SIZE} matches as a deferred value).`,
        );
      }
      if (n > LIST_PAGE_SIZE) await showMore(page, env.runs);
      await page.close();
    }
    if (more.length > 0) {
      r.addSamples('more', `"Weitere 100 anzeigen" → ${2 * LIST_PAGE_SIZE} rows painted`, more, uiBudget('more100', v.profile));
    } else {
      r.add({ key: 'more', label: '"Weitere 100 anzeigen"', value: null, unit: 'ms', detail: `not applicable: ${n} persons fit on the first page` });
    }

    // in-app tab switch Buchen → Personen (what users actually do): the first one loads the route's
    // code and the totals (a cold start of the screen); the later ones render cached data only – an
    // interaction, budgeted like a keystroke
    const page = await env.open({ profile: v.profile, login, load: { conds: buchenTiles(env.fixtures.offerings.length) } });
    await page.load('/', { label: '' });
    await page.waitQuiet({ quietMs: 500, before: 'the first tab switch' });
    const switches: number[] = [];
    const total = env.quick ? 1 : 1 + env.runs;
    for (let i = 0; i < total; i++) {
      env.signal.throwIfAborted();
      const conds = await personenExpect(env, username);
      const m = await page.measure({ ready: conds.ready as Cond }, () => page.press(page.page.getByTestId('nav-personen')), {
        label: i === 0 ? 'tab.first' : `tab.again (switch ${i + 1})`,
      });
      switches.push(paintedAt(m, 'ready') - m.start);
      await page.waitQuiet({ quietMs: 400, before: 'switching back' });
      await page.measure(buchenTiles(env.fixtures.offerings.length), () => page.press(page.page.getByTestId('nav-buchen')), {
        label: '',
      });
      await page.waitQuiet({ quietMs: 400, before: 'the next tab switch' });
    }
    await page.close();
    r.add({
      key: 'tab.first',
      label: 'Tab Buchen → Personen, first time (route code + per-person totals download + render)',
      value: switches[0] ?? null,
      unit: 'ms',
      budget: uiBudget('U4.ready', v.profile),
    });
    const again = switches.slice(1);
    if (again.length > 0) {
      const tab = r.addSamples('tab.again', 'Tab Buchen → Personen again (cached data: render only)', again, uiBudget('U4.tab', v.profile));
      if (tab.verdict === 'warn' || tab.verdict === 'fail') {
        r.note(
          `Every switch to the Personen tab takes about ${fmtMs(median(again) as number)} ms on the ${v.profile} although all ` +
            `data is cached: the page mounts its first ${shownRows} rows again.`,
        );
      }
    }
  },
};

// ------------------------------------------------------------------ U5

export const U5: UiScenario = {
  id: 'U5',
  title: 'Personen during a rush',
  simulates: 'A device shows the Personen list while other devices book one drink per second.',
  variants: perProfile('U5', 'Personen during a rush', ['phone', 'desktop'], ['phone']),
  timeoutMs: 90_000,
  async run(env, v, r) {
    const username = 'user1';
    const login = env.login(username);
    const conds = await personenExpect(env, username);
    const page = await env.open({ profile: v.profile, login, load: { conds } });
    const created: Array<[string, string]> = [];
    try {
      await page.load('/personen', { label: '' });
      await page.waitQuiet({ quietMs: 600, maxMs: 10_000, before: 'the rush' });

      const events = env.quick ? 5 : 10;
      const creators = ['user2', 'user3', 'user4', 'user5'].filter((name) => env.ctx.logins[name]);
      if (creators.length === 0) creators.push(username);
      const offering = env.fixtures.offerings[0];
      if (!offering) throw new Error('no active offering');
      const targets = Array.from({ length: events }, (_, i) => env.person(10 + i * 7));
      const expected = new Map<string, { totalCents: number; count: number }>();
      for (const target of targets) {
        if (expected.has(target.id)) continue;
        const totals = await env.rest.totals(login.token, { person: target.id });
        expected.set(target.id, { totalCents: totals.totalCents, count: totals.count });
      }

      // open loop: booking i is due at t0 + i s, whatever the previous one did
      const t0 = epochNow() + 300;
      const pending: Array<{ sent: number; wait: () => Promise<{ origin: number; painted: number }> }> = [];
      for (let i = 0; i < events; i++) {
        env.signal.throwIfAborted();
        const delay = t0 + i * 1000 - epochNow();
        if (delay > 0) await sleep(delay);
        const target = targets[i] as (typeof targets)[number];
        const before = expected.get(target.id) as { totalCents: number; count: number };
        const after = { totalCents: before.totalCents + offering.priceCents, count: before.count + 1 };
        expected.set(target.id, after);
        const watch = await page.watch({ row: personRowTotal(target, after.totalCents, after.count) }, {
          timeoutMs: 20_000,
          label: `remote booking ${i + 1} → row updated`,
        });
        const creator = env.login(creators[i % creators.length] as string);
        const sent = epochNow();
        const booking = await env.rest.createBooking(creator.token, target.id, offering.id, String(creator.record.id));
        created.push([creator.username, booking.id]);
        pending.push({
          sent,
          wait: async () => {
            const w = await watch();
            return { origin: w.origin, painted: paintedAt(w, 'row') };
          },
        });
      }
      const propagation: number[] = [];
      for (const event of pending) {
        const { origin, painted } = await event.wait();
        propagation.push(origin + painted - event.sent);
      }
      await page.waitQuiet({ quietMs: 600, maxMs: 10_000, before: 'reading the long tasks' });

      const block: number[] = [];
      const longest: number[] = [];
      const requests: number[] = [];
      const kib: number[] = [];
      let kinds = '';
      for (const [i, event] of pending.entries()) {
        const next = pending[i + 1]?.sent ?? event.sent + 1000;
        const from = event.sent - page.origin;
        const lt = await page.longTasks(from, from + (next - event.sent));
        block.push(lt.total);
        longest.push(lt.max);
        const reqs = page.requestsBetween(event.sent, next).filter((x) => x.api && !x.sse);
        requests.push(reqs.length);
        kinds = describeKinds(reqs);
        kib.push(KiB(sumBytes(reqs)));
        // the window of each booking counts for the busy-machine check
        r.timing(`main thread per remote booking ${i + 1}`, event.sent, next);
      }
      const blocking = r.add({
        key: 'block.median',
        label: 'Main thread blocked per remote booking (long tasks, median)',
        value: median(block),
        unit: 'ms',
        budget: uiBudget('U5.block', v.profile),
        detail: `per booking: ${block.map(fmtMs).join(' · ')} ms; longest single task ${fmtMs(max(longest) ?? 0)} ms`,
      });
      r.add({ key: 'block.max', label: 'Main thread blocked per remote booking (worst)', value: max(block), unit: 'ms' });
      r.addSamples('propagation', 'Remote booking sent → the row shows the new total', propagation);
      r.add({
        key: 'requests',
        label: 'Requests per remote booking',
        value: median(requests),
        unit: 'count',
        detail: `${kinds} – the booked person's row (person=<id>&parts=perPerson); before the fixes 1 – the complete totals, 253 KiB`,
      });
      r.add({ key: 'transfer', label: 'Downloaded per remote booking', value: median(kib), unit: 'KiB', detail: 'before the fixes 253 KiB' });
      r.data.events = pending.map((_, i) => ({ propagation: propagation[i], block: block[i], longest: longest[i], requests: requests[i] }));
      if (blocking.verdict === 'warn' || blocking.verdict === 'fail') {
        r.note(
          `Each booking on another device blocks this ${v.profile} for about ${fmtMs(median(block) ?? 0)} ms: the realtime ` +
            `event fetches the booked person's row (${Math.round((median(kib) ?? 0) * 1024)} bytes) and only the changed row should re-render ` +
            `(PersonsPage.tsx: memoized rows).`,
        );
      }
    } finally {
      await page.close();
      for (const [creator, id] of created) await deleteBookings(env, creator, [id]);
    }
  },
};

// ------------------------------------------------------------------ U6

export const U6: UiScenario = {
  id: 'U6',
  title: 'QR sheet (all persons)',
  simulates: 'The organizer opens the print sheet with a QR code for every person (the cards appear step by step; printing waits for all).',
  variants: perProfile('U6', 'QR sheet of all persons', ['phone', 'desktop'], ['phone']),
  timeoutMs: 120_000,
  async run(env, v, r) {
    const login = env.login('user1');
    const n = env.fixtures.persons.length;
    const ready: number[] = [];
    const first: number[] = [];
    const longest: number[] = [];
    const sums: number[] = [];
    let size: PageSize | undefined;
    for (let run = 1; run <= env.runs; run++) {
      env.signal.throwIfAborted();
      const page = await env.open({ profile: v.profile, login, load: { conds: qrSheetLoad(n), timeoutMs: 60_000 } });
      const load = await page.load('/personen/qr-codes', { timeoutMs: 60_000, label: `ready (cold run ${run})` });
      const done = paintedAt(load, 'ready');
      ready.push(done);
      first.push(paintedAt(load, 'first'));
      await page.waitQuiet({ quietMs: 500, before: 'reading the long tasks' });
      const lt = await page.longTasks(0, done);
      longest.push(lt.max);
      sums.push(lt.total);
      if (run === 1) size = await pageSize(page, `QR sheet, ${n} codes`);
      await page.close();
      env.log(`${v.id}: run ${run}/${env.runs}: ready ${fmtMs(done)} ms, longest task ${fmtMs(lt.max)} ms`);
    }
    r.addSamples('ready', `Cold start → all ${n} QR codes painted (printing enabled)`, ready, uiBudget('U6.ready', v.profile));
    r.addSamples('first', `Cold start → the first ${Math.min(100, n)} QR codes painted`, first);
    const frozen = r.add({
      key: 'longTask.max',
      label: 'Longest main-thread task while rendering',
      value: median(longest),
      unit: 'ms',
      budget: uiBudget('U6.longTask', v.profile),
      detail: `median of the runs' longest task; runs: ${longest.map(fmtMs).join(' · ')} ms`,
    });
    r.add({ key: 'longTasks.sum', label: 'Long tasks until ready (sum)', value: median(sums), unit: 'ms' });
    addPageSize(r, size);
    if (frozen.verdict === 'warn' || frozen.verdict === 'fail') {
      r.note(
        `The QR sheet blocks the page for ${fmtMs(median(longest) ?? 0)} ms in one piece although the cards are added in steps ` +
          '(QrSheetPage.tsx useProgressiveCount: 100, then up to 400 per step) – check the step size.',
      );
    }
  },
};
