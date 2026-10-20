/**
 * `make loadtest` / `npm run loadtest` – the automated performance checks
 * (docs/LOADTEST.md "Performance checks"): a throw-away PocketBase on a free
 * port, the load-test dataset, the API scenarios and the browser checks, a
 * report in test-results/loadtest/. See src/perf/runner.ts.
 *
 * Exit code: 0 = no FAIL budget violated (warnings are only reported),
 * 1 = a FAIL budget was violated, a scenario crashed or nothing ran,
 * 2 = usage error (checked before anything starts, e.g. a selection that
 * selects nothing), 129/130/143 = interrupted (SIGHUP / Ctrl+C / SIGTERM;
 * PocketBase is stopped, the temp dirs removed, a partial report written).
 *
 * After the report the process exits within a few seconds even if something
 * still holds the event loop (a stray timer or socket of a stopped scenario).
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { consoleSummary, exitCodeOf } from '../perf/report.ts';
import { DEFAULT_RESULTS_DIR, MIN_USERS, runPerformanceChecks, validateSelection } from '../perf/runner.ts';
import { API_SCENARIOS, UI_IDS } from '../perf/scenarios/index.ts';
import { abortOnSignals, DATASET_FLAGS, DATASET_FLAGS_HELP, datasetOptionsFrom, envFlag, signalExitCode, UsageError } from './args.ts';

const HELP = `Usage: make loadtest [LOADTEST_QUICK=1] [LOADTEST_SCENARIOS=A1,A2,U4] [LOADTEST_UI=0] [LOADTEST_SOAK=1]
       npm run loadtest -- [options]      (in loadtest/, uses the existing frontend/dist)

Performance checks against a throw-away PocketBase seeded with the load-test
dataset; report in test-results/loadtest/ (report.md, results.json,
pocketbase.log). Exit code 1 when a FAIL budget is violated.

  --quick              LOADTEST_QUICK=1        short smoke run (about 3 minutes)
  --scenarios <ids>    LOADTEST_SCENARIOS      only these (seeding always runs), e.g. A1,A2,U4,U7-phone
                                               API: ${API_SCENARIOS.map((s) => s.id).join(' ')} (A11 = the soak)
                                               browser: ${UI_IDS.join(' ')} or one variant, e.g. U4-phone
  --no-ui              LOADTEST_UI=0           skip the browser checks
  --soak               LOADTEST_SOAK=1         add A11, the soak (LOADTEST_SOAK_MINUTES, default 35)
  --results <dir>                              report directory (test-results/loadtest)
  --keep-data                                  keep the instance's temp dir (debugging)
                       LOADTEST_SCENARIO_TIMEOUT_S  watchdog per scenario in seconds
                                               (default 600, browser checks 1200, A11 its length + 600)
${DATASET_FLAGS_HELP}
  (the budgets are meant for the default dataset; at least ${MIN_USERS} users)
  -h, --help`;

const say = (line: string) => console.log(`[loadtest] ${line}`);

function parseFlags() {
  return parseArgs({
    allowNegative: true,
    options: {
      ...DATASET_FLAGS,
      quick: { type: 'boolean' },
      scenarios: { type: 'string' },
      ui: { type: 'boolean' },
      soak: { type: 'boolean' },
      results: { type: 'string' },
      'keep-data': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }).values;
}

/** "0", "false", "no" (case-insensitive) */
function envOff(name: string): boolean {
  return /^(0|false|no)$/i.test(process.env[name]?.trim() ?? '');
}

/** Exits within `ms` even if something still holds the event loop – logged, so a stuck run is visible. */
function armForcedExit(code: number, ms: number): void {
  setTimeout(() => {
    process.stderr.write(`[loadtest] still running ${ms / 1000} s after the report (a timer or socket of a stopped scenario) – exiting\n`);
    process.exit(code);
  }, ms).unref();
}

async function main(): Promise<number> {
  let values: ReturnType<typeof parseFlags>;
  let dataset: ReturnType<typeof datasetOptionsFrom>;
  let scenarios: string[] | null;
  let quick: boolean;
  let ui: boolean;
  let soak: boolean;
  try {
    values = parseFlags();
    if (values.help) {
      console.log(HELP);
      return 0;
    }
    dataset = datasetOptionsFrom(values);
    if ((dataset.users ?? MIN_USERS) < MIN_USERS) {
      throw new UsageError(`--users / LOADTEST_USERS: the performance checks need at least ${MIN_USERS} users (user1 … user${MIN_USERS})`);
    }
    quick = values.quick ?? envFlag('LOADTEST_QUICK');
    ui = values.ui ?? !envOff('LOADTEST_UI');
    soak = values.soak ?? envFlag('LOADTEST_SOAK');
    const list = values.scenarios ?? process.env.LOADTEST_SCENARIOS ?? '';
    scenarios = list.trim() ? list.split(/[\s,]+/).filter(Boolean) : null;
    if (scenarios) {
      // before anything starts: every id must select something in this mode
      const checked = await validateSelection(scenarios, { quick, ui });
      if (checked.problems.length > 0) throw new UsageError(`invalid scenario selection:\n  ${checked.problems.join('\n  ')}`);
      scenarios = checked.ids;
      // the browser checks read the selection from the environment as well (src/ui/index.ts)
      process.env.LOADTEST_SCENARIOS = scenarios.join(',');
    }
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }
  const resultsDir = values.results ? path.resolve(values.results) : DEFAULT_RESULTS_DIR;

  const { controller, received } = abortOnSignals((signal) => say(`${signal} received – stopping (PocketBase is shut down, a partial report written) …`));
  say(
    `performance checks: ${quick ? 'quick' : 'full'} run · ${scenarios ? `scenarios ${scenarios.join(',')}` : 'all scenarios'} · ` +
      `browser checks ${ui ? 'on' : 'off'}${soak ? ' · soak' : ''}`,
  );
  try {
    const report = await runPerformanceChecks({
      quick,
      scenarios,
      ui,
      soak,
      resultsDir,
      signal: controller.signal,
      log: say,
      dataset,
      keepData: values['keep-data'],
    });
    for (const line of consoleSummary(report, path.relative(process.cwd(), resultsDir) || resultsDir)) console.log(line);
    const signal = received();
    const code = signal ? signalExitCode(signal) : exitCodeOf(report);
    armForcedExit(code, signal ? 1_000 : 5_000);
    return code;
  } catch (error) {
    const signal = received();
    const code = signal ? signalExitCode(signal) : 1;
    if (!signal) console.error(`[loadtest] failed: ${(error as Error).message}`);
    armForcedExit(code, 5_000);
    return code;
  }
}

process.exitCode = await main();
