/**
 * Load patterns besides the device fleets:
 *
 * - closed loop: `concurrency` workers, each sends its next request as soon
 *   as the previous one finished – for throughput curves (A7) and sweeps.
 *   Closed-loop latencies are not open-loop SLOs: the clients slow down with
 *   the server and hide queueing (1B §6.4); they are reported as throughput
 *   and as latency at a given concurrency.
 * - open loop: requests at fixed intended times (constant or Poisson
 *   arrivals); latency is measured from the intended time.
 *
 * runClosedLoop() also runs in worker threads (worker.ts): at a few thousand
 * small requests per second a single Node thread saturates, so heavy levels
 * are split across threads (each thread keeps its share of the concurrency
 * and reports its own client health).
 */
import { Worker } from 'node:worker_threads';
import { createRandom, type Random } from '../random.ts';
import { HealthProbe, type ThreadHealth } from './health.ts';
import { HttpClient, type HttpResult } from './http.ts';
import { nowAbs, SampleLog, type RawSamples } from './samples.ts';
import { sleep } from './sleep.ts';
import { waitFor } from './fleet.ts';

export interface RequestTemplate {
  type: string;
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
}

export interface ClosedLoopTask {
  url: string;
  /** Auth tokens, one per closed-loop worker (round-robin) – e.g. one per user. */
  tokens: string[];
  /**
   * The user ids of `tokens` (same order). When given, a request body's
   * `createdBy` is set to the worker's own user id – what the SPA sends.
   */
  userIds?: string[];
  /** Used round-robin by every worker (offset by the worker number). */
  requests: RequestTemplate[];
  concurrency: number;
  /** Requests before this time are warm-up (not evaluated). */
  warmupMs: number;
  durationMs: number;
  /** Stop after this many requests in this thread (default: no limit). */
  maxRequests?: number;
  /** Share of successful creates that are deleted again right away ("Rückgängig"), measured as "delete". */
  undoShare?: number;
  /** Seed of the undo decisions. */
  seed?: string;
}

export interface ClosedLoopRaw {
  samples: RawSamples;
  health: ThreadHealth;
  /** Absolute measurement window. */
  window: { from: number; to: number };
}


/** Closed-loop load in this thread, starting at the absolute time `start` (default: now). */
export async function runClosedLoop(
  task: ClosedLoopTask,
  start = nowAbs(),
  label = 'main',
  workerOffset = 0,
  signal?: AbortSignal,
): Promise<ClosedLoopRaw> {
  const samples = new SampleLog();
  // one connection (and login) per closed-loop worker, like one device each
  const clients = Array.from(
    { length: task.concurrency },
    (_, worker) => new HttpClient(task.url, { token: task.tokens[(workerOffset + worker) % task.tokens.length], maxSockets: 1 }),
  );
  const random = createRandom(`${task.seed ?? 'closed-loop'}:${workerOffset}`);
  let started = 0;
  await sleep(start - nowAbs(), signal);
  const window = { from: start + task.warmupMs, to: start + task.warmupMs + task.durationMs };
  const health = new HealthProbe(label).start();
  try {
    await Promise.all(
      clients.map(async (client, worker) => {
        const userId = task.userIds?.[(workerOffset + worker) % task.userIds.length];
        let i = worker + workerOffset;
        while (nowAbs() < window.to && !signal?.aborted && (task.maxRequests === undefined || started < task.maxRequests)) {
          started++;
          const template = task.requests[i++ % task.requests.length] as RequestTemplate;
          const undo = template.method === 'POST' && task.undoShare !== undefined && random.next() < task.undoShare;
          const body =
            userId !== undefined && template.body && typeof template.body === 'object' && 'createdBy' in template.body
              ? { ...(template.body as Record<string, unknown>), createdBy: userId }
              : template.body;
          const result = await client.request(template.method, template.path, { body, collect: undo });
          samples.add(template.type, result);
          if (undo && result.status === 200 && result.body) {
            const id = (JSON.parse(result.body.toString('utf8')) as { id: string }).id;
            samples.add('delete', await client.delete(`${template.path.split('?')[0]}/${encodeURIComponent(id)}`));
          }
        }
      }),
    );
  } finally {
    for (const client of clients) client.close();
  }
  return { samples: samples.toRaw(), health: health.stop(), window };
}

/** Closed-loop load split across `workers` threads (concurrency divided as evenly as possible). */
export async function runClosedLoopDistributed(task: ClosedLoopTask, workers: number, signal?: AbortSignal): Promise<ClosedLoopRaw[]> {
  const count = Math.max(1, Math.min(workers, task.concurrency));
  if (count === 1) return [await runClosedLoop(task, nowAbs(), 'main', 0, signal)];
  const shares = Array.from({ length: count }, (_, i) => Math.floor(task.concurrency / count) + (i < task.concurrency % count ? 1 : 0));
  let offset = 0;
  const threads = shares.map((concurrency, i) => {
    const thread = new Worker(new URL('./worker.ts', import.meta.url), {
      workerData: {
        task: 'closed-loop',
        closedLoop: {
          ...task,
          concurrency,
          ...(task.maxRequests !== undefined ? { maxRequests: Math.ceil((task.maxRequests * concurrency) / task.concurrency) } : {}),
        },
        label: `worker ${i + 1}/${count}`,
        offset,
      },
    });
    offset += concurrency;
    return thread;
  });
  const abort = () => void Promise.all(threads.map((thread) => thread.terminate()));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await Promise.all(threads.map((thread) => waitFor(thread, 'ready')));
    const start = nowAbs() + 100;
    const done = threads.map((thread) => waitFor<ClosedLoopRaw>(thread, 'done'));
    for (const thread of threads) thread.postMessage({ type: 'start', start });
    return await Promise.all(done);
  } finally {
    signal?.removeEventListener('abort', abort);
    await Promise.all(threads.map((thread) => thread.terminate()));
  }
}

/**
 * Exactly round(rate × duration) arrivals with Poisson spacing: a Poisson
 * process conditioned on its count is a set of uniform random times. The
 * realized rate equals the nominal one (a 60 s window at 2/s has exactly 120
 * bookings – an unconditioned draw gave 1.7/s in one window), so results are
 * comparable between runs and with the budgets' assumptions.
 */
export function poissonArrivalsExact(ratePerSecond: number, durationMs: number, random: Random): number[] {
  const count = Math.round((ratePerSecond * durationMs) / 1000);
  const offsets = Array.from({ length: count }, () => random.next() * durationMs);
  return offsets.sort((a, b) => a - b);
}

/** Evenly spaced arrivals: offsets in ms in [0, durationMs). */
export function constantArrivals(ratePerSecond: number, durationMs: number): number[] {
  const offsets: number[] = [];
  if (ratePerSecond <= 0) return offsets;
  for (let t = 0; t < durationMs; t += 1000 / ratePerSecond) offsets.push(t);
  return offsets;
}

export interface OpenLoopSample {
  /** Latency from the intended time (ms). */
  ms: number;
  result: HttpResult;
}

/**
 * Sends `send()` at each offset after the absolute `start` (open loop) and
 * resolves with the latencies measured from the intended times.
 */
export async function runOpenLoop(
  offsets: readonly number[],
  start: number,
  send: (index: number) => Promise<HttpResult>,
  signal?: AbortSignal,
): Promise<OpenLoopSample[]> {
  const results: OpenLoopSample[] = [];
  const pending: Promise<void>[] = [];
  for (const [index, offset] of offsets.entries()) {
    const intended = start + offset;
    await sleep(intended - nowAbs(), signal);
    if (signal?.aborted) break;
    pending.push(
      send(index).then((result) => {
        const done = performance.timeOrigin + result.startedAt + result.ms;
        results.push({ ms: done - intended, result });
      }),
    );
  }
  await Promise.all(pending);
  return results;
}
