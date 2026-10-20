/**
 * Scaffolding shared by the API scenarios: the extended context the runner
 * passes to them, and ScenarioRecorder, which turns measurements into a
 * ScenarioResult (types.ts – the contract shared with the browser timings).
 *
 * Every scenario runs isolated (runScenario): a crash becomes a 'fail'
 * result with the error, the run continues. Measurement windows sample the
 * PocketBase process and the machine (server.ts) and the load generator's
 * own health (health.ts); a saturated generator flags the scenario as
 * client-bound instead of blaming the server. The machine's background load
 * (other processes' CPU, load average) is recorded per scenario, because the
 * machine may be shared (another test run, a browser, a build).
 */
import os from 'node:os';
import type { OfferingPlan } from '../dataset.ts';
import { HealthProbe, judgeClient, type ThreadHealth } from './health.ts';
import type { PlannerInfo, PlannerState } from './planner.ts';
import { dbFileSizes, ProcessSampler, type DbFileSizes, type ServerStats } from './server.ts';
import { metric, worstVerdict, type Metric, type ScenarioContext, type ScenarioResult, type Verdict } from './types.ts';

export interface CatalogPerson {
  id: string;
  number: string;
  name: string;
}

export interface CatalogOffering extends OfferingPlan {
  id: string;
}

/** Records the scenarios need (ids), loaded once after seeding. */
export interface Catalog {
  /** Sorted by number ("1" … "2000"). */
  persons: CatalogPerson[];
  offerings: CatalogOffering[];
  /** The browser's / the dataset's time zone. */
  timeZone: string;
}

/** What the runner passes to the API scenarios (a superset of the contract's ScenarioContext). */
export interface PerfContext extends ScenarioContext {
  signal: AbortSignal;
  catalog: Catalog;
  plannerState(): PlannerState;
  /** Production steady state of the planner statistics (planner.ts); idempotent. */
  ensureSteadyState(): Promise<PlannerInfo>;
}

/** A table in ScenarioResult.data.tables (report.ts renders them). */
export interface ReportTable {
  title: string;
  columns: string[];
  rows: Array<Array<string | number>>;
}

export interface ScenarioMeta {
  id: string;
  title: string;
  simulates: string;
}

export interface WindowStats {
  label: string;
  server: ServerStats | null;
  client: ThreadHealth;
}

export type MetricFields = Omit<Metric, 'verdict'> & {
  /** Plain-language consequence for the user, given the verdict (appended to `detail`). */
  explain?: (verdict: Verdict, value: number | null) => string | undefined;
};

/** Collects metrics, notes, data and client-health findings of one scenario result. */
export class ScenarioRecorder {
  readonly ctx: PerfContext;
  readonly meta: ScenarioMeta;
  readonly metrics: Metric[] = [];
  readonly notes: string[] = [];
  readonly data: Record<string, unknown> = {};
  private readonly threads: ThreadHealth[] = [];
  private readonly windows: WindowStats[] = [];

  constructor(ctx: PerfContext, meta: ScenarioMeta) {
    this.ctx = ctx;
    this.meta = meta;
  }

  /** Adds a metric; `explain` turns the verdict into a sentence for the report. */
  add(fields: MetricFields): Metric {
    const { explain, ...plain } = fields;
    const built = metric(plain);
    const consequence = explain?.(built.verdict, built.value);
    if (consequence) built.detail = built.detail ? `${built.detail} – ${consequence}` : consequence;
    this.metrics.push(built);
    return built;
  }

  /** An informational metric (no budget). */
  info(key: string, label: string, value: number | null, unit: Metric['unit'], detail?: string): Metric {
    return this.add({ key, label, value, unit, detail });
  }

  note(text: string): void {
    this.notes.push(text);
  }

  /** A table for the report (stored in data.tables; rendered below the metrics). */
  table(title: string, table: { columns: string[]; rows: Array<Array<string | number>> }): void {
    const tables = (this.data.tables ??= []) as ReportTable[];
    tables.push({ title, ...table });
  }

  /** Client health of threads that ran outside a window() (worker threads). */
  addClientHealth(threads: readonly ThreadHealth[]): void {
    this.threads.push(...threads);
  }

  /**
   * Starts sampling PocketBase + the machine + this thread's health. stop()
   * returns the stats – of the given absolute time range (e.g. a fleet's
   * measurement window) or of the whole sampling period; `server` gives the
   * stats of further sub-ranges (e.g. sweep levels) before stop().
   */
  window(label = 'main'): { stop(range?: { from: number; to: number }): WindowStats; server(range: { from: number; to: number }): ServerStats | null } {
    const sampler = new ProcessSampler(this.ctx.instance.pid).start();
    const probe = new HealthProbe(label).start();
    return {
      stop: (range) => {
        const stats: WindowStats = { label, server: sampler.stop(range), client: probe.stop() };
        this.windows.push(stats);
        this.threads.push(stats.client);
        return stats;
      },
      server: (range) => sampler.stats(range),
    };
  }

  /** A window sampled outside of window() (e.g. around the seed). */
  addWindow(stats: WindowStats): void {
    this.windows.push(stats);
    this.threads.push(stats.client);
  }

  dbSizes(): DbFileSizes {
    return dbFileSizes(this.ctx.instance.dataDir);
  }

  /** Machine background load over all windows (for the report's validity hints). */
  machine(): { otherBusyCoresMean: number | null; otherBusyCoresMax: number | null } {
    const others = this.windows.map((w) => w.server?.otherBusyCores).filter((v): v is number => v !== undefined);
    if (others.length === 0) return { otherBusyCoresMean: null, otherBusyCoresMax: null };
    const mean = others.reduce((a, b) => a + b, 0) / others.length;
    return { otherBusyCoresMean: Math.round(mean * 100) / 100, otherBusyCoresMax: Math.max(...others) };
  }

  clientBound(): { flagged: boolean; detail: string } | undefined {
    return this.threads.length > 0 ? judgeClient(this.threads) : undefined;
  }

  windowsStats(): WindowStats[] {
    return this.windows;
  }
}

/**
 * Busy cores of other processes above which a scenario gets a validity note:
 * a quarter of the logical CPUs, at least one (4 of 16) – the same rule as the
 * browser checks (src/ui/machine.ts), so both parts of the report call a
 * machine busy alike.
 */
export const BUSY_MACHINE_CORES = Math.max(1, 0.25 * os.availableParallelism());

/** The message of a crashed scenario: first line + the first stack frames. */
export function describeCrash(caught: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) return 'interrupted';
  const err = caught instanceof Error ? caught : new Error(String(caught));
  return [err.message, ...(err.stack?.split('\n').slice(1, 4) ?? [])].join('\n');
}

/** Runs one scenario body isolated and builds its ScenarioResult. */
export async function runScenario(
  ctx: PerfContext,
  meta: ScenarioMeta,
  body: (rec: ScenarioRecorder) => Promise<void>,
): Promise<ScenarioResult> {
  const run = startScenario(ctx, meta);
  try {
    ctx.signal.throwIfAborted();
    await body(run.rec);
    return run.finish();
  } catch (caught) {
    return run.finish(caught);
  }
}

/** A scenario result in the making – for bodies that produce several results (A1 → A1, A1-planner, A1-empty). */
export function startScenario(ctx: PerfContext, meta: ScenarioMeta): { rec: ScenarioRecorder; finish(caught?: unknown): ScenarioResult } {
  const rec = new ScenarioRecorder(ctx, meta);
  const startedAt = new Date();
  const t0 = performance.now();
  const loadStart = os.loadavg()[0] ?? 0;
  return { rec, finish: (caught?: unknown) => finishScenario(rec, startedAt, t0, loadStart, caught === undefined ? undefined : describeCrash(caught, ctx.signal)) };
}

function finishScenario(rec: ScenarioRecorder, startedAt: Date, t0: number, loadStart: number, error: string | undefined): ScenarioResult {
  const { meta } = rec;
  const machine = rec.machine();
  if (machine.otherBusyCoresMean !== null && machine.otherBusyCoresMean > BUSY_MACHINE_CORES) {
    rec.note(
      `Other processes kept ${machine.otherBusyCoresMean} cores busy on average (max ${machine.otherBusyCoresMax}) ` +
        'during this scenario – the machine was shared; compare with a run on a quiet machine before trusting small differences.',
    );
  }
  const clientBound = rec.clientBound();
  const verdict: Verdict = error ? 'fail' : worstVerdict(rec.metrics.map((m) => m.verdict));
  return {
    id: meta.id,
    title: meta.title,
    simulates: meta.simulates,
    startedAt: startedAt.toISOString(),
    durationMs: Math.round(performance.now() - t0),
    verdict,
    metrics: rec.metrics,
    notes: rec.notes,
    ...(clientBound ? { clientBound } : {}),
    ...(error ? { error } : {}),
    data: {
      ...rec.data,
      machine: {
        loadavg1Start: Math.round(loadStart * 100) / 100,
        loadavg1End: Math.round((os.loadavg()[0] ?? 0) * 100) / 100,
        ...machine,
      },
      windows: rec.windowsStats(),
    },
  };
}

/** Formats numbers for notes: 1234.5 → "1,234.5". */
export function fmt(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  return value.toLocaleString('en', { maximumFractionDigits: digits });
}

/** Median of a list of numbers (NaN when empty). */
export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export { sleep } from './sleep.ts';
