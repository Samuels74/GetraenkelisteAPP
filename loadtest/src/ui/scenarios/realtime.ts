/**
 * U9: realtime propagation between real browsers – phone A books, phone B
 * (same guest selected) and a laptop on Buchungen must show it.
 */
import { uiBudget } from '../budgets.ts';
import { paintedAt, PROFILES } from '../browser.ts';
import { bookingsState, bookingToast, personTotal, SEL } from '../conditions.ts';
import { fmtMs, max, median } from '../result.ts';
import { buchenExpect, deleteBookings, type UiScenario } from '../scenario.ts';

export const U9: UiScenario = {
  id: 'U9',
  title: 'Realtime propagation',
  simulates:
    'Two bartenders serve the same guest on two phones while the host watches Buchungen on a laptop: a booking on phone A must appear on phone B and on the laptop.',
  variants: () => [
    {
      id: 'U9',
      title: 'Realtime propagation (phone A → phone B + laptop)',
      profile: 'phone',
      devices: ['phone', 'desktop'],
      deviceLabel: `phones A and B: ${PROFILES.phone.label}; laptop: ${PROFILES.desktop.label}`,
    },
  ],
  timeoutMs: 120_000,
  async run(env, _v, r) {
    const person = env.person(8);
    const users = { a: 'user1', b: env.ctx.logins.user2 ? 'user2' : 'user1', laptop: env.ctx.logins.user3 ? 'user3' : 'user1' };
    const offerings = env.fixtures.offerings;
    const tokenA = env.login(users.a).token;
    const personTotals = await env.rest.totals(tokenA, { person: person.id });
    const allTotals = await env.rest.totals(tokenA);
    const buchen = await buchenExpect(env, users.a, person);
    const a = await env.open({ profile: 'phone', login: env.login(users.a), selectedPersonId: person.id, load: { conds: buchen } });
    const b = await env.open({ profile: 'phone', login: env.login(users.b), selectedPersonId: person.id, load: { conds: buchen } });
    const laptop = await env.open({
      profile: 'desktop',
      login: env.login(users.laptop),
      load: { conds: { ready: bookingsState({ filterKey: '', count: allTotals.count, totalCents: allTotals.totalCents }) } },
    });
    try {
      await Promise.all([a.load('/', { label: '' }), b.load('/', { label: '' }), laptop.load('/buchungen', { label: '' })]);
      await Promise.all([a, b, laptop].map((page) => page.waitQuiet({ quietMs: 500, before: 'the first round' })));

      const toB: number[] = [];
      const toLaptop: number[] = [];
      const toast: number[] = [];
      let total = personTotals.totalCents;
      let count = personTotals.count;
      let all = allTotals.count;
      const rounds = env.quick ? 2 : 5;
      for (let i = 0; i < rounds; i++) {
        env.signal.throwIfAborted();
        const offering = offerings[(i + 1) % offerings.length];
        if (!offering) break;
        total += offering.priceCents;
        count += 1;
        all += 1;
        const waitB = await b.watch({ total: personTotal(total, count) }, { label: `round ${i + 1}: phone B` });
        const waitLaptop = await laptop.watch({ count: { sel: SEL.bookingsCount, text: String(all) } }, { label: `round ${i + 1}: laptop` });
        const tile = a.page.locator(`${SEL.tile}[data-offering-id="${offering.id}"]`);
        const m = await a.measure({ toast: bookingToast(offering.name, offering.priceCents) }, () => a.press(tile), {
          allowStale: offerings.length === 1,
          label: `round ${i + 1}: phone A tap → toast`,
        });
        const tapped = m.origin + m.start;
        const [wb, wl] = await Promise.all([waitB(), waitLaptop()]);
        toB.push(wb.origin + paintedAt(wb, 'total') - tapped);
        toLaptop.push(wl.origin + paintedAt(wl, 'count') - tapped);
        toast.push(paintedAt(m, 'toast') - m.start);
        await Promise.all([a, b, laptop].map((page) => page.waitQuiet({ quietMs: 500, before: 'the next round' })));
        env.log(`U9: round ${i + 1}/${rounds}: phone B ${fmtMs(toB.at(-1) as number)} ms, laptop ${fmtMs(toLaptop.at(-1) as number)} ms`);
      }
      const budget = uiBudget('U9.propagation', 'phone');
      r.addSamples('phoneB', 'Tap on phone A → phone B shows the new total', toB, budget, `max ${fmtMs(max(toB) ?? NaN)} ms`);
      r.addSamples('laptop', 'Tap on phone A → laptop (Buchungen "Alle") shows the new count', toLaptop, budget, `max ${fmtMs(max(toLaptop) ?? NaN)} ms`);
      r.addSamples('phoneA.toast', 'Tap on phone A → its own confirmation toast visible', toast);
      r.note(
        `Propagation includes the app's 120 ms realtime debounce and the refetch of the affected queries ` +
          `(median phone B ${fmtMs(median(toB) ?? NaN)} ms, laptop ${fmtMs(median(toLaptop) ?? NaN)} ms).`,
      );
    } finally {
      await Promise.all([a.close(), b.close(), laptop.close()]);
      await deleteBookings(env, users.a, a.createdBookings);
    }
  },
};
