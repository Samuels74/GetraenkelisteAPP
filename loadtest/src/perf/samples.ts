/**
 * Raw request samples and their statistics.
 *
 * Every request of a scenario is recorded – type, device, absolute start
 * time, latency, bytes, status, error message – and evaluated afterwards:
 * exact nearest-rank percentiles over all samples (stats.ts, no histogram
 * buckets), throughput and bytes over the measurement window, errors grouped
 * by request type and message. Recording everything and windowing later
 * keeps the hot path cheap and lets the samples of several worker threads
 * be merged (RawSamples is structured-clone friendly: plain arrays).
 *
 * Times are absolute (epoch ms with sub-ms precision: performance.timeOrigin
 * + performance.now()), so samples from different worker threads – each with
 * its own performance.now() origin – share one clock.
 */
import { latencyStats, type LatencyStats } from '../stats.ts';
import type { HttpResult } from './http.ts';

/** Absolute time in ms (shared by all threads of the process). */
export function nowAbs(): number {
  return performance.timeOrigin + performance.now();
}

export interface RawSamples {
  /** Dictionary of request types; `type` holds indexes into it. */
  types: string[];
  type: number[];
  /** Device index within its fleet (−1 = not a device request). */
  device: number[];
  /** Absolute start time (ms). */
  start: number[];
  ms: number[];
  bytes: number[];
  status: number[];
  /** Error messages of failed samples, by sample index. */
  errors: Record<number, string>;
}

export function emptySamples(): RawSamples {
  return { types: [], type: [], device: [], start: [], ms: [], bytes: [], status: [], errors: {} };
}

export class SampleLog {
  private readonly raw = emptySamples();
  private readonly typeIndex = new Map<string, number>();

  add(type: string, result: HttpResult, device = -1): void {
    let index = this.typeIndex.get(type);
    if (index === undefined) {
      index = this.raw.types.length;
      this.raw.types.push(type);
      this.typeIndex.set(type, index);
    }
    const i = this.raw.type.length;
    this.raw.type.push(index);
    this.raw.device.push(device);
    this.raw.start.push(performance.timeOrigin + result.startedAt);
    this.raw.ms.push(result.ms);
    this.raw.bytes.push(result.bytes);
    this.raw.status.push(result.status);
    if (result.error !== undefined) this.raw.errors[i] = result.error;
  }

  get size(): number {
    return this.raw.type.length;
  }

  toRaw(): RawSamples {
    return this.raw;
  }
}

/** True for samples that count as errors: no response or HTTP ≥ 400. */
export function isError(status: number): boolean {
  return status === 0 || status >= 400;
}

export interface SampleFilter {
  /** Absolute start time ≥ from. */
  from?: number;
  /** Absolute start time < to. */
  to?: number;
  types?: readonly string[];
  devices?: ReadonlySet<number>;
}

interface Selected {
  type: string;
  device: number;
  start: number;
  ms: number;
  bytes: number;
  status: number;
  error?: string;
}

function* select(raws: readonly RawSamples[], filter: SampleFilter): Generator<Selected> {
  for (const raw of raws) {
    for (let i = 0; i < raw.type.length; i++) {
      const start = raw.start[i] as number;
      if (filter.from !== undefined && start < filter.from) continue;
      if (filter.to !== undefined && start >= filter.to) continue;
      const device = raw.device[i] as number;
      if (filter.devices && !filter.devices.has(device)) continue;
      const type = raw.types[raw.type[i] as number] as string;
      if (filter.types && !filter.types.includes(type)) continue;
      yield {
        type,
        device,
        start,
        ms: raw.ms[i] as number,
        bytes: raw.bytes[i] as number,
        status: raw.status[i] as number,
        error: raw.errors[i],
      };
    }
  }
}

export interface TypeStats {
  type: string;
  count: number;
  errors: number;
  bytes: number;
  /** Mean response size in bytes. */
  bytesMean: number;
  latency: LatencyStats;
  /** count / window (only with a window). */
  perSecond?: number;
  /** bytes / window in KiB/s (only with a window). */
  kibPerSecond?: number;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

function typeStats(type: string, ms: number[], bytes: number, errors: number, windowMs?: number): TypeStats {
  return {
    type,
    count: ms.length,
    errors,
    bytes,
    bytesMean: ms.length ? Math.round(bytes / ms.length) : 0,
    latency: latencyStats(ms),
    ...(windowMs ? { perSecond: round1((ms.length / windowMs) * 1000), kibPerSecond: round1((bytes / 1024 / windowMs) * 1000) } : {}),
  };
}

/** Statistics per request type (in first-seen order) plus an "all" entry. */
export function summarize(raws: readonly RawSamples[], filter: SampleFilter = {}, windowMs?: number): TypeStats[] {
  const byType = new Map<string, { ms: number[]; bytes: number; errors: number }>();
  const all = { ms: [] as number[], bytes: 0, errors: 0 };
  for (const s of select(raws, filter)) {
    let entry = byType.get(s.type);
    if (!entry) byType.set(s.type, (entry = { ms: [], bytes: 0, errors: 0 }));
    entry.ms.push(s.ms);
    entry.bytes += s.bytes;
    all.ms.push(s.ms);
    all.bytes += s.bytes;
    if (isError(s.status)) {
      entry.errors++;
      all.errors++;
    }
  }
  const result = [...byType].map(([type, e]) => typeStats(type, e.ms, e.bytes, e.errors, windowMs));
  result.push(typeStats('all', all.ms, all.bytes, all.errors, windowMs));
  return result;
}

/** Latencies of the selected samples (ms). */
export function latencies(raws: readonly RawSamples[], filter: SampleFilter = {}): number[] {
  const values: number[] = [];
  for (const s of select(raws, filter)) values.push(s.ms);
  return values;
}

/** Bytes per device index over the selected samples. */
export function bytesByDevice(raws: readonly RawSamples[], filter: SampleFilter = {}): Map<number, number> {
  const result = new Map<number, number>();
  for (const s of select(raws, filter)) result.set(s.device, (result.get(s.device) ?? 0) + s.bytes);
  return result;
}

export interface ErrorGroup {
  /** "<type>: <message>", e.g. "create: HTTP 400: Failed to create record." */
  key: string;
  count: number;
}

/** Failed samples grouped by type and message, most frequent first. */
export function errorGroups(raws: readonly RawSamples[], filter: SampleFilter = {}): ErrorGroup[] {
  const groups = new Map<string, number>();
  for (const s of select(raws, filter)) {
    if (!isError(s.status)) continue;
    const key = `${s.type}: ${s.error ?? (s.status ? `HTTP ${s.status}` : 'no response')}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

/** One line per error group (for metric details), at most `limit` groups. */
export function formatErrorGroups(groups: readonly ErrorGroup[], limit = 5): string {
  if (groups.length === 0) return 'no errors';
  const shown = groups.slice(0, limit).map((g) => `${g.count}× ${g.key}`);
  if (groups.length > limit) shown.push(`… ${groups.length - limit} more groups`);
  return shown.join('; ');
}
