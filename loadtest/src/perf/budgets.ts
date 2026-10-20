/**
 * Budgets shared by several scenarios (docs/LOADTEST.md "Budgets" explains
 * them). FAIL marks a user-visible problem, WARN a noticeable delay or the
 * regression margin (typically 3–10× the measured baseline on the reference
 * machine, a 16-thread desktop CPU). They apply to a load-test instance on
 * localhost: real networks add their latency on top.
 */
import type { Budget } from './types.ts';

/** Small requests (≤ ~10 KB): groups, offerings, users, totals(person), recent, create/delete, refresh. */
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
  rationale: 'p95 of one booking-list page (50 rows + expand, ≈ 64 KB); baseline 2–4 ms, ≈ 15 ms at offset 14,450',
};

/** The persons list as the SPA loads it: getFullList → 3 sequential pages. */
export const PERSONS_SEQUENCE: Budget = {
  direction: 'max',
  warn: 150,
  fail: 500,
  rationale: 'p95 of the 3 sequential pages (≈ 421 KB) the picker / Personen screen need; baseline ≈ 15 ms',
};

/** GET /api/app/totals with many rows (all, periods, nur meine). */
export const TOTALS_LARGE: Budget = {
  direction: 'max',
  warn: 100,
  fail: 300,
  rationale: 'p95 of the totals endpoint (4 aggregate queries, ≈ 250 KB for all 2000 persons); baseline ≈ 45–55 ms',
};

/** Size of the reference totals (all bookings, all persons). */
export const TOTALS_ALL_SIZE: Budget = {
  direction: 'max',
  warn: 400,
  rationale: 'KiB per totals(all) response – refetched by Personen / Buchungen / admin screens after every booking; baseline 248 KiB',
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
  rationale: 'p95 booking → refetched on the other devices; baseline ≈ 170 ms (120 ms debounce) – > 1.5 s looks out of sync',
};

/** Any failed request in a realistic scenario. */
export const NO_ERRORS: Budget = {
  direction: 'max',
  fail: 0,
  rationale: 'every failed request is a user-visible error (lost booking, error toast, stale screen)',
};
