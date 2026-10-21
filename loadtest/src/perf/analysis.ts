/**
 * Evaluation of fleet runs (fleet.ts): what the users of the simulated
 * devices experienced inside the measurement window.
 *
 * - create / delete latency from the intended (scheduled) time – bookings
 *   whose intended time lies in the window;
 * - propagation: booking intended time → another device has finished the
 *   update that shows it (patch, head request or refetch), per screen – only
 *   for devices whose screen shows the booking (a Buchen phone of another
 *   person has nothing to update: "unaffected"); the booking device itself is
 *   excluded. Realtime events that never arrived and updates that never
 *   completed (a request failed, the run ended) count as missing;
 * - requests and bytes per type and per device (responses + realtime stream)
 *   for requests started in the window;
 * - errors grouped by type and message; realtime connection statistics; the
 *   health of every load-generating thread.
 */
import { latencyStats, type LatencyStats } from '../stats.ts';
import type { ScreenKind } from './device.ts';
import type { FleetPlan, FleetRaw } from './fleet.ts';
import type { ThreadHealth } from './health.ts';
import { bytesByDevice, errorGroups, summarize, type ErrorGroup, type TypeStats } from './samples.ts';

export interface DeviceTraffic {
  id: string;
  screen: ScreenKind;
  /** Responses + realtime stream, KiB/s over the window. */
  kibPerSecond: number;
  requests: number;
}

export interface FleetAnalysis {
  windowMs: number;
  devices: number;
  /** Achieved bookings per second (creates intended in the window). */
  bookingsPerSecond: number;
  types: TypeStats[];
  creates: { count: number; errors: number; latency: LatencyStats };
  deletes: { count: number; errors: number; latency: LatencyStats };
  propagation: {
    all: LatencyStats;
    byScreen: Partial<Record<ScreenKind, LatencyStats>>;
    /** (booking, other device) pairs whose event never arrived or whose update never completed. */
    missing: number;
    /** Pairs whose screen does not show the booking (no update needed – e.g. a Buchen phone of another person). */
    unaffected: number;
    /** Pairs whose screen was updated (the propagation samples). */
    updated: number;
  };
  traffic: DeviceTraffic[];
  byScreen: Partial<Record<ScreenKind, { devices: number; meanKiBps: number; maxKiBps: number }>>;
  errors: ErrorGroup[];
  totalErrors: number;
  realtime: { connects: number; reconnects: number; serverCloses: number; reconnectRefetches: number; messages: number };
  health: ThreadHealth[];
}

const round1 = (value: number) => Math.round(value * 10) / 10;

export function analyzeFleet(raws: readonly FleetRaw[], plan: FleetPlan): FleetAnalysis {
  const first = raws[0];
  if (!first) throw new Error('no fleet results');
  const { from, to } = first.window;
  const windowMs = to - from;
  const samples = raws.map((raw) => raw.samples);
  const inWindow = { from, to };

  const creates = raws.flatMap((raw) => raw.creates).filter((c) => c.intended >= from && c.intended < to);
  const deletes = raws.flatMap((raw) => raw.deletes).filter((d) => d.intended >= from && d.intended < to);
  const ok = (status: number) => status >= 200 && status < 300;

  // propagation: every other device subscribed to bookings must receive every create; the ones whose screen shows it must update
  const createdBy = new Map<string, { device: string; intended: number }>();
  for (const c of creates) if (c.id && ok(c.status)) createdBy.set(c.id, { device: c.device, intended: c.intended });
  const screenOf = new Map(plan.devices.map((d) => [d.id, d.screen]));
  const all: number[] = [];
  const perScreen = new Map<ScreenKind, number[]>();
  let received = 0;
  let unaffected = 0;
  let incomplete = 0;
  for (const event of raws.flatMap((raw) => raw.events)) {
    if (event.action !== 'create') continue;
    const origin = createdBy.get(event.bookingId);
    if (!origin || origin.device === event.device) continue;
    received++;
    if (!event.relevant) {
      unaffected++;
      continue;
    }
    if (event.doneAt <= 0) {
      incomplete++;
      continue;
    }
    const ms = event.doneAt - origin.intended;
    all.push(ms);
    const screen = screenOf.get(event.device);
    if (screen) {
      let list = perScreen.get(screen);
      if (!list) perScreen.set(screen, (list = []));
      list.push(ms);
    }
  }
  const expected = createdBy.size * Math.max(0, plan.devices.length - 1);

  const devicesByIndex = new Map(raws.flatMap((raw) => raw.devices).map((d) => [d.index, d]));
  const bytes = bytesByDevice(samples, inWindow);
  const requestCounts = new Map<number, number>();
  for (const raw of samples) {
    for (let i = 0; i < raw.start.length; i++) {
      const start = raw.start[i] as number;
      if (start >= from && start < to) requestCounts.set(raw.device[i] as number, (requestCounts.get(raw.device[i] as number) ?? 0) + 1);
    }
  }
  const traffic: DeviceTraffic[] = [...devicesByIndex.values()]
    .sort((a, b) => a.index - b.index)
    .map((d) => ({
      id: d.id,
      screen: d.screen,
      kibPerSecond: round1((((bytes.get(d.index) ?? 0) + d.sseBytesInWindow) / 1024 / windowMs) * 1000),
      requests: requestCounts.get(d.index) ?? 0,
    }));
  const byScreen: FleetAnalysis['byScreen'] = {};
  for (const screen of new Set(traffic.map((t) => t.screen))) {
    const list = traffic.filter((t) => t.screen === screen).map((t) => t.kibPerSecond);
    byScreen[screen] = {
      devices: list.length,
      meanKiBps: round1(list.reduce((a, b) => a + b, 0) / list.length),
      maxKiBps: Math.max(...list),
    };
  }

  const errors = errorGroups(samples, inWindow);
  const deviceInfos = raws.flatMap((raw) => raw.devices);
  return {
    windowMs,
    devices: plan.devices.length,
    bookingsPerSecond: round1((creates.length / windowMs) * 1000),
    types: summarize(samples, inWindow, windowMs),
    creates: {
      count: creates.length,
      errors: creates.filter((c) => !ok(c.status)).length,
      latency: latencyStats(creates.map((c) => c.done - c.intended)),
    },
    deletes: {
      count: deletes.length,
      errors: deletes.filter((d) => !ok(d.status)).length,
      latency: latencyStats(deletes.map((d) => d.done - d.intended)),
    },
    propagation: {
      all: latencyStats(all),
      byScreen: Object.fromEntries([...perScreen].map(([screen, list]) => [screen, latencyStats(list)])),
      missing: Math.max(0, expected - received) + incomplete,
      unaffected,
      updated: all.length,
    },
    traffic,
    byScreen,
    errors,
    totalErrors: errors.reduce((sum, group) => sum + group.count, 0),
    realtime: {
      connects: deviceInfos.reduce((s, d) => s + d.connects, 0),
      reconnects: deviceInfos.reduce((s, d) => s + d.reconnects, 0),
      serverCloses: deviceInfos.reduce((s, d) => s + d.serverCloses, 0),
      reconnectRefetches: deviceInfos.reduce((s, d) => s + d.reconnectRefetches, 0),
      messages: deviceInfos.reduce((s, d) => s + d.sseMessages, 0),
    },
    health: raws.map((raw) => raw.health),
  };
}

/** "p50 2.1 · p95 3.4 · p99 5 · max 9.8 ms (n = 180)" */
export function describeLatency(stats: LatencyStats, unit = 'ms'): string {
  if (!stats.count) return 'no samples';
  return `p50 ${stats.p50} · p95 ${stats.p95} · p99 ${stats.p99} · max ${stats.max} ${unit} (n = ${stats.count.toLocaleString('en')})`;
}

/** Table rows of request types for ScenarioResult.data (rendered by the report). */
export function typeTable(types: readonly TypeStats[]): { columns: string[]; rows: Array<Array<string | number>> } {
  return {
    columns: ['request', 'n', 'per s', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms', 'mean size KiB', 'KiB/s', 'errors'],
    rows: types.map((t) => [
      t.type,
      t.count,
      t.perSecond ?? '',
      t.latency.p50,
      t.latency.p95,
      t.latency.p99,
      t.latency.max,
      Math.round((t.bytesMean / 1024) * 10) / 10,
      t.kibPerSecond ?? '',
      t.errors,
    ]),
  };
}
