/**
 * U10: the admin screens that load totals only to mark records as "in use"
 * – since the fixes just the part they need (`parts=perOffering` /
 * `parts=perUser`, ≈ 1 KB; before: the complete totals, ≈ 257 KB).
 */
import { uiBudget } from '../budgets.ts';
import { describeKinds, paintedAt } from '../browser.ts';
import { angeboteLoad, benutzerLoad } from '../conditions.ts';
import type { Conds } from '../probe.ts';
import { fmtMs, median } from '../result.ts';
import { KiB, perProfile, sumBytes, type UiEnv, type UiScenario } from '../scenario.ts';

async function screens(env: UiEnv): Promise<Array<{ key: string; label: string; path: string; conds: Conds }>> {
  const totals = await env.rest.totals(env.login('admin').token, {}, ['perOffering']);
  const booked = new Set(totals.perOffering.map((entry) => entry.offeringId));
  const offerings = env.fixtures.allOfferings.length;
  const bookedRows = env.fixtures.allOfferings.filter((offering) => booked.has(offering.id)).length;
  return [
    {
      key: 'angebote',
      label: `Verwaltung → Angebote: ${offerings} offerings with "Gebucht" badges painted`,
      path: '/verwaltung/angebote',
      conds: angeboteLoad(offerings, bookedRows),
    },
    {
      key: 'benutzer',
      label: `Verwaltung → Benutzer: ${env.fixtures.users.length} users painted`,
      path: '/verwaltung/benutzer',
      conds: benutzerLoad(env.fixtures.users.length),
    },
  ];
}

export const U10: UiScenario = {
  id: 'U10',
  title: 'Admin screens',
  simulates: 'The admin opens Verwaltung → Angebote and → Benutzer.',
  variants: perProfile('U10', 'Admin screens', ['phone', 'desktop'], ['desktop']),
  timeoutMs: 120_000,
  async run(env, v, r) {
    const login = env.login('admin');
    for (const screen of await screens(env)) {
      const ready: number[] = [];
      const kib: number[] = [];
      let kinds = '';
      for (let run = 1; run <= env.runs; run++) {
        env.signal.throwIfAborted();
        const page = await env.open({ profile: v.profile, login, load: { conds: screen.conds } });
        const load = await page.load(screen.path, { label: `${screen.key}.ready (run ${run})` });
        ready.push(paintedAt(load, 'ready'));
        await page.waitQuiet({ quietMs: 500, before: 'counting the requests' });
        const api = page.requests.filter((x) => x.api);
        kinds = describeKinds(api);
        kib.push(KiB(sumBytes(api)));
        await page.close();
        env.log(`${v.id}: ${screen.key} run ${run}/${env.runs}: ready ${fmtMs(ready.at(-1) as number)} ms`);
      }
      r.addSamples(`${screen.key}.ready`, `Cold start → ${screen.label}`, ready, uiBudget('U10.ready', v.profile));
      r.add({ key: `${screen.key}.api`, label: `API data of ${screen.path}`, value: median(kib), unit: 'KiB', detail: kinds });
    }
    r.note(
      'Angebote and Benutzer download only the per-offering / per-user part of the totals (`parts=perOffering` / `parts=perUser`) to know ' +
        'which offerings / users have bookings – before the fixes the complete totals incl. one row per person (≈ 257 KiB).',
    );
  },
};
