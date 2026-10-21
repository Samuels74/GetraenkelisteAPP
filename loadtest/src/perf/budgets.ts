/**
 * Budgets shared by several scenarios (docs/LOADTEST.md "Budgets" explains
 * them). FAIL marks a user-visible problem, WARN a noticeable delay or the
 * regression margin (typically 3–10× the measured baseline on the reference
 * machine, a 16-thread desktop CPU). They apply to a load-test instance on
 * localhost: real networks add their latency on top.
 */
import type { Budget } from './types.ts';

/** Small requests (≤ ~10 KB): groups, offerings, users, one person's totals (card summary, realtime row), recent, create/delete, refresh. */
export const SMALL_REQUEST: Budget = {
  direction: 'max',
  warn: 25,
  fail: 100,
  rationale: 'p95 of a small request on an idle server; baseline 1–3 ms – a tap that waits > 100 ms feels sluggish',
};

/** One page (50) of the booking list with the SPA's expand. */
export const LIST_PAGE: Budget = {
  direction: 'max',
  warn: 50,
  fail: 200,
  rationale: 'p95 of one booking-list page (50 rows + expand, ≈ 64 KB); baseline 2–4 ms (keyset pages at any depth; offset paging before the fixes: ≈ 15 ms at offset 14,450)',
};

/** The persons list as the SPA loads it: getFullList → 3 sequential pages. */
export const PERSONS_SEQUENCE: Budget = {
  direction: 'max',
  warn: 150,
  fail: 500,
  rationale: 'p95 of the 3 sequential pages (≈ 421 KB) the picker / Personen screen need; baseline ≈ 15 ms',
};

/** GET /api/app/totals aggregating many bookings (per person, periods, nur meine, the admin parts). */
export const TOTALS_LARGE: Budget = {
  direction: 'max',
  warn: 100,
  fail: 300,
  rationale:
    'p95 of a totals request over many bookings; the per-person rows of all 2000 persons ≈ 250 KB and ≈ 25–40 ms, summaries a few ms ' +
    '(before the fixes every request computed all four parts: ≈ 45–55 ms)',
};

/** Size of the per-person totals of all bookings (one row per person). */
export const TOTALS_ALL_SIZE: Budget = {
  direction: 'max',
  warn: 400,
  rationale:
    'KiB of the per-person totals of all bookings – loaded when Personen / "Pro Person" open (before the fixes refetched by every big screen after every booking); baseline ≈ 250 KiB',
};

/** Booking create / delete under realistic load (from the intended send time). */
export const MUTATION_UNDER_LOAD: Budget = {
  direction: 'max',
  warn: 50,
  fail: 250,
  rationale: 'p95 tap → server answer from the scheduled time; baseline 3 ms – > 250 ms is a visibly slow toast',
};

/** Booking → visible on the other devices. */
export const PROPAGATION: Budget = {
  direction: 'max',
  warn: 500,
  fail: 1500,
  rationale: 'p95 booking → shown on the other devices whose screen shows it; baseline ≈ 170 ms (120 ms debounce) – > 1.5 s looks out of sync',
};

/** Any failed request in a realistic scenario. */
export const NO_ERRORS: Budget = {
  direction: 'max',
  fail: 0,
  rationale: 'every failed request is a user-visible error (lost booking, error toast, stale screen)',
};
