/**
 * Worker-thread entry for load that one Node thread cannot generate alone
 * (fleet.ts runFleet with workers > 1, load.ts runClosedLoopDistributed).
 *
 * Protocol (messages {type, payload?, error?}):
 *   worker → main  "ready"   devices connected / client created
 *   main → worker  "start"   { start: absolute ms } – all workers start together
 *   worker → main  "done"    payload = FleetRaw | ClosedLoopRaw
 *   main → worker  "abort"   stop scheduling new requests
 *   worker → main  "error"   error = message + stack
 * The main thread terminates the worker after "done" or on failure.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { Fleet, type FleetPlan } from './fleet.ts';
import { runClosedLoop, type ClosedLoopTask } from './load.ts';

type Task =
  | { task: 'fleet'; plan: FleetPlan; deviceIds: string[]; label: string }
  | { task: 'closed-loop'; closedLoop: ClosedLoopTask; label: string; offset: number };

const port = parentPort;
if (!port) throw new Error('worker.ts must run in a worker thread');

const data = workerData as Task;
const abort = new AbortController();
let resolveStart: (start: number) => void = () => undefined;
const started = new Promise<number>((resolve) => (resolveStart = resolve));
port.on('message', (message: { type: string; start?: number }) => {
  if (message.type === 'start' && typeof message.start === 'number') resolveStart(message.start);
  if (message.type === 'abort') abort.abort();
});

try {
  if (data.task === 'fleet') {
    const fleet = await Fleet.open(data.plan, { deviceIds: new Set(data.deviceIds), label: data.label });
    try {
      port.postMessage({ type: 'ready' });
      const raw = await fleet.run(await started, abort.signal);
      port.postMessage({ type: 'done', payload: raw });
    } finally {
      fleet.close();
    }
  } else {
    port.postMessage({ type: 'ready' });
    const raw = await runClosedLoop(data.closedLoop, await started, data.label, data.offset, abort.signal);
    port.postMessage({ type: 'done', payload: raw });
  }
} catch (error) {
  port.postMessage({ type: 'error', error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
}
