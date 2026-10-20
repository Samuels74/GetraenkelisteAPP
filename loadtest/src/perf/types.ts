/**
 * Contract between the performance-check runner and the scenario modules –
 * the API scenarios (src/perf/) and the browser timings (src/ui/). Every
 * scenario returns ScenarioResult objects; the runner writes them to
 * test-results/loadtest/{report.md,results.json} and derives the exit code
 * from the verdicts (any 'fail' → exit code 1, 'warn' is reported only).
 *
 * Budgets: WARN marks a noticeable delay or a regression margin, FAIL a
 * user-visible problem. docs/LOADTEST.md explains every budget.
 */
import type { Instance } from '../instance.ts';
import type { SeedSummary } from '../seed.ts';

export type Verdict = 'pass' | 'warn' | 'fail' | 'info';

export type Unit = 'ms' | 's' | 'B' | 'KiB' | 'MiB' | 'KiB/s' | 'MiB/s' | '%' | 'rps' | 'count' | 'devices';

/**
 * Limits for one metric. 'max': the value must stay at or below the limits
 * (latency, bytes); 'min': at or above them (throughput, knee).
 */
export interface Budget {
  direction: 'max' | 'min';
  warn?: number;
  fail?: number;
  /** One line: why this limit (shown in the report). */
  rationale?: string;
}

export interface Metric {
  /** Stable key, unique within its scenario result, e.g. "post.p95" or "phone.ready.median". */
  key: string;
  label: string;
  /** null = could not be measured (say why in `detail`); evaluates to 'fail' if a FAIL limit is set. */
  value: number | null;
  unit: Unit;
  budget?: Budget;
  /** Derived with evaluate(); 'info' when there is no budget. */
  verdict: Verdict;
  detail?: string;
}

export interface ScenarioResult {
  /** "seeding", "A1" … "A11", "U1" … "U11"; variants may add a suffix, e.g. "U4-phone". */
  id: string;
  title: string;
  /** One sentence: the real-world situation this simulates. */
  simulates: string;
  /** ISO 8601. */
  startedAt: string;
  durationMs: number;
  /** worstVerdict() of the metrics; 'fail' when the scenario crashed (`error` set). */
  verdict: Verdict;
  metrics: Metric[];
  /** Observations in plain language, e.g. "page time grows linearly with the page index". */
  notes: string[];
  /** Set when the load generator or the browser was the bottleneck – the numbers are then unreliable. */
  clientBound?: { flagged: boolean; detail: string };
  /** The scenario crashed: message and the first stack lines. */
  error?: string;
  /** Extra machine-readable data for results.json (series, per-level tables, raw percentiles). */
  data?: Record<string, unknown>;
}

/** One logged-in app account, shared by all scenarios (avoids the login rate limiter). */
export interface Login {
  username: string;
  password: string;
  token: string;
  /** The auth record as returned by auth-with-password – what the SPA keeps in localStorage "pocketbase_auth". */
  record: Record<string, unknown>;
}

export interface ScenarioContext {
  url: string;
  instance: Instance;
  seed: SeedSummary;
  /** Keys "admin", "user1" … "user5". */
  logins: Record<string, Login>;
  /** LOADTEST_QUICK=1: short smoke run. */
  quick: boolean;
  /** Absolute path of test-results/loadtest/; scenarios may write extra files there (traces, raw data). */
  resultsDir: string;
  log: (message: string) => void;
  /** Aborted on Ctrl+C / SIGTERM: scenarios stop promptly and clean up (close browsers, delete their bookings). */
  signal?: AbortSignal;
}

export type Scenario = (ctx: ScenarioContext) => Promise<ScenarioResult[]>;

export function evaluate(value: number | null, budget: Budget | undefined): Verdict {
  if (!budget || (budget.warn === undefined && budget.fail === undefined)) return 'info';
  if (value === null || Number.isNaN(value)) return budget.fail !== undefined ? 'fail' : 'warn';
  const beyond = (limit: number | undefined): boolean =>
    limit !== undefined && (budget.direction === 'max' ? value > limit : value < limit);
  if (beyond(budget.fail)) return 'fail';
  if (beyond(budget.warn)) return 'warn';
  return 'pass';
}

const RANK: Record<Verdict, number> = { info: 0, pass: 1, warn: 2, fail: 3 };

export function worstVerdict(verdicts: Iterable<Verdict>): Verdict {
  let worst: Verdict = 'info';
  for (const verdict of verdicts) {
    if (RANK[verdict] > RANK[worst]) worst = verdict;
  }
  return worst;
}

/** Builds a metric and derives its verdict from the budget. */
export function metric(fields: Omit<Metric, 'verdict'>): Metric {
  return { ...fields, verdict: evaluate(fields.value, fields.budget) };
}
