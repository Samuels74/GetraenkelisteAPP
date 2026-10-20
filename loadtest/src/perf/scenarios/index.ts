/**
 * The API scenarios and the order of the default run
 * (docs/LOADTEST.md "Performance checks"):
 *
 *   seeding → A1 → A2 → A2b → U1 … U11 → A5 → A6 → A7 → A8 → A10 → A3 → A4 → A9
 *
 * - A1 first: it measures the freshly seeded database before the planner
 *   statistics are switched to the production steady state (A1-planner).
 * - The browser checks (U*) after the rushes: "Heute" then has bookings.
 * - A3 (stress) and A4 (≈ 4,500 extra bookings) near the end, A9 last: it
 *   switches the login rate limiter on.
 * - A11 (soak, 35 min) only with LOADTEST_SOAK=1, before the stress part.
 */
import type { PerfContext } from '../scenario.ts';
import type { ScenarioResult } from '../types.ts';
import { scenarioA1 } from './a01-baseline.ts';
import { scenarioA2 } from './a02-rush.ts';
import { scenarioA3 } from './a03-sweep.ts';
import { scenarioA4 } from './a04-writes.ts';
import { scenarioA5 } from './a05-csv.ts';
import { scenarioA6 } from './a06-persons.ts';
import { scenarioA7 } from './a07-totals.ts';
import { scenarioA8 } from './a08-paging.ts';
import { scenarioA9 } from './a09-login.ts';
import { scenarioA10 } from './a10-fanout.ts';
import { scenarioA11 } from './a11-soak.ts';

export type ApiScenario = (ctx: PerfContext) => Promise<ScenarioResult[]>;

export interface ApiScenarioEntry {
  id: string;
  title: string;
  run: ApiScenario;
  /** Only with LOADTEST_SOAK=1. */
  optIn?: boolean;
}

export const API_SCENARIOS: readonly ApiScenarioEntry[] = [
  { id: 'A1', title: 'Single-request baseline (+ A1-planner, A1-empty)', run: scenarioA1 },
  { id: 'A2', title: 'Bar rush (realistic)', run: scenarioA2('A2') },
  { id: 'A2b', title: 'Bar rush with heavy screens open', run: scenarioA2('A2b') },
  { id: 'A3', title: 'Concurrency sweep (knee)', run: scenarioA3 },
  { id: 'A4', title: 'Write contention', run: scenarioA4 },
  { id: 'A5', title: 'CSV export of all bookings', run: scenarioA5 },
  { id: 'A6', title: 'Persons list burst', run: scenarioA6 },
  { id: 'A7', title: 'Totals variants under load', run: scenarioA7 },
  { id: 'A8', title: 'Deep paging and refetch of all loaded pages', run: scenarioA8 },
  { id: 'A9', title: 'Logins and the login rate limiter', run: scenarioA9 },
  { id: 'A10', title: 'Realtime fan-out capacity', run: scenarioA10 },
  { id: 'A11', title: 'Soak (opt-in)', run: scenarioA11, optIn: true },
];

/** The default order; "UI" is the slot of the browser checks (src/ui/index.ts). */
export const RUN_ORDER: readonly string[] = ['A1', 'A2', 'A2b', 'UI', 'A5', 'A6', 'A7', 'A8', 'A10', 'A11', 'A3', 'A4', 'A9'];

/** Ids of the browser checks (for LOADTEST_SCENARIOS validation). */
export const UI_IDS: readonly string[] = ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8', 'U9', 'U10', 'U11'];
