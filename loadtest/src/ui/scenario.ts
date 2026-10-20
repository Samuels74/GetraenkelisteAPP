/**
 * Framework of the UI scenarios: the environment a scenario runs in, its
 * variants (one ScenarioResult per device profile, e.g. "U4-phone"), the API
 * fixtures, the expected-content builders shared by several scenarios and
 * small helpers.
 */
import type { Login, ScenarioContext } from '../perf/types.ts';
import type { OpenOptions, ProfileName, RequestRecord, UiPage } from './browser.ts';
import { buchenLoad, personenLoad } from './conditions.ts';
import { elements, type Conds } from './probe.ts';
import type { ResultBuilder } from './result.ts';
import { Rest, type Offering, type Person, type User } from './rest.ts';

export interface Variant {
  /** Result id, e.g. "U4-phone". */
  id: string;
  title: string;
  /** The profile of a single-device variant. */
  profile: ProfileName;
  /** All profiles a multi-device variant uses (U9: two phones and a laptop); default [profile]. */
  devices?: ProfileName[];
  /** data.profile of the result (default: the profile's label). */
  deviceLabel?: string;
}

export interface Fixtures {
  /** All persons in the SPA's order. */
  persons: Person[];
  /** Active offerings (= the tiles on Buchen), sortOrder/name order. */
  offerings: Offering[];
  /** All offerings (Verwaltung lists inactive ones too). */
  allOfferings: Offering[];
  users: User[];
}

export interface UiEnv {
  ctx: ScenarioContext;
  rest: Rest;
  fixtures: Fixtures;
  quick: boolean;
  /** Repetitions of cold timings and cheap steps (3, quick: 1). */
  runs: number;
  /** Aborted when the variant timed out or the run was stopped – stop loops. */
  signal: AbortSignal;
  /** Write a Chromium trace of the first phone cold load of Personen (U4) into resultsDir. */
  trace: boolean;
  /** Opens a measured page (closed automatically when the variant ends; its timings are reported). */
  open(options: OpenOptions): Promise<UiPage>;
  login(username: string): Login;
  /** The person at this position of the SPA's order (wraps around for small datasets). */
  person(index: number): Person;
  log(message: string): void;
}

export interface UiScenario {
  id: string;
  title: string;
  /** One sentence: the real-world situation. */
  simulates: string;
  /** Variants for the full / quick run ([] = not run in that mode). */
  variants(quick: boolean): Variant[];
  /** Per variant. */
  timeoutMs: number;
  run(env: UiEnv, variant: Variant, result: ResultBuilder): Promise<void>;
}

/** One variant per profile: "U4-phone", "U4-desktop". */
export function perProfile(id: string, title: string, full: ProfileName[], quick: ProfileName[]) {
  return (isQuick: boolean): Variant[] =>
    (isQuick ? quick : full).map((profile) => ({ id: `${id}-${profile}`, title: `${title} (${profile})`, profile }));
}

/** Loads what the "ready" conditions need, with the runner's tokens. */
export async function loadFixtures(rest: Rest, logins: Record<string, Login>): Promise<Fixtures> {
  const user = logins.user1 ?? Object.values(logins).find((login) => login.record.role !== 'admin');
  const admin = logins.admin;
  if (!user || !admin) throw new Error('the UI checks need the logins "admin" and "user1" in ctx.logins');
  const [persons, allOfferings, users] = await Promise.all([
    rest.persons(user.token),
    rest.offerings(user.token),
    rest.users(admin.token),
  ]);
  if (persons.length === 0) throw new Error('the instance has no persons – seed it first');
  const offerings = allOfferings.filter((offering) => offering.active);
  if (offerings.length === 0) throw new Error('the instance has no active offerings');
  return { persons, offerings, allOfferings, users };
}

// ------------------------------------------------------------------ expected content

/** Buchen with `person` selected: its current total from the API. */
export async function buchenExpect(env: UiEnv, username: string, person: Person): Promise<Conds> {
  const totals = await env.rest.totals(env.login(username).token, { person: person.id });
  return buchenLoad({ offerings: env.fixtures.offerings.length, person, totalCents: totals.totalCents, count: totals.count });
}

/** Personen with the current totals (the first row that has bookings shows its amount). */
export async function personenExpect(env: UiEnv, username: string): Promise<Conds> {
  const totals = await env.rest.totals(env.login(username).token);
  const byId = new Map(totals.perPerson.map((entry) => [entry.personId, entry.totalCents]));
  const first = env.fixtures.persons.find((person) => byId.has(person.id));
  return personenLoad(env.fixtures.persons, first ? { person: first, totalCents: byId.get(first.id) as number } : null);
}

// ------------------------------------------------------------------ helpers

export const sumBytes = (records: readonly RequestRecord[]) => records.reduce((total, r) => total + r.bytes, 0);
export const KiB = (bytes: number) => bytes / 1024;
export const MiB = (bytes: number) => bytes / 1024 / 1024;

export interface PageSize {
  what: string;
  elements: number;
  heapBytes: number;
}

/** DOM size and the JS heap after a full GC of a loaded screen. */
export async function pageSize(page: UiPage, what: string): Promise<PageSize> {
  return { what, elements: await elements(page.page), heapBytes: await page.heapAfterGc() };
}

/** Adds a PageSize as info metrics (dom.elements, heap). */
export function addPageSize(r: ResultBuilder, size: PageSize | undefined): void {
  if (!size) return;
  r.add({ key: 'dom.elements', label: `DOM elements (${size.what})`, value: size.elements, unit: 'count' });
  r.add({ key: 'heap', label: `JS heap after GC (${size.what})`, value: size.heapBytes / 1024 / 1024, unit: 'MiB' });
}

/** Deletes bookings the checks created (as their creator), so the dataset keeps its seeded size. */
export async function deleteBookings(env: UiEnv, username: string, ids: readonly string[]): Promise<number> {
  const token = env.login(username).token;
  let deleted = 0;
  for (const id of new Set(ids)) {
    try {
      if (await env.rest.deleteBooking(token, id)) deleted++;
    } catch (error) {
      env.log(`cleanup: deleting booking ${id} failed: ${(error as Error).message}`);
    }
  }
  return deleted;
}

/** Median per label of repeated labelled samples, in first-seen order. */
export function mediansByLabel(samples: ReadonlyArray<{ label: string; ms: number }>): Array<{ label: string; ms: number; runs: number[] }> {
  const byLabel = new Map<string, number[]>();
  for (const { label, ms } of samples) byLabel.set(label, [...(byLabel.get(label) ?? []), ms]);
  return [...byLabel].map(([label, runs]) => {
    const sorted = [...runs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const ms = sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
    return { label, ms, runs };
  });
}
