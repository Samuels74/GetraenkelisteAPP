/**
 * Plain-text rendering of seed summaries for the CLIs (no colors, no
 * terminal control sequences – the output also ends up in log files).
 */
import type { SeedSummary, StepResult } from './seed.ts';

export const int = (value: number): string => value.toLocaleString('en');
export const euros = (cents: number): string =>
  `${(cents / 100).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
export const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

function joinCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([key, value]) => `${key} ${int(value)}`)
    .join(' · ');
}

function createStep(step: StepResult, what: string): string {
  const latency = step.latency;
  const timing = latency?.count
    ? `; latency p50 ${latency.p50} ms, p95 ${latency.p95} ms, p99 ${latency.p99} ms, max ${latency.max} ms`
    : '';
  return `${int(step.count)} ${what} in ${seconds(step.durationMs)} = ${step.perSecond}/s${timing}; ${step.errors} errors`;
}

/** PERIOD key → label of the Buchungen screen. */
export const PERIOD_LABELS = { today: 'Heute', '7d': '7 Tage', '30d': '30 Tage', all: 'Alle' } as const;

export function formatPeriods(perPeriod: Record<keyof typeof PERIOD_LABELS, number>): string {
  return (Object.keys(PERIOD_LABELS) as (keyof typeof PERIOD_LABELS)[])
    .map((key) => `${PERIOD_LABELS[key]} ${int(perPeriod[key])}`)
    .join(' · ');
}

export function formatSeedSummary(summary: SeedSummary): string[] {
  const { counts, steps, options } = summary;
  const histogram = Object.entries(counts.perPersonHistogram)
    .map(([bookings, persons]) => `${bookings}×${int(persons)}`)
    .join(' · ');
  const lines = [
    `Dataset (seed "${options.seed}", plan ${summary.fingerprints.plan.slice(0, 12)}` +
      `${summary.fingerprints.content ? `, content ${summary.fingerprints.content.slice(0, 12)}` : ''})`,
    `  persons    ${int(counts.persons)} (numbers 1–${counts.persons}; ${int(counts.personsCreated)} created)`,
    `  users      ${counts.users} (${summary.users.filter((u) => u.role === 'user').map((u) => u.username).join(', ')}) + admin`,
    `  bookings   ${int(counts.bookings)}${counts.source === 'instance' ? ' (read back)' : ''} – per user: ${joinCounts(counts.perUser)}`,
    `             per offering: ${joinCounts(counts.perOffering)}`,
    `             persons per booking count: ${histogram}`,
    `  value      ${euros(summary.value.totalCents)} (${int(summary.value.quantity)} items)`,
    `  window     ${summary.window.from} → ${summary.window.to} (${summary.window.days} days, evenings in ${summary.window.timeZone})`,
    `  periods    ${formatPeriods(counts.perPeriod)} (at the seed start)`,
    `Timings (concurrency ${options.concurrency})`,
    `  setup      ${seconds(steps.setup.durationMs)}`,
    `  persons    ${createStep(steps.persons, 'created')}`,
    `  bookings   ${createStep(steps.bookings, summary.creationOrder === 'chronological' ? 'created (chronological order)' : 'created')}`,
    `  backdate   ${options.backdate ? `${int(steps.backdate.count)} bookings in ${steps.backdate.requests} requests, ${seconds(steps.backdate.durationMs)}` : 'skipped'}`,
    `  verify     ${options.verify ? `${steps.verify.count} checks, ${seconds(steps.verify.durationMs)}` : 'skipped'}`,
    `  total      ${seconds(summary.durationMs)}`,
  ];
  if (summary.checks.length > 0) {
    lines.push('Checks');
    for (const check of summary.checks) lines.push(`  [${check.ok ? 'ok' : 'FAIL'}] ${check.name} – ${check.detail}`);
  }
  const { errors } = summary;
  if (errors.total === 0) {
    lines.push('Errors: none');
  } else {
    lines.push(
      `Errors: ${errors.total} (by status: ${joinCounts(errors.byStatus)}; ${errors.foundOnServer ?? 0} created anyway ` +
        `(found on the server), retried ${errors.retried}, recovered ${errors.recovered})`,
    );
    for (const sample of errors.samples) lines.push(`  ${sample}`);
  }
  lines.push(summary.ok ? 'Result: OK' : 'Result: FAILED');
  return lines;
}
