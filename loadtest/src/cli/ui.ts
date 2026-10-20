/**
 * `node src/cli/ui.ts` – the browser checks U1–U11 on their own, for
 * development (the full performance run, `make loadtest`, calls
 * runUiScenarios itself).
 *
 * Starts a throw-away PocketBase (random free port, temp dir, login rate
 * limiter off – the seed logs in 7×), seeds the load-test dataset, logs in
 * once per account (admin, user1…user5), runs the checks, prints a table and
 * writes the results as JSON. The instance serves a snapshot copy of
 * frontend/dist, so a concurrent `make loadtest-dev` rebuilding the SPA cannot
 * pull files away mid-run. Ctrl+C / SIGTERM stop everything: the checks get
 * an abort signal and are awaited (bounded) – they close the browser, so
 * Playwright removes its temp profile, and delete their bookings – then the
 * instance and the temp dirs are removed here.
 *
 * Exit code: 0 = no FAIL, 1 = a FAIL budget was violated or a check crashed,
 * 2 = usage error, 130/143 = interrupted.
 */
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loginUser } from '../api.ts';
import { DEFAULT_PASSWORD } from '../dataset.ts';
import { formatSeedSummary } from '../format.ts';
import { startInstance, type Instance } from '../instance.ts';
import { defaultPaths, displayPath, REPO_ROOT } from '../paths.ts';
import type { Login, Metric, ScenarioContext, ScenarioResult } from '../perf/types.ts';
import { seedDataset } from '../seed.ts';
import type { ProfileName } from '../ui/browser.ts';
import { sleep } from '../ui/browser.ts';
import { machineLoad, planUi, runUi, selectionFromEnv } from '../ui/index.ts';
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

const HELP = `Usage: node src/cli/ui.ts [options]      (in loadtest/)

Runs the browser checks U1–U11 against a throw-away PocketBase with a fresh
load-test dataset: Chromium (headless), "phone" = Pixel 7 + 4× CPU throttling,
"desktop" = Desktop Chrome. Prints a table, writes <results>/ui-results.json.

Checks:
  --quick                  subset, one run each (or LOADTEST_QUICK=1)
  --only <ids>             e.g. U4,U7-phone (or the U ids of LOADTEST_SCENARIOS)
  --runs <n>               repetitions of cold timings (3, quick: 1)
  --profile <name>         only phone or only desktop variants
  --trace                  Chromium trace of the first U4 phone cold load
                           (<results>/ui-trace-U4-phone.json, open in chrome://tracing)
  --list                   print the planned variants and exit
Output and instance:
  --results <dir>          output dir (test-results/loadtest-ui)
  --keep-data              keep the instance's temp dir
  --log <file>             write the PocketBase output to this file
${DATASET_FLAGS_HELP}
  -h, --help`;

function parseFlags() {
  return parseArgs({
    options: {
      ...DATASET_FLAGS,
      quick: { type: 'boolean', default: false },
      only: { type: 'string' },
      runs: { type: 'string' },
      profile: { type: 'string' },
      trace: { type: 'boolean', default: false },
      list: { type: 'boolean', default: false },
      results: { type: 'string' },
      'keep-data': { type: 'boolean', default: false },
      log: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }).values;
}

const log = (line: string) => process.stdout.write(`${line}\n`);

function formatValue(metric: Metric): string {
  if (metric.value === null) return 'n/a';
  const value = metric.unit === 'ms' || metric.unit === 'count' ? Math.round(metric.value).toLocaleString('en') : metric.value.toLocaleString('en', { maximumFractionDigits: 1 });
  return `${value} ${metric.unit === 'count' ? '' : metric.unit}`.trim();
}

/** "warn 1500 / fail 4000" ('max' budgets) or "fail below 240" ('min' budgets). */
function formatLimits(metric: Metric): string {
  const budget = metric.budget;
  if (!budget) return '';
  const below = budget.direction === 'min' ? 'below ' : '';
  const parts: string[] = [];
  if (budget.warn !== undefined) parts.push(`warn ${below}${budget.warn}`);
  if (budget.fail !== undefined) parts.push(`fail ${below}${budget.fail}`);
  return parts.join(' / ');
}

function formatTable(results: readonly ScenarioResult[]): string[] {
  const lines: string[] = [];
  const width = Math.max(10, ...results.flatMap((r) => r.metrics.map((m) => m.key.length)));
  for (const result of results) {
    const busy = result.clientBound?.flagged ? '  (machine busy – timings unreliable)' : '';
    lines.push(`${result.id.padEnd(12)} ${result.verdict.toUpperCase().padEnd(5)} ${(result.durationMs / 1000).toFixed(1)} s  ${result.title}${busy}`);
    for (const metric of result.metrics) {
      const budget = metric.budget ? `  [${formatLimits(metric)}]` : '';
      const verdict = metric.verdict === 'info' ? '' : `  ${metric.verdict.toUpperCase()}`;
      lines.push(`    ${metric.key.padEnd(width)} ${formatValue(metric).padStart(11)}${verdict}${budget}`);
      if (metric.verdict === 'warn' || metric.verdict === 'fail' || metric.value === null) {
        lines.push(`    ${''.padEnd(width)}   ${metric.detail ?? ''}`);
      }
    }
    for (const note of result.notes) lines.push(`    note: ${note}`);
    if (result.error) lines.push(`    ERROR: ${result.error.split('\n').join('\n           ')}`);
  }
  return lines;
}

/** Copies the SPA build, so a concurrent rebuild cannot remove files under the running instance. */
async function snapshotPublicDir(): Promise<string> {
  const source = defaultPaths().publicDir;
  const index = await stat(path.join(source, 'index.html')).catch(() => null);
  if (!index) throw new UsageError(`no SPA build in ${displayPath(source)} – run: cd frontend && npm run build`);
  const target = await mkdtemp(path.join(os.tmpdir(), 'getraenkeliste-loadtest-spa-'));
  await cp(source, target, { recursive: true });
  log(`SPA build: ${displayPath(source)} (built ${index.mtime.toISOString()}), served from a snapshot copy`);
  return target;
}

async function main(): Promise<number> {
  let values: ReturnType<typeof parseFlags>;
  let dataset: ReturnType<typeof datasetOptionsFrom>;
  let runs: number | undefined;
  let profiles: ProfileName[] | undefined;
  try {
    values = parseFlags();
    if (values.help) {
      log(HELP);
      return 0;
    }
    dataset = datasetOptionsFrom(values);
    runs = parseInteger('--runs', values.runs);
    if (runs === 0) throw new UsageError('--runs must be at least 1');
    if (values.profile !== undefined) {
      if (values.profile !== 'phone' && values.profile !== 'desktop') throw new UsageError('--profile must be phone or desktop');
      profiles = [values.profile];
    }
  } catch (error) {
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      process.stderr.write(`${(error as Error).message}\n\n${HELP}\n`);
      return 2;
    }
    throw error;
  }

  const quick = values.quick || envFlag('LOADTEST_QUICK');
  const only = values.only !== undefined ? values.only.split(',').map((id) => id.trim()).filter(Boolean) : selectionFromEnv();
  const plan = planUi({ quick, only, profiles });
  if (values.list || plan.length === 0) {
    log(plan.length === 0 ? 'Nothing selected.' : `Planned (${quick ? 'quick' : 'full'}):`);
    for (const { variant } of plan) log(`  ${variant.id.padEnd(12)} ${variant.title}`);
    for (const skipped of plan.skipped) log(`  skipped: ${skipped}`);
    return plan.length === 0 ? 2 : 0;
  }

  const resultsDir = path.resolve(values.results ?? path.join(REPO_ROOT, 'test-results', 'loadtest-ui'));
  await mkdir(resultsDir, { recursive: true });

  const { controller, received } = abortOnSignals((signal) => log(`\n${signal} received – stopping …`));
  let instance: Instance | undefined;
  let publicDir: string | undefined;
  let results: ScenarioResult[] = [];
  const started = Date.now();
  try {
    publicDir = await snapshotPublicDir();
    instance = await startInstance({ keepData: values['keep-data'], logFile: values.log, paths: { publicDir } });
    log(`PocketBase ${instance.url} (pid ${instance.pid}); ${machineLoad()}`);
    await instance.setRateLimiting(false);
    const seed = await seedDataset({
      ...dataset,
      url: instance.url,
      superuser: instance.superuser,
      log: (line) => log(`  ${line}`),
      signal: controller.signal,
    });
    for (const line of formatSeedSummary(seed)) log(line);
    if (!seed.ok) throw new Error('seeding failed – see the summary above');

    // one login per account; the checks reuse these tokens (no further logins)
    const logins: Record<string, Login> = {};
    for (const username of seed.users.map((user) => user.username)) {
      const pb = await loginUser(instance.url, username, DEFAULT_PASSWORD);
      logins[username] = { username, password: DEFAULT_PASSWORD, token: pb.authStore.token, record: pb.authStore.record ?? {} };
    }

    const ctx: ScenarioContext = {
      url: instance.url,
      instance,
      seed,
      logins,
      quick,
      resultsDir,
      log: (line) => log(`  ${line}`),
      signal: controller.signal,
    };
    log(`UI checks (${quick ? 'quick' : 'full'}, ${plan.length} variants); ${machineLoad()}`);
    // runUi stops promptly on the signal; it then closes the browser (Playwright removes its temp
    // profile only after the browser exited) and deletes its bookings – wait for that, but bounded
    const ui = runUi(ctx, { quick, only, runs, profiles, trace: values.trace, signal: controller.signal });
    const aborted = new Promise<null>((resolve) => controller.signal.addEventListener('abort', () => resolve(null), { once: true }));
    const first = await Promise.race([ui, aborted]);
    if (first === null) await Promise.race([ui.catch(() => undefined), sleep(40_000)]);
    else results = first;
  } catch (error) {
    if (!received()) {
      process.stderr.write(`ui checks failed: ${(error as Error).message}\n`);
      return 1;
    }
  } finally {
    await instance?.stop();
    if (publicDir) await rm(publicDir, { recursive: true, force: true });
  }
  const signal = received();
  if (signal) return signalExitCode(signal);

  log('');
  for (const line of formatTable(results)) log(line);
  const file = path.join(resultsDir, 'ui-results.json');
  await writeFile(file, `${JSON.stringify({ quick, startedAt: new Date(started).toISOString(), results }, null, 2)}\n`);
  const counts = { pass: 0, warn: 0, fail: 0, info: 0 };
  for (const result of results) counts[result.verdict]++;
  log(
    `\n${results.length} results: ${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail, ${counts.info} info ` +
      `in ${((Date.now() - started) / 1000).toFixed(0)} s; ${machineLoad()} → ${displayPath(file)}`,
  );
  return counts.fail > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${(error as Error)?.stack ?? String(error)}\n`);
    process.exit(1);
  },
);
