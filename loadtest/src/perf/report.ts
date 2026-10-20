/**
 * The report of a performance-check run, in test-results/loadtest/:
 *
 *   report.md     for people: the verdict first, then the environment and the
 *                 dataset, the findings (every WARN/FAIL metric with its
 *                 explanation), measurement-validity hints (client-bound
 *                 scenarios, a busy machine), then one section per scenario
 *   results.json  everything machine-readable: environment, knobs, dataset,
 *                 planner state and all ScenarioResults (types.ts)
 *   (pocketbase.log is written by the instance itself)
 *
 * Verdicts: PASS / PASS with N warnings / FAIL (exit code 1) / INTERRUPTED.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Environment } from './env.ts';
import type { PlannerInfo } from './planner.ts';
import { BUSY_MACHINE_CORES, type ReportTable } from './scenario.ts';
import type { Metric, ScenarioResult, Verdict } from './types.ts';

export interface RunReport {
  verdict: Verdict | 'interrupted';
  interrupted: boolean;
  /** Why the run stopped early (scenario timeout). */
  aborted?: string;
  /** Scenarios not run because of `aborted`. */
  skipped: string[];
  durationMs: number;
  environment: Environment;
  knobs: { quick: boolean; scenarios: string[] | null; ui: boolean; soak: boolean; soakMinutes?: number };
  dataset?: {
    seed: string;
    persons: number;
    users: number;
    bookings: number;
    perPeriod: Record<string, number>;
    window: { from: string; to: string; days: number; timeZone: string };
    valueCents: number;
    fingerprints: { plan: string; content?: string };
  };
  planner?: PlannerInfo;
  instance?: {
    url: string;
    pid: number;
    /** PocketBase's cron backup in the throw-away instance ('off' = switched off by the runner). */
    backupCron?: string;
    /** The run crossed 00:00 UTC – PocketBase's nightly job (PRAGMA optimize + WAL checkpoint) may have run meanwhile. */
    crossedMidnightUtc?: boolean;
  };
  results: ScenarioResult[];
}

export interface Finding {
  verdict: 'warn' | 'fail';
  scenario: string;
  metric?: Metric;
  text: string;
}

const int = (value: number) => value.toLocaleString('en');

function formatNumber(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toLocaleString('en', { maximumFractionDigits: digits });
}

export function formatValue(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  const space = unit === '%' ? '' : ' ';
  return unit === 'count' ? formatNumber(value) : `${formatNumber(value)}${space}${unit}`;
}

function formatLimit(metric: Metric, limit: number | undefined): string {
  if (limit === undefined || !metric.budget) return '';
  return `${metric.budget.direction === 'max' ? '>' : '<'} ${formatValue(limit, metric.unit)}`;
}

/** Counts WARN / FAIL metrics (and crashed scenarios as failures). */
export function countVerdicts(results: readonly ScenarioResult[]): { warn: number; fail: number } {
  let warn = 0;
  let fail = 0;
  for (const result of results) {
    const failing = result.metrics.filter((metric) => metric.verdict === 'fail').length;
    warn += result.metrics.filter((metric) => metric.verdict === 'warn').length;
    fail += failing;
    // a crash, or a 'fail' verdict that no metric explains (e.g. a setup failure of the browser checks)
    if (result.error || (result.verdict === 'fail' && failing === 0)) fail++;
  }
  return { warn, fail };
}

export function verdictLine(report: RunReport): string {
  if (report.interrupted) return 'INTERRUPTED';
  const { warn, fail } = countVerdicts(report.results);
  if (fail > 0) return `FAIL – ${fail} failure${fail === 1 ? '' : 's'}, ${warn} warning${warn === 1 ? '' : 's'}`;
  if (warn > 0) return `PASS with ${warn} warning${warn === 1 ? '' : 's'}`;
  return 'PASS';
}

export function exitCodeOf(report: RunReport): number {
  return countVerdicts(report.results).fail > 0 ? 1 : 0;
}

/** Every WARN/FAIL metric and every crashed scenario, FAIL first, then in run order. */
export function findings(results: readonly ScenarioResult[]): Finding[] {
  const out: Finding[] = [];
  for (const result of results) {
    if (result.error) out.push({ verdict: 'fail', scenario: result.id, text: `scenario failed: ${result.error.split('\n')[0]}` });
    else if (result.verdict === 'fail' && !result.metrics.some((metric) => metric.verdict === 'fail')) {
      out.push({ verdict: 'fail', scenario: result.id, text: `scenario failed: ${result.notes[0] ?? 'verdict FAIL without a failing metric'}` });
    }
    for (const metric of result.metrics) {
      if (metric.verdict !== 'warn' && metric.verdict !== 'fail') continue;
      const limit = metric.verdict === 'fail' ? metric.budget?.fail : metric.budget?.warn;
      const text =
        `${metric.label} = **${formatValue(metric.value, metric.unit)}** (${metric.verdict.toUpperCase()} ${formatLimit(metric, limit)})` +
        (metric.detail ? ` – ${metric.detail}` : '');
      out.push({ verdict: metric.verdict, scenario: result.id, metric, text });
    }
  }
  return out.sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === 'fail' ? -1 : 1));
}

/**
 * The machine load around a result: API scenarios store data.machine
 * (scenario.ts), the browser checks data.loadavg + data.busyCores (src/ui).
 */
function machineOf(result: ScenarioResult): { loadavg1Start?: number; otherBusyCoresMean?: number | null; otherBusyCoresMax?: number | null } {
  const data = result.data ?? {};
  if (data.machine) return data.machine as { loadavg1Start?: number; otherBusyCoresMean?: number | null; otherBusyCoresMax?: number | null };
  const loadavg = data.loadavg as { before?: number[] } | undefined;
  const busy = data.busyCores as { foreign?: number } | undefined;
  return { loadavg1Start: loadavg?.before?.[0], otherBusyCoresMean: busy?.foreign ?? null, otherBusyCoresMax: busy?.foreign ?? null };
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${(ms / 1000).toFixed(1)} s`;
}

function escapeCell(value: string | number): string {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function markdownTable(columns: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number>>): string[] {
  return [
    `| ${columns.map(escapeCell).join(' | ')} |`,
    `|${columns.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`),
  ];
}

function localTime(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' });
}

export function renderMarkdown(report: RunReport): string {
  const env = report.environment;
  const lines: string[] = [];
  const { warn, fail } = countVerdicts(report.results);
  lines.push('# Getränkeliste – load test report', '');
  lines.push(`**Result: ${verdictLine(report)}** · exit code ${report.interrupted ? 'n/a (interrupted)' : exitCodeOf(report)}`, '');
  if (report.aborted) lines.push(`> The run stopped early: ${report.aborted} (skipped: ${report.skipped.join(', ') || 'none'}).`, '');
  if (report.instance?.crossedMidnightUtc) {
    lines.push(
      "> The run crossed 00:00 UTC: PocketBase's nightly job (PRAGMA optimize + WAL checkpoint) may have run during a scenario – " +
        'repeat the run if numbers around that time look odd.',
      '',
    );
  }

  const knobs = [
    report.knobs.quick ? 'quick run (LOADTEST_QUICK=1)' : 'full run',
    report.knobs.scenarios ? `scenarios ${report.knobs.scenarios.join(', ')}` : 'all scenarios',
    report.knobs.ui ? 'browser checks on' : 'browser checks off (LOADTEST_UI=0)',
    report.knobs.soak ? `soak ${report.knobs.soakMinutes} min` : 'no soak',
  ];
  const ds = report.dataset;
  const periods = ds ? `Heute ${int(ds.perPeriod.today ?? 0)} · 7 Tage ${int(ds.perPeriod['7d'] ?? 0)} · 30 Tage ${int(ds.perPeriod['30d'] ?? 0)} · Alle ${int(ds.perPeriod.all ?? 0)}` : '';
  lines.push(
    ...markdownTable(
      ['', ''],
      [
        ['Run', `${localTime(env.date, ds?.window.timeZone ?? env.timeZone)} (${ds?.window.timeZone ?? env.timeZone}) · ${duration(report.durationMs)} · ${knobs.join(' · ')}`],
        ['Code', `${env.git.branch} @ ${env.git.commit.slice(0, 7)}${env.git.dirty ? ` (working tree differs: ${env.git.changedFiles} files)` : ''}`],
        [
          'Machine',
          `${env.host.cpuModel} · ${env.host.logicalCpus} logical CPUs · ${env.host.memoryGiB} GiB · ${env.host.os} · load average (1/5/15 min) ` +
            `${env.loadavg.start.join(' / ')} at the start → ${env.loadavg.end?.join(' / ') ?? '?'} at the end`,
        ],
        [
          'Software',
          `Node ${env.node} · PocketBase ${env.pocketbase} (throw-away instance on localhost, login rate limiter off until A9, ` +
            `backup cron ${report.instance?.backupCron ?? 'unchanged'})`,
        ],
        [
          'Dataset',
          ds
            ? `${int(ds.persons)} persons · ${ds.users} users + admin · ${int(ds.bookings)} bookings over ${ds.window.days} days (${periods} at the seed start) · ` +
              `seed "${ds.seed}" · ${(ds.valueCents / 100).toLocaleString('en', { minimumFractionDigits: 2 })} € · plan ${ds.fingerprints.plan.slice(0, 12)}`
            : 'not seeded',
        ],
        [
          'Planner statistics',
          report.planner
            ? report.planner.state === 'steady'
              ? `production steady state ("PRAGMA optimize" like PocketBase's nightly job${report.planner.optimizedAt ? `, ${report.planner.optimizedAt}` : ''}): ${report.planner.appTables.join(', ')}`
              : 'freshly seeded (no statistics for the app tables)'
            : 'n/a',
        ],
      ],
    ),
    '',
  );

  lines.push('## Findings', '');
  const list = findings(report.results);
  if (list.length === 0) lines.push('No budget was exceeded.', '');
  else {
    lines.push(`${fail} failure${fail === 1 ? '' : 's'}, ${warn} warning${warn === 1 ? '' : 's'} – FAIL = user-visible problem, WARN = noticeable delay or regression margin.`, '');
    list.forEach((finding, i) => lines.push(`${i + 1}. **${finding.verdict.toUpperCase()}** · ${finding.scenario} · ${finding.text}`));
    lines.push('');
  }

  lines.push('## Measurement validity', '');
  const validity: string[] = [];
  for (const result of report.results) {
    if (result.clientBound?.flagged) validity.push(`**CLIENT-BOUND** (load generator or browser short of CPU) · ${result.id}: ${result.clientBound.detail}`);
    const machine = machineOf(result);
    // (the browser checks flag a busy machine through clientBound themselves)
    if (result.data?.machine && machine.otherBusyCoresMean !== undefined && machine.otherBusyCoresMean !== null && machine.otherBusyCoresMean > BUSY_MACHINE_CORES) {
      validity.push(`**BUSY MACHINE** · ${result.id}: other processes used ${machine.otherBusyCoresMean} cores on average (max ${machine.otherBusyCoresMax})`);
    }
  }
  if (validity.length === 0) {
    validity.push(`No scenario was limited by the load generator, and no other process kept the machine busy (> ${BUSY_MACHINE_CORES} cores) while measuring.`);
  }
  lines.push(...validity.map((v) => `- ${v}`));
  lines.push(
    '- Localhost only: real networks add latency and limited bandwidth (see the KiB/s figures); the server shares the machine with the load generator.',
    '',
  );

  lines.push('## Overview', '');
  lines.push(
    ...markdownTable(
      ['scenario', 'title', 'verdict', 'duration', 'WARN', 'FAIL', 'machine: load avg (1 min) / other processes (cores)', 'WAL left by the predecessor (MiB)'],
      report.results.map((r) => {
        const m = machineOf(r);
        const wal = r.data?.walLeftMiB;
        const warns = r.metrics.filter((x) => x.verdict === 'warn').length;
        const fails = r.metrics.filter((x) => x.verdict === 'fail').length + (r.error ? 1 : 0);
        return [
          r.id,
          r.title,
          `${r.verdict.toUpperCase()}${r.clientBound?.flagged ? ' (client-bound)' : ''}`,
          duration(r.durationMs),
          warns,
          fails,
          `${m.loadavg1Start ?? '–'} / ${m.otherBusyCoresMean ?? '–'}`,
          typeof wal === 'number' ? wal : '–',
        ];
      }),
    ),
    '',
  );

  lines.push('## Scenarios', '');
  for (const r of report.results) {
    lines.push(`### ${r.id} – ${r.title} · ${r.verdict.toUpperCase()}`, '');
    if (r.simulates) lines.push(`*Simulates:* ${r.simulates}. Started ${r.startedAt}, ${duration(r.durationMs)}.`, '');
    if (r.error) lines.push('**Crashed:**', '', '```', r.error, '```', '');
    if (r.clientBound) lines.push(`*Client / machine:* ${r.clientBound.flagged ? '**CLIENT-BOUND** – ' : ''}${r.clientBound.detail}`, '');
    if (r.metrics.length > 0) {
      lines.push(
        ...markdownTable(
          ['metric', 'value', 'WARN', 'FAIL', 'verdict', 'detail'],
          r.metrics.map((m) => [
            m.label,
            formatValue(m.value, m.unit),
            formatLimit(m, m.budget?.warn),
            formatLimit(m, m.budget?.fail),
            m.verdict.toUpperCase(),
            m.detail ?? '',
          ]),
        ),
        '',
      );
      const rationales = r.metrics.filter((m) => m.budget?.rationale).map((m) => `${m.label}: ${m.budget?.rationale}`);
      if (rationales.length > 0) {
        lines.push('<details><summary>Budget rationale</summary>', '', ...rationales.map((text) => `- ${text}`), '', '</details>', '');
      }
    }
    if (r.notes.length > 0) lines.push(...r.notes.map((note) => `- ${note}`), '');
    const tables = (r.data?.tables ?? []) as ReportTable[];
    for (const table of tables) lines.push(`**${table.title}**`, '', ...markdownTable(table.columns, table.rows), '');
  }
  lines.push('---', '', `Generated by \`loadtest/src/cli/run.ts\` (make loadtest); raw data: results.json. Method and budgets: docs/LOADTEST.md.`, '');
  return lines.join('\n');
}

export async function writeReport(dir: string, report: RunReport): Promise<void> {
  await writeFile(path.join(dir, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(dir, 'report.md'), renderMarkdown(report));
}

/** The summary at the end of the console output. */
export function consoleSummary(report: RunReport, dir: string): string[] {
  const lines = ['', `Result: ${verdictLine(report)} (${duration(report.durationMs)})`];
  const list = findings(report.results);
  for (const finding of list) {
    const text = finding.metric
      ? `${finding.metric.label} = ${formatValue(finding.metric.value, finding.metric.unit)} (${finding.verdict.toUpperCase()} ${formatLimit(
          finding.metric,
          finding.verdict === 'fail' ? finding.metric.budget?.fail : finding.metric.budget?.warn,
        )})`
      : finding.text;
    lines.push(`  ${finding.verdict.toUpperCase()}  ${finding.scenario.padEnd(11)} ${text}`);
  }
  const bound = report.results.filter((r) => r.clientBound?.flagged).map((r) => r.id);
  if (bound.length > 0) lines.push(`  client-bound (numbers unreliable): ${bound.join(', ')}`);
  lines.push(`Report: ${path.join(dir, 'report.md')}`, `Data:   ${path.join(dir, 'results.json')}`);
  return lines;
}
