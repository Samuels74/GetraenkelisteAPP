/**
 * "seeding" – the seeder's own measurements as a scenario result: creating
 * 2000 persons and ≈ 15,000 bookings through the REST API with 10 requests
 * in flight is a write-path test in itself (every booking with the SPA's
 * request, rules and hooks). Budgets from Phase 1A's measurements on the
 * reference machine: bookings ≈ 3,500–3,700/s, p95 ≈ 6 ms, max 15–20 ms.
 */
import type { SeedSummary } from '../../seed.ts';
import { describeLatency } from '../analysis.ts';
import { fmt, startScenario, type PerfContext, type WindowStats } from '../scenario.ts';
import type { ScenarioResult } from '../types.ts';

export function seedingResult(ctx: PerfContext, summary: SeedSummary, startedAt: Date, durationMs: number, window?: WindowStats): ScenarioResult {
  const run = startScenario(ctx, {
    id: 'seeding',
    title: 'Seeding (write path)',
    simulates: 'creating the dataset through the REST API: persons as admin, bookings as their users, 10 requests in flight',
  });
  const { rec } = run;
  if (window) rec.addWindow(window);
  const { steps, counts } = summary;
  const bookings = steps.bookings;
  rec.add({
    key: 'bookings.p95',
    label: 'booking create while seeding (10 in flight) – p95',
    value: bookings.latency?.count ? bookings.latency.p95 : null,
    unit: 'ms',
    budget: { direction: 'max', warn: 25, fail: 250, rationale: 'creates with 10 in flight; baseline p95 ≈ 6 ms – > 250 ms would be a visibly slow tap' },
    detail: bookings.latency ? describeLatency(bookings.latency) : 'no samples',
  });
  rec.add({
    key: 'bookings.perSecond',
    label: 'booking creates per second while seeding',
    value: bookings.perSecond,
    unit: 'rps',
    budget: { direction: 'min', warn: 1000, rationale: 'regression margin: baseline ≈ 3,500/s on the reference machine' },
    detail: `${counts.bookings.toLocaleString('en')} bookings in ${fmt(bookings.durationMs / 1000, 1)} s`,
  });
  rec.add({
    key: 'persons.p95',
    label: 'person create while seeding (10 in flight) – p95',
    value: steps.persons.latency?.count ? steps.persons.latency.p95 : null,
    unit: 'ms',
    budget: { direction: 'max', warn: 25, fail: 250, rationale: 'baseline p95 ≈ 3.6 ms' },
    detail: steps.persons.latency ? describeLatency(steps.persons.latency) : 'no samples',
  });
  rec.add({
    key: 'errors',
    label: 'failed seed requests (after one retry)',
    value: summary.errors.total - summary.errors.recovered,
    unit: 'count',
    budget: { direction: 'max', fail: 0, rationale: 'the dataset must be complete' },
    detail: summary.errors.total ? `${summary.errors.total} failed, ${summary.errors.recovered} recovered: ${summary.errors.samples.slice(0, 2).join('; ')}` : 'none',
  });
  const failedChecks = summary.checks.filter((check) => !check.ok);
  rec.add({
    key: 'checks.failed',
    label: 'failed read-back checks',
    value: failedChecks.length,
    unit: 'count',
    budget: { direction: 'max', fail: 0, rationale: 'the dataset must be exactly the planned one' },
    detail: failedChecks.length ? failedChecks.map((c) => `${c.name}: ${c.detail}`).join('; ') : `${summary.checks.length} checks passed`,
  });
  rec.info('total', 'seeding total', Math.round(summary.durationMs) / 1000, 's', `setup ${steps.setup.durationMs} ms · persons ${steps.persons.durationMs} ms · bookings ${bookings.durationMs} ms · backdate ${steps.backdate.durationMs} ms · verify ${steps.verify.durationMs} ms`);
  rec.data.counts = counts;
  rec.data.fingerprints = summary.fingerprints;
  const result = run.finish();
  result.startedAt = startedAt.toISOString();
  result.durationMs = Math.round(durationMs);
  return result;
}
