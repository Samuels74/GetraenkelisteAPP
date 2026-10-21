/**
 * The performance-check runner behind `make loadtest` (cli/run.ts is the
 * command line around it; it is usable as a library as well):
 *
 *   prerequisites → snapshot copy of frontend/dist → throw-away PocketBase
 *   (free port, temp dir, login rate limiter and backup cron off) → seed +
 *   verify (scenario "seeding") → one login per account (admin, user1 …
 *   user5; scenarios never log in again, except A9) → scenarios in the
 *   default order, each isolated → browser checks via the UI slot → report in
 *   test-results/loadtest/ → PocketBase stopped, temp dirs removed (also on
 *   Ctrl+C / errors).
 *
 * Isolation: every scenario (and the UI slot) runs with its own
 * AbortController, combined with the run's signal. A crash is a 'fail'
 * result and the run goes on. A scenario that exceeds its watchdog is
 * aborted, gets a bounded grace period to stop (workers terminated, clients
 * closed) and fails; the remaining scenarios are skipped. On Ctrl+C the
 * running scenario is aborted as well and awaited for a bounded time – the
 * browser checks get up to 40 s to close the browser and delete their
 * bookings before the instance stops.
 *
 * The runner only measures its own throw-away instance (there is no URL
 * option): the scenarios create and delete bookings, switch planner
 * statistics and finally the rate limiter.
 */
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PASSWORD, OFFERINGS, type DatasetOptions } from '../dataset.ts';
import { startInstance, type Instance } from '../instance.ts';
import { checkPaths, defaultPaths, displayPath, removeOwnedDir, REPO_ROOT, snapshotSpa } from '../paths.ts';
import { seedDataset, type SeedSummary } from '../seed.ts';
import { collectEnvironment, type Environment } from './env.ts';
import { HealthProbe } from './health.ts';
import { HttpClient, parseJson } from './http.ts';
import { PlannerControl, type PlannerInfo } from './planner.ts';
import { writeReport, type RunReport } from './report.ts';
import { paths } from './requests.ts';
import { describeCrash, type Catalog, type PerfContext } from './scenario.ts';
import { API_SCENARIOS, RUN_ORDER } from './scenarios/index.ts';
import { seedingResult } from './scenarios/seeding.ts';
import { dbFileSizes, ProcessSampler } from './server.ts';
import { sleep } from './sleep.ts';
import { worstVerdict, type Login, type Scenario, type ScenarioResult } from './types.ts';

export const DEFAULT_RESULTS_DIR = path.join(REPO_ROOT, 'test-results', 'loadtest');
/** The browser checks (agent 2B) – loaded on demand, the run works without them. */
const UI_MODULE = '../ui/index.ts';
const ACCOUNTS = ['admin', 'user1', 'user2', 'user3', 'user4', 'user5'];
/** The scenarios book with user1 … user5 (one phone per user in the rushes). */
export const MIN_USERS = 5;
/** Grace for a scenario to stop after its watchdog / Ctrl+C aborted it. */
const STOP_GRACE_MS = 15_000;
/** The browser checks close the browser and sweep their bookings after an abort (2B: ≤ ≈ 40 s worst case). */
const UI_STOP_GRACE_MS = 40_000;

export interface RunnerOptions {
  /** LOADTEST_QUICK=1: short smoke run. */
  quick: boolean;
  /** LOADTEST_SCENARIOS: only these ids (A1 … A11, U1 … U11, U4-phone …); null = the default run. */
  scenarios: string[] | null;
  /** LOADTEST_UI=0 skips the browser checks. */
  ui: boolean;
  /** LOADTEST_SOAK=1 adds A11 to the default run (an explicit selection of A11 runs it anyway). */
  soak: boolean;
  resultsDir?: string;
  signal: AbortSignal;
  log: (line: string) => void;
  dataset?: DatasetOptions & { concurrency?: number };
  /** Keep the instance's temp dir (debugging). */
  keepData?: boolean;
}

/** What the runner uses of src/ui/index.ts (the contract entry is runUiScenarios). */
interface UiModule {
  runUiScenarios?: Scenario;
  /** runUiScenarios with options – the runner passes the slot's AbortSignal and the selection. */
  runUi?: (ctx: PerfContext, options: { signal?: AbortSignal; only?: string[] }) => Promise<ScenarioResult[]>;
  selectionFromEnv?: (value?: string) => string[] | undefined;
  planUi?: (options: { quick: boolean; only?: string[] }) => Array<{ variant: { id: string } }>;
}

async function loadUiModule(): Promise<UiModule | null> {
  try {
    return (await import(UI_MODULE)) as UiModule;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' && String(error).includes('ui/index.ts')) return null;
    throw error;
  }
}

/** "a1" → "A1", "u4-PHONE" → "U4-phone" (the UI checks also accept any case). */
export function normalizeScenarioId(id: string): string {
  const match = /^([au])(\d+)(-[a-z]+)?$/i.exec(id.trim());
  if (!match) return id.trim();
  return `${(match[1] as string).toUpperCase()}${match[2]}${match[3] ? match[3].toLowerCase() : ''}`;
}

/**
 * Checks a LOADTEST_SCENARIOS selection before anything starts: every id must
 * select something in this mode – an API scenario (A11 included: selecting it
 * runs the soak), a browser check or exactly one of its variants. Returns the
 * normalized ids and the problems (empty = fine).
 */
export async function validateSelection(
  ids: readonly string[],
  options: { quick: boolean; ui: boolean },
): Promise<{ ids: string[]; problems: string[] }> {
  const normalized = [...new Set(ids.map(normalizeScenarioId).filter(Boolean))];
  const problems: string[] = [];
  const api = API_SCENARIOS.map((s) => s.id);
  const uiIds = normalized.filter((id) => /^U\d+/.test(id));
  let uiVariants: string[] | null = null;
  if (uiIds.length > 0) {
    if (!options.ui) problems.push(`${uiIds.join(', ')}: browser checks selected, but LOADTEST_UI=0 / --no-ui switches them off`);
    else {
      const module = await loadUiModule();
      if (!module?.planUi) problems.push(`${uiIds.join(', ')}: the browser checks module (loadtest/src/ui/index.ts) is missing`);
      else uiVariants = module.planUi({ quick: options.quick }).map((planned) => planned.variant.id);
      for (const id of uiIds) {
        if (!module?.planUi || !uiVariants) continue;
        if (module.planUi({ quick: options.quick, only: [id] }).length === 0) {
          problems.push(
            `${id} selects no browser check in ${options.quick ? 'quick' : 'full'} mode ` +
              `(variants: ${uiVariants.join(' ')}; ids without a suffix select all variants of a check)`,
          );
        }
      }
    }
  }
  for (const id of normalized) {
    if (/^U\d+/.test(id)) continue;
    if (/^A1-(planner|empty)$/.test(id)) problems.push(`${id} is a result of A1 – select A1`);
    else if (!api.includes(id)) problems.push(`unknown scenario "${id}" (API: ${api.join(' ')}; browser: U1 … U11, e.g. U4 or U4-phone)`);
  }
  return { ids: normalized, problems };
}

async function login(url: string, username: string, password: string): Promise<Login> {
  const client = new HttpClient(url);
  try {
    const result = await client.post(paths.login(), { identity: username, password }, { collect: true });
    const body = parseJson<{ token: string; record: Record<string, unknown> }>(result);
    return { username, password, token: body.token, record: body.record };
  } finally {
    client.close();
  }
}

async function loadCatalog(url: string, adminToken: string, timeZone: string): Promise<Catalog> {
  const client = new HttpClient(url, { token: adminToken });
  try {
    const persons: Catalog['persons'] = [];
    for (let page = 1; ; page++) {
      const items = parseJson<{ items: Array<{ id: string; number: string; name: string }> }>(await client.get(paths.personsPage(page), { collect: true })).items;
      persons.push(...items.map(({ id, number, name }) => ({ id, number, name })));
      if (items.length < 1000) break;
    }
    persons.sort((a, b) => a.number.localeCompare(b.number, 'en', { numeric: true }));
    const records = parseJson<{ items: Array<{ id: string; name: string }> }>(await client.get(paths.offerings(), { collect: true })).items;
    const offerings = OFFERINGS.map((plan) => {
      const record = records.find((r) => r.name === plan.name);
      if (!record) throw new Error(`offering "${plan.name}" not found`);
      return { ...plan, id: record.id };
    });
    return { persons, offerings, timeZone };
  } finally {
    client.close();
  }
}

/** A 'fail' result for something that could not run at all. */
function failure(id: string, title: string, error: string, simulates = ''): ScenarioResult {
  return { id, title, simulates, startedAt: new Date().toISOString(), durationMs: 0, verdict: 'fail', metrics: [], notes: [], error };
}

const pad = (text: string, width: number) => (text.length >= width ? text : text + ' '.repeat(width - text.length));
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Per-scenario watchdog in ms (LOADTEST_SCENARIO_TIMEOUT_S overrides it for every scenario). */
function timeoutMs(id: string): number {
  const override = Number(process.env.LOADTEST_SCENARIO_TIMEOUT_S);
  if (override > 0) return override * 1000;
  if (id === 'A11') return ((Number(process.env.LOADTEST_SOAK_MINUTES) || 35) + 10) * 60_000;
  if (id === 'UI') return 20 * 60_000;
  return 10 * 60_000;
}

const minutesText = (ms: number) => (ms >= 60_000 ? `${Math.round((ms / 60_000) * 10) / 10} min` : `${Math.round(ms / 1000)} s`);

interface SlotOutcome {
  results: ScenarioResult[];
  /** The watchdog fired (the slot was aborted). */
  timedOut: boolean;
}

/**
 * Runs one scenario (or the UI slot) with its own AbortController. Normal
 * completion returns its results. When the watchdog fires or the run is
 * interrupted, the slot's signal aborts and the slot gets `graceMs` to stop
 * and clean up; whatever it returns by then is kept (an interrupted UI part
 * returns its finished variants), otherwise a failure stands in.
 */
async function runSlot(
  run: (signal: AbortSignal) => Promise<ScenarioResult[]>,
  options: {
    id: string;
    title: string;
    timeoutMs: number;
    graceMs: number;
    runSignal: AbortSignal;
    log: (line: string) => void;
    /** Keep the results a timed-out slot returned (the UI part's finished variants are valid; an API scenario's are not). */
    keepPartial: boolean;
  },
): Promise<SlotOutcome> {
  const controller = new AbortController();
  const signal = AbortSignal.any([options.runSignal, controller.signal]);
  let timedOut = false;
  const outcome = run(signal).then(
    (results) => ({ results }),
    (error: unknown) => ({ error }),
  );
  const watchdog = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`${options.id} did not finish within ${minutesText(options.timeoutMs)}`));
  }, options.timeoutMs);
  const aborted = new Promise<'aborted'>((resolve) => {
    if (signal.aborted) resolve('aborted');
    else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
  let settled = await Promise.race([outcome, aborted]);
  clearTimeout(watchdog);
  if (settled === 'aborted') {
    const what = timedOut ? 'watchdog' : 'Ctrl+C / SIGTERM';
    options.log(`  ${options.id}: stopping (${what}) – waiting up to ${minutesText(options.graceMs)} for it to clean up …`);
    const late = await Promise.race([outcome, sleep(options.graceMs).then(() => 'gone' as const)]);
    if (late === 'gone') {
      return {
        timedOut,
        results: [
          failure(
            options.id,
            options.title,
            timedOut
              ? `did not finish within ${minutesText(options.timeoutMs)} and did not stop within ${minutesText(options.graceMs)} after the abort`
              : `interrupted – did not stop within ${minutesText(options.graceMs)}`,
          ),
        ],
      };
    }
    settled = late;
  }
  if ('error' in settled) return { timedOut, results: [failure(options.id, options.title, describeCrash(settled.error, signal))] };
  if (timedOut) {
    const stopped = failure(options.id, options.title, `did not finish within ${minutesText(options.timeoutMs)} – stopped`);
    // the slot stopped in time; finished UI variants stay, a half-measured API scenario does not
    return { timedOut, results: options.keepPartial ? [stopped, ...settled.results.filter((r) => !r.error)] : [stopped] };
  }
  return { timedOut, results: settled.results };
}

/**
 * Isolation between scenarios: checkpoint the WAL like PocketBase's nightly
 * job (planner.ts checkpoint()), so every scenario starts from the same WAL
 * state. Returns the WAL size found (MiB) – reported per scenario.
 */
async function isolate(instance: Instance, planner: PlannerControl): Promise<number> {
  const left = dbFileSizes(instance.dataDir).dataWal;
  await planner.checkpoint();
  return left;
}

/** The SPA build is copied so a concurrent `make loadtest-dev` / build cannot change it under the running checks. */
async function snapshotFrontend(log: (line: string) => void): Promise<{ root: string; publicDir: string }> {
  const source = defaultPaths().publicDir;
  const snapshot = await snapshotSpa(source);
  log(`serving a snapshot copy of ${displayPath(source)} (${snapshot.publicDir})`);
  return snapshot;
}

/** Switches PocketBase's own cron backup (migration 1790550002: daily 03:00 UTC) off in the throw-away instance. */
async function disableBackupCron(instance: Instance): Promise<string> {
  const superuser = await instance.superuserClient();
  const settings = (await superuser.settings.update({ backups: { cron: '' } })) as { backups?: { cron?: string } };
  if (settings.backups?.cron !== '') throw new Error(`could not switch the backup cron off: ${JSON.stringify(settings.backups)}`);
  return 'off';
}

export async function runPerformanceChecks(options: RunnerOptions): Promise<RunReport> {
  const resultsDir = options.resultsDir ?? DEFAULT_RESULTS_DIR;
  const { signal, log } = options;
  const started = performance.now();
  const results: ScenarioResult[] = [];
  const skipped: string[] = [];
  let interrupted = false;
  let aborted: string | undefined;
  let instance: Instance | undefined;
  let spa: { root: string; publicDir: string } | undefined;
  let seed: SeedSummary | undefined;
  let planner: PlannerInfo | undefined;
  let backupCron = 'unchanged';

  const problems = checkPaths(defaultPaths());
  if (problems.length > 0) throw new Error(`prerequisites missing:\n  ${problems.join('\n  ')}`);
  if ((options.dataset?.users ?? MIN_USERS) < MIN_USERS) {
    throw new Error(`the performance checks need at least ${MIN_USERS} users (user1 … user${MIN_USERS}); got ${options.dataset?.users}`);
  }
  const selection = options.scenarios ? await validateSelection(options.scenarios, { quick: options.quick, ui: options.ui }) : null;
  if (selection && selection.problems.length > 0) throw new Error(`invalid scenario selection:\n  ${selection.problems.join('\n  ')}`);
  await mkdir(resultsDir, { recursive: true });
  for (const file of ['report.md', 'results.json', 'pocketbase.log']) await rm(path.join(resultsDir, file), { force: true });
  const environment: Environment = await collectEnvironment(defaultPaths().pbBin);
  const selected = selection ? new Set(selection.ids) : null;
  const wants = (id: string) => (selected ? selected.has(id) : true);
  const uiSelection = selection ? selection.ids.filter((id) => /^U\d+/.test(id)) : null;
  const wantsUi = options.ui && (uiSelection ? uiSelection.length > 0 : true);

  try {
    spa = await snapshotFrontend(log);
    instance = await startInstance({ logFile: path.join(resultsDir, 'pocketbase.log'), keepData: options.keepData, paths: { publicDir: spa.publicDir } });
    log(`PocketBase ${environment.pocketbase} on ${instance.url} (pid ${instance.pid}); results → ${path.relative(process.cwd(), resultsDir) || resultsDir}`);
    // all virtual devices log in from 127.0.0.1 – as in the other harnesses (docs/LOADTEST.md); A9 switches it on again
    await instance.setRateLimiting(false);
    backupCron = await disableBackupCron(instance);

    log('seeding the dataset …');
    const seedStart = new Date();
    const t0 = performance.now();
    const seedSampler = new ProcessSampler(instance.pid).start();
    const seedProbe = new HealthProbe('main').start();
    seed = await seedDataset({ url: instance.url, superuser: instance.superuser, ...options.dataset, signal });
    const seedWindow = { label: 'seeding', server: seedSampler.stop(), client: seedProbe.stop() };
    const seedMs = performance.now() - t0;
    log(
      `seeded ${seed.counts.persons.toLocaleString('en')} persons, ${seed.counts.bookings.toLocaleString('en')} bookings in ${seconds(seedMs)}` +
        ` (bookings ${seed.steps.bookings.perSecond}/s, p95 ${seed.steps.bookings.latency?.p95} ms)${seed.ok ? '' : ' – CHECKS FAILED'}`,
    );

    const logins: Record<string, Login> = {};
    for (const account of ACCOUNTS) logins[account] = await login(instance.url, account, DEFAULT_PASSWORD);
    const catalog = await loadCatalog(instance.url, logins.admin!.token, seed.options.timeZone);
    const plannerControl = new PlannerControl(() => (instance as Instance).superuserClient());
    const ctx: PerfContext = {
      url: instance.url,
      instance,
      seed,
      logins,
      quick: options.quick,
      resultsDir,
      log: (message) => log(message),
      signal,
      catalog,
      plannerState: () => plannerControl.state,
      ensureSteadyState: () => plannerControl.ensureSteadyState(),
    };
    results.push(seedingResult(ctx, seed, seedStart, seedMs, seedWindow));
    if (!seed.ok) throw new Error('the seeded dataset failed its checks – see the "seeding" result');

    // without A1 the database goes to the steady state right away
    if (!wants('A1')) {
      planner = await plannerControl.ensureSteadyState();
      log(`planner statistics: PRAGMA optimize (production steady state) – ${planner.appTables.join(', ')}`);
    }

    /** Would this slot run in this run (selection, LOADTEST_UI, opt-in)? */
    const willRun = (id: string): boolean => {
      if (id === 'UI') return wantsUi;
      const entry = API_SCENARIOS.find((s) => s.id === id);
      return Boolean(entry && wants(id) && (!entry.optIn || options.soak || selected?.has(id)));
    };
    for (const id of RUN_ORDER) {
      if (signal.aborted) {
        interrupted = true;
        break;
      }
      if (aborted) {
        if (willRun(id)) skipped.push(id);
        continue;
      }
      if (!willRun(id)) continue;
      if (id === 'UI') {
        if (plannerControl.state === 'fresh') planner = await plannerControl.ensureSteadyState();
        const walLeft = await isolate(instance, plannerControl);
        log(`▶ UI   browser checks (U1 … U11)${options.quick ? ' – quick' : ''} …`);
        const module = await loadUiModule().catch((error: unknown) => {
          results.push(failure('UI', 'Browser checks (U1 … U11)', describeCrash(error)));
          return undefined;
        });
        if (module === undefined) continue;
        if (module === null) {
          results.push(failure('UI', 'Browser checks (U1 … U11)', 'UI module missing (loadtest/src/ui/index.ts)'));
          continue;
        }
        const { runUi, runUiScenarios } = module;
        const only = uiSelection ?? undefined;
        const outcome = await runSlot(
          (slotSignal) => {
            const slotCtx: PerfContext = { ...ctx, signal: slotSignal };
            if (typeof runUi === 'function') return runUi(slotCtx, { signal: slotSignal, only });
            if (typeof runUiScenarios === 'function') return runUiScenarios(slotCtx);
            return Promise.reject(new Error(`${UI_MODULE} does not export runUiScenarios`));
          },
          { id: 'UI', title: 'Browser checks (U1 … U11)', timeoutMs: timeoutMs('UI'), graceMs: UI_STOP_GRACE_MS, runSignal: signal, log, keepPartial: true },
        );
        // the UI module returns one result per variant ("U4-phone"); a setup failure is a single result "UI"
        const uiResults = outcome.results;
        if (uiResults.length === 0 && !signal.aborted) {
          uiResults.push(failure('UI', 'Browser checks (U1 … U11)', `nothing ran for the browser checks${only ? ` (selection ${only.join(', ')})` : ''}`));
        }
        if (uiResults[0]) uiResults[0].data = { ...uiResults[0].data, walLeftMiB: walLeft };
        results.push(...uiResults);
        for (const r of uiResults) log(`  ${pad(r.id, 12)} ${pad(r.verdict.toUpperCase(), 5)} ${seconds(r.durationMs)}${r.error ? ` – ${r.error.split('\n')[0]}` : ''}`);
        if (outcome.timedOut) aborted = `the browser checks did not finish within ${minutesText(timeoutMs('UI'))} – stopped; the remaining scenarios were skipped`;
        continue;
      }
      // (willRun: A11, the soak, runs with LOADTEST_SOAK=1 or when selected explicitly)
      const entry = API_SCENARIOS.find((s) => s.id === id);
      if (!entry) continue;
      if (id !== 'A1' && plannerControl.state === 'fresh') planner = await plannerControl.ensureSteadyState();
      const walLeft = await isolate(instance, plannerControl);
      log(`▶ ${pad(id, 4)} ${entry.title} …`);
      const t = performance.now();
      const outcome = await runSlot((slotSignal) => entry.run({ ...ctx, signal: slotSignal }), {
        id,
        title: entry.title,
        timeoutMs: timeoutMs(id),
        graceMs: STOP_GRACE_MS,
        runSignal: signal,
        log,
        keepPartial: false,
      });
      if (outcome.timedOut) aborted = `${id} did not finish within ${minutesText(timeoutMs(id))} – stopped; the remaining scenarios were skipped`;
      if (outcome.results[0]) outcome.results[0].data = { ...outcome.results[0].data, walLeftMiB: walLeft };
      for (const r of outcome.results) {
        results.push(r);
        log(`  ${pad(r.id, 12)} ${pad(r.verdict.toUpperCase(), 5)} ${seconds(r.id === id ? performance.now() - t : r.durationMs)}${r.error ? ` – ${r.error.split('\n')[0]}` : ''}`);
      }
    }
    planner = plannerControl.state === 'steady' ? await plannerControl.status() : planner;
    if (signal.aborted) interrupted = true;
    // a run must never end PASS without having measured anything
    if (!interrupted && !results.some((r) => r.id !== 'seeding')) {
      results.push(failure('run', 'Nothing ran', 'no scenario ran besides the seeding – check LOADTEST_SCENARIOS / LOADTEST_UI / LOADTEST_SOAK'));
    }
  } catch (error) {
    if (signal.aborted) interrupted = true;
    else results.push(failure('runner', 'Runner', describeCrash(error)));
  } finally {
    environment.loadavg.end = os.loadavg().map((value) => Math.round(value * 100) / 100);
    if (instance) {
      const exit = instance.exitStatus();
      if (exit && !interrupted) {
        results.push(failure('pocketbase', 'PocketBase process', `PocketBase exited unexpectedly (code ${exit.code}, signal ${exit.signal}):\n${instance.output().slice(-2000)}`));
      }
      await instance.stop();
    }
    if (spa) await removeOwnedDir(spa.root).catch((error: unknown) => log(`could not remove ${spa?.root}: ${(error as Error).message}`));
  }

  const endedAt = new Date();
  const crossedMidnightUtc = environment.date.slice(0, 10) !== endedAt.toISOString().slice(0, 10);
  const report: RunReport = {
    verdict: interrupted ? 'interrupted' : worstVerdict(results.map((r) => r.verdict)),
    interrupted,
    aborted,
    skipped,
    durationMs: Math.round(performance.now() - started),
    environment,
    knobs: {
      quick: options.quick,
      scenarios: selection ? selection.ids : null,
      ui: options.ui,
      soak: options.soak || Boolean(selected?.has('A11')),
      soakMinutes: options.soak || selected?.has('A11') ? Number(process.env.LOADTEST_SOAK_MINUTES) || 35 : undefined,
    },
    instance: instance ? { url: instance.url, pid: instance.pid, backupCron, crossedMidnightUtc } : undefined,
    dataset: seed
      ? {
          seed: seed.options.seed,
          persons: seed.counts.persons,
          users: seed.counts.users,
          bookings: seed.counts.bookings,
          perPeriod: seed.counts.perPeriod,
          window: seed.window,
          valueCents: seed.value.totalCents,
          creationOrder: seed.creationOrder,
          fingerprints: seed.fingerprints,
        }
      : undefined,
    planner,
    results,
  };
  await writeReport(resultsDir, report);
  // test hook (verification only): simulates a stopped scenario that left a timer running – the CLI
  // must still exit shortly after the report
  if (process.env.LOADTEST_FAULT === 'leak-timer') setInterval(() => undefined, 1_000);
  return report;
}
