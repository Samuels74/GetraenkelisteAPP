/**
 * A fleet of virtual SPA devices (device.ts) plus an open-loop booking
 * schedule: the bar-rush scenarios A2/A2b/A3/A11 and the background load of
 * A5 are fleets.
 *
 * Open loop: every booking has an intended time (Poisson arrivals, seeded);
 * it is sent at that time no matter how long earlier requests take, and its
 * latency is measured from the intended time. A slow server therefore shows
 * up as latency instead of silently lowering the request rate (coordinated
 * omission, 1B §6.4). Undo ("Rückgängig") follows a booking after a delay,
 * but never before the create's response arrived (the button appears with
 * the toast).
 *
 * Phases on one absolute clock (samples.ts nowAbs): connect + screen load
 * (not measured) → warm-up (load runs, samples discarded) → measurement
 * window → drain (refetch rounds of the last bookings finish). Requests are
 * evaluated by start time within the window, bookings by intended time.
 *
 * Big fleets run in worker threads (worker.ts): the devices are split
 * round-robin, every worker connects its devices and reports "ready", then
 * all start at the same absolute time. Each worker records its own raw
 * samples and client health; fleet results are merged by the caller.
 */
import { Worker } from 'node:worker_threads';
import { Device, type DeviceEvent, type DeviceSpec, type MutationRecord, type ScreenKind } from './device.ts';
import { HealthProbe, type ThreadHealth } from './health.ts';
import { nowAbs, SampleLog, type RawSamples } from './samples.ts';
import { sleep } from './sleep.ts';

export interface FleetBooking {
  /** ms after the fleet start. */
  at: number;
  /** Id of the booking device (a Buchen device). */
  device: string;
  personId: string;
  offeringId: string;
  /** Undo this many ms after the booking was due (only if the create succeeded). */
  undoAfterMs?: number;
}

export interface FleetPlan {
  url: string;
  timeZone: string;
  devices: DeviceSpec[];
  /** Sorted by `at`. */
  bookings: FleetBooking[];
  /** [0, warmupMs) is warm-up, [warmupMs, warmupMs + measureMs) the measurement window. */
  warmupMs: number;
  measureMs: number;
  /** After the last mutation: time for the refetch rounds to finish. */
  drainMs: number;
}

export interface FleetDeviceInfo {
  id: string;
  index: number;
  screen: ScreenKind;
  /** Realtime stream bytes received inside the measurement window. */
  sseBytesInWindow: number;
  sseMessages: number;
  connects: number;
  reconnects: number;
  serverCloses: number;
  reconnectRefetches: number;
}

export interface FleetRaw {
  label: string;
  samples: RawSamples;
  creates: MutationRecord[];
  deletes: MutationRecord[];
  events: DeviceEvent[];
  devices: FleetDeviceInfo[];
  health: ThreadHealth;
  /** Absolute times. */
  start: number;
  window: { from: number; to: number };
}

/** Runs `tasks` with at most `limit` in flight. */
async function limited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await task(items[next++] as T);
    }),
  );
}

/** The devices of one thread. */
export class Fleet {
  private readonly plan: FleetPlan;
  private readonly label: string;
  private readonly samples = new SampleLog();
  private readonly devices = new Map<string, Device>();

  private constructor(plan: FleetPlan, label: string) {
    this.plan = plan;
    this.label = label;
  }

  /** Creates and opens (realtime + screen load) the devices with the given ids (default: all). */
  static async open(plan: FleetPlan, options: { deviceIds?: ReadonlySet<string>; label?: string } = {}): Promise<Fleet> {
    const fleet = new Fleet(plan, options.label ?? 'main');
    plan.devices.forEach((spec, index) => {
      if (options.deviceIds && !options.deviceIds.has(spec.id)) return;
      fleet.devices.set(spec.id, new Device(spec, { url: plan.url, timeZone: plan.timeZone, samples: fleet.samples, index }));
    });
    try {
      await limited([...fleet.devices.values()], 10, (device) => device.open());
    } catch (error) {
      fleet.close();
      throw error;
    }
    return fleet;
  }

  /** Runs the schedule from the absolute time `start`; resolves with the raw results. */
  async run(start: number, signal?: AbortSignal): Promise<FleetRaw> {
    const { plan } = this;
    const window = { from: start + plan.warmupMs, to: start + plan.warmupMs + plan.measureMs };
    const creates: MutationRecord[] = [];
    const deletes: MutationRecord[] = [];
    const pending: Promise<void>[] = [];
    const timers: NodeJS.Timeout[] = [];
    const sseAtWindowStart = new Map<string, number>();
    const sseAtWindowEnd = new Map<string, number>();
    const snapshot = (target: Map<string, number>) => {
      for (const [id, device] of this.devices) target.set(id, device.sse.stats.bytes);
    };

    await sleep(start - nowAbs(), signal);
    const health = new HealthProbe(this.label).start();
    timers.push(setTimeout(() => snapshot(sseAtWindowStart), window.from - nowAbs()));
    timers.push(setTimeout(() => snapshot(sseAtWindowEnd), window.to - nowAbs()));

    for (const booking of plan.bookings) {
      const device = this.devices.get(booking.device);
      if (!device) continue;
      const intended = start + booking.at;
      pending.push(
        new Promise<void>((resolve) => {
          timers.push(
            setTimeout(() => {
              if (signal?.aborted) return resolve();
              void device.book(booking.personId, booking.offeringId, intended).then((record) => {
                creates.push(record);
                if (booking.undoAfterMs === undefined || !record.id || signal?.aborted) return resolve();
                const due = Math.max(intended + booking.undoAfterMs, record.done);
                timers.push(
                  setTimeout(() => {
                    void device.undo(record.id as string, due).then((undo) => {
                      deletes.push(undo);
                      resolve();
                    });
                  }, due - nowAbs()),
                );
              });
            }, intended - nowAbs()),
          );
        }),
      );
    }

    // the measurement window must be over even when the schedule ends earlier
    pending.push(sleep(window.to - nowAbs(), signal));
    const aborted = new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    await Promise.race([Promise.all(pending), aborted]);
    if (!signal?.aborted) {
      await sleep(plan.drainMs, signal);
      await Promise.race([Promise.all([...this.devices.values()].map((d) => d.settled())), sleep(plan.drainMs, signal)]);
    }
    for (const timer of timers) clearTimeout(timer);
    if (sseAtWindowEnd.size === 0) snapshot(sseAtWindowEnd);

    return {
      label: this.label,
      samples: this.samples.toRaw(),
      creates,
      deletes,
      events: [...this.devices.values()].flatMap((device) => device.events),
      devices: [...this.devices.values()].map((device) => ({
        id: device.spec.id,
        index: plan.devices.indexOf(device.spec),
        screen: device.spec.screen,
        sseBytesInWindow: (sseAtWindowEnd.get(device.spec.id) ?? 0) - (sseAtWindowStart.get(device.spec.id) ?? 0),
        sseMessages: device.sse.stats.messages,
        connects: device.sse.stats.connects,
        reconnects: device.sse.stats.reconnects,
        serverCloses: device.sse.stats.serverCloses,
        reconnectRefetches: device.reconnectRefetches,
      })),
      health: health.stop(),
      start,
      window,
    };
  }

  close(): void {
    for (const device of this.devices.values()) device.close();
  }
}

/** Splits the devices round-robin into `workers` groups (each keeps the mix of screens). */
function splitDevices(devices: readonly DeviceSpec[], workers: number): string[][] {
  const groups: string[][] = Array.from({ length: workers }, () => []);
  devices.forEach((device, index) => groups[index % workers]!.push(device.id));
  return groups.filter((group) => group.length > 0);
}

export interface FleetRunOptions {
  /** Worker threads (≤ 1: in this thread). */
  workers?: number;
  signal?: AbortSignal;
  /** Called when all devices are connected and the screens are loaded. */
  onReady?: () => void;
  /** Delay between "all ready" and the start (default 300 ms). */
  startDelayMs?: number;
}

/** Runs a fleet plan – in this thread or split across worker threads. */
export async function runFleet(plan: FleetPlan, options: FleetRunOptions = {}): Promise<FleetRaw[]> {
  const workers = Math.max(1, Math.min(options.workers ?? 1, plan.devices.length));
  if (workers === 1) {
    const fleet = await Fleet.open(plan);
    try {
      options.onReady?.();
      return [await fleet.run(nowAbs() + (options.startDelayMs ?? 300), options.signal)];
    } finally {
      fleet.close();
    }
  }

  const groups = splitDevices(plan.devices, workers);
  const threads = groups.map(
    (deviceIds, i) =>
      new Worker(new URL('./worker.ts', import.meta.url), {
        workerData: { task: 'fleet', plan, deviceIds, label: `worker ${i + 1}/${groups.length}` },
      }),
  );
  const abort = () => {
    for (const thread of threads) thread.postMessage({ type: 'abort' });
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const ready = threads.map((thread) => waitFor(thread, 'ready'));
    await Promise.all(ready);
    options.onReady?.();
    const start = nowAbs() + (options.startDelayMs ?? 300);
    const done = threads.map((thread) => waitFor<FleetRaw>(thread, 'done'));
    for (const thread of threads) thread.postMessage({ type: 'start', start });
    return await Promise.all(done);
  } finally {
    options.signal?.removeEventListener('abort', abort);
    await Promise.all(threads.map((thread) => thread.terminate()));
  }
}

/** Resolves with the payload of the worker's next message of `type`; rejects on errors and early exits. */
export function waitFor<T = undefined>(thread: Worker, type: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onMessage = (message: { type: string; payload?: T; error?: string }) => {
      if (message.type === type) {
        cleanup();
        resolve(message.payload as T);
      } else if (message.type === 'error') {
        cleanup();
        reject(new Error(message.error ?? 'worker failed'));
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`worker exited (code ${code}) before "${type}"`));
    };
    const cleanup = () => {
      thread.off('message', onMessage);
      thread.off('error', onError);
      thread.off('exit', onExit);
    };
    thread.on('message', onMessage);
    thread.on('error', onError);
    thread.on('exit', onExit);
  });
}
