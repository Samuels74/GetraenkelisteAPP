/**
 * `make loadtest-dev` – prepares the load-test dataset and runs the app for
 * interactive testing (docs/LOADTEST.md "Interactive testing").
 *
 * - Data: .pb/loadtest-data, seeded fresh on every start. LOADTEST_KEEP=1
 *   reuses a completely seeded dataset of an earlier run instead (marker file
 *   loadtest-seed.json in the data dir, written after a successful seed) –
 *   after checking that the data still is that dataset.
 * - Hooks: .pb/loadtest-hooks = backend/pb_hooks + the test-only support
 *   routes of loadtest/support (rebuilt on every start).
 * - Both directories are only deleted through the owned-directory guard of
 *   paths.ts (marker file, allowed locations), and never while another
 *   process (e.g. `PB_DATA_DIR=.pb/loadtest-data make dev`) uses the data dir.
 * - PocketBase serves the production SPA build (frontend/dist; with
 *   --build-frontend it is built here, after the lock is taken) on
 *   127.0.0.1:${LOADTEST_PORT:-8091}, so 8090 stays free for make dev /
 *   make run. LOADTEST_HTTP overrides the whole listen address (e.g.
 *   0.0.0.0:8091 for phones on the LAN – a warning is printed, the passwords
 *   are well-known).
 * - The login rate limiter is off while seeding (8 logins from 127.0.0.1
 *   within a second: the instance's superuser client plus the seed's 7) and
 *   on again for the interactive session, as in production.
 * - Runs in the foreground until Ctrl+C / SIGTERM / SIGHUP, then stops
 *   PocketBase. PocketBase runs in the same process group, so a Ctrl+C in the
 *   terminal reaches it directly as well.
 * - .pb/loadtest-dev.pid (created atomically) prevents two runs on the same
 *   data dir.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { countRecords, type RateLimitSettings } from '../api.ts';
import { DEFAULT_PASSWORD, type DatasetOptions, type ResolvedDatasetOptions } from '../dataset.ts';
import { formatPeriods, formatSeedSummary, int } from '../format.ts';
import { isLoopback, isPortFree, parseListenAddress, startInstance, type Instance } from '../instance.ts';
import { createOwnedDir, displayPath, PB_HOME, realPath, removeOwnedDir, REPO_ROOT } from '../paths.ts';
import { runSeed, type SeedSummary } from '../seed.ts';
import { periodRanges, toPbDate, type PeriodKey, type TimeRange } from '../time.ts';
import {
  abortOnSignals,
  DATASET_FLAGS,
  DATASET_FLAGS_HELP,
  datasetOptionsFrom,
  envFlag,
  parseInteger,
  signalExitCode,
  UsageError,
} from './args.ts';

const PB_DIR = PB_HOME;
const DATA_DIR = path.join(PB_DIR, 'loadtest-data');
const HOOKS_DIR = path.join(PB_DIR, 'loadtest-hooks');
const LOG_FILE = path.join(PB_DIR, 'loadtest-pocketbase.log');
const LOCK_FILE = path.join(PB_DIR, 'loadtest-dev.pid');
const MARKER_FILE = path.join(DATA_DIR, 'loadtest-seed.json');
const DEFAULT_PORT = 8091;

const SUPERUSER = {
  email: process.env.LOADTEST_SUPERUSER_EMAIL || 'loadtest@example.com',
  password: process.env.LOADTEST_SUPERUSER_PASSWORD || DEFAULT_PASSWORD,
};

const HELP = `Usage: make loadtest-dev [LOADTEST_PORT=8091] [LOADTEST_KEEP=1] [LOADTEST_SEED=…]
       npm run dev -- [options]          (in loadtest/, uses the existing frontend/dist)

Seeds the load-test dataset into ${displayPath(DATA_DIR)} and serves the app with it
until Ctrl+C.

  --port <n>             LOADTEST_PORT   port on 127.0.0.1 (${DEFAULT_PORT})
  --http <host:port>     LOADTEST_HTTP   listen address instead, e.g. 0.0.0.0:${DEFAULT_PORT}
  --keep                 LOADTEST_KEEP=1 reuse the dataset of the last run instead of reseeding
  --build-frontend                       build the SPA (npm run build in frontend/) after
                                         taking the lock, before PocketBase starts
${DATASET_FLAGS_HELP}
  -h, --help`;

const say = (line: string) => console.log(`[loadtest-dev] ${line}`);

function parseFlags() {
  return parseArgs({
    options: {
      ...DATASET_FLAGS,
      port: { type: 'string' },
      http: { type: 'string' },
      keep: { type: 'boolean', default: false },
      'build-frontend': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }).values;
}

// ------------------------------------------------------------------- lock

function isLoadtestDev(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('dev.ts');
  } catch {
    return true; // no procfs: a living process with that pid counts
  }
}

/** Creates the lock file atomically ('wx'); a stale one (process gone) is taken over. */
function acquireLock(): void {
  mkdirSync(PB_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(LOCK_FILE, `${process.pid}\n`, { flag: 'wx' });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let pid = 0;
    try {
      pid = Number(readFileSync(LOCK_FILE, 'utf8').trim());
    } catch {
      // removed meanwhile – try again
    }
    if (pid > 0 && pid !== process.pid && isLoadtestDev(pid)) {
      throw new Error(
        `another loadtest-dev (pid ${pid}) is using ${displayPath(DATA_DIR)} – stop it first ` +
          `(or delete ${displayPath(LOCK_FILE)} if that process is something else)`,
      );
    }
    try {
      unlinkSync(LOCK_FILE); // stale
    } catch {
      // somebody else removed it
    }
  }
  throw new Error(`could not take ${displayPath(LOCK_FILE)} – is another loadtest-dev starting right now?`);
}

function releaseLock(): void {
  try {
    if (readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) unlinkSync(LOCK_FILE);
  } catch {
    // already gone
  }
}

/**
 * Other processes started with `--dir=<data dir>` (PocketBase of `make dev`
 * with PB_DATA_DIR=.pb/loadtest-data, a manual `pocketbase serve`, …).
 * Linux only (/proc); elsewhere nothing is found.
 */
function processesUsingDataDir(): string[] {
  if (process.platform !== 'linux') return [];
  const targets = new Set([path.resolve(DATA_DIR), realPath(DATA_DIR)]);
  const found: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    let args: string[];
    try {
      args = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean);
    } catch {
      continue;
    }
    const dirs = args.flatMap((arg, i) =>
      arg.startsWith('--dir=') ? [arg.slice('--dir='.length)] : arg === '--dir' && args[i + 1] ? [args[i + 1]!] : [],
    );
    if (dirs.length === 0) continue;
    let cwd = '/';
    try {
      cwd = readlinkSync(`/proc/${entry}/cwd`);
    } catch {
      // relative --dir values then resolve against /
    }
    if (dirs.some((dir) => targets.has(path.resolve(cwd, dir)) || targets.has(realPath(path.resolve(cwd, dir))))) {
      found.push(`pid ${entry}: ${args.join(' ').slice(0, 160)}`);
    }
  }
  return found;
}

// ------------------------------------------------------------------- data

async function readMarker(): Promise<SeedSummary | null> {
  try {
    const summary = JSON.parse(await readFile(MARKER_FILE, 'utf8')) as SeedSummary;
    return summary.ok && summary.counts ? summary : null;
  } catch {
    return null;
  }
}

/** A data dir of an earlier version (no owned-dir marker yet) is recognized by its seed marker. */
function isLegacyDataDir(dir: string): boolean {
  return existsSync(path.join(dir, 'loadtest-seed.json'));
}

/** Dataset options given for this run that differ from the kept dataset (they do not apply with KEEP). */
function ignoredOptions(given: DatasetOptions, kept: ResolvedDatasetOptions): string[] {
  const names: Array<[keyof ResolvedDatasetOptions, string]> = [
    ['seed', 'LOADTEST_SEED'],
    ['persons', 'LOADTEST_PERSONS'],
    ['users', 'LOADTEST_USERS'],
    ['minBookingsPerPerson', 'LOADTEST_MIN_BOOKINGS'],
    ['maxBookingsPerPerson', 'LOADTEST_MAX_BOOKINGS'],
    ['days', 'LOADTEST_DAYS'],
  ];
  return names
    .filter(([key]) => given[key] !== undefined && given[key] !== kept[key])
    .map(([key, name]) => `${name}=${given[key]} (kept: ${kept[key]})`);
}

/** Why the kept data is not the dataset its marker describes (empty = it is). */
async function keptDataProblems(instance: Instance, marker: SeedSummary): Promise<string[]> {
  const superuser = await instance.superuserClient();
  const users = await superuser.collection('users').getFullList({ batch: 1000, fields: 'id,username' });
  const problems = marker.users
    .filter((expected) => !users.some((user) => user.id === expected.id && user.username === expected.username))
    .map((expected) => `user "${expected.username}" is missing`);
  const persons = await countRecords(superuser, 'persons');
  if (persons < marker.counts.persons) problems.push(`${int(persons)} persons instead of ${int(marker.counts.persons)}`);
  return problems;
}

function rangeFilter({ from, to }: TimeRange): string {
  const parts: string[] = [];
  if (from !== undefined) parts.push(`created >= "${toPbDate(from)}"`);
  if (to !== undefined) parts.push(`created < "${toPbDate(to)}"`);
  return parts.join(' && ');
}

/** Current counts of the instance (bookings per period as the Buchungen screen shows them now). */
async function liveCounts(instance: Instance, timeZone: string) {
  const superuser = await instance.superuserClient();
  const ranges = periodRanges(Date.now(), timeZone);
  const keys = Object.keys(ranges) as PeriodKey[];
  const [persons, users, ...periodCounts] = await Promise.all([
    countRecords(superuser, 'persons'),
    countRecords(superuser, 'users'),
    ...keys.map((key) => countRecords(superuser, 'bookings', rangeFilter(ranges[key]))),
  ]);
  const perPeriod = Object.fromEntries(keys.map((key, i) => [key, periodCounts[i] ?? 0])) as Record<PeriodKey, number>;
  return { persons, users, bookings: perPeriod.all, perPeriod };
}

function describeRateLimits(limits: RateLimitSettings): string {
  const auth = limits.rules.find((rule) => rule.label === '*:auth');
  const rule = auth ? ` (${auth.maxRequests} logins / ${auth.duration} s per client IP)` : '';
  return limits.enabled ? `login throttling on${rule}, as in production` : 'OFF';
}

/** `npm ci` (if needed) + `npm run build` in frontend/ – the production build PocketBase serves. */
function buildFrontend(): void {
  const frontend = path.join(REPO_ROOT, 'frontend');
  const run = (args: string[]) => {
    say(`npm ${args.join(' ')} (in ${displayPath(frontend)}) ...`);
    const result = spawnSync('npm', args, { cwd: frontend, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed (${result.signal ?? `exit ${result.status}`})`);
  };
  if (!existsSync(path.join(frontend, 'node_modules'))) run(['ci']);
  run(['run', 'build']);
}

function describeExit(instance: Instance): string {
  const exit = instance.exitStatus();
  return exit ? `PocketBase exited unexpectedly (code ${exit.code}, signal ${exit.signal}):\n${instance.output()}` : '';
}

// ------------------------------------------------------------------- main

async function main(): Promise<number> {
  let values: ReturnType<typeof parseFlags>;
  let dataset: ReturnType<typeof datasetOptionsFrom>;
  let http: string;
  try {
    values = parseFlags();
    if (values.help) {
      console.log(HELP);
      return 0;
    }
    dataset = datasetOptionsFrom(values);
    // flags win over the environment, a full address wins over a port
    const flagPort = parseInteger('--port', values.port);
    const envPort = parseInteger('LOADTEST_PORT', process.env.LOADTEST_PORT);
    http =
      values.http ||
      (flagPort !== undefined ? `127.0.0.1:${flagPort}` : process.env.LOADTEST_HTTP || `127.0.0.1:${envPort ?? DEFAULT_PORT}`);
    parseListenAddress(http);
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }
  const keep = values.keep || envFlag('LOADTEST_KEEP');

  let ready = false;
  const { controller, received } = abortOnSignals((signal) =>
    say(`${signal} received – ${ready ? 'stopping' : 'aborting'} ...`),
  );
  let instance: Instance | undefined;
  let locked = false;
  let seeding = false;
  let reused = false;
  try {
    acquireLock();
    locked = true;
    process.on('exit', releaseLock); // also after a forced exit (second signal)
    const { host, port } = parseListenAddress(http);
    if (!(await isPortFree(host, port))) {
      throw new UsageError(
        `port ${port} is already in use (${http}) – is another server running there? ` +
          'Choose another one with LOADTEST_PORT=<port>.',
      );
    }
    const users = processesUsingDataDir();
    if (users.length > 0) {
      throw new Error(
        `${displayPath(DATA_DIR)} is in use by another process – stop it first ` +
          `(e.g. make dev with PB_DATA_DIR=${displayPath(DATA_DIR)}):\n  ${users.join('\n  ')}`,
      );
    }
    if (values['build-frontend']) buildFrontend();
    controller.signal.throwIfAborted();

    let marker = keep ? await readMarker() : null;
    if (keep && !marker) {
      say(`LOADTEST_KEEP=1, but ${displayPath(DATA_DIR)} holds no complete load-test dataset – seeding a fresh one`);
    }
    if (marker) {
      const ignored = ignoredOptions(dataset, marker.options);
      if (ignored.length > 0) {
        say(`WARNING: LOADTEST_KEEP=1 reuses the kept dataset – ignoring ${ignored.join(', ')}; ` +
          'run without LOADTEST_KEEP=1 to seed with them');
      }
    } else {
      await removeOwnedDir(DATA_DIR, { isLegacy: isLegacyDataDir });
      await createOwnedDir(DATA_DIR);
    }

    say(`starting PocketBase on ${http} (data ${displayPath(DATA_DIR)}, log ${displayPath(LOG_FILE)}) ...`);
    try {
      instance = await startInstance({
        dataDir: DATA_DIR,
        hooksDir: HOOKS_DIR,
        http,
        superuser: SUPERUSER,
        logFile: LOG_FILE,
        echo: true,
      });
    } catch (error) {
      if (!marker) throw error;
      throw new Error(
        `${(error as Error).message}\nThe kept data in ${displayPath(DATA_DIR)} could not be started – ` +
          'run without LOADTEST_KEEP=1 to seed a fresh dataset.',
        { cause: error },
      );
    }
    controller.signal.throwIfAborted();

    if (marker) {
      const problems = await keptDataProblems(instance, marker);
      if (problems.length > 0) {
        throw new Error(
          `LOADTEST_KEEP=1, but ${displayPath(DATA_DIR)} does not hold the dataset its marker describes ` +
            `(${problems.slice(0, 3).join('; ')}${problems.length > 3 ? '; …' : ''}) – ` +
            'run without LOADTEST_KEEP=1 to seed a fresh one',
        );
      }
      reused = true;
      say(
        `reusing the dataset seeded ${marker.startedAt} (seed "${marker.options.seed}", ` +
          `${marker.counts.persons} persons) – LOADTEST_KEEP=1`,
      );
    } else {
      seeding = true;
      await instance.setRateLimiting(false);
      say('seeding ...');
      const { summary } = await runSeed({
        url: instance.url,
        superuser: SUPERUSER,
        ...dataset,
        log: say,
        signal: controller.signal,
      });
      seeding = false;
      for (const line of formatSeedSummary(summary)) console.log(line);
      if (!summary.ok) throw new Error('the seeded dataset failed its checks (see above) – not starting the session');
      await writeFile(MARKER_FILE, `${JSON.stringify(summary, null, 2)}\n`);
      marker = summary;
    }
    const limits = await instance.setRateLimiting(true);
    const live = await liveCounts(instance, marker.options.timeZone);
    controller.signal.throwIfAborted();
    ready = true;

    const usernames = marker.users.filter((user) => user.role === 'user').map((user) => user.username);
    const userRange = usernames.length > 1 ? `${usernames[0]} … ${usernames.at(-1)}` : usernames[0];
    const lines = [
      'Getränkeliste load-test instance is ready',
      '',
      `App          ${instance.url}/`,
      `Dashboard    ${instance.url}/_/  –  superuser ${SUPERUSER.email} / ${SUPERUSER.password}`,
      `App logins   admin (role admin), ${userRange} (role user) – password ` +
        `"${DEFAULT_PASSWORD}", no password change asked`,
      `Data         ${int(live.persons)} persons (numbers 1–${marker.counts.persons}) · ${live.users} app users · ` +
        `${int(live.bookings)} bookings`,
      `             ${formatPeriods(live.perPeriod)} (now, ${marker.options.timeZone})`,
      `             seed "${marker.options.seed}", bookings spread over ${marker.options.days} days before ` +
        `${marker.window.to.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}${reused ? ' (reused)' : ''}`,
      `Data dir     ${displayPath(DATA_DIR)} – LOADTEST_KEEP=1 make loadtest-dev reuses it`,
      `Rate limit   ${describeRateLimits(limits)}`,
      `Log          ${displayPath(LOG_FILE)}`,
      'Stop         Ctrl+C',
    ];
    if (!isLoopback(http)) {
      lines.push(
        '',
        `WARNING: listening on ${http} – reachable from other machines, and every password above is well-known.`,
        'Phones need HTTPS for the camera (QR scanning) – see README "Phones and HTTPS".',
      );
    }
    const rule = '='.repeat(100);
    console.log(['', rule, ...lines.map((line) => (line ? `  ${line}` : '')), rule, ''].join('\n'));

    // foreground until a signal arrives or PocketBase goes away
    const aborted = new Promise<'signal'>((resolve) => {
      if (controller.signal.aborted) resolve('signal');
      else controller.signal.addEventListener('abort', () => resolve('signal'), { once: true });
    });
    const outcome = await Promise.race([aborted, instance.exited.then(() => 'exited' as const)]);
    if (outcome === 'exited') {
      // a terminal Ctrl+C reaches PocketBase too – give our own signal handler a moment
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!received()) {
        console.error(`[loadtest-dev] ${describeExit(instance)}`);
        return 1;
      }
    }
    return 0;
  } catch (error) {
    const signal = received();
    if (signal) return signalExitCode(signal);
    console.error(`[loadtest-dev] ${(error as Error).message}`);
    const exit = instance ? describeExit(instance) : '';
    if (exit) console.error(`[loadtest-dev] ${exit}`);
    return error instanceof UsageError ? 2 : 1;
  } finally {
    if (instance) {
      await instance.stop();
      say(`PocketBase stopped${seeding ? ' – seeding did not finish, the next run seeds a fresh dataset' : ''}`);
    }
    if (locked) releaseLock();
  }
}

process.exitCode = await main();
