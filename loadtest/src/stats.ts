/**
 * Latency / throughput statistics shared by the seeder and the performance
 * checks. Percentiles use the nearest-rank method on the recorded samples
 * (no interpolation, no histogram buckets) – exact for the sample sizes here.
 */

export interface LatencyStats {
  count: number;
  min: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
}

/** Nearest-rank percentile of an ascending sorted array (p in 0–100). */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] as number;
}

/** Summary of latency samples in ms (rounded to 0.1 ms). */
export function latencyStats(samplesMs: readonly number[]): LatencyStats {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const round = (value: number) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : NaN);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    min: round(sorted[0] ?? NaN),
    mean: round(sorted.length ? sum / sorted.length : NaN),
    p50: round(percentile(sorted, 50)),
    p90: round(percentile(sorted, 90)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted.at(-1) ?? NaN),
  };
}

/** Operations per second, rounded to 0.1. */
export function perSecond(count: number, durationMs: number): number {
  return durationMs > 0 ? Math.round((count / durationMs) * 10_000) / 10 : NaN;
}

/** Milliseconds since an arbitrary origin (monotonic). */
export function now(): number {
  return performance.now();
}

/** Runs `fn` and returns its result with the elapsed wall time in ms. */
export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}
