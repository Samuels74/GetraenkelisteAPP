/**
 * Health of the load generator itself. A saturated client delays its own
 * requests and timers, and the delay then looks like server latency. Every
 * measurement window therefore records, per thread that generated load:
 *
 * - the event-loop lateness (perf_hooks.monitorEventLoopDelay): how late
 *   timers and I/O callbacks run – an open-loop schedule sends late and SSE
 *   events are handled late when it is high. The histogram records the time
 *   between its 10 ms sampling ticks (an idle loop reads ≈ 10 ms), so the
 *   sampling interval is subtracted: 0 ms = on time;
 * - the thread's CPU time (process.threadCpuUsage) relative to the wall time:
 *   a JavaScript thread close to 100 % of a core cannot keep up.
 *
 * Above the limits below the measurement is flagged as client-bound
 * (ScenarioResult.clientBound) instead of blaming the server.
 */
import { monitorEventLoopDelay, type ELDHistogram } from 'node:perf_hooks';

/** Limits above which a load-generating thread counts as saturated. */
export const CLIENT_LIMITS = {
  /** p99 event-loop lateness in ms (beyond the sampling interval). */
  eventLoopP99Ms: 50,
  /** CPU time of the JavaScript thread in % of one core. */
  cpuPct: 70,
} as const;

export interface ThreadHealth {
  /** "main" or "worker 2/4" */
  label: string;
  wallMs: number;
  /** CPU time of this JavaScript thread in % of one core. */
  cpuPct: number;
  /** Event-loop lateness (p99 / max) in ms – the 10 ms sampling interval already subtracted. */
  eventLoopP99Ms: number;
  eventLoopMaxMs: number;
}

/** monitorEventLoopDelay's sampling interval: an idle loop records ≈ this value. */
const RESOLUTION_MS = 10;

export class HealthProbe {
  private readonly label: string;
  private histogram: ELDHistogram | undefined;
  private cpu0: NodeJS.CpuUsage | undefined;
  private t0 = 0;

  constructor(label: string) {
    this.label = label;
  }

  start(): this {
    this.histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    this.histogram.enable();
    this.cpu0 = process.threadCpuUsage();
    this.t0 = performance.now();
    return this;
  }

  stop(): ThreadHealth {
    const wallMs = performance.now() - this.t0;
    const cpu = process.threadCpuUsage(this.cpu0);
    const histogram = this.histogram;
    histogram?.disable();
    // ns → ms, minus the sampling interval (the histogram measures tick to tick)
    const ns = (value: number | undefined) =>
      value && Number.isFinite(value) ? Math.max(0, Math.round((value / 1e6 - RESOLUTION_MS) * 10) / 10) : 0;
    return {
      label: this.label,
      wallMs: Math.round(wallMs),
      cpuPct: wallMs > 0 ? Math.round(((cpu.user + cpu.system) / 1000 / wallMs) * 1000) / 10 : 0,
      eventLoopP99Ms: ns(histogram?.percentile(99)),
      eventLoopMaxMs: ns(histogram?.max),
    };
  }
}

/** Whether any thread was saturated, with a one-line explanation. */
export function judgeClient(threads: readonly ThreadHealth[]): { flagged: boolean; detail: string } {
  const saturated = threads.filter(
    (t) => t.eventLoopP99Ms > CLIENT_LIMITS.eventLoopP99Ms || t.cpuPct > CLIENT_LIMITS.cpuPct,
  );
  const describe = (t: ThreadHealth) => `${t.label}: CPU ${t.cpuPct} % of a core, event-loop lateness p99 ${t.eventLoopP99Ms} ms`;
  if (saturated.length === 0) {
    const worst = [...threads].sort((a, b) => b.cpuPct - a.cpuPct)[0];
    return { flagged: false, detail: worst ? `load generator OK (busiest thread – ${describe(worst)})` : 'not measured' };
  }
  return {
    flagged: true,
    detail:
      `the load generator was saturated (limits: CPU ${CLIENT_LIMITS.cpuPct} % of a core, event-loop lateness p99 ` +
      `${CLIENT_LIMITS.eventLoopP99Ms} ms) – ${saturated.map(describe).join('; ')}; latencies include client-side delay`,
  };
}
