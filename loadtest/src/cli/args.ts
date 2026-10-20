/**
 * Shared command line handling of the CLIs: dataset options from flags or
 * LOADTEST_* environment variables (flags win), integer parsing, signals.
 */
import type { ParseArgsOptionsConfig } from 'node:util';
import { DATASET_DEFAULTS, resolveDatasetOptions, type DatasetOptions } from '../dataset.ts';

export class UsageError extends Error {
  override name = 'UsageError';
}

/** Flags shared by the CLIs (dataset shape + write concurrency). */
export const DATASET_FLAGS = {
  seed: { type: 'string' },
  persons: { type: 'string' },
  users: { type: 'string' },
  'min-bookings': { type: 'string' },
  'max-bookings': { type: 'string' },
  days: { type: 'string' },
  concurrency: { type: 'string' },
} satisfies ParseArgsOptionsConfig;

export const DATASET_FLAGS_HELP = `Dataset (flag or environment variable; defaults = the load-test dataset):
  --seed <text>          LOADTEST_SEED          PRNG seed, same seed = same data ("getraenkeliste")
  --persons <n>          LOADTEST_PERSONS       persons, numbered 1…n (2000)
  --users <n>            LOADTEST_USERS         users user1…user<n> (5)
  --min-bookings <n>     LOADTEST_MIN_BOOKINGS  bookings per person, at least (5)
  --max-bookings <n>     LOADTEST_MAX_BOOKINGS  bookings per person, at most (10)
  --days <n>             LOADTEST_DAYS          spread the bookings over the last n days (60)
  --concurrency <n>      LOADTEST_CONCURRENCY   create requests in flight (10)`;

type FlagValues = Record<string, string | boolean | undefined>;

export function parseInteger(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^\d+$/.test(value.trim())) throw new UsageError(`${name} must be a non-negative integer (got "${value}")`);
  return Number(value.trim());
}

function pick(values: FlagValues, flag: string, envName: string): string | undefined {
  const flagValue = values[flag];
  if (typeof flagValue === 'string') return flagValue;
  const envValue = process.env[envName];
  return envValue === undefined || envValue === '' ? undefined : envValue;
}

/** Flag / variable names of the dataset options (for messages). */
const OPTION_NAMES: Readonly<Record<string, string>> = {
  seed: '--seed / LOADTEST_SEED',
  persons: '--persons / LOADTEST_PERSONS',
  users: '--users / LOADTEST_USERS',
  minBookingsPerPerson: '--min-bookings / LOADTEST_MIN_BOOKINGS',
  maxBookingsPerPerson: '--max-bookings / LOADTEST_MAX_BOOKINGS',
  days: '--days / LOADTEST_DAYS',
};

/** Dataset options from flags / environment, validated (UsageError) before anything starts. */
export function datasetOptionsFrom(values: FlagValues): DatasetOptions & { concurrency?: number } {
  const integer = (flag: string, env: string) => parseInteger(`--${flag} / ${env}`, pick(values, flag, env));
  const options = {
    seed: pick(values, 'seed', 'LOADTEST_SEED'),
    persons: integer('persons', 'LOADTEST_PERSONS'),
    users: integer('users', 'LOADTEST_USERS'),
    minBookingsPerPerson: integer('min-bookings', 'LOADTEST_MIN_BOOKINGS'),
    maxBookingsPerPerson: integer('max-bookings', 'LOADTEST_MAX_BOOKINGS'),
    days: integer('days', 'LOADTEST_DAYS'),
    concurrency: integer('concurrency', 'LOADTEST_CONCURRENCY'),
  };
  if (options.concurrency === 0) throw new UsageError('--concurrency / LOADTEST_CONCURRENCY must be at least 1');
  const min = options.minBookingsPerPerson ?? DATASET_DEFAULTS.minBookingsPerPerson;
  const max = options.maxBookingsPerPerson ?? DATASET_DEFAULTS.maxBookingsPerPerson;
  if (max < min) {
    throw new UsageError(
      `${OPTION_NAMES.maxBookingsPerPerson} (${max}) must not be smaller than ${OPTION_NAMES.minBookingsPerPerson} (${min})`,
    );
  }
  try {
    resolveDatasetOptions(options);
  } catch (error) {
    // "persons must be …" → "--persons / LOADTEST_PERSONS must be …"
    throw new UsageError((error as Error).message.replace(/^(\w+)(?= must)/, (name) => OPTION_NAMES[name] ?? name));
  }
  return options;
}

/** True for "1", "true", "yes" (case-insensitive). */
export function envFlag(name: string): boolean {
  return /^(1|true|yes)$/i.test(process.env[name]?.trim() ?? '');
}

/**
 * Routes SIGINT/SIGTERM/SIGHUP into an AbortController: the first signal
 * starts a clean shutdown (PocketBase, in the same process group, gets a
 * terminal's Ctrl+C or hang-up directly anyway). A further signal at least a
 * second later exits at once – the process 'exit' hooks still send SIGTERM to
 * running instances (instance.ts) and release locks; earlier repeats are
 * ignored, because npm forwards a Ctrl+C to its child in addition to the
 * terminal. Returns the controller and the signal that arrived first (null
 * while none).
 */
export function abortOnSignals(onSignal?: (signal: NodeJS.Signals) => void): {
  controller: AbortController;
  received: () => NodeJS.Signals | null;
} {
  const controller = new AbortController();
  let received: NodeJS.Signals | null = null;
  let firstAt = 0;
  const handler = (signal: NodeJS.Signals) => {
    if (received) {
      if (Date.now() - firstAt < 1_000) return;
      process.stderr.write(`\n${signal} again – exiting without waiting for the clean shutdown\n`);
      process.exit(signalExitCode(signal));
    }
    received = signal;
    firstAt = Date.now();
    onSignal?.(signal);
    controller.abort(new Error(`interrupted (${signal})`));
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  process.on('SIGHUP', handler);
  return { controller, received: () => received };
}

/** Conventional exit code for a signal (128 + number). */
export function signalExitCode(signal: NodeJS.Signals): number {
  return signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : signal === 'SIGHUP' ? 129 : 1;
}
