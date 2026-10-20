/**
 * Browser-level performance checks U1–U11 (docs/LOADTEST.md "UI checks"):
 * what users feel with 2000 persons and ~15,000 bookings – screen ready
 * times, search keystrokes, booking taps, list views, QR sheet, CSV export,
 * realtime propagation, long tasks, JS heap and DOM size – on a desktop
 * profile and on a 4×-CPU-throttled "phone" (Chromium, headless).
 *
 * `runUiScenarios` is the runner's entry (contract: ../perf/types.ts); the
 * runner may also call `runUi(ctx, { signal, only })`. Both use the runner's
 * logins (ctx.logins) – no logins of their own – and return one
 * ScenarioResult per scenario variant ("U4-phone", "U4-desktop", "U9").
 *
 * Robustness: every wait has a timeout (also the calibration and closing
 * pages and the browser – a wedged browser is killed); a variant that crashes
 * or times out becomes a 'fail' result with `error` and the next variant runs
 * (a dead browser is relaunched); the browser is always closed. ctx.signal
 * (Ctrl+C in the runner) stops the checks promptly: the running variant
 * fails, the rest is skipped, the browser is closed and the bookings the
 * checks created are deleted.
 *
 * Every result carries the machine load around it (data.loadavg,
 * data.busyCores) and the CPU calibration of the profiles (data.cpu); a
 * timing taken while other processes kept the machine busy marks the result
 * as clientBound (machine.ts). An ineffective phone throttling FAILs the phone
 * variants – their numbers would come from a fast CPU.
 *
 * Selection: LOADTEST_SCENARIOS (e.g. "A1,U4,U7-phone") restricts the UI
 * checks to the listed U ids (a list without U ids selects none); quick mode
 * (ctx.quick) runs a subset with one repetition.
 */
import os from 'node:os';
import type { Scenario, ScenarioContext, ScenarioResult } from '../perf/types.ts';
import { THROTTLING_TOLERANCE } from './budgets.ts';
import { BrowserHolder, PROFILES, UiPage, withTimeout, type ProfileName } from './browser.ts';
import { CpuMonitor } from './machine.ts';
import { bench } from './probe.ts';
import { median, ResultBuilder } from './result.ts';
import { Rest } from './rest.ts';
import { loadFixtures, type Fixtures, type UiEnv, type UiScenario, type Variant } from './scenario.ts';
import { U10 } from './scenarios/admin.ts';
import { U1, U2, U3 } from './scenarios/buchen.ts';
import { U7, U8 } from './scenarios/buchungen.ts';
import { U4, U5, U6 } from './scenarios/personen.ts';
import { U9 } from './scenarios/realtime.ts';
import { U11 } from './scenarios/wifi.ts';

export { UI_BUDGETS } from './budgets.ts';
export { BAR_WIFI, PROFILES } from './browser.ts';

/** In run order (coordinator-notes-2: U1 … U11 after the API rush). */
export const UI_SCENARIOS: readonly UiScenario[] = [U1, U2, U3, U4, U5, U6, U7, U8, U9, U10, U11];

export interface UiOptions {
  /** Default: ctx.quick. */
  quick?: boolean;
  /** Scenario ids ("U4") or variant ids ("U4-phone"); undefined = all, [] = none. */
  only?: string[];
  /** Repetitions of cold timings (default 3, quick 1). */
  runs?: number;
  /** Restrict the device profiles (development). */
  profiles?: ProfileName[];
  /** Write a Chromium trace of the first phone cold load of U4 into ctx.resultsDir. */
  trace?: boolean;
  /** Upper bound for the whole UI part (default 10 min, quick 3 min). */
  suiteTimeoutMs?: number;
  /** Stops the checks (default: ctx.signal). */
  signal?: AbortSignal;
}

/** U ids of LOADTEST_SCENARIOS (undefined when the variable is not set). */
export function selectionFromEnv(value = process.env.LOADTEST_SCENARIOS): string[] | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^U\d+(-[a-z]+)?$/i.test(id));
}

/** The runner's entry point. */
export const runUiScenarios: Scenario = (ctx) => runUi(ctx, { only: selectionFromEnv(), signal: ctx.signal });

export interface PlannedVariant {
  scenario: UiScenario;
  variant: Variant;
}

/** The variants a run would execute, in order, and the ones a profile restriction leaves out. */
export function planUi(options: { quick: boolean; only?: string[]; profiles?: ProfileName[] }): PlannedVariant[] & { skipped: string[] } {
  const wanted = options.only?.map((id) => id.toUpperCase().replace(/-(PHONE|DESKTOP)$/, (s) => s.toLowerCase()));
  const planned = Object.assign([] as PlannedVariant[], { skipped: [] as string[] });
  for (const scenario of UI_SCENARIOS) {
    for (const variant of scenario.variants(options.quick)) {
      if (wanted && !wanted.includes(scenario.id) && !wanted.includes(variant.id)) continue;
      const devices = variant.devices ?? [variant.profile];
      if (options.profiles && !devices.every((device) => options.profiles?.includes(device))) {
        // a multi-device variant (U9) is not obviously "a phone or desktop variant" – say why it is left out
        if (variant.devices) planned.skipped.push(`${variant.id} (needs the ${devices.join(' and ')} profiles)`);
        continue;
      }
      planned.push({ scenario, variant });
    }
  }
  return planned;
}

export interface CpuCalibration {
  /** A fixed amount of JS work in ms, per profile (median of 3). */
  desktopMs: number | null;
  phoneMs: number | null;
  /** phone / desktop – should be ≈ the throttling rate (4). */
  ratio: number | null;
}

const CALIBRATION_ITERATIONS = 5_000_000;
const CALIBRATION_TIMEOUT_MS = 60_000;

/** Runs the same JS workload on both profiles – shows that the 4× throttling is active on the app origin. */
async function calibrate(holder: BrowserHolder, ctx: ScenarioContext, login: UiEnv['login']): Promise<CpuCalibration> {
  const result: Record<ProfileName, number | null> = { desktop: null, phone: null };
  for (const profile of ['desktop', 'phone'] as const) {
    const page = await UiPage.open(await holder.get(), ctx.url, { profile, login: login('user1') });
    try {
      await page.page.goto('/favicon.svg', { waitUntil: 'load' });
      const samples: number[] = [];
      for (let i = 0; i < 3; i++) samples.push(await bench(page.page, CALIBRATION_ITERATIONS));
      result[profile] = median(samples);
    } finally {
      await page.close();
    }
  }
  const ratio = result.phone !== null && result.desktop ? Math.round((result.phone / result.desktop) * 100) / 100 : null;
  return {
    desktopMs: result.desktop === null ? null : Math.round(result.desktop),
    phoneMs: result.phone === null ? null : Math.round(result.phone),
    ratio,
  };
}

function failure(id: string, title: string, simulates: string, error: unknown): ScenarioResult {
  const r = new ResultBuilder(id, title, simulates);
  r.fail(error);
  return r.finish();
}

/**
 * Deletes every booking the UI checks created – a safety net behind the
 * per-scenario cleanup (a variant may time out or be stopped after a POST
 * reached the server but before its response was read). Assumption: the
 * runner runs scenarios sequentially, so nothing but the UI checks writes
 * bookings while they run; only bookings of the accounts the checks book with
 * (user1 … user5) created after the UI part started are deleted. Then the
 * booking count must be back to its value before the UI part.
 */
async function sweep(ctx: ScenarioContext, rest: Rest, startedAt: number, countBefore: number | null): Promise<string> {
  const admin = ctx.logins.admin;
  if (!admin) return 'cleanup sweep skipped: no admin login';
  const bookers = Object.values(ctx.logins)
    .filter((login) => login.username !== 'admin')
    .map((login) => String(login.record.id));
  const leftovers = await rest.bookingIdsSince(admin.token, startedAt, bookers);
  let deleted = 0;
  for (const id of leftovers) if (await rest.deleteBooking(admin.token, id)) deleted++;
  const after = (await rest.totals(admin.token)).count;
  const swept = deleted > 0 ? `deleted ${deleted} leftover booking${deleted === 1 ? '' : 's'}; ` : '';
  if (countBefore === null) return `cleanup: ${swept}${after} bookings`;
  return after === countBefore
    ? `cleanup: ${swept}${after.toLocaleString('en')} bookings, as before the UI checks`
    : `cleanup: ${swept}WARNING – ${after.toLocaleString('en')} bookings, ${countBefore.toLocaleString('en')} before the UI checks`;
}

const SWEEP_TIMEOUT_MS = 30_000;

export async function runUi(ctx: ScenarioContext, options: UiOptions = {}): Promise<ScenarioResult[]> {
  const quick = options.quick ?? ctx.quick;
  const planned = planUi({ quick, only: options.only, profiles: options.profiles });
  for (const skipped of planned.skipped) ctx.log(`UI checks: skipped ${skipped}`);
  if (planned.length === 0) {
    ctx.log('UI checks: nothing selected');
    return [];
  }
  const runs = options.runs ?? (quick ? 1 : 3);
  const deadline = Date.now() + (options.suiteTimeoutMs ?? (quick ? 180_000 : 600_000));
  const rest = new Rest(ctx.url);
  const holder = new BrowserHolder();
  const monitor = new CpuMonitor();
  const results: ScenarioResult[] = [];
  const login: UiEnv['login'] = (username) => {
    const found = ctx.logins[username];
    if (!found) throw new Error(`no login "${username}" in ctx.logins`);
    return found;
  };

  const stopped = options.signal ?? ctx.signal;
  const onStop = () => void holder.close(true);
  stopped?.addEventListener('abort', onStop, { once: true });
  const startedAt = Date.now();
  let countBefore: number | null = null;
  monitor.start();

  try {
    if (stopped?.aborted) return [];
    let fixtures: Fixtures;
    let cpu: CpuCalibration;
    try {
      if (ctx.logins.admin) countBefore = (await rest.totals(ctx.logins.admin.token)).count;
      fixtures = await loadFixtures(rest, ctx.logins);
      await holder.get();
      cpu = await withTimeout(calibrate(holder, ctx, login), CALIBRATION_TIMEOUT_MS, 'CPU calibration');
    } catch (error) {
      ctx.log(`UI checks: setup failed: ${(error as Error).message}`);
      return [failure('UI', 'Browser checks: setup', 'Starting Chromium and loading the reference data for the UI checks.', error)];
    }
    const target = PROFILES.phone.cpuThrottling;
    const throttlingOk =
      cpu.ratio !== null && cpu.ratio >= target * THROTTLING_TOLERANCE.min && cpu.ratio <= target * THROTTLING_TOLERANCE.max;
    ctx.log(
      `UI checks: Chromium ${holder.version() ?? '?'}, ${planned.length} variants, ${runs} run(s) per timing; ` +
        `CPU calibration desktop ${cpu.desktopMs} ms, phone ${cpu.phoneMs} ms (×${cpu.ratio}${throttlingOk ? '' : ' – NOT the expected 4×'}); ` +
        `busy-machine limit ${monitor.limit} of ${monitor.capacity.cores} cores`,
    );

    for (const { scenario, variant } of planned) {
      if (stopped?.aborted) break;
      const r = new ResultBuilder(variant.id, variant.title, scenario.simulates, monitor);
      r.data.cpu = cpu;
      r.data.profile = variant.deviceLabel ?? PROFILES[variant.profile].label;
      if (Date.now() > deadline) {
        r.fail(new Error('not run: the UI checks exceeded their time limit'));
        results.push(r.finish());
        continue;
      }
      const pages = new Set<UiPage>();
      const abort = new AbortController();
      const signal = stopped ? AbortSignal.any([abort.signal, stopped]) : abort.signal;
      const env: UiEnv = {
        ctx,
        rest,
        fixtures,
        quick,
        runs,
        signal,
        trace: options.trace ?? false,
        login,
        log: (message) => ctx.log(message),
        person: (index) => fixtures.persons[index % fixtures.persons.length] as Fixtures['persons'][number],
        open: async (openOptions) => {
          signal.throwIfAborted();
          const page = await UiPage.open(await holder.get(), ctx.url, openOptions);
          page.onTiming = (label, from, to) => r.timing(label, from, to);
          pages.add(page);
          return page;
        },
      };
      const disconnectsBefore = holder.disconnects;
      try {
        const budget = Math.min(scenario.timeoutMs, Math.max(10_000, deadline - Date.now()));
        await withTimeout(scenario.run(env, variant, r), budget, `${variant.id} timed out`);
      } catch (error) {
        r.fail(
          stopped?.aborted
            ? new Error('interrupted (the run was stopped)')
            : holder.disconnects > disconnectsBefore
              ? new Error(`the browser went away: ${(error as Error).message}`)
              : error,
        );
      } finally {
        abort.abort();
        const errors = [...new Set([...pages].flatMap((page) => page.errors))];
        if (errors.length > 0) {
          r.data.pageErrors = errors.slice(0, 10);
          r.note(`Browser reported: ${errors.slice(0, 3).join(' | ')}`);
        }
        for (const warning of new Set([...pages].flatMap((page) => page.warnings))) r.note(warning);
        const closed = await Promise.all([...pages].map((page) => page.close()));
        // a page that does not close means a wedged browser: kill it, the next variant relaunches one
        if (closed.includes(false)) holder.kill();
      }
      const devices = variant.devices ?? [variant.profile];
      if (devices.includes('phone') && !throttlingOk) {
        const low = cpu.ratio === null || cpu.ratio < target;
        r.add({
          key: 'phone.throttling',
          label: `Phone CPU throttling effective (calibration: phone time in % of desktop time, target ${target * 100} %)`,
          value: cpu.ratio === null ? null : cpu.ratio * 100,
          unit: '%',
          budget: low
            ? { direction: 'min', fail: target * THROTTLING_TOLERANCE.min * 100, rationale: 'phone CPU throttling not effective – the phone timings come from a fast CPU' }
            : { direction: 'max', fail: target * THROTTLING_TOLERANCE.max * 100, rationale: 'phone CPU throttling too strong – the phone timings are too slow' },
          detail: `phone CPU throttling not effective: calibration desktop ${cpu.desktopMs} ms, phone ${cpu.phoneMs} ms = ×${cpu.ratio} (expected ×${target}) – the phone numbers of this run are not valid`,
        });
      }
      const result = r.finish();
      results.push(result);
      ctx.log(
        `${result.id}: ${result.verdict.toUpperCase()}${result.error ? ` – ${result.error.split('\n')[0]}` : ''}` +
          `${result.clientBound?.flagged ? ' (machine busy)' : ''} (${Math.round(result.durationMs / 100) / 10} s)`,
      );
    }
  } finally {
    stopped?.removeEventListener('abort', onStop);
    await holder.close(true);
    monitor.stop();
    // bounded: on Ctrl+C the host may already be stopping PocketBase
    const summary = await withTimeout(sweep(ctx, rest, startedAt, countBefore), SWEEP_TIMEOUT_MS, 'cleanup sweep').catch(
      (error: unknown) => `cleanup sweep failed: ${(error as Error).message}`,
    );
    ctx.log(`UI checks: ${summary}`);
    const lastResult = results.at(-1);
    if (lastResult && (/deleted|WARNING|failed/.test(summary) || stopped?.aborted)) lastResult.notes.push(`UI ${summary}`);
  }
  return results;
}

/** Cores and current load (for CLI output). */
export function machineLoad(): string {
  const [one, five] = os.loadavg();
  return `load ${one?.toFixed(2)} / ${five?.toFixed(2)} on ${os.availableParallelism()} cores`;
}
