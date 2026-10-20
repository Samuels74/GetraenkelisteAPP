/**
 * Assembly of the UI checks' ScenarioResults (contract: ../perf/types.ts):
 * metrics from repeated samples (median + spread), plain-language notes, and
 * the machine load around each check:
 *   data.loadavg     1/5/15-min load average before and after (os.loadavg())
 *   data.busyCores   average busy cores while the check ran: machine, own
 *                    process tree, foreign (machine.ts)
 *   clientBound      set when other processes had more than `limit` busy
 *                    cores in a ≈500 ms window that overlaps a measured
 *                    timing; the detail names those timings. Browser timings
 *                    are only as good as the CPU the browser got – the flag
 *                    is informational and never changes a verdict.
 */
import os from 'node:os';
import { metric, worstVerdict, type Budget, type Metric, type ScenarioResult, type Unit } from '../perf/types.ts';
import type { CpuMonitor } from './machine.ts';

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function max(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

/** Nearest-rank percentile. */
export function pct(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] as number;
}

export const round = (value: number | null, digits = 0): number | null =>
  value === null || !Number.isFinite(value) ? null : Math.round(value * 10 ** digits) / 10 ** digits;

export const fmtMs = (value: number) => `${Math.round(value)}`;

/** "3 runs: 812 · 845 · 901 ms (spread 89 ms)" */
export function samplesDetail(values: readonly number[], unit = 'ms'): string {
  if (values.length === 0) return 'no samples';
  if (values.length === 1) return `1 run: ${fmtMs(values[0] as number)} ${unit}`;
  const spread = Math.max(...values) - Math.min(...values);
  return `${values.length} runs: ${values.map(fmtMs).join(' · ')} ${unit} (spread ${fmtMs(spread)} ${unit})`;
}

export interface LoadAverage {
  before: number[];
  after: number[];
  cores: number;
}

/** A measured interval of the check (epoch ms), e.g. "keystroke clear (sequence 2)". */
interface Timing {
  label: string;
  from: number;
  to: number;
}

export class ResultBuilder {
  private readonly metrics: Metric[] = [];
  private readonly notes: string[] = [];
  readonly data: Record<string, unknown> = {};
  private readonly timings: Timing[] = [];
  private readonly started = Date.now();
  private readonly loadBefore = os.loadavg().map((v) => Math.round(v * 100) / 100);
  private error: string | undefined;
  private finished = false;

  readonly id: string;
  readonly title: string;
  readonly simulates: string;
  private readonly monitor: CpuMonitor | undefined;

  constructor(id: string, title: string, simulates: string, monitor?: CpuMonitor) {
    this.id = id;
    this.title = title;
    this.simulates = simulates;
    this.monitor = monitor;
  }

  /**
   * Adds a metric. Ignored after finish(): a scenario that timed out keeps
   * running in the background and must not change a result already handed out.
   */
  add(fields: {
    key: string;
    label: string;
    value: number | null;
    unit: Unit;
    budget?: Budget;
    detail?: string;
  }): Metric {
    const value = fields.value === null ? null : round(fields.value, fields.unit === 'ms' ? 0 : 1);
    // the contract: a null value says why in `detail`
    const detail = value === null && !fields.detail ? 'not measured (no sample)' : fields.detail;
    const built = metric({ ...fields, value, detail });
    if (!this.finished) this.metrics.push(built);
    return built;
  }

  /** Median of repeated samples, details list every run. */
  addSamples(key: string, label: string, samples: readonly number[], budget?: Budget, extra?: string): Metric {
    const detail = samplesDetail(samples) + (extra ? `; ${extra}` : '');
    return this.add({ key, label, value: median(samples), unit: 'ms', budget, detail });
  }

  note(text: string): void {
    if (!this.finished && !this.notes.includes(text)) this.notes.push(text);
  }

  /** Registers a measured interval (epoch ms) for the busy-machine check. */
  timing(label: string, from: number, to: number): void {
    if (!this.finished && label && to >= from) this.timings.push({ label, from, to });
  }

  /** Records a crash: the first line of the message (Playwright appends call and browser logs) and 3 stack frames. */
  fail(error: unknown): void {
    if (this.finished) return;
    if (!(error instanceof Error)) {
      this.error = String(error).split('\n')[0];
      return;
    }
    const frames = (error.stack ?? '')
      .split('\n')
      .filter((line) => /^\s+at /.test(line))
      .slice(0, 3);
    this.error = [error.message.split('\n')[0]?.trim() ?? 'error', ...frames].join('\n');
  }

  get failed(): boolean {
    return this.error !== undefined;
  }

  /** The timings measured while other processes kept more than `limit` cores busy (worst first). */
  private busyTimings(): Array<{ label: string; foreign: number; machine: number }> {
    const monitor = this.monitor;
    if (!monitor) return [];
    const busy: Array<{ label: string; foreign: number; machine: number }> = [];
    for (const timing of this.timings) {
      const worst = monitor.worst(timing.from, timing.to);
      if (worst && worst.foreign > monitor.limit) {
        busy.push({ label: timing.label, foreign: Math.round(worst.foreign * 10) / 10, machine: Math.round(worst.machine * 10) / 10 });
      }
    }
    return busy.sort((a, b) => b.foreign - a.foreign);
  }

  /** Builds the result (once); later calls return a copy of the same result. */
  finish(): ScenarioResult {
    this.monitor?.tick();
    const cores = this.monitor?.capacity.cores ?? os.availableParallelism();
    const loadavg: LoadAverage = {
      before: this.loadBefore,
      after: os.loadavg().map((v) => Math.round(v * 100) / 100),
      cores,
    };
    const ended = Date.now();
    const busyCores = this.monitor?.average(this.started, ended) ?? null;
    const busy = this.busyTimings();
    this.finished = true;
    const result: ScenarioResult = {
      id: this.id,
      title: this.title,
      simulates: this.simulates,
      startedAt: new Date(this.started).toISOString(),
      durationMs: ended - this.started,
      verdict: this.error ? 'fail' : worstVerdict(this.metrics.map((m) => m.verdict)),
      metrics: this.metrics.map((m) => ({ ...m, budget: m.budget ? { ...m.budget } : undefined })),
      notes: [...this.notes],
      data: { ...this.data, loadavg, busyCores, busyLimit: this.monitor?.limit ?? null, busyTimings: busy.slice(0, 20) },
    };
    if (busy.length > 0) {
      const shown = busy
        .slice(0, 3)
        .map((b) => `${b.label}: ${b.foreign} cores of other processes (machine ${b.machine})`)
        .join('; ');
      const more = busy.length > 3 ? `; ${busy.length - 3} more` : '';
      result.clientBound = {
        flagged: true,
        detail:
          `machine busy during ${busy.length} of ${this.timings.length} timings – ${shown}${more} ` +
          `(limit ${this.monitor?.limit} of ${cores} cores) – the browser competed for CPU, these timings may be inflated`,
      };
    }
    if (this.error) result.error = this.error;
    return result;
  }
}
