/**
 * Budgets of the browser checks (Phase 1B proposal, docs/LOADTEST.md "UI
 * checks"). WARN = a delay users notice, FAIL = a user-visible problem. They
 * express user expectations at the bar, not the current numbers: slow spots
 * must WARN and are never "fixed" by moving a limit – before the 2026-10-20
 * fixes the Personen search and tab switch, the rush jank on Personen and the
 * QR sheet WARNed on the phone; the fixes did not touch the limits (the
 * rationales note the old and the new baseline). All values in ms; phone =
 * Pixel 7 emulation with 4× CPU throttling, desktop = Desktop Chrome.
 */
import type { Budget } from '../perf/types.ts';
import type { ProfileName } from './browser.ts';

interface Limits {
  warn: number;
  fail: number;
}

interface BudgetDef {
  phone: Limits;
  desktop: Limits;
  rationale: string;
}

const both = (warn: number, fail: number) => ({ phone: { warn, fail }, desktop: { warn, fail } });

export const UI_BUDGETS = {
  'U1.ready': {
    phone: { warn: 1500, fail: 4000 },
    desktop: { warn: 1000, fail: 3000 },
    rationale: 'opening the app at the bar: from 1.5 s (phone) the start feels sluggish, 4 s is a broken start; baseline ≈ 0.28 s / 0.1 s',
  },
  'U2.tap': {
    phone: { warn: 300, fail: 1000 },
    desktop: { warn: 200, fail: 1000 },
    rationale: 'a tap must confirm immediately; from 1 s bartenders tap twice; baseline 30–86 ms',
  },
  'U3.open': {
    ...both(300, 1000),
    rationale: 'the person picker is opened for nearly every guest; baseline ≈ 70–80 ms phone',
  },
  'U3.keystroke': {
    ...both(100, 200),
    rationale: 'typing must keep up with the fingers: 100 ms per keystroke is noticeable lag, 200 ms makes typing jumpy; baseline 8–32 ms',
  },
  'U4.ready': {
    phone: { warn: 2000, fail: 5000 },
    desktop: { warn: 800, fail: 2000 },
    rationale:
      'Personen is a list screen: 2 s / 0.8 s is noticeable, 5 s / 2 s a problem; baseline 1.3 s / 0.34 s before the fixes (all 2000 rows), ≈ 0.35 s / 0.1 s with the first 100 rows',
  },
  'U4.keystroke': {
    ...both(300, 1000),
    rationale: 'search must keep up with typing: 300 ms feels laggy, 1 s is broken; "clear" took ≈ 0.7 s on the phone before the fixes (WARN), now < 0.1 s',
  },
  'U4.tab': {
    ...both(300, 1000),
    rationale:
      'switching to the Personen tab with cached data is an interaction, like a keystroke: 300 ms feels laggy, 1 s is broken; phone ≈ 0.68 s before the fixes (WARN), now ≈ 0.1 s',
  },
  'U5.block': {
    ...both(100, 300),
    rationale:
      'per booking of another device the main thread must not freeze visibly: 100 ms is a hitch, 300 ms makes taps and scrolling stutter; ≈ 0.12 s on the phone before the fixes (WARN), now 0',
  },
  'U6.ready': {
    phone: { warn: 3000, fail: 8000 },
    desktop: { warn: 1000, fail: 3000 },
    rationale:
      'print sheet of all persons – rarely used, so generous; 1.3 s / 0.34 s in one commit before the fixes, ≈ 1.5–1.8 s / 0.4 s now (step by step, the first 100 cards after ≈ 0.35 s)',
  },
  'U6.longTask': {
    ...both(500, 2000),
    rationale: 'one frozen frame of 500 ms is visible, 2 s risks the "page unresponsive" dialog; 0.74 s on the phone before the fixes (WARN), now ≈ 0.1 s',
  },
  'U7.cold': {
    phone: { warn: 1500, fail: 4000 },
    desktop: { warn: 1000, fail: 3000 },
    rationale: 'Buchungen opens with the whole history ("Alle"); baseline ≈ 0.3 s / 0.1 s',
  },
  'U7.step': {
    ...both(500, 2000),
    rationale: 'a filter change should answer within half a second, 2 s feels broken',
  },
  'U7.more': {
    ...both(300, 1000),
    rationale: '"Weitere laden" appends 50 rows (a keyset page); baseline ≈ 0.06–0.12 s phone (up to 550 rows)',
  },
  'U7.perPerson': {
    ...both(1000, 3000),
    rationale: 'the per-person view (its rows are loaded when it opens); baseline 0.64 s phone / 0.17 s desktop before the fixes (all rows rendered)',
  },
  'U7.filterOpen': {
    ...both(300, 1000),
    rationale: 'the person filter of Buchungen opens the person picker – the same expectation as the picker on Buchen (U3.open)',
  },
  more100: {
    ...both(300, 1000),
    rationale: '"Weitere 100 anzeigen" (Personen, "Pro Person") appends 100 rows – a tap like "Weitere laden": 300 ms is noticeable, 1 s broken',
  },
  'U8.export': {
    phone: { warn: 5000, fail: 15_000 },
    desktop: { warn: 3000, fail: 10_000 },
    rationale: 'exporting the whole history (≈15k rows, 30 requests, ≈18 MiB) on localhost; 1.8 s / 1.25 s before the fixes (quadratic keyset pages), ≈ 0.8 s on the desktop now',
  },
  'U9.propagation': {
    ...both(1000, 3000),
    rationale: 'two devices serving the same person must see each other\'s bookings within about a second; 3 s invites double bookings; baseline ≈0.15–0.2 s',
  },
  'U10.ready': {
    phone: { warn: 1500, fail: 4000 },
    desktop: { warn: 1000, fail: 3000 },
    rationale: 'admin screens; baseline 0.27 s / 0.11 s',
  },
} satisfies Record<string, BudgetDef>;

export type BudgetKey = keyof typeof UI_BUDGETS;

/**
 * The CPU calibration (same JS work on both profiles) must show the phone's 4×
 * throttling: outside 60–160 % of the target ratio the phone timings are not
 * valid, so the phone variants FAIL instead of passing on a fast CPU.
 */
export const THROTTLING_TOLERANCE = { min: 0.6, max: 1.6 } as const;

/** The 'max' budget of a metric for a profile. */
export function uiBudget(key: BudgetKey, profile: ProfileName): Budget {
  const def: BudgetDef = UI_BUDGETS[key];
  const limits = def[profile];
  return { direction: 'max', warn: limits.warn, fail: limits.fail, rationale: def.rationale };
}
