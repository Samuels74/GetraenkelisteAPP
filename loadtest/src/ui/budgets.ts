/**
 * Budgets of the browser checks (Phase 1B proposal, docs/LOADTEST.md "UI
 * checks"). WARN = a delay users notice, FAIL = a user-visible problem. They
 * express user expectations at the bar, not the current numbers: known slow
 * spots are expected to WARN (Personen search, rush jank, QR sheet) and must
 * not be "fixed" by moving a limit. All values in ms; phone = Pixel 7
 * emulation with 4× CPU throttling, desktop = Desktop Chrome.
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
    rationale: 'opening the app at the bar: from 1.5 s (phone) the start feels sluggish, 4 s is a broken start; baseline 0.33–0.38 s / 0.18 s',
  },
  'U2.tap': {
    phone: { warn: 300, fail: 1000 },
    desktop: { warn: 200, fail: 1000 },
    rationale: 'a tap must confirm immediately; from 1 s bartenders tap twice; baseline 30–86 ms',
  },
  'U3.open': {
    ...both(300, 1000),
    rationale: 'the person picker is opened for nearly every guest; baseline 72 ms phone',
  },
  'U3.keystroke': {
    ...both(100, 200),
    rationale: 'typing must keep up with the fingers: 100 ms per keystroke is noticeable lag, 200 ms makes typing jumpy; baseline 8–32 ms',
  },
  'U4.ready': {
    phone: { warn: 2000, fail: 5000 },
    desktop: { warn: 800, fail: 2000 },
    rationale: 'Personen is a list screen: 2 s / 0.8 s is noticeable, 5 s / 2 s a problem; baseline 1.32 s / 0.36 s',
  },
  'U4.keystroke': {
    ...both(300, 1000),
    rationale: 'search must keep up with typing: 300 ms feels laggy, 1 s is broken; baseline "clear" 770 ms on the phone (known WARN)',
  },
  'U4.tab': {
    ...both(300, 1000),
    rationale:
      'switching to the Personen tab with cached data is an interaction, like a keystroke: 300 ms feels laggy, 1 s is broken; phone ≈ 0.66–0.83 s (known WARN)',
  },
  'U5.block': {
    ...both(100, 300),
    rationale: 'per booking of another device the main thread must not freeze visibly: 100 ms is a hitch, 300 ms makes taps and scrolling stutter; baseline ≈133 ms phone (known WARN)',
  },
  'U6.ready': {
    phone: { warn: 3000, fail: 8000 },
    desktop: { warn: 1000, fail: 3000 },
    rationale: 'print sheet of all persons – rarely used, so generous; baseline 1.34 s / 0.39 s',
  },
  'U6.longTask': {
    ...both(500, 2000),
    rationale: 'one frozen frame of 500 ms is visible, 2 s risks the "page unresponsive" dialog; baseline 738 ms phone (known WARN)',
  },
  'U7.cold': {
    phone: { warn: 1500, fail: 4000 },
    desktop: { warn: 1000, fail: 3000 },
    rationale: 'Buchungen opens with the whole history ("Alle"); baseline 0.46 s / 0.15 s',
  },
  'U7.step': {
    ...both(500, 2000),
    rationale: 'a filter change should answer within half a second, 2 s feels broken',
  },
  'U7.more': {
    ...both(300, 1000),
    rationale: '"Weitere laden" appends 50 rows; baseline 95–167 ms phone (up to 550 rows)',
  },
  'U7.perPerson': {
    ...both(1000, 3000),
    rationale: 'the per-person view renders every person; baseline 0.77 s phone / 0.2 s desktop',
  },
  'U8.export': {
    phone: { warn: 5000, fail: 15_000 },
    desktop: { warn: 3000, fail: 10_000 },
    rationale: 'exporting the whole history (≈15k rows, 30 requests, ≈18 MiB) on localhost; baseline 1.45 s / 1.09 s',
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
