/**
 * U1–U3: the booking screen ("Buchen") – cold start, booking taps and the
 * person picker. The screen every bartender uses for every drink.
 */
import { uiBudget } from '../budgets.ts';
import { describeKinds, epochNow, paintedAt, type ProfileName, type UiPage } from '../browser.ts';
import { bookingToast, personTotal, pickerSignature, pickerState, SEL, UNDO_TOAST } from '../conditions.ts';
import { eventsBetween, type Cond, type Conds } from '../probe.ts';
import { fmtMs, max, median, pct } from '../result.ts';
import type { Person } from '../rest.ts';
import { searchPersons } from '../search.ts';
import {
  addPageSize,
  buchenExpect,
  deleteBookings,
  KiB,
  pageSize,
  perProfile,
  sumBytes,
  type PageSize,
  type UiEnv,
  type UiScenario,
} from '../scenario.ts';

/** Opens Buchen with `person` selected and waits until it is ready and idle. */
export async function openBuchen(env: UiEnv, profile: ProfileName, username: string, person: Person): Promise<UiPage> {
  const conds = await buchenExpect(env, username, person);
  const page = await env.open({ profile, login: env.login(username), selectedPersonId: person.id, load: { conds } });
  await page.load('/', { label: '' });
  await page.waitQuiet({ quietMs: 500, before: 'the first step' });
  return page;
}

/** Longest Event Timing entry (input → next paint) of an interaction window. */
async function interactionLatency(page: UiPage, from: number, to: number): Promise<number | null> {
  const events = await eventsBetween(page.page, from - 1, to);
  return events.length > 0 ? Math.max(...events.map((event) => event[4])) : null;
}

// ------------------------------------------------------------------ U1

export const U1: UiScenario = {
  id: 'U1',
  title: 'Buchen cold start',
  simulates:
    'A bartender opens the app: the booking screen appears with the last guest still selected (person card with total, latest bookings, offering tiles).',
  variants: perProfile('U1', 'Buchen cold start', ['phone', 'desktop'], ['phone', 'desktop']),
  timeoutMs: 120_000,
  async run(env, v, r) {
    const person = env.person(0);
    const login = env.login('user1');
    const cold: number[] = [];
    const warm: number[] = [];
    const tiles: number[] = [];
    const requests: number[] = [];
    const kibCold: number[] = [];
    const kibWarm: number[] = [];
    const kibPersons: number[] = [];
    const longTasks: number[] = [];
    let kinds = '';
    let size: PageSize | undefined;
    for (let run = 1; run <= env.runs; run++) {
      env.signal.throwIfAborted();
      const conds = await buchenExpect(env, 'user1', person);
      const page = await env.open({ profile: v.profile, login, selectedPersonId: person.id, load: { conds } });
      const load = await page.load('/', { label: `ready.cold (run ${run})` });
      const ready = paintedAt(load, 'ready');
      cold.push(ready);
      tiles.push(paintedAt(load, 'tiles'));
      await page.waitQuiet({ quietMs: 500, before: 'counting the requests' });
      const api = page.requests.filter((x) => x.api);
      requests.push(api.length);
      kinds = describeKinds(api);
      kibCold.push(KiB(sumBytes(page.requests)));
      kibPersons.push(KiB(sumBytes(api.filter((x) => x.kind === 'PERS'))));
      longTasks.push((await page.longTasks(0, ready)).total);
      if (run === 1) size = await pageSize(page, 'Buchen');

      // warm: the same document reloaded – JS/CSS come from the HTTP cache (immutable assets)
      const mark = page.requests.length;
      const reload = await page.reload({ label: `ready.warm (run ${run})` });
      warm.push(paintedAt(reload, 'ready'));
      await page.waitQuiet({ quietMs: 500, before: 'the next run' });
      kibWarm.push(KiB(sumBytes(page.requests.slice(mark))));
      await page.close();
      env.log(`${v.id}: run ${run}/${env.runs}: cold ${fmtMs(ready)} ms, warm ${fmtMs(warm.at(-1) as number)} ms`);
    }
    r.addSamples('ready.cold', 'Cold start → person card with total, latest bookings and tiles painted', cold, uiBudget('U1.ready', v.profile));
    r.addSamples('ready.warm', 'Reload with cached JS/CSS → ready', warm);
    r.addSamples('tiles.cold', 'Cold start → offering tiles painted', tiles);
    r.add({ key: 'requests', label: 'API requests of a start', value: median(requests), unit: 'count', detail: `${kinds} (Phase 1B: 11)` });
    r.add({ key: 'transfer.cold', label: 'Transferred on a cold start (JS/CSS + API)', value: median(kibCold), unit: 'KiB' });
    r.add({ key: 'transfer.warm', label: 'Transferred on a reload (API only)', value: median(kibWarm), unit: 'KiB' });
    r.add({ key: 'longTasks', label: 'Long tasks until ready (sum)', value: median(longTasks), unit: 'ms' });
    addPageSize(r, size);
    const persons = median(kibPersons) ?? 0;
    r.note(
      `Every start downloads the whole person list (${env.fixtures.persons.length} persons, ${Math.round(persons)} KiB in ` +
        'PERS requests) for the picker, although the screen shows one person – on a slow network this dominates the start (see U11).',
    );
  },
};

// ------------------------------------------------------------------ U2

export const U2: UiScenario = {
  id: 'U2',
  title: 'Booking tap',
  simulates: 'A bartender taps drink tiles for the selected guest and watches for the confirmation (toast and updated total).',
  variants: perProfile('U2', 'Booking tap', ['phone', 'desktop'], ['phone']),
  timeoutMs: 90_000,
  async run(env, v, r) {
    const username = 'user1';
    const person = env.person(1);
    const offerings = env.fixtures.offerings;
    const page = await openBuchen(env, v.profile, username, person);
    try {
      const start = await env.rest.totals(env.login(username).token, { person: person.id });
      let count = start.count;
      let cents = start.totalCents;
      const toast: number[] = [];
      const total: number[] = [];
      const requests: number[] = [];
      const interaction: number[] = [];
      let kinds = '';
      let previous: string | null = null;
      let last: { priceCents: number } | null = null;
      const taps = env.quick ? 3 : 5;
      for (let i = 0; i < taps; i++) {
        env.signal.throwIfAborted();
        const offering = offerings[i % offerings.length];
        if (!offering) break;
        count += 1;
        cents += offering.priceCents;
        const conds: Conds = { total: personTotal(cents, count) };
        // the toast is reused: its text only changes when the drink changes
        if (offering.name !== previous) conds.toast = bookingToast(offering.name, offering.priceCents);
        const from = epochNow();
        const tile = page.page.locator(`${SEL.tile}[data-offering-id="${offering.id}"]`);
        const m = await page.measure(conds, () => page.press(tile), { label: `tap ${i + 1} → toast and total` });
        if (conds.toast) toast.push(paintedAt(m, 'toast') - m.start);
        total.push(paintedAt(m, 'total') - m.start);
        await page.waitQuiet({ quietMs: 500, before: `counting the requests of tap ${i + 1}` });
        const tapRequests = page.requestsBetween(from).filter((x) => x.api && !x.sse);
        requests.push(tapRequests.length);
        kinds = describeKinds(tapRequests);
        const latency = await interactionLatency(page, m.start, m.doneAt);
        if (latency !== null) interaction.push(latency);
        previous = offering.name;
        last = offering;
      }

      // "Rückgängig" in the toast of the last booking
      let undo: number | null = null;
      let undoWhy = '';
      const button = page.page.locator('[data-sonner-toast] [data-button]', { hasText: 'Rückgängig' });
      if (last && (await button.isVisible())) {
        const m = await page.measure(
          { toast: UNDO_TOAST, total: personTotal(cents - last.priceCents, count - 1) },
          () => page.press(button),
          { label: '"Rückgängig" → total restored' },
        );
        undo = paintedAt(m, 'total') - m.start;
        await page.waitQuiet({ quietMs: 500, before: 'the cleanup' });
      } else {
        undoWhy = last ? 'not measured: the booking toast (6 s) had already disappeared' : 'not measured: no booking';
      }

      const budget = uiBudget('U2.tap', v.profile);
      if (toast.length > 0) {
        r.addSamples('tap.toast', 'Tap → confirmation toast visible (opacity ≥ 0.5)', toast, budget, `max ${fmtMs(max(toast) as number)} ms`);
      } else {
        r.add({ key: 'tap.toast', label: 'Tap → confirmation toast visible', value: null, unit: 'ms', detail: 'not applicable: only one offering (the toast text never changes)' });
      }
      r.addSamples('tap.total', 'Tap → person total updated', total, budget, `max ${fmtMs(max(total) ?? NaN)} ms`);
      r.add({
        key: 'requests',
        label: 'Requests per tap',
        value: median(requests),
        unit: 'count',
        detail: `${kinds} – the POST plus two refetch rounds (mutation + own realtime echo); Phase 1B: 5`,
      });
      r.add({ key: 'undo', label: '"Rückgängig" → total restored', value: undo, unit: 'ms', detail: undoWhy || undefined });
      r.add({
        key: 'interaction',
        label: 'Tap interaction latency (Event Timing, input → next paint)',
        value: max(interaction),
        unit: 'ms',
        detail: interaction.length ? `per tap: ${interaction.map(fmtMs).join(' · ')} ms` : 'no Event Timing entry ≥ 16 ms',
      });
      r.data.taps = { toast, total, requests, interaction };
      if (toast.length > 1) {
        r.note(
          `The first tap mounts a new toast that fades in (opacity ≥ 0.5 after ${fmtMs(toast[0] as number)} ms); later taps ` +
            'update the visible toast in place – hence the gap between the first and the other taps.',
        );
      }
    } finally {
      await page.close();
      await deleteBookings(env, username, page.createdBookings);
    }
  },
};

// ------------------------------------------------------------------ U3

interface Keystroke {
  label: string;
  /** The search text after the keystroke. */
  value: string;
  key: { type: string } | { clear: true };
}

/** Typing `texts` one character at a time; '' = clear the field (select all + Backspace). */
function keystrokes(texts: string[]): Keystroke[] {
  const steps: Keystroke[] = [];
  for (const text of texts) {
    if (text === '') {
      steps.push({ label: 'clear', value: '', key: { clear: true } });
      continue;
    }
    let value = '';
    for (const char of text) {
      value += char;
      steps.push({ label: `"${value}"`, value, key: { type: char } });
    }
  }
  return steps;
}

/**
 * Types the keystrokes into a focused search field – real key events, also for
 * "ü" (UiPage.typeChar) – and times each one: until the expected result list
 * is painted, or – if the visible list does not change – until the frame after
 * the key press.
 */
export async function timeKeystrokes(
  page: UiPage,
  steps: readonly Keystroke[],
  expected: (value: string) => { cond: Cond; signature: string },
  initialSignature: string,
  labelSuffix = '',
): Promise<Array<{ label: string; ms: number; block: number; visible: boolean }>> {
  const out: Array<{ label: string; ms: number; block: number; visible: boolean }> = [];
  let signature = initialSignature;
  for (const step of steps) {
    const next = expected(step.value);
    const visible = next.signature !== signature;
    if ('clear' in step.key) await page.page.keyboard.press('ControlOrMeta+A');
    const key = step.key;
    const m = await page.measure(
      visible ? { list: next.cond } : { painted: { input: true } },
      () => ('clear' in key ? page.page.keyboard.press('Backspace') : page.typeChar(key.type)),
      { label: `keystroke ${step.label}${labelSuffix}` },
    );
    const end = visible ? paintedAt(m, 'list') : (m.inputPaint ?? paintedAt(m, 'painted'));
    await page.waitQuiet({ quietMs: 250, before: 'the next keystroke' });
    const block = (await page.longTasks(m.start, end)).total;
    out.push({ label: step.label, ms: end - m.start, block, visible });
    signature = next.signature;
  }
  return out;
}

export const U3: UiScenario = {
  id: 'U3',
  title: 'Person picker',
  simulates: 'A bartender opens the person picker for a new guest and types a name or number to find them.',
  variants: perProfile('U3', 'Person picker', ['phone', 'desktop'], ['phone']),
  timeoutMs: 90_000,
  async run(env, v, r) {
    const person = env.person(2);
    const all = env.fixtures.persons;
    const page = await openBuchen(env, v.profile, 'user1', person);
    try {
      const initial = searchPersons(all, '');
      const button = page.page.getByRole('button', { name: /^Person wechseln/ });
      // opened several times (the picker is remounted each time); the last one stays open for the typing
      const opens: number[] = [];
      for (let run = 1; run <= env.runs; run++) {
        env.signal.throwIfAborted();
        const open = await page.measure({ open: pickerState(initial) }, () => page.press(button), { label: `open (run ${run})` });
        opens.push(paintedAt(open, 'open') - open.start);
        await page.waitQuiet({ quietMs: 400, before: run < env.runs ? 'closing the picker' : 'typing' });
        if (run < env.runs) {
          await page.measure({ closed: { sel: SEL.picker, absent: true } }, () => page.press(page.page.getByTestId('dialog-close')), {
            label: '',
          });
          await page.waitQuiet({ quietMs: 300, before: 'opening the picker again' });
        }
      }

      await page.page.locator(SEL.pickerSearch).focus();
      const steps = keystrokes(env.quick ? ['müller', '', '1234'] : ['müller', '', '1234', '', 'a']);
      const keys = await timeKeystrokes(
        page,
        steps,
        (value) => {
          const results = searchPersons(all, value);
          return { cond: pickerState(results), signature: pickerSignature(results) };
        },
        pickerSignature(initial),
      );
      const times = keys.map((k) => k.ms);
      r.addSamples('open', 'Tap → picker with the first 60 persons visible', opens, uiBudget('U3.open', v.profile));
      r.add({
        key: 'keystroke.p95',
        label: 'Keystroke → result list painted (p95)',
        value: pct(times, 95),
        unit: 'ms',
        budget: uiBudget('U3.keystroke', v.profile),
        detail: keys.map((k) => `${k.label} ${fmtMs(k.ms)}${k.visible ? '' : '*'}`).join(' · ') + ' ms (* list unchanged: next paint)',
      });
      r.add({ key: 'keystroke.median', label: 'Keystroke → result list painted (median)', value: median(times), unit: 'ms' });
      r.data.keystrokes = keys;
    } finally {
      await page.close();
    }
  },
};

export { keystrokes, type Keystroke };
